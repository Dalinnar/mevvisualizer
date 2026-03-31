const { mat4 } = glMatrix
const {
  BlockDefinition,
  BlockModel,
  Identifier,
  Structure,
  StructureRenderer,
  TextureAtlas,
  upperPowerOfTwo
} = deepslate

// ================= CAMERA =================
class InteractiveCanvas {
  constructor(canvas, onRender, center = null, viewDist = 4) {
    this.xRotation = 0.8
    this.yRotation = 0.5
    this.onRender = onRender
    this.center = center
    this.viewDist = viewDist
    let dragPos = null

    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) dragPos = [e.clientX, e.clientY]
    })

    canvas.addEventListener('mousemove', e => {
      if (dragPos) {
        this.yRotation += (e.clientX - dragPos[0]) / 100
        this.xRotation += (e.clientY - dragPos[1]) / 100
        dragPos = [e.clientX, e.clientY]
        this.redraw()
      }
    })

    canvas.addEventListener('mouseup', () => dragPos = null)

    canvas.addEventListener('wheel', e => {
      e.preventDefault()
      this.viewDist += e.deltaY / 100
      this.redraw()
    })

    this.redraw()
  }

  redraw() {
    requestAnimationFrame(() => this.render())
  }

  render() {
    this.yRotation %= Math.PI * 2
    this.xRotation = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.xRotation))
    this.viewDist = Math.max(1, this.viewDist)

    const view = mat4.create()
    mat4.translate(view, view, [0, 0, -this.viewDist])
    mat4.rotate(view, view, this.xRotation, [1, 0, 0])
    mat4.rotate(view, view, this.yRotation, [0, 1, 0])

    if (this.center) {
      mat4.translate(view, view, [-this.center[0], -this.center[1], -this.center[2]])
    }
    this.onRender(view)
  }
}

// ================= UNPACK =================
function unpackBlockStates(regionData, paletteSize, width, height, depth) {
  const nbits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const mask = (1 << nbits) - 1;
  const totalBlocks = width * height * depth;
  const blockIds = new Array(totalBlocks);
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
          blockEnd = regionData[half_ind]?.[0] ?? 0;
        } else {
          blockStart = regionData[half_ind]?.[0] ?? 0;
          blockEnd = regionData[half_ind + 1]?.[1] ?? 0;
        }

        let value;
        if (start_arr_index === end_arr_index) {
          value = (blockStart >>> start_bit_offset) & mask;
        } else {
          const end_offset = 32 - start_bit_offset;
          value = ((blockStart >>> start_bit_offset) & mask) | ((blockEnd << end_offset) & mask);
        }
        blockIds[idx++] = value;
      }
    }
  }
  return blockIds;
}

// ================= REGION =================
function create3DBlocks(region) {
  const size = region.get("Size");
  const width = Math.abs(Number(size.get("x").value ?? size.get("x")));
  const height = Math.abs(Number(size.get("y").value ?? size.get("y")));
  const depth = Math.abs(Number(size.get("z").value ?? size.get("z")));

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
  return { blockIds, palette, width, height, depth };
}

// ================= LOAD RESOURCES =================
const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta/'

async function loadBlockData() {
  const res = await fetch('./blocklist.json');
  return await res.json();
}

