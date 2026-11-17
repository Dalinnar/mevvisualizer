import { readPackedId } from './region.js';

// Storage chunk edge (blocks). Must be a power of two.
export const CHUNK_BITS = 4;
export const CHUNK = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK - 1;
const CHUNK_VOLUME = CHUNK * CHUNK * CHUNK;

const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

// Holds every placed block of a litematic in a compact form so that very
// large schematics fit in memory:
//  - one global palette of block states ({ Name, Properties }), index 0 = empty
//  - sparse 16x16x16 chunks of Uint16 palette indices, keyed by world chunk
//  - bounds and per-state counts maintained while blocks are added
// Rendering reads the chunks directly (see chunkMesher.js), so no per-block
// JS objects are ever created.
export class StructureBuilder {
  constructor(totalW, totalH, totalD) {
    this.totalW = totalW;
    this.totalH = totalH;
    this.totalD = totalD;
    this.palette = [null];
    this.paletteIndex = new Map();
    this.paletteCounts = [0];
    this.chunks = new Map();
    this.blockTotal = 0;
    this.minX = Infinity; this.maxX = -Infinity;
    this.minY = Infinity; this.maxY = -Infinity;
    this.minZ = Infinity; this.maxZ = -Infinity;
    // World-space bounding box of each region, keyed by region name. Recorded
    // from the region's full extent (not just its non-air blocks) so a
    // region outline can still be drawn even for mostly/entirely-air regions.
    this.regionBounds = {};
  }

  // Global palette index for a block state (registers it on first use).
  internState(entry) {
    const props = entry.Properties;
    const key = props
      ? entry.Name + '[' + Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',') + ']'
      : entry.Name;
    let idx = this.paletteIndex.get(key);
    if (idx === undefined) {
      idx = this.palette.length;
      if (idx > 0xffff) throw new Error('Too many distinct block states (over 65535) in this schematic');
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
    return chunk.data[((wy & CHUNK_MASK) << (2 * CHUNK_BITS)) | ((wz & CHUNK_MASK) << CHUNK_BITS) | (wx & CHUNK_MASK)];
  }

  // Adds a region synchronously.
  addRegionBlocks(regionName, region) {
    for (const _ of this.addRegionBlocksSteps(regionName, region)) { /* drain */ }
  }

  // Same as addRegionBlocks, but yields after every Y layer so a caller can
  // spread a huge region over several tasks and keep the page responsive.
  // Yields the fraction of the region done (0..1).
  *addRegionBlocksSteps(regionName, { palette, width, height, depth, words, nbits, origin }) {
    if (width > 0 && height > 0 && depth > 0) {
      this.regionBounds[regionName] = {
        minX: origin[0], maxX: origin[0] + width - 1,
        minY: origin[1], maxY: origin[1] + height - 1,
        minZ: origin[2], maxZ: origin[2] + depth - 1,
      };
    }

    // Region palette -> global palette (0 for air / unknown entries).
    const map = new Uint16Array(palette.length);
    for (let i = 0; i < palette.length; i++) {
      const e = palette[i];
      map[i] = e && e.Name !== 'minecraft:air' ? this.internState(e) : 0;
    }

    const mask = (1 << nbits) - 1;
    const counts = this.paletteCounts;
    const [ox, oy, oz] = origin;
    let index = 0;
    for (let ly = 0; ly < height; ly++) {
      const wy = oy + ly;
      const cy = wy >> CHUNK_BITS, yOff = (wy & CHUNK_MASK) << (2 * CHUNK_BITS);
      let layerHasBlocks = false;
      for (let lz = 0; lz < depth; lz++) {
        const wz = oz + lz;
        const cz = wz >> CHUNK_BITS, yzOff = yOff | ((wz & CHUNK_MASK) << CHUNK_BITS);
        let chunk = null, chunkCx = NaN;
        for (let lx = 0; lx < width; lx++, index++) {
          const p = map[readPackedId(words, nbits, mask, index)];
          if (p === 0) continue;
          const wx = ox + lx;
          const cx = wx >> CHUNK_BITS;
          if (cx !== chunkCx) { chunk = this.getChunk(cx, cy, cz, true); chunkCx = cx; }
          const i = yzOff | (wx & CHUNK_MASK);
          const prev = chunk.data[i];
          if (prev) counts[prev]--; else { chunk.count++; this.blockTotal++; }
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
    const cy = y >> CHUNK_BITS, yOff = (y & CHUNK_MASK) << (2 * CHUNK_BITS);
    const counts = new Map();
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
        max: [rb.maxX - bounds.minX, rb.maxY - bounds.minY, rb.maxZ - bounds.minZ],
      };
    }
    return local;
  }

  getActualBounds() {
    if (this.blockTotal === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    }
    return {
      minX: this.minX, maxX: this.maxX,
      minY: this.minY, maxY: this.maxY,
      minZ: this.minZ, maxZ: this.maxZ,
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
      csv += `${name},${count}\n`;
    }
    return csv;
  }
}
