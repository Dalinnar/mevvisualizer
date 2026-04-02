const { Structure } = deepslate;

export class StructureBuilder {
  constructor(totalW, totalH, totalD) {
    this.totalW = totalW;
    this.totalH = totalH;
    this.totalD = totalD;
    this.placedBlocks = [];
    this.blockCounts = {};
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
    const structure = new Structure([this.totalW, this.totalH, this.totalD]);
    for (const { wx, wy, wz, entry } of this.placedBlocks) {
      if (wy >= filterMinY && wy <= filterMaxY) {
        structure.addBlock([wx, wy, wz], entry.Name, entry.Properties || {});
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