async function init() {
  const blockData = await loadBlockData(); // <-- await ensures loaded

  const [blockstates, models, uvMap, atlas] = await Promise.all([
    fetch(`${MCMETA}summary/assets/block_definition/data.min.json`).then(r => r.json()),
    fetch(`${MCMETA}summary/assets/model/data.min.json`).then(r => r.json()),
    fetch(`${MCMETA}atlas/all/data.min.json`).then(r => r.json()),
    new Promise(res => {
      const img = new Image()
      img.onload = () => res(img)
      img.crossOrigin = 'Anonymous'
      img.src = `${MCMETA}atlas/all/atlas.png`
    })
  ]);

  const blockDefinitions = {}
  Object.keys(blockstates).forEach(id => {
    blockDefinitions['minecraft:' + id] = BlockDefinition.fromJson(blockstates[id])
  })

  const blockModels = {}
  Object.keys(models).forEach(id => {
    const model = models[id];
    if (model.textures) {
      for (const key in model.textures) {
        const tex = model.textures[key];
        if (typeof tex === "object" && tex.sprite) {
          model.textures[key] = tex.sprite;
        } else if (typeof tex !== "string") {
          model.textures[key] = "#missing";
        }
      }
    }
    blockModels['minecraft:' + id] = BlockModel.fromJson(model);
  });

  Object.values(blockModels).forEach(m => m.flatten({ getBlockModel: id => blockModels[id] }))

  const atlasCanvas = document.createElement('canvas')
  const size = upperPowerOfTwo(Math.max(atlas.width, atlas.height))
  atlasCanvas.width = size
  atlasCanvas.height = size
  const ctx = atlasCanvas.getContext('2d')
  ctx.drawImage(atlas, 0, 0)
  const atlasData = ctx.getImageData(0, 0, size, size)

  const idMap = {}
  Object.keys(uvMap).forEach(id => {
    const [u, v, du, dv] = uvMap[id]
    idMap[Identifier.create(id).toString()] = [
      u / size, v / size, (u + du) / size, (v + dv) / size
    ]
  })

  const textureAtlas = new TextureAtlas(atlasData, idMap)

  // ================= BLOCK FLAG LOGIC =================
  function normalizeName(name) {
    if (typeof name === 'object' && name !== null) {
      if ('path' in name) name = name.path
      else name = ''
    }
    if (typeof name !== 'string') return ''
    if (name.startsWith('minecraft:')) name = name.slice('minecraft:'.length)
    return name.toLowerCase().replace(/\s+/g, '_')
  }

  const blockMap = {}
  blockData.forEach(block => {
    const mainName = normalizeName(block.block)
    blockMap[mainName] = block
    if (block.variants) {
      if (Array.isArray(block.variants)) {
        block.variants.forEach(v => blockMap[normalizeName(v)] = block)
      } else {
        blockMap[normalizeName(block.variants)] = block
      }
    }
  })

function getBlockFlags(name) {
  if (!name) {
    console.log(`[BlockFlags] Called with empty name, using defaults`);
    return { opaque: false, semi_transparent: false, self_culling: false };
  }

  const norm = normalizeName(name);
  const block = blockMap[norm];

  if (!block) {
    console.log(`[BlockFlags] No match for "${name}" (normalized: "${norm}"), using defaults`);
    return { opaque: false, semi_transparent: false, self_culling: false };
  }

  const opaque = block.full_cube === "Yes" && !block.transparent;
  const semi_transparent = !opaque && block.transparent;
  const self_culling = opaque || block.transparent;

  console.log(`[BlockFlags] Matched "${name}" (normalized: "${norm}"), flags:`, { opaque, semi_transparent, self_culling });

  return { opaque, semi_transparent, self_culling };
}

  const resources = {
    getBlockDefinition: id => blockDefinitions[id.toString()],
    getBlockModel: id => blockModels[id.toString()],
    getTextureUV: id => textureAtlas.getTextureUV(id),
    getTextureAtlas: () => textureAtlas.getTextureAtlas(),
    getPixelSize: () => textureAtlas.getPixelSize(),
    getBlockFlags,
    getBlockProperties: () => null,
    getDefaultBlockProperties: () => null,
  };

  const canvas = document.getElementById('structure-display')
  const gl = canvas.getContext('webgl')

  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return

    const buffer = await file.arrayBuffer()
    const nbt = deepslate.NbtFile.read(new Uint8Array(buffer))
    const regions = nbt.root.get("Regions")
    const region = regions.get(Array.from(regions.keys())[0])

    const { blockIds, palette, width, height, depth } = create3DBlocks(region)
    const structure = new Structure([width, height, depth])
    const renderer = new StructureRenderer(gl, structure, resources)
    const center = [width / 2, height / 2, depth / 2]

    new InteractiveCanvas(canvas, view => {
      renderer.drawStructure(view)
    }, center, Math.max(...center) * 3)

    let idx = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
          const paletteId = blockIds[idx++]
          const blockEntry = palette[paletteId]
          if (blockEntry && blockEntry.Name !== 'minecraft:air') {
            structure.addBlock(
              [x, y, z],
              blockEntry.Name,
              blockEntry.Properties || {}
            )
          }
        }
      }
    }
    renderer.setStructure(structure)
  })
}

init();