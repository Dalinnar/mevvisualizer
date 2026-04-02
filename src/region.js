// Unpacks packed block state indices from raw region data
export function unpackBlockStates(regionData, paletteSize, width, height, depth) {
  const nbits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const mask = (1 << nbits) - 1;
  const totalBlocks = width * height * depth;
  const blockIds = new Uint16Array(totalBlocks); // <-- only change
  const y_shift = Math.abs(width * depth);
  const z_shift = Math.abs(width);
  let idx = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const index = y * y_shift + z * z_shift + x;
        const start_offset = index * nbits;
        const start_arr_index = start_offset >>> 5;
        const end_arr_index = ((index + 1) * nbits - 1) >>> 5;
        const start_bit_offset = start_offset & 31;
        const half_ind = start_arr_index >>> 1;

        let blockStart, blockEnd;
        if ((start_arr_index & 1) === 0) {
          blockStart = regionData[half_ind]?.[1] ?? 0;
          blockEnd   = regionData[half_ind]?.[0] ?? 0;
        } else {
          blockStart = regionData[half_ind]?.[0] ?? 0;
          blockEnd   = regionData[half_ind + 1]?.[1] ?? 0;
        }

        let value;
        if (start_arr_index === end_arr_index) {
          value = (blockStart >>> start_bit_offset) & mask;
        } else {
          const end_offset = 32 - start_bit_offset;
          value = ((blockStart >>> start_bit_offset) | (blockEnd << end_offset)) & mask;
        }
        blockIds[idx++] = value;
      }
    }
  }
  return blockIds;
}

// Parses a Litematica region NBT tag into structured block data
export function create3DBlocks(region) {
  const size = region.get("Size");
  const sx = Number(size.get("x").value ?? size.get("x"));
  const sy = Number(size.get("y").value ?? size.get("y"));
  const sz = Number(size.get("z").value ?? size.get("z"));

  const width = Math.abs(sx);
  const height = Math.abs(sy);
  const depth = Math.abs(sz);

  const pos = region.get("Position");
  const posX = Number(pos.get("x").value ?? pos.get("x"));
  const posY = Number(pos.get("y").value ?? pos.get("y"));
  const posZ = Number(pos.get("z").value ?? pos.get("z"));

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
        props[key] = (val && typeof val === 'object') ? (val.value ?? val.toString()) : String(val);
      }
    }
    palette.push({ Name: name, Properties: Object.keys(props).length ? props : null });
  }

  const raw = region.get("BlockStates");
  const regionData = [];
  if (raw) {
    for (let i = 0; i < raw.length; i++) {
      const entry = raw.get(i);
      let val = entry.value ?? entry;
      if (typeof val === "string" && val.includes(",")) {
        const parts = val.split(",").map(v => Number(v.trim()));
        regionData.push(parts);
      } else if (Array.isArray(val)) {
        regionData.push(val);
      } else {
        regionData.push([Number(val), 0]);
      }
    }
  }

  const blockIds = unpackBlockStates(regionData, palette.length, width, height, depth);

  function localToWorld(lx, ly, lz) {
    const ox = sx >= 0 ? lx : lx + sx + 1;
    const oy = sy >= 0 ? ly : ly + sy + 1;
    const oz = sz >= 0 ? lz : lz + sz + 1;
    return [posX + ox, posY + oy, posZ + oz];
  }

  return { blockIds, palette, width, height, depth, localToWorld };
}
