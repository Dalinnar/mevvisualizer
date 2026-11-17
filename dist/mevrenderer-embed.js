var mevrenderer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/embed.js
  var embed_exports = {};
  __export(embed_exports, {
    renderLitematicImage: () => renderLitematicImage,
    setBlocklistUrl: () => setBlocklistUrl
  });

  // src/region.js
  function readNumber(tag) {
    return Number(tag?.value ?? tag);
  }
  function readPackedWords(raw) {
    if (!raw) return new Int32Array(0);
    const n = raw.length;
    const words = new Int32Array(n * 2);
    const items = raw.items;
    for (let i = 0; i < n; i++) {
      const entry = items ? items[i] : raw.get(i);
      let pair = entry?.value ?? entry;
      if (typeof pair === "string" && pair.includes(",")) pair = pair.split(",").map((v) => Number(v.trim()));
      if (Array.isArray(pair)) {
        words[2 * i] = pair[1] | 0;
        words[2 * i + 1] = pair[0] | 0;
      } else {
        words[2 * i] = Number(pair) | 0;
      }
    }
    return words;
  }
  function bitsForPalette(paletteSize) {
    return Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
  }
  function readPackedId(words, nbits, mask, index) {
    const bit = index * nbits;
    const w = bit >>> 5;
    const off = bit & 31;
    let v = words[w] >>> off;
    if (off + nbits > 32) v |= words[w + 1] << 32 - off;
    return v & mask;
  }
  function create3DBlocks(region) {
    const size = region.get("Size");
    const sx = readNumber(size.get("x"));
    const sy = readNumber(size.get("y"));
    const sz = readNumber(size.get("z"));
    const width = Math.abs(sx);
    const height = Math.abs(sy);
    const depth = Math.abs(sz);
    const pos = region.get("Position");
    const posX = readNumber(pos.get("x"));
    const posY = readNumber(pos.get("y"));
    const posZ = readNumber(pos.get("z"));
    const paletteTag = region.get("BlockStatePalette");
    const palette = [];
    for (let i = 0; i < paletteTag.length; i++) {
      const p = paletteTag.get(i);
      const name = p.get("Name").value ?? p.get("Name");
      let props = {};
      const propsTag = p.get("Properties");
      if (propsTag) {
        for (const key of propsTag.keys()) {
          const val = propsTag.get(key);
          props[key] = val && typeof val === "object" ? val.value ?? val.toString() : String(val);
        }
      }
      palette.push({ Name: name, Properties: Object.keys(props).length ? props : null });
    }
    const words = readPackedWords(region.get("BlockStates"));
    const nbits = bitsForPalette(palette.length);
    const originX = posX + (sx >= 0 ? 0 : sx + 1);
    const originY = posY + (sy >= 0 ? 0 : sy + 1);
    const originZ = posZ + (sz >= 0 ? 0 : sz + 1);
    function localToWorld(lx, ly, lz) {
      return [originX + lx, originY + ly, originZ + lz];
    }
    return { palette, width, height, depth, words, nbits, origin: [originX, originY, originZ], localToWorld };
  }

  // src/resources.js
  var import_meta = {};
  var {
    BlockDefinition,
    BlockModel,
    Identifier,
    TextureAtlas,
    upperPowerOfTwo
  } = deepslate;
  var MCMETA = "https://raw.githubusercontent.com/misode/mcmeta/";
  var blocklistUrl;
  try {
    blocklistUrl = new URL("./blocklist.json", import_meta.url).toString();
  } catch {
    blocklistUrl = null;
  }
  function setBlocklistUrl(url) {
    blocklistUrl = url;
  }
  function normalizeName(name) {
    if (typeof name === "object" && name !== null) {
      if ("path" in name) name = name.path;
      else name = "";
    }
    if (typeof name !== "string") return "";
    if (name.startsWith("minecraft:")) name = name.slice("minecraft:".length);
    return name.toLowerCase().replace(/\s+/g, "_");
  }
  async function loadBlockData() {
    if (!blocklistUrl) {
      throw new Error(
        "resources.js couldn't resolve blocklist.json's URL automatically (this happens when this module has been bundled into a non-ESM script format). Call setBlocklistUrl(absoluteUrl) before loadBlockData()/renderLitematicImage() runs."
      );
    }
    const res = await fetch(blocklistUrl);
    return await res.json();
  }
  function isAnimatedTexture(u, v, du, dv) {
    return dv > du * 2;
  }
  function getFirstFrameUV(u, v, du, dv, size) {
    if (isAnimatedTexture(u, v, du, dv)) {
      return [u / size, v / size, (u + du) / size, (v + du) / size];
    }
    return [u / size, v / size, (u + du) / size, (v + dv) / size];
  }
  var ResourceLoader = class {
    constructor() {
      this.blockDefinitions = null;
      this.blockModels = null;
      this.textureAtlas = null;
      this.blockMap = null;
      this.loading = false;
      this.animatedTextures = /* @__PURE__ */ new Set();
    }
    async load(blockData, onProgress) {
      if (this.loading) return;
      this.loading = true;
      try {
        onProgress?.({ stage: "Fetching block states...", percent: 10 });
        const blockstates = await fetch(`${MCMETA}summary/assets/block_definition/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Fetching models...", percent: 25 });
        const models = await fetch(`${MCMETA}summary/assets/model/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Fetching UV map...", percent: 40 });
        const uvMap = await fetch(`${MCMETA}atlas/all/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Loading texture atlas...", percent: 55 });
        const atlas = await new Promise((res) => {
          const img = new Image();
          img.onload = () => res(img);
          img.crossOrigin = "Anonymous";
          img.src = `${MCMETA}atlas/all/atlas.png`;
        });
        onProgress?.({ stage: "Processing block definitions...", percent: 65 });
        this.blockDefinitions = {};
        Object.keys(blockstates).forEach((id) => {
          this.blockDefinitions["minecraft:" + id] = BlockDefinition.fromJson(blockstates[id]);
        });
        onProgress?.({ stage: "Processing block models...", percent: 75 });
        this.blockModels = {};
        Object.keys(models).forEach((id) => {
          const model = models[id];
          if (model.textures) {
            for (const key in model.textures) {
              const tex = model.textures[key];
              if (typeof tex === "object" && tex.sprite) model.textures[key] = tex.sprite;
              else if (typeof tex !== "string") model.textures[key] = "#missing";
            }
          }
          this.blockModels["minecraft:" + id] = BlockModel.fromJson(model);
        });
        Object.values(this.blockModels).forEach((m) => m.flatten({ getBlockModel: (id) => this.blockModels[id] }));
        onProgress?.({ stage: "Building texture atlas...", percent: 85 });
        const atlasCanvas = document.createElement("canvas");
        const size = upperPowerOfTwo(Math.max(atlas.width, atlas.height));
        atlasCanvas.width = size;
        atlasCanvas.height = size;
        const ctx = atlasCanvas.getContext("2d");
        ctx.drawImage(atlas, 0, 0);
        const atlasData = ctx.getImageData(0, 0, size, size);
        const idMap = {};
        Object.keys(uvMap).forEach((id) => {
          const [u, v, du, dv] = uvMap[id];
          if (isAnimatedTexture(u, v, du, dv)) {
            this.animatedTextures.add(id);
          }
          const [u1, v1, u2, v2] = getFirstFrameUV(u, v, du, dv, size);
          idMap[Identifier.create(id).toString()] = [u1, v1, u2, v2];
        });
        this.textureAtlas = new TextureAtlas(atlasData, idMap);
        this.blockMap = {};
        blockData.forEach((block) => {
          const mainName = normalizeName(block.block);
          this.blockMap[mainName] = block;
          if (block.variants) {
            if (Array.isArray(block.variants)) {
              block.variants.forEach((v) => this.blockMap[normalizeName(v)] = block);
            } else {
              this.blockMap[normalizeName(block.variants)] = block;
            }
          }
        });
        onProgress?.({ stage: "Resources ready!", percent: 100 });
      } catch (err) {
        console.error("Resource loading failed:", err);
        throw err;
      }
    }
    getResources() {
      return {
        getBlockDefinition: (id) => this.blockDefinitions[id.toString()],
        getBlockModel: (id) => this.blockModels[id.toString()],
        getTextureUV: (id) => this.textureAtlas.getTextureUV(id),
        getTextureAtlas: () => this.textureAtlas.getTextureAtlas(),
        getPixelSize: () => this.textureAtlas.getPixelSize(),
        getBlockFlags: (name) => this.getBlockFlags(name),
        getBlockProperties: () => null,
        getDefaultBlockProperties: () => null
      };
    }
    getBlockFlags(name) {
      if (!name) return { opaque: false, semi_transparent: false, self_culling: false };
      const norm = normalizeName(name);
      const block = this.blockMap[norm];
      if (!block) return { opaque: false, semi_transparent: false, self_culling: false };
      const isGlass = norm.includes("glass");
      const opaque = !isGlass && block.full_cube === "Yes" && !block.transparent;
      const semi_transparent = isGlass || !opaque && block.transparent;
      const self_culling = opaque || isGlass;
      return { opaque, semi_transparent, self_culling };
    }
    isTextureAnimated(textureId) {
      return this.animatedTextures.has(textureId);
    }
  };

  // src/structure.js
  var CHUNK_BITS = 4;
  var CHUNK = 1 << CHUNK_BITS;
  var CHUNK_MASK = CHUNK - 1;
  var CHUNK_VOLUME = CHUNK * CHUNK * CHUNK;
  var chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`;
  var StructureBuilder = class {
    constructor(totalW, totalH, totalD) {
      this.totalW = totalW;
      this.totalH = totalH;
      this.totalD = totalD;
      this.palette = [null];
      this.paletteIndex = /* @__PURE__ */ new Map();
      this.paletteCounts = [0];
      this.chunks = /* @__PURE__ */ new Map();
      this.blockTotal = 0;
      this.minX = Infinity;
      this.maxX = -Infinity;
      this.minY = Infinity;
      this.maxY = -Infinity;
      this.minZ = Infinity;
      this.maxZ = -Infinity;
      this.regionBounds = {};
    }
    // Global palette index for a block state (registers it on first use).
    internState(entry) {
      const props = entry.Properties;
      const key = props ? entry.Name + "[" + Object.keys(props).sort().map((k) => `${k}=${props[k]}`).join(",") + "]" : entry.Name;
      let idx = this.paletteIndex.get(key);
      if (idx === void 0) {
        idx = this.palette.length;
        if (idx > 65535) throw new Error("Too many distinct block states (over 65535) in this schematic");
        this.palette.push({ Name: entry.Name, Properties: props || null });
        this.paletteCounts.push(0);
        this.paletteIndex.set(key, idx);
      }
      return idx;
    }
    getChunk(cx, cy, cz, create = false) {
      const key = chunkKey(cx, cy, cz);
      let chunk = this.chunks.get(key);
      if (!chunk && create) {
        chunk = { cx, cy, cz, key, data: new Uint16Array(CHUNK_VOLUME), count: 0 };
        this.chunks.set(key, chunk);
      }
      return chunk;
    }
    // Palette index at a world position (0 = empty).
    getBlock(wx, wy, wz) {
      const chunk = this.chunks.get(chunkKey(wx >> CHUNK_BITS, wy >> CHUNK_BITS, wz >> CHUNK_BITS));
      if (!chunk) return 0;
      return chunk.data[(wy & CHUNK_MASK) << 2 * CHUNK_BITS | (wz & CHUNK_MASK) << CHUNK_BITS | wx & CHUNK_MASK];
    }
    // Adds a region synchronously.
    addRegionBlocks(regionName, region) {
      for (const _ of this.addRegionBlocksSteps(regionName, region)) {
      }
    }
    // Same as addRegionBlocks, but yields after every Y layer so a caller can
    // spread a huge region over several tasks and keep the page responsive.
    // Yields the fraction of the region done (0..1).
    *addRegionBlocksSteps(regionName, { palette, width, height, depth, words, nbits, origin }) {
      if (width > 0 && height > 0 && depth > 0) {
        this.regionBounds[regionName] = {
          minX: origin[0],
          maxX: origin[0] + width - 1,
          minY: origin[1],
          maxY: origin[1] + height - 1,
          minZ: origin[2],
          maxZ: origin[2] + depth - 1
        };
      }
      const map = new Uint16Array(palette.length);
      for (let i = 0; i < palette.length; i++) {
        const e = palette[i];
        map[i] = e && e.Name !== "minecraft:air" ? this.internState(e) : 0;
      }
      const mask = (1 << nbits) - 1;
      const counts = this.paletteCounts;
      const [ox, oy, oz] = origin;
      let index = 0;
      for (let ly = 0; ly < height; ly++) {
        const wy = oy + ly;
        const cy = wy >> CHUNK_BITS, yOff = (wy & CHUNK_MASK) << 2 * CHUNK_BITS;
        let layerHasBlocks = false;
        for (let lz = 0; lz < depth; lz++) {
          const wz = oz + lz;
          const cz = wz >> CHUNK_BITS, yzOff = yOff | (wz & CHUNK_MASK) << CHUNK_BITS;
          let chunk = null, chunkCx = NaN;
          for (let lx = 0; lx < width; lx++, index++) {
            const p = map[readPackedId(words, nbits, mask, index)];
            if (p === 0) continue;
            const wx = ox + lx;
            const cx = wx >> CHUNK_BITS;
            if (cx !== chunkCx) {
              chunk = this.getChunk(cx, cy, cz, true);
              chunkCx = cx;
            }
            const i = yzOff | wx & CHUNK_MASK;
            const prev = chunk.data[i];
            if (prev) counts[prev]--;
            else {
              chunk.count++;
              this.blockTotal++;
            }
            chunk.data[i] = p;
            counts[p]++;
            if (wx < this.minX) this.minX = wx;
            if (wx > this.maxX) this.maxX = wx;
            if (wz < this.minZ) this.minZ = wz;
            if (wz > this.maxZ) this.maxZ = wz;
            layerHasBlocks = true;
          }
        }
        if (layerHasBlocks) {
          if (wy < this.minY) this.minY = wy;
          if (wy > this.maxY) this.maxY = wy;
        }
        yield (ly + 1) / height;
      }
    }
    get blockCount() {
      return this.blockTotal;
    }
    // Count per block name (kept for generateMaterialsCSV / older callers).
    get blockCounts() {
      const out = {};
      for (let p = 1; p < this.palette.length; p++) {
        if (this.paletteCounts[p] > 0) out[this.palette[p].Name] = (out[this.palette[p].Name] || 0) + this.paletteCounts[p];
      }
      return out;
    }
    // [[{ Name, Properties }, count], ...] for every block state present.
    getPaletteCounts() {
      const out = [];
      for (let p = 1; p < this.palette.length; p++) {
        if (this.paletteCounts[p] > 0) out.push([this.palette[p], this.paletteCounts[p]]);
      }
      return out;
    }
    // Same as getPaletteCounts(), restricted to one world Y layer.
    getLayerCounts(y) {
      const cy = y >> CHUNK_BITS, yOff = (y & CHUNK_MASK) << 2 * CHUNK_BITS;
      const counts = /* @__PURE__ */ new Map();
      for (const chunk of this.chunks.values()) {
        if (chunk.cy !== cy) continue;
        const data = chunk.data;
        for (let i = yOff, end = yOff + CHUNK * CHUNK; i < end; i++) {
          const p = data[i];
          if (p) counts.set(p, (counts.get(p) || 0) + 1);
        }
      }
      return [...counts].map(([p, n]) => [this.palette[p], n]);
    }
    // Returns each region's bounding box translated into the same local
    // coordinate space the renderer uses (relative to the overall
    // structure's minimum corner), so a box drawn at these coords lines up
    // exactly with the rendered structure.
    getRegionBoundsLocal() {
      const bounds = this.getActualBounds();
      const local = {};
      for (const [name, rb] of Object.entries(this.regionBounds)) {
        local[name] = {
          min: [rb.minX - bounds.minX, rb.minY - bounds.minY, rb.minZ - bounds.minZ],
          max: [rb.maxX - bounds.minX, rb.maxY - bounds.minY, rb.maxZ - bounds.minZ]
        };
      }
      return local;
    }
    getActualBounds() {
      if (this.blockTotal === 0) {
        return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
      }
      return {
        minX: this.minX,
        maxX: this.maxX,
        minY: this.minY,
        maxY: this.maxY,
        minZ: this.minZ,
        maxZ: this.maxZ
      };
    }
    // Size of the structure in blocks, from the actual bounds.
    getSize() {
      const b = this.getActualBounds();
      return [b.maxX - b.minX + 1, b.maxY - b.minY + 1, b.maxZ - b.minZ + 1];
    }
    generateMaterialsCSV() {
      let csv = "Block Name,Count\n";
      for (const [name, count] of Object.entries(this.blockCounts)) {
        csv += `${name},${count}
`;
      }
      return csv;
    }
  };

  // src/chunkMesher.js
  var { Mesh, BlockState, SpecialRenderers, Structure, StructureRenderer } = deepslate;
  var R_BITS = 5;
  var R = 1 << R_BITS;
  var P = R + 2;
  var PP = P * P;
  var FPV = 15;
  var FPQ = FPV * 4;
  var STRIDE = FPV * 4;
  var UP = 1;
  var DOWN = 2;
  var WEST = 4;
  var EAST = 8;
  var NORTH = 16;
  var SOUTH = 32;
  var EMPTY_TEMPLATE = { quads: 0, data: null, transparent: false };
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
        data[o++] = v.pos.x;
        data[o++] = v.pos.y;
        data[o++] = v.pos.z;
        data[o++] = c[0];
        data[o++] = c[1];
        data[o++] = c[2];
        data[o++] = t[0];
        data[o++] = t[1];
        data[o++] = l[0];
        data[o++] = l[1];
        data[o++] = l[2];
        data[o++] = l[3];
        data[o++] = nx;
        data[o++] = ny;
        data[o++] = nz;
      }
    }
    return { quads: quads.length, data, transparent };
  }
  var FloatOut = class {
    constructor() {
      this.data = new Float32Array(FPQ * 4096);
      this.length = 0;
    }
    reset() {
      this.length = 0;
    }
    reserve(n) {
      if (this.length + n <= this.data.length) return;
      let size = this.data.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Float32Array(size);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
  };
  var ChunkMesher = class {
    constructor(gl, builder, resources) {
      this.gl = gl;
      this.builder = builder;
      this.resources = resources;
      this.bounds = builder.getActualBounds();
      this.origin = [this.bounds.minX, this.bounds.minY, this.bounds.minZ];
      this.uintIndices = !!gl.getExtension("OES_element_index_uint");
      this.maxQuadsPerPiece = this.uintIndices ? 1 << 20 : 16383;
      this.indexBuffer = null;
      this.indexQuads = 0;
      this.attribLocations = /* @__PURE__ */ new Map();
      this.focus = [0, 0, 0];
      this.budgetWindowStart = 0;
      this.budgetSpent = 0;
      this.warned = /* @__PURE__ */ new Set();
      this.totalQuads = 0;
      const nameIds = /* @__PURE__ */ new Map();
      this.info = builder.palette.map((entry) => {
        if (!entry) return null;
        const state = new BlockState(entry.Name, { ...entry.Properties || {} });
        const flags = resources.getBlockFlags(state.getName()) || {};
        let nameId = nameIds.get(entry.Name);
        if (nameId === void 0) {
          nameId = nameIds.size;
          nameIds.set(entry.Name, nameId);
        }
        return {
          state,
          nameId,
          opaque: !!flags.opaque,
          selfCull: !!flags.self_culling,
          transparent: !!flags.semi_transparent,
          waterlogged: state.isWaterlogged(),
          templates: new Array(64)
        };
      });
      const shift = R_BITS - CHUNK_BITS;
      this.renderChunks = /* @__PURE__ */ new Map();
      for (const c of builder.chunks.values()) {
        if (!c.count) continue;
        const rx = c.cx >> shift, ry = c.cy >> shift, rz = c.cz >> shift;
        const key = `${rx},${ry},${rz}`;
        if (this.renderChunks.has(key)) continue;
        const x0 = rx * R, y0 = ry * R, z0 = rz * R;
        this.renderChunks.set(key, {
          key,
          rx,
          ry,
          rz,
          x0,
          y0,
          z0,
          y1: y0 + R - 1,
          center: [x0 + R / 2 - this.origin[0], y0 + R / 2 - this.origin[1], z0 + R / 2 - this.origin[2]]
        });
      }
      this.renderChunkList = [...this.renderChunks.values()];
      this.full = /* @__PURE__ */ new Map();
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
        up: !!(mask & UP),
        down: !!(mask & DOWN),
        west: !!(mask & WEST),
        east: !!(mask & EAST),
        north: !!(mask & NORTH),
        south: !!(mask & SOUTH)
      };
      const mesh = new Mesh();
      try {
        const name = info.state.getName();
        const props = info.state.getProperties();
        const def = this.resources.getBlockDefinition(name);
        if (def) mesh.merge(def.getMesh(name, props, this.resources, this.resources, cull));
        const special = SpecialRenderers.getBlockMesh(info.state, void 0, this.resources, cull);
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
        for (let cz = z0 - 1 >> CHUNK_BITS; cz <= z0 + R >> CHUNK_BITS; cz++) {
          for (let cx = x0 - 1 >> CHUNK_BITS; cx <= x0 + R >> CHUNK_BITS; cx++) {
            const chunk = chunks.get(`${cx},${cy},${cz}`);
            if (!chunk || !chunk.count) continue;
            any = true;
            const data = chunk.data;
            const wy0 = Math.max(yMin, cy * C), wy1 = Math.min(yMax, cy * C + CM);
            const wz0 = Math.max(z0 - 1, cz * C), wz1 = Math.min(z0 + R, cz * C + CM);
            const wx0 = Math.max(x0 - 1, cx * C), wx1 = Math.min(x0 + R, cx * C + CM);
            for (let wy = wy0; wy <= wy1; wy++) {
              for (let wz = wz0; wz <= wz1; wz++) {
                const src = (wy & CM) << 2 * CHUNK_BITS | (wz & CM) << CHUNK_BITS;
                const dst = ((wy - y0 + 1) * P + (wz - z0 + 1)) * P + 1 - x0;
                for (let wx = wx0; wx <= wx1; wx++) s[dst + wx] = data[src | wx & CM];
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
      oo.reset();
      ot.reset();
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
              dst[o + v] += x;
              dst[o + v + 1] += y;
              dst[o + v + 2] += z;
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
        idx[o++] = v;
        idx[o++] = v + 1;
        idx[o++] = v + 2;
        idx[o++] = v;
        idx[o++] = v + 2;
        idx[o++] = v + 3;
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
        if (m) {
          opaque.push(...m.opaque);
          transparent.push(...m.transparent);
        } else missing.push({ rc, isFull });
      }
      if (missing.length && budgetMs > 0) {
        const now = performance.now();
        if (now - this.budgetWindowStart > 16) {
          this.budgetWindowStart = now;
          this.budgetSpent = 0;
        }
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
            if (isFull) {
              this.full.set(rc.key, m);
              this.totalQuads += m.quads;
            } else view.partial.set(rc.key, m);
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
        locs = ["vertPos", "vertColor", "texCoord", "texLimit", "normal"].map((n) => gl.getAttribLocation(program, n));
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
  };
  var MeshView = class {
    constructor(mesher) {
      this.mesher = mesher;
      this.lo = -Infinity;
      this.hi = Infinity;
      this.partial = /* @__PURE__ */ new Map();
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
  };
  var FastStructureRenderer = class extends StructureRenderer {
    constructor(gl, builder, resources, { budgetMs = 14 } = {}) {
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
      for (; ; ) {
        this.mesher.budgetWindowStart = 0;
        const { missing, total } = this.mesher.collect(this.mainView, 30);
        onProgress?.(total - missing, total);
        if (!missing) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    dispose() {
      for (const v of this.views) v.dispose();
      this.mesher.dispose();
    }
  };

  // src/embed.js
  if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
    setBlocklistUrl(new URL("./blocklist.json", document.currentScript.src).toString());
  }
  var { mat4, vec3 } = glMatrix;
  var resourcesPromise = null;
  function getSharedResources(onProgress) {
    if (!resourcesPromise) {
      resourcesPromise = (async () => {
        const blockData = await loadBlockData();
        const loader = new ResourceLoader();
        await loader.load(blockData, onProgress);
        return loader.getResources();
      })();
    }
    return resourcesPromise;
  }
  function getEnclosing(root) {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = (k) => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  }
  function localBox(bounds) {
    return [
      bounds.maxX - bounds.minX + 1,
      bounds.maxY - bounds.minY + 1,
      bounds.maxZ - bounds.minZ + 1
    ];
  }
  function projectedHalfExtents(size, xRotation, yRotation) {
    const rot = mat4.create();
    mat4.rotate(rot, rot, xRotation, [1, 0, 0]);
    mat4.rotate(rot, rot, yRotation, [0, 1, 0]);
    let hx = 0, hy = 0, hz = 0;
    const v = vec3.create();
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
      vec3.transformMat4(v, [sx * size[0], sy * size[1], sz * size[2]], rot);
      hx = Math.max(hx, Math.abs(v[0]));
      hy = Math.max(hy, Math.abs(v[1]));
      hz = Math.max(hz, Math.abs(v[2]));
    }
    return { hx, hy, hz };
  }
  function computeFitViewDist(radius, width, height, marginFactor) {
    if (radius <= 0 || !Number.isFinite(radius)) return 4;
    const aspect = width / height;
    const vFov = 70 * Math.PI / 180;
    const hFov = 2 * Math.atan(aspect * Math.tan(vFov / 2));
    const limitingHalfAngle = Math.min(vFov, hFov) / 2;
    return Math.max(radius / Math.sin(limitingHalfAngle) * marginFactor, 2);
  }
  function buildViewMatrix(center, viewDist, xRotation, yRotation) {
    const view = mat4.create();
    mat4.translate(view, view, [0, 0, -viewDist]);
    mat4.rotate(view, view, xRotation, [1, 0, 0]);
    mat4.rotate(view, view, yRotation, [0, 1, 0]);
    mat4.translate(view, view, [-center[0], -center[1], -center[2]]);
    return view;
  }
  function parseCssColor(css) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    const normalized = ctx.fillStyle;
    const hex = normalized.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    const rgb = normalized.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
      const [r, g, b] = rgb[1].split(",").map((v) => parseFloat(v) / 255);
      return [r, g, b];
    }
    return [0.1, 0.1, 0.1];
  }
  async function renderLitematicImage(options = {}) {
    const {
      url,
      buffer,
      width = 800,
      height = 600,
      projection = "orthographic",
      xRotation = Math.atan(1 / Math.SQRT2),
      yRotation = -Math.PI / 4,
      padding = 0.06,
      background = "#1a1a1a",
      asBlob = false,
      onProgress = null
    } = options;
    if (!url && !buffer) {
      throw new Error("renderLitematicImage: pass either `url` or `buffer`");
    }
    const [arrayBuffer, resources] = await Promise.all([
      buffer ?? fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch litematic: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      getSharedResources(onProgress)
    ]);
    const nbt = deepslate.NbtFile.read(new Uint8Array(arrayBuffer));
    const root = nbt.root ?? nbt;
    const { w, h, d } = getEnclosing(root);
    const builder = new StructureBuilder(w, h, d);
    const regions = root.get("Regions");
    for (const name of regions.keys()) {
      let sliceStart = performance.now();
      for (const _ of builder.addRegionBlocksSteps(name, create3DBlocks(regions.get(name)))) {
        if (performance.now() - sliceStart > 30) {
          await new Promise((r) => setTimeout(r, 0));
          sliceStart = performance.now();
        }
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "-100000px";
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    document.body.appendChild(canvas);
    try {
      const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL is not available in this browser");
      gl.viewport(0, 0, width, height);
      if (background === null) {
        gl.clearColor(0, 0, 0, 0);
      } else {
        const [r, g, b] = parseCssColor(background);
        gl.clearColor(r, g, b, 1);
      }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const renderer = new FastStructureRenderer(gl, builder, resources);
      const size = localBox(builder.getActualBounds());
      const center = size.map((v) => v / 2);
      const radius = 0.5 * Math.hypot(...size);
      const aspect = width / height;
      const margin = 1 / Math.max(0.05, 1 - 2 * padding);
      let view;
      if (projection === "perspective") {
        const viewDist = computeFitViewDist(radius, width, height, margin);
        view = buildViewMatrix(center, viewDist, xRotation, yRotation);
        const far = Math.max(500, viewDist + radius * 2 + 50);
        renderer.projMatrix = mat4.perspective(mat4.create(), 70 * Math.PI / 180, aspect, Math.max(0.1, far / 5e4), far);
      } else {
        const { hx, hy, hz } = projectedHalfExtents(size, xRotation, yRotation);
        const halfH = Math.max(hy, hx / aspect, 0.5) * margin;
        const halfW = halfH * aspect;
        const viewDist = hz + 10;
        view = buildViewMatrix(center, viewDist, xRotation, yRotation);
        renderer.projMatrix = mat4.ortho(mat4.create(), -halfW, halfW, -halfH, halfH, 0.1, viewDist + hz + 10);
      }
      try {
        renderer.setFocus(center);
        await renderer.buildAll();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        renderer.drawStructure(view);
      } finally {
        renderer.dispose();
      }
      return await new Promise((resolve, reject) => {
        if (asBlob) {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("canvas.toBlob failed")), "image/png");
        } else {
          resolve(canvas.toDataURL("image/png"));
        }
      });
    } finally {
      canvas.remove();
    }
  }
  return __toCommonJS(embed_exports);
})();
