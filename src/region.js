// Reads one litematic region into a compact, streamable form.
//
// The packed BlockStates long array is copied once into a flat Int32Array of
// 32-bit words (low word first, so word 2k / 2k+1 = low / high half of long
// k). Block ids are then decoded on the fly by index, so a huge region never
// needs a per-cell id array (which for e.g. 1000x256x1000 would be 256 MB).

function readNumber(tag) {
  return Number(tag?.value ?? tag);
}

// Converts the NBT long array into the flat word array described above.
function readPackedWords(raw) {
  if (!raw) return new Int32Array(0);
  const n = raw.length;
  const words = new Int32Array(n * 2);
  const items = raw.items; // deepslate NbtLongArray keeps NbtLong items here
  for (let i = 0; i < n; i++) {
    const entry = items ? items[i] : raw.get(i);
    let pair = entry?.value ?? entry;
    if (typeof pair === 'string' && pair.includes(',')) pair = pair.split(',').map(v => Number(v.trim()));
    if (Array.isArray(pair)) {
      words[2 * i] = pair[1] | 0;     // low 32 bits
      words[2 * i + 1] = pair[0] | 0; // high 32 bits
    } else {
      words[2 * i] = Number(pair) | 0;
    }
  }
  return words;
}

export function bitsForPalette(paletteSize) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
}

// Palette index of cell `index` (y * w * d + z * w + x) in a packed word array.
export function readPackedId(words, nbits, mask, index) {
  const bit = index * nbits;
  const w = bit >>> 5;
  const off = bit & 31;
  let v = words[w] >>> off;
  if (off + nbits > 32) v |= words[w + 1] << (32 - off);
  return v & mask;
}

// Kept for compatibility: decodes a whole region into a typed id array.
// Prefer create3DBlocks(), which never materialises this array.
export function unpackBlockStates(regionData, paletteSize, width, height, depth) {
  const words = new Int32Array(regionData.length * 2);
  regionData.forEach((pair, i) => { words[2 * i] = pair[1] | 0; words[2 * i + 1] = pair[0] | 0; });
  const nbits = bitsForPalette(paletteSize);
  const mask = (1 << nbits) - 1;
  const total = width * height * depth;
  const ids = paletteSize <= 256 ? new Uint8Array(total) : paletteSize <= 65536 ? new Uint16Array(total) : new Uint32Array(total);
  for (let i = 0; i < total; i++) ids[i] = readPackedId(words, nbits, mask, i);
  return ids;
}

export function create3DBlocks(region) {
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
        props[key] = (val && typeof val === 'object') ? (val.value ?? val.toString()) : String(val);
      }
    }
    palette.push({ Name: name, Properties: Object.keys(props).length ? props : null });
  }

  const words = readPackedWords(region.get("BlockStates"));
  const nbits = bitsForPalette(palette.length);

  // World position of the region's local (0,0,0) corner; negative sizes
  // grow towards -axis from Position.
  const originX = posX + (sx >= 0 ? 0 : sx + 1);
  const originY = posY + (sy >= 0 ? 0 : sy + 1);
  const originZ = posZ + (sz >= 0 ? 0 : sz + 1);

  function localToWorld(lx, ly, lz) {
    return [originX + lx, originY + ly, originZ + lz];
  }

  return { palette, width, height, depth, words, nbits, origin: [originX, originY, originZ], localToWorld };
}
