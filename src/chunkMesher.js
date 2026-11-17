// Progressive, memory-light meshing for large structures.
//
// deepslate's own ChunkBuilder meshes *every* block synchronously in its
// constructor, creating a Mesh/Quad/Vertex object graph per block and then
// flattening it with flatMap; with a few million blocks that freezes (or
// crashes) the tab. It also uses 16-bit indices, so a dense chunk with more
// than 16383 faces silently renders garbage.
//
// This module replaces it:
//  - blocks are read straight from StructureBuilder's typed-array chunks
//  - each (block state, cull mask) is meshed once through deepslate and
//    cached as a flat Float32Array "template"; placing a block is a copy
//  - meshes are built per 32^3 render chunk, a few milliseconds per frame,
//    nearest to the camera first, so the page stays responsive and the
//    structure appears progressively
//  - vertex data is interleaved into one GPU buffer per chunk piece, drawn
//    with a shared index buffer (32-bit when available)
//  - views with a Y filter (slider, layer mode) reuse the unfiltered mesh of
//    every chunk the filter doesn't cut, and only rebuild the cut ones

const { Mesh, BlockState, SpecialRenderers, Structure, StructureRenderer } = deepslate;

import { CHUNK_BITS } from './structure.js';

const R_BITS = 5;
const R = 1 << R_BITS;      // render chunk edge (blocks)
const P = R + 2;            // padded edge (one neighbor cell on each side)
const PP = P * P;
const FPV = 15;             // floats per vertex: pos3 color3 tex2 texLimit4 normal3
const FPQ = FPV * 4;        // floats per quad
const STRIDE = FPV * 4;     // bytes per vertex

const UP = 1, DOWN = 2, WEST = 4, EAST = 8, NORTH = 16, SOUTH = 32;
const EMPTY_TEMPLATE = { quads: 0, data: null, transparent: false };

// Converts a deepslate Mesh (block-local, already scaled to 0..1) to a flat
// interleaved array.
function meshToTemplate(mesh, transparent) {
  const quads = mesh.quads;
  if (!quads.length) return EMPTY_TEMPLATE;
  const data = new Float32Array(quads.length * FPQ);
  let o = 0;
  for (const q of quads) {
    const n = q.normal();
    const nx = Number.isFinite(n.x) ? n.x : 0, ny = Number.isFinite(n.y) ? n.y : 0, nz = Number.isFinite(n.z) ? n.z : 0;
    for (const v of [q.v1, q.v2, q.v3, q.v4]) {
      const c = v.color || [1, 1, 1], t = v.texture || [0, 0], l = v.textureLimit || [0, 0, 0, 0];
      data[o++] = v.pos.x; data[o++] = v.pos.y; data[o++] = v.pos.z;
      data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2];
      data[o++] = t[0]; data[o++] = t[1];
      data[o++] = l[0]; data[o++] = l[1]; data[o++] = l[2]; data[o++] = l[3];
      data[o++] = nx; data[o++] = ny; data[o++] = nz;
    }
  }
  return { quads: quads.length, data, transparent };
}

