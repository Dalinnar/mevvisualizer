const { Structure } = deepslate;

export class StructureBuilder {
  constructor(totalW, totalH, totalD) {
    this.totalW = totalW;
    this.totalH = totalH;
    this.totalD = totalD;
    this.placedBlocks = [];
    this.blockCounts = {};
    // World-space bounding box of each region, keyed by region name. Recorded
    // from the region's full extent (not just its non-air blocks) so a
    // region outline can still be drawn even for mostly/entirely-air regions.
    this.regionBounds = {};
  }

  addRegionBlocks(regionName, { blockIds, palette, width, height, depth, localToWorld }) {
    let idx = 0;
    for (let ly = 0; ly < height; ly++) {
      for (let lz = 0; lz < depth; lz++) {
        for (let lx = 0; lx < width; lx++) {
          const paletteId = blockIds[idx++];
          const blockEntry = palette[paletteId];

          if (blockEntry && blockEntry.Name !== 'minecraft:air') {
            const [wx, wy, wz] = localToWorld(lx, ly, lz);
            this.placedBlocks.push({ wx, wy, wz, entry: blockEntry });
            this.blockCounts[blockEntry.Name] = (this.blockCounts[blockEntry.Name] || 0) + 1;
          }
        }
      }
    }

    if (width > 0 && height > 0 && depth > 0) {
      const c1 = localToWorld(0, 0, 0);
      const c2 = localToWorld(width - 1, height - 1, depth - 1);
      this.regionBounds[regionName] = {
        minX: Math.min(c1[0], c2[0]), maxX: Math.max(c1[0], c2[0]),
        minY: Math.min(c1[1], c2[1]), maxY: Math.max(c1[1], c2[1]),
        minZ: Math.min(c1[2], c2[2]), maxZ: Math.max(c1[2], c2[2]),
      };
    }
  }

  // Returns each region's bounding box translated into the same local
  // coordinate space that buildStructure() uses (relative to the overall
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
    if (this.placedBlocks.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const { wx, wy, wz } of this.placedBlocks) {
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }

    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  buildStructure(filterMinY = -Infinity, filterMaxY = Infinity) {
    const bounds = this.getActualBounds();

    const width = bounds.maxX - bounds.minX + 1;
    const height = bounds.maxY - bounds.minY + 1;
    const depth = bounds.maxZ - bounds.minZ + 1;

    const structure = new Structure([width, height, depth]);

    for (const { wx, wy, wz, entry } of this.placedBlocks) {
      if (wy >= filterMinY && wy <= filterMaxY) {

        const lx = wx - bounds.minX;
        const ly = wy - bounds.minY;
        const lz = wz - bounds.minZ;

        structure.addBlock([lx, ly, lz], entry.Name, entry.Properties || {});
      }
    }
    return structure;
  }

  generateMaterialsCSV() {
    let csv = "Block Name,Count\n";
    for (const [name, count] of Object.entries(this.blockCounts)) {
      csv += `${name},${count}\n`;
    }
    return csv;
  }
}