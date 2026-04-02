const { mat4 } = glMatrix;
const {
  BlockDefinition,
  BlockModel,
  Identifier,
  Structure,
  StructureRenderer,
  TextureAtlas,
  upperPowerOfTwo
} = deepslate;

// ================= CAMERA =================
class InteractiveCanvas {
  constructor(canvas, onRender, center = null, viewDist = 4) {
    this.xRotation = 0.8;
    this.yRotation = 0.5;
    this.onRender = onRender;
    this.center = center;
    this.viewDist = viewDist;
    let dragPos = null;

    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) dragPos = [e.clientX, e.clientY];
    });

    canvas.addEventListener('mousemove', e => {
      if (dragPos) {
        this.yRotation += (e.clientX - dragPos[0]) / 100;
        this.xRotation += (e.clientY - dragPos[1]) / 100;
        dragPos = [e.clientX, e.clientY];
        this.redraw();
      }
    });

    canvas.addEventListener('mouseup', () => dragPos = null);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.viewDist += e.deltaY / 100;
      this.redraw();
    });

    this.redraw();
  }

  redraw() {
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.yRotation %= Math.PI * 2;
    this.xRotation = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.xRotation));
    this.viewDist = Math.max(1, this.viewDist);

    const view = mat4.create();
    mat4.translate(view, view, [0, 0, -this.viewDist]);
    mat4.rotate(view, view, this.xRotation, [1, 0, 0]);
    mat4.rotate(view, view, this.yRotation, [0, 1, 0]);

    if (this.center) {
      mat4.translate(view, view, [-this.center[0], -this.center[1], -this.center[2]]);
    }
    this.onRender(view);
  }
}