// Growable float buffer for one chunk's output.
class FloatOut {
  constructor() { this.data = new Float32Array(FPQ * 4096); this.length = 0; }
  reset() { this.length = 0; }
  reserve(n) {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Float32Array(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

export class ChunkMesher {
  constructor(gl, builder, resources) {
    this.gl = gl;
    this.builder = builder;
    this.resources = resources;
    this.bounds = builder.getActualBounds();
    this.origin = [this.bounds.minX, this.bounds.minY, this.bounds.minZ];
    this.uintIndices = !!gl.getExtension('OES_element_index_uint');
    this.maxQuadsPerPiece = this.uintIndices ? 1 << 20 : 16383;
    this.indexBuffer = null;
    this.indexQuads = 0;
    this.attribLocations = new Map();
    this.focus = [0, 0, 0];
    this.budgetWindowStart = 0;
    this.budgetSpent = 0;
    this.warned = new Set();
    this.totalQuads = 0;

    // Per palette entry: render state, culling flags and template cache.
    const nameIds = new Map();
    this.info = builder.palette.map(entry => {
      if (!entry) return null;
      const state = new BlockState(entry.Name, { ...(entry.Properties || {}) });
      const flags = resources.getBlockFlags(state.getName()) || {};
      let nameId = nameIds.get(entry.Name);
      if (nameId === undefined) { nameId = nameIds.size; nameIds.set(entry.Name, nameId); }
      return {
        state,
        nameId,
        opaque: !!flags.opaque,
        selfCull: !!flags.self_culling,
        transparent: !!flags.semi_transparent,
        waterlogged: state.isWaterlogged(),
        templates: new Array(64),
      };
    });

    // Render chunks (32^3) covering every non-empty storage chunk.
    const shift = R_BITS - CHUNK_BITS;
    this.renderChunks = new Map();
    for (const c of builder.chunks.values()) {
      if (!c.count) continue;
      const rx = c.cx >> shift, ry = c.cy >> shift, rz = c.cz >> shift;
      const key = `${rx},${ry},${rz}`;
      if (this.renderChunks.has(key)) continue;
      const x0 = rx * R, y0 = ry * R, z0 = rz * R;
      this.renderChunks.set(key, {
        key, rx, ry, rz, x0, y0, z0, y1: y0 + R - 1,
        center: [x0 + R / 2 - this.origin[0], y0 + R / 2 - this.origin[1], z0 + R / 2 - this.origin[2]],
      });
    }
    this.renderChunkList = [...this.renderChunks.values()];
    // Unfiltered mesh per render chunk, shared by every view.
    this.full = new Map();

    this.scratch = new Uint16Array(P * P * P);
    this.outOpaque = new FloatOut();
    this.outTransparent = new FloatOut();
  }

  get chunkCount() {
    return this.renderChunkList.length;
  }

  getTemplate(p, mask) {
    const info = this.info[p];
    let t = info.templates[mask];
    if (t) return t;
    const cull = {
      up: !!(mask & UP), down: !!(mask & DOWN),
      west: !!(mask & WEST), east: !!(mask & EAST),
      north: !!(mask & NORTH), south: !!(mask & SOUTH),
    };
    const mesh = new Mesh();
    try {
      const name = info.state.getName();
      const props = info.state.getProperties();
      const def = this.resources.getBlockDefinition(name);
      if (def) mesh.merge(def.getMesh(name, props, this.resources, this.resources, cull));
      const special = SpecialRenderers.getBlockMesh(info.state, undefined, this.resources, cull);
      if (!special.isEmpty()) mesh.merge(special);
    } catch (e) {
      const key = info.state.toString();
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.error(`Error rendering block ${key}`, e);
      }
    }
    t = meshToTemplate(mesh, info.transparent);
    info.templates[mask] = t;
    return t;
  }

  // Whether the face of block p towards neighbor q is hidden (same rules
  // as deepslate's ChunkBuilder.needsCull).
  culls(pi, q, up) {
    if (!q) return false;
    const qi = this.info[q];
    if (qi.nameId === pi.nameId && qi.selfCull) return true;
    if (qi.opaque) return !(up && pi.waterlogged);
    return pi.waterlogged && qi.waterlogged;
  }

  // Copies the render chunk plus a one-block border, limited to Y in
  // [lo, hi], into the padded scratch grid.
  fillScratch(rc, lo, hi) {
    const s = this.scratch;
    s.fill(0);
    const { x0, y0, z0 } = rc;
    const yMin = Math.max(y0 - 1, lo), yMax = Math.min(y0 + R, hi);
    if (yMin > yMax) return false;
    const chunks = this.builder.chunks;
    const C = 1 << CHUNK_BITS, CM = C - 1;
    let any = false;
    for (let cy = yMin >> CHUNK_BITS; cy <= yMax >> CHUNK_BITS; cy++) {
      for (let cz = (z0 - 1) >> CHUNK_BITS; cz <= (z0 + R) >> CHUNK_BITS; cz++) {
        for (let cx = (x0 - 1) >> CHUNK_BITS; cx <= (x0 + R) >> CHUNK_BITS; cx++) {
          const chunk = chunks.get(`${cx},${cy},${cz}`);
          if (!chunk || !chunk.count) continue;
          any = true;
          const data = chunk.data;
          const wy0 = Math.max(yMin, cy * C), wy1 = Math.min(yMax, cy * C + CM);
          const wz0 = Math.max(z0 - 1, cz * C), wz1 = Math.min(z0 + R, cz * C + CM);
          const wx0 = Math.max(x0 - 1, cx * C), wx1 = Math.min(x0 + R, cx * C + CM);
          for (let wy = wy0; wy <= wy1; wy++) {
            for (let wz = wz0; wz <= wz1; wz++) {
              const src = ((wy & CM) << (2 * CHUNK_BITS)) | ((wz & CM) << CHUNK_BITS);
              const dst = ((wy - y0 + 1) * P + (wz - z0 + 1)) * P + 1 - x0;
              for (let wx = wx0; wx <= wx1; wx++) s[dst + wx] = data[src | (wx & CM)];
            }
          }
        }
      }
    }
    return any;
  }

  // Builds the GPU mesh of one render chunk with blocks limited to [lo, hi].
  buildChunk(rc, lo, hi) {
    const result = { opaque: [], transparent: [], quads: 0 };
    if (!this.fillScratch(rc, lo, hi)) return result;
    const s = this.scratch, info = this.info;
    const oo = this.outOpaque, ot = this.outTransparent;
    oo.reset(); ot.reset();
    const offX = rc.x0 - this.origin[0], offY = rc.y0 - this.origin[1], offZ = rc.z0 - this.origin[2];
    const lyMin = Math.max(0, lo - rc.y0), lyMax = Math.min(R - 1, hi - rc.y0);

    for (let ly = lyMin; ly <= lyMax; ly++) {
      for (let lz = 0; lz < R; lz++) {
        let i = ((ly + 1) * P + lz + 1) * P + 1;
        for (let lx = 0; lx < R; lx++, i++) {
          const p = s[i];
          if (!p) continue;
          const pi = info[p];
          let mask = 0;
          if (this.culls(pi, s[i + PP], true)) mask |= UP;
          if (this.culls(pi, s[i - PP], false)) mask |= DOWN;
          if (this.culls(pi, s[i - 1], false)) mask |= WEST;
          if (this.culls(pi, s[i + 1], false)) mask |= EAST;
          if (this.culls(pi, s[i - P], false)) mask |= NORTH;
          if (this.culls(pi, s[i + P], false)) mask |= SOUTH;
          const t = this.getTemplate(p, mask);
          if (!t.quads) continue;
          const out = t.transparent ? ot : oo;
          const n = t.quads * FPQ;
          out.reserve(n);
          const dst = out.data, src = t.data;
          let o = out.length;
          dst.set(src, o);
          const x = offX + lx, y = offY + ly, z = offZ + lz;
          for (let v = 0; v < n; v += FPV) {
            dst[o + v] += x; dst[o + v + 1] += y; dst[o + v + 2] += z;
          }
          out.length = o + n;
        }
      }
    }
    result.opaque = this.upload(oo);
    result.transparent = this.upload(ot);
    result.quads = (oo.length + ot.length) / FPQ;
    return result;
  }

  upload(out) {
    const pieces = [];
    const gl = this.gl;
    const totalQuads = out.length / FPQ;
    for (let q = 0; q < totalQuads; q += this.maxQuadsPerPiece) {
      const quads = Math.min(this.maxQuadsPerPiece, totalQuads - q);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, out.data.subarray(q * FPQ, (q + quads) * FPQ), gl.STATIC_DRAW);
      pieces.push({ vbo, quads });
      this.ensureIndexCapacity(quads);
    }
    return pieces;
  }

  ensureIndexCapacity(quads) {
    if (quads <= this.indexQuads) return;
    let cap = Math.max(1024, this.indexQuads);
    while (cap < quads) cap *= 2;
    cap = Math.min(cap, this.maxQuadsPerPiece);
    const idx = this.uintIndices ? new Uint32Array(cap * 6) : new Uint16Array(cap * 6);
    for (let i = 0, v = 0, o = 0; i < cap; i++, v += 4) {
      idx[o++] = v; idx[o++] = v + 1; idx[o++] = v + 2;
      idx[o++] = v; idx[o++] = v + 2; idx[o++] = v + 3;
    }
    const gl = this.gl;
    if (!this.indexBuffer) this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.indexQuads = cap;
  }

  freeMesh(m) {
    if (!m) return;
    for (const piece of m.opaque) this.gl.deleteBuffer(piece.vbo);
    for (const piece of m.transparent) this.gl.deleteBuffer(piece.vbo);
  }

  // Meshes to draw for `view`, building missing chunks within the time
  // budget (shared across calls in the same ~frame). Returns what is ready
  // plus how many chunks are still missing.
  collect(view, budgetMs) {
    const lo = view.lo, hi = view.hi, b = this.bounds;
    const loEff = lo <= b.minY ? -Infinity : lo;
    const hiEff = hi >= b.maxY ? Infinity : hi;
    const opaque = [], transparent = [], missing = [];
    let total = 0;

    for (const rc of this.renderChunkList) {
      if (rc.y1 < lo || rc.y0 > hi) continue;
      total++;
      const isFull = rc.y0 - 1 >= loEff && rc.y1 + 1 <= hiEff;
      const m = isFull ? this.full.get(rc.key) : view.partial.get(rc.key);
      if (m) { opaque.push(...m.opaque); transparent.push(...m.transparent); }
      else missing.push({ rc, isFull });
    }

    if (missing.length && budgetMs > 0) {
      const now = performance.now();
      if (now - this.budgetWindowStart > 16) { this.budgetWindowStart = now; this.budgetSpent = 0; }
      const allowed = budgetMs - this.budgetSpent;
      if (allowed > 0) {
        const [fx, fy, fz] = this.focus;
        const dist = ({ rc }) => (rc.center[0] - fx) ** 2 + (rc.center[1] - fy) ** 2 + (rc.center[2] - fz) ** 2;
        missing.sort((a, b2) => dist(a) - dist(b2));
        const start = performance.now();
        let built = 0;
        while (built < missing.length && performance.now() - start < allowed) {
          const { rc, isFull } = missing[built++];
          const m = isFull ? this.buildChunk(rc, -Infinity, Infinity) : this.buildChunk(rc, lo, hi);
          if (isFull) { this.full.set(rc.key, m); this.totalQuads += m.quads; }
          else view.partial.set(rc.key, m);
          opaque.push(...m.opaque);
          transparent.push(...m.transparent);
        }
        this.budgetSpent += performance.now() - start;
        missing.splice(0, built);
      }
    }
    return { opaque, transparent, missing: missing.length, total };
  }

  // Draws a list of pieces with the renderer's active (block) shader.
  drawPieces(renderer, pieces) {
    if (!pieces.length || !this.indexBuffer) return;
    const gl = this.gl;
    const program = renderer.activeShader;
    let locs = this.attribLocations.get(program);
    if (!locs) {
      locs = ['vertPos', 'vertColor', 'texCoord', 'texLimit', 'normal'].map(n => gl.getAttribLocation(program, n));
      this.attribLocations.set(program, locs);
    }
    const [lPos, lColor, lTex, lLimit, lNormal] = locs;
    const type = this.uintIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    for (const l of locs) if (l >= 0) gl.enableVertexAttribArray(l);
    for (const { vbo, quads } of pieces) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      if (lPos >= 0) gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, STRIDE, 0);
      if (lColor >= 0) gl.vertexAttribPointer(lColor, 3, gl.FLOAT, false, STRIDE, 12);
      if (lTex >= 0) gl.vertexAttribPointer(lTex, 2, gl.FLOAT, false, STRIDE, 24);
      if (lLimit >= 0) gl.vertexAttribPointer(lLimit, 4, gl.FLOAT, false, STRIDE, 32);
      if (lNormal >= 0) gl.vertexAttribPointer(lNormal, 3, gl.FLOAT, false, STRIDE, 48);
      gl.drawElements(gl.TRIANGLES, quads * 6, type, 0);
    }
  }

  dispose() {
    for (const m of this.full.values()) this.freeMesh(m);
    this.full.clear();
    if (this.indexBuffer) this.gl.deleteBuffer(this.indexBuffer);
    this.indexBuffer = null;
    this.indexQuads = 0;
  }
}

