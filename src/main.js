import { InteractiveCanvas } from './camera.js';
import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader } from './resources.js';
import { StructureBuilder } from './structure.js';
import { DoubleRangeSlider } from './slider.js';
const { StructureRenderer } = deepslate;
import { validateStackingStructure, stackMiddle } from './validate.js';

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

// ── NEW: query param helper ────────────────────────────────────────────────
function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// ── NEW: fetch with fallback ───────────────────────────────────────────────
async function fetchExternalFile(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Direct fetch failed');
    return await res.arrayBuffer();
  } catch (err) {
    console.warn('Direct fetch failed, trying AllOrigins...', err);

    try {
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error('AllOrigins fetch failed');
      return await res.arrayBuffer();
    } catch (err2) {
      console.error('AllOrigins also failed:', err2);
      return null;
    }
  }
}

async function init() {
  const blockData = await loadBlockData();
  const resourceLoader = new ResourceLoader();
  let showGrid = true;

  const canvas = document.getElementById('structure-display');
  const gl = canvas.getContext('webgl');
  const progressDisplay = document.getElementById('progress-display') || createProgressDisplay();

  await resourceLoader.load(blockData, ({ stage, percent }) => {
    progressDisplay.textContent = `${stage} ${percent}%`;
  });
  progressDisplay.style.display = 'none';

  const resources = resourceLoader.getResources();

  let currentStructure = null, currentRenderer = null, currentCamera = null,
    currentBuilder = null, slider = null, originalBuffer = null, lastStackedNbt = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getEnclosing = (root) => {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  };

  function rebuildWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    currentStructure = currentBuilder.buildStructure(minY, maxY);
    if (currentRenderer) {
      currentRenderer.setStructure(currentStructure);
      currentCamera?.redraw();
    }
  }

  function downloadLitematic(nbtFile, filename = 'stacked.litematic') {
    try {
      nbtFile.compression = 'gzip';
      const data = nbtFile.write();
      const blob = new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: filename }).click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert("Failed to export litematic.");
    }
  }

  async function buildAndRender(builder, regions, w, h, d) {
    const regionNames = Array.from(regions.keys());
    for (let i = 0; i < regionNames.length; i++) {
      progressDisplay.textContent = `Processing region ${i + 1}/${regionNames.length}...`;
      await new Promise(resolve => setTimeout(resolve, 0));
      const regionData = create3DBlocks(regions.get(regionNames[i]));
      builder.addRegionBlocks(regionNames[i], regionData);
      if (regionData.blockIds?.length > 100000) regionData.blockIds = null;
    }

    progressDisplay.textContent = 'Building structure...';
    const structure = builder.buildStructure();
    const renderer = new StructureRenderer(gl, structure, resources, {
      useInvisibleBlockBuffer: false, chunkSize: 16
    });

    const bounds = builder.getActualBounds();
    const center = ['x', 'y', 'z'].map(k => (bounds[`min${k.toUpperCase()}`] + bounds[`max${k.toUpperCase()}`]) / 2);

    currentCamera?.destroy();
    currentBuilder = builder;
    currentStructure = structure;
    currentRenderer = renderer;

    currentCamera = new InteractiveCanvas(canvas, view => {
      renderer.drawStructure(view);
      if (showGrid) renderer.drawGrid(view);
    }, center);

    if (!slider) {
      slider = new DoubleRangeSlider('slider-container', {
        min: Math.floor(bounds.minY),
        max: Math.floor(bounds.maxY),
        currentMin: Math.floor(bounds.minY),
        currentMax: Math.floor(bounds.maxY),
        onChange: (minY, maxY) => rebuildWithYRange(minY, maxY)
      });
    } else {
      slider.setRange(Math.floor(bounds.minY), Math.floor(bounds.maxY));
    }

    document.getElementById('slider-container').classList.add('active');
    renderer.setStructure(structure);
    progressDisplay.style.display = 'none';
  }

  // ── Main render ────────────────────────────────────────────────────────────
  async function renderStructure(nbt, stackSize = null, gap = 0) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = stackSize ? 'Stacking...' : 'Loading structure...';

    let root = nbt.root || nbt;
    lastStackedNbt = null;

    if (stackSize) {
      const stacked = stackMiddle(nbt, stackSize, gap);
      lastStackedNbt = stacked;
      root = stacked.root;
    }

    const { w, h, d } = getEnclosing(root);
    if (stackSize) {
      document.getElementById('enclosing-size-display').textContent = `Size: ${w} x ${h} x ${d}`;
    }

    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, root.get("Regions"), w, h, d);
  }

  // ── NEW: shared buffer handler ─────────────────────────────────────────────
  async function handleArrayBuffer(buffer) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Parsing NBT...';

    originalBuffer = buffer;

    const nbt = deepslate.NbtFile.read(new Uint8Array(buffer));
    const validation = validateStackingStructure(nbt);

    if (validation.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      const hasMultipleClusters = validation.details.clusterCount > 1;
      document.getElementById('gap-controls').style.display = hasMultipleClusters ? '' : 'none';

      await renderStructure(deepslate.NbtFile.read(new Uint8Array(buffer)), 1, 0);
    } else {
      document.getElementById('stack-controls').style.display = 'none';
      await renderStructure(nbt);
    }
  }

  // ── Shared rerender ────────────────────────────────────────────────────────
  const rerender = async () => {
    if (!originalBuffer) return;
    const stackSize = Math.max(1, parseInt(document.getElementById('stack-count').value) || 1);
    const gap = Math.max(0, parseInt(document.getElementById('cluster-gap').value) || 0);
    await renderStructure(deepslate.NbtFile.read(new Uint8Array(originalBuffer)), stackSize, gap);
  };

  // ── Events ────────────────────────────────────────────────────────────────
  document.getElementById('stack-count').addEventListener('change', rerender);
  document.getElementById('cluster-gap').addEventListener('change', rerender);

  document.getElementById('clear-button').addEventListener('click', () => {
    currentCamera?.destroy();
    gl?.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    originalBuffer = lastStackedNbt = null;
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
    document.getElementById('stack-controls').style.display = 'none';
    document.getElementById('gap-controls').style.display = 'none';
    document.getElementById('stack-count').value = 1;
    document.getElementById('cluster-gap').value = 0;
  });

  document.getElementById('download-materials').addEventListener('click', () => {
    if (!currentBuilder) return alert("No structure loaded!");
    const blob = new Blob([currentBuilder.generateMaterialsCSV()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: 'materials_list.csv' }).click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('toggle-grid').addEventListener('change', (e) => {
    showGrid = e.target.checked;
    currentCamera?.redraw();
  });

  document.getElementById('download-litematic').addEventListener('click', () => {
    if (!lastStackedNbt) return alert("No stacked structure to download!");
    const stackSize = document.getElementById('stack-count').value || 1;
    const gap = document.getElementById('cluster-gap').value || 0;
    downloadLitematic(lastStackedNbt, `stacked_${stackSize}x_gap${gap}.litematic`);
  });

  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Reading file...';

    const buffer = await file.arrayBuffer();
    await handleArrayBuffer(buffer);
  });

  // ── NEW: auto-load from ?ext_link ──────────────────────────────────────────
  const extLink = getQueryParam('ext_link');

  if (extLink) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Loading external file...';

    const buffer = await fetchExternalFile(extLink);

    if (!buffer) {
      progressDisplay.style.display = 'none';
      alert('Unable to load the file from URL. Please drag & drop it manually.');
      return;
    }

    await handleArrayBuffer(buffer);
  }
}

init();