// ================= UNPACK =================
function unpackBlockStates(regionData, paletteSize, width, height, depth) {
  const nbits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const mask = (1 << nbits) - 1;
  const totalBlocks = width * height * depth;
  const blockIds = new Uint8Array(totalBlocks); // Use typed array for memory efficiency
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

// ================= LOAD RESOURCES =================
const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta/';

async function loadBlockData() {
  const res = await fetch('./blocklist.json');
  return await res.json();
}

// ===== PROGRESSIVE RESOURCE LOADER =====
class ResourceLoader {
  constructor() {
    this.blockDefinitions = null;
    this.blockModels = null;
    this.textureAtlas = null;
    this.blockMap = null;
    this.loading = false;
  }

  async load(blockData, onProgress) {
    if (this.loading) return;
    this.loading = true;

    try {
      onProgress?.({ stage: 'Fetching block states...', percent: 10 });
      const blockstates = await fetch(`${MCMETA}summary/assets/block_definition/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Fetching models...', percent: 25 });
      const models = await fetch(`${MCMETA}summary/assets/model/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Fetching UV map...', percent: 40 });
      const uvMap = await fetch(`${MCMETA}atlas/all/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Loading texture atlas...', percent: 55 });
      const atlas = await new Promise(res => {
        const img = new Image();
        img.onload = () => res(img);
        img.crossOrigin = 'Anonymous';
        img.src = `${MCMETA}atlas/all/atlas.png`;
      });

      onProgress?.({ stage: 'Processing block definitions...', percent: 65 });
      this.blockDefinitions = {};
      Object.keys(blockstates).forEach(id => {
        this.blockDefinitions['minecraft:' + id] = BlockDefinition.fromJson(blockstates[id]);
      });

      onProgress?.({ stage: 'Processing block models...', percent: 75 });
      this.blockModels = {};
      Object.keys(models).forEach(id => {
        const model = models[id];
        if (model.textures) {
          for (const key in model.textures) {
            const tex = model.textures[key];
            if (typeof tex === "object" && tex.sprite) model.textures[key] = tex.sprite;
            else if (typeof tex !== "string") model.textures[key] = "#missing";
          }
        }
        this.blockModels['minecraft:' + id] = BlockModel.fromJson(model);
      });

      Object.values(this.blockModels).forEach(m => m.flatten({ getBlockModel: id => this.blockModels[id] }));

      onProgress?.({ stage: 'Building texture atlas...', percent: 85 });
      const atlasCanvas = document.createElement('canvas');
      const size = upperPowerOfTwo(Math.max(atlas.width, atlas.height));
      atlasCanvas.width = size;
      atlasCanvas.height = size;
      const ctx = atlasCanvas.getContext('2d');
      ctx.drawImage(atlas, 0, 0);
      const atlasData = ctx.getImageData(0, 0, size, size);

      const idMap = {};
      Object.keys(uvMap).forEach(id => {
        const [u, v, du, dv] = uvMap[id];
        idMap[Identifier.create(id).toString()] = [u / size, v / size, (u + du) / size, (v + dv) / size];
      });

      this.textureAtlas = new TextureAtlas(atlasData, idMap);

      // Build block map
      this.blockMap = {};
      blockData.forEach(block => {
        const mainName = normalizeName(block.block);
        this.blockMap[mainName] = block;
        if (block.variants) {
          if (Array.isArray(block.variants)) {
            block.variants.forEach(v => this.blockMap[normalizeName(v)] = block);
          } else {
            this.blockMap[normalizeName(block.variants)] = block;
          }
        }
      });

      onProgress?.({ stage: 'Resources ready!', percent: 100 });
    } catch (err) {
      console.error('Resource loading failed:', err);
      throw err;
    }
  }

  getResources() {
    return {
      getBlockDefinition: id => this.blockDefinitions[id.toString()],
      getBlockModel: id => this.blockModels[id.toString()],
      getTextureUV: id => this.textureAtlas.getTextureUV(id),
      getTextureAtlas: () => this.textureAtlas.getTextureAtlas(),
      getPixelSize: () => this.textureAtlas.getPixelSize(),
      getBlockFlags: name => this.getBlockFlags(name),
      getBlockProperties: () => null,
      getDefaultBlockProperties: () => null
    };
  }

  getBlockFlags(name) {
    if (!name) return { opaque: false, semi_transparent: false, self_culling: false };
    const norm = normalizeName(name);
    const block = this.blockMap[norm];
    if (!block) return { opaque: false, semi_transparent: false, self_culling: false };
    const opaque = block.full_cube === "Yes" && !block.transparent;
    const semi_transparent = !opaque && block.transparent;
    const self_culling = opaque || block.transparent;
    return { opaque, semi_transparent, self_culling };
  }
}

function normalizeName(name) {
  if (typeof name === 'object' && name !== null) {
    if ('path' in name) name = name.path;
    else name = '';
  }
  if (typeof name !== 'string') return '';
  if (name.startsWith('minecraft:')) name = name.slice('minecraft:'.length);
  return name.toLowerCase().replace(/\s+/g, '_');
}

// ===== SEQUENTIAL REGION LOADER =====
class StructureBuilder {
  constructor(totalW, totalH, totalD) {
    this.totalW = totalW;
    this.totalH = totalH;
    this.totalD = totalD;
    this.placedBlocks = [];
    this.blockCounts = {};
  }

  addRegionBlocks(regionName, { blockIds, palette, width, height, depth, localToWorld }) {
    // Process region immediately without storing full data
    let idx = 0;
    for (let ly = 0; ly < height; ly++) {
      for (let lz = 0; lz < depth; lz++) {
        for (let lx = 0; lx < width; lx++) {
          const paletteId = blockIds[idx++];
          const blockEntry = palette[paletteId];

          if (blockEntry && blockEntry.Name !== 'minecraft:air') {
            const [wx, wy, wz] = localToWorld(lx, ly, lz);
            this.placedBlocks.push({ wx, wy, wz, entry: blockEntry });

            // Track for materials
            this.blockCounts[blockEntry.Name] = (this.blockCounts[blockEntry.Name] || 0) + 1;
          }
        }
      }
    }
    // Typed arrays are garbage collected after this function
  }

  buildStructure() {
    const structure = new Structure([this.totalW, this.totalH, this.totalD]);
    for (const { wx, wy, wz, entry } of this.placedBlocks) {
      structure.addBlock([wx, wy, wz], entry.Name, entry.Properties || {});
    }
    return structure;
  }

  generateMaterialsCSV(palette = null) {
    let csv = "Block Name,Count\n";
    Object.keys(this.blockCounts).forEach(name => {
      csv += `${name},${this.blockCounts[name]}\n`;
    });
    return csv;
  }
}


// ===== SLIDER COMPONENT =====
class DoubleRangeSlider {
  constructor(containerId, options) {
    this.container = document.getElementById(containerId);
    this.min = options.min;
    this.max = options.max;
    this.currentMin = options.currentMin;
    this.currentMax = options.currentMax;
    this.onChange = options.onChange;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div style="padding: 15px; background: #222; border-radius: 8px;">
        <label style="color: #ccc; display: block; margin-bottom: 10px;">
          Y-Range: <span id="y-range-display">${this.currentMin} - ${this.currentMax}</span>
        </label>
        <input type="range" id="slider-min" min="${this.min}" max="${this.max}" value="${this.currentMin}" style="width: 48%; margin-right: 2%;">
        <input type="range" id="slider-max" min="${this.min}" max="${this.max}" value="${this.currentMax}" style="width: 48%;">
      </div>
    `;

    const sliderMin = document.getElementById('slider-min');
    const sliderMax = document.getElementById('slider-max');
    const display = document.getElementById('y-range-display');

    const updateRange = () => {
      this.currentMin = Math.min(parseInt(sliderMin.value), parseInt(sliderMax.value));
      this.currentMax = Math.max(parseInt(sliderMin.value), parseInt(sliderMax.value));
      display.textContent = `${this.currentMin} - ${this.currentMax}`;
      this.onChange(this.currentMin, this.currentMax);
    };

    sliderMin.addEventListener('input', updateRange);
    sliderMax.addEventListener('input', updateRange);
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.currentMin = min;
    this.currentMax = max;
    this.render();
  }
}

// ===== MAIN INITIALIZATION =====
async function init() {
  const blockData = await loadBlockData();
  const resourceLoader = new ResourceLoader();

  const canvas = document.getElementById('structure-display');
  const gl = canvas.getContext('webgl');
  const progressDisplay = document.getElementById('progress-display') || createProgressDisplay();

  // Load resources with progress
  await resourceLoader.load(blockData, (info) => {
    progressDisplay.textContent = `${info.stage} ${info.percent}%`;
  });
  progressDisplay.style.display = 'none';

  const resources = resourceLoader.getResources();

  let currentStructure = null;
  let currentRenderer = null;
  let currentCamera = null;
  let currentBuilder = null;
  let slider = null;
  let minYFilter = 0;
  let maxYFilter = Infinity;

  function rebuildStructureWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    minYFilter = minY;
    maxYFilter = maxY;

    const filteredBlocks = currentBuilder.placedBlocks.filter(b => b.wy >= minY && b.wy <= maxY);
    const structure = new Structure([currentBuilder.totalW, currentBuilder.totalH, currentBuilder.totalD]);

    for (const { wx, wy, wz, entry } of filteredBlocks) {
      structure.addBlock([wx, wy, wz], entry.Name, entry.Properties || {});
    }

    currentStructure = structure;
    if (currentRenderer) {
      currentRenderer.setStructure(structure);
      if (currentCamera) currentCamera.redraw();
    }
  }

  document.getElementById('clear-button').addEventListener('click', () => {
    if (gl) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
  });

  document.getElementById('download-materials').addEventListener('click', () => {
    if (!currentBuilder) return alert("No structure loaded!");

    const csv = currentBuilder.generateMaterialsCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'materials_list.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Reading file...';

    const buffer = await file.arrayBuffer();
    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(buffer));

    const metadata = nbt.root.get("Metadata");
    const enclosing = metadata.get("EnclosingSize");
    const totalW = Math.abs(Number(enclosing.get("x").value ?? enclosing.get("x")));
    const totalH = Math.abs(Number(enclosing.get("y").value ?? enclosing.get("y")));
    const totalD = Math.abs(Number(enclosing.get("z").value ?? enclosing.get("z")));

    const regions = nbt.root.get("Regions");
    const regionNames = Array.from(regions.keys());
    const builder = new StructureBuilder(totalW, totalH, totalD);

    // Process regions sequentially
    for (let i = 0; i < regionNames.length; i++) {
      const regionName = regionNames[i];
      progressDisplay.textContent = `Processing region ${i + 1}/${regionNames.length}...`;

      // Yield to main thread
      await new Promise(resolve => setTimeout(resolve, 0));

      const region = regions.get(regionName);
      const regionData = create3DBlocks(region);
      builder.addRegionBlocks(regionName, regionData);

      // Explicitly clear unused references
      if (regionData.blockIds && regionData.blockIds.length > 100000) {
        // Hint to GC that this can be freed
        regionData.blockIds = null;
      }
    }

    progressDisplay.textContent = 'Building structure...';
    const structure = builder.buildStructure();

    currentBuilder = builder;
    currentStructure = structure;
    const renderer = new StructureRenderer(gl, structure, resources, {
      useInvisibleBlockBuffer: false,
      chunkSize: 16  // optional, can tune this too
    });
    const center = [totalW / 2, totalH / 2, totalD / 2];

    currentRenderer = renderer;

    currentCamera = new InteractiveCanvas(canvas, view => {
      renderer.drawStructure(view);
    }, center, Math.max(totalW, totalH, totalD) * 2.5);

    if (!slider) {
      slider = new DoubleRangeSlider('slider-container', {
        min: 0,
        max: totalH - 1,
        currentMin: 0,
        currentMax: totalH - 1,
        onChange: (minY, maxY) => rebuildStructureWithYRange(minY, maxY)
      });
    } else {
      slider.setRange(0, totalH - 1);
    }

    document.getElementById('slider-container').classList.add('active');
    renderer.setStructure(structure);
    progressDisplay.style.display = 'none';
  });
}

function createProgressDisplay() {
  const div = document.createElement('div');
  div.id = 'progress-display';
  div.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0,0,0,0.9);
    color: #0f0;
    padding: 20px 40px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 14px;
    z-index: 1000;
  `;
  document.body.appendChild(div);
  return div;
}

init();