// A Y-filtered way of looking at a mesher's structure (main view, layer-mode
// ghost, ...). Chunks the filter doesn't cut come from the shared full mesh.
export class MeshView {
  constructor(mesher) {
    this.mesher = mesher;
    this.lo = -Infinity;
    this.hi = Infinity;
    this.partial = new Map();
  }

  setYRange(lo, hi) {
    if (lo === this.lo && hi === this.hi) return;
    this.lo = lo;
    this.hi = hi;
    this.clearPartial();
  }

  clearPartial() {
    for (const m of this.partial.values()) this.mesher.freeMesh(m);
    this.partial.clear();
  }

  dispose() {
    this.clearPartial();
  }
}

// deepslate StructureRenderer (grid, shaders, atlas texture, prepareDraw...)
// with its block meshing replaced by ChunkMesher. Coordinates are local to
// the structure's minimum corner, as before.
export class FastStructureRenderer extends StructureRenderer {
  constructor(gl, builder, resources, { budgetMs = 14 } = {}) {
    // An empty Structure of the right size: deepslate only uses it for the
    // grid, so its own ChunkBuilder has nothing to do.
    super(gl, new Structure(builder.getSize()), resources, { useInvisibleBlockBuffer: false, chunkSize: 16 });
    this.mesher = new ChunkMesher(gl, builder, resources);
    this.mainView = new MeshView(this.mesher);
    this.views = [this.mainView];
    this.budgetMs = budgetMs;
    this.lastStats = { missing: 0, total: 0 };
  }

  createView() {
    const view = new MeshView(this.mesher);
    this.views.push(view);
    return view;
  }

  setFocus(center) {
    this.mesher.focus = center;
  }

  // Draws `view` (the main view by default). Returns { missing, total }
  // render chunks, so the caller can keep redrawing until missing is 0.
  drawStructure(viewMatrix, view = this.mainView) {
    this.setShader(this.shaderProgram);
    this.setTexture(this.atlasTexture, this.resources.getPixelSize?.());
    this.prepareDraw(viewMatrix);
    const res = this.mesher.collect(view, this.budgetMs);
    this.mesher.drawPieces(this, res.opaque);
    this.mesher.drawPieces(this, res.transparent);
    this.lastStats = res;
    return res;
  }

  // Builds every chunk the main view needs, yielding between slices.
  async buildAll(onProgress) {
    for (;;) {
      this.mesher.budgetWindowStart = 0;
      const { missing, total } = this.mesher.collect(this.mainView, 30);
      onProgress?.(total - missing, total);
      if (!missing) return;
      await new Promise(r => setTimeout(r, 0));
    }
  }

  dispose() {
    for (const v of this.views) v.dispose();
    this.mesher.dispose();
  }
}
