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

function closeMenu() {
  const btn = document.getElementById('burger-menu-btn');
  const panel = document.getElementById('controls-panel');
  const mainContent = document.getElementById('main-content');
  btn.classList.remove('open');
  panel.classList.remove('open');
  mainContent.classList.remove('menu-open');
}


async function init() {
  const blockData = await loadBlockData();
  const resourceLoader = new ResourceLoader();

  const canvas = document.getElementById('structure-display');
  const gl = canvas.getContext('webgl');
  const progressDisplay = document.getElementById('progress-display') || createProgressDisplay();

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
  let originalBuffer = null;

  // ⭐ NEW: keep last stacked NBT
  let lastStackedNbt = null;

  function rebuildWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    currentStructure = currentBuilder.buildStructure(minY, maxY);
    if (currentRenderer) {
      currentRenderer.setStructure(currentStructure);
      if (currentCamera) currentCamera.redraw();
    }
  }

  // ⭐ NEW: download function
  function downloadLitematic(nbtFile, filename = 'stacked.litematic') {
    try {
      const raw = nbtFile.write(); // Uint8Array
      const gzipped = pako.gzip(raw);

      const blob = new Blob([gzipped], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();

      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert("Failed to export litematic.");
    }
  }

  async function renderNbt(nbt, stackSize) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Stacking...';

    const stacked = stackMiddle(nbt, stackSize);

    // ⭐ store it for download
    lastStackedNbt = stacked;

    const metadata = stacked.root.get("Metadata");
    const enclosing = metadata.get("EnclosingSize");

    const totalW = Math.abs(Number(enclosing.get("x").value ?? enclosing.get("x")));
    const totalH = Math.abs(Number(enclosing.get("y").value ?? enclosing.get("y")));
    const totalD = Math.abs(Number(enclosing.get("z").value ?? enclosing.get("z")));

    const regions = stacked.root.get("Regions");
    const regionNames = Array.from(regions.keys());
    const builder = new StructureBuilder(totalW, totalH, totalD);

    for (let i = 0; i < regionNames.length; i++) {
      progressDisplay.textContent = `Processing region ${i + 1}/${regionNames.length}...`;
      await new Promise(resolve => setTimeout(resolve, 0));

      const region = regions.get(regionNames[i]);
      const regionData = create3DBlocks(region);
      builder.addRegionBlocks(regionNames[i], regionData);

      if (regionData.blockIds && regionData.blockIds.length > 100000) {
        regionData.blockIds = null;
      }
    }

    progressDisplay.textContent = 'Building structure...';
    const structure = builder.buildStructure();

    const renderer = new StructureRenderer(gl, structure, resources, {
      useInvisibleBlockBuffer: false,
      chunkSize: 16
    });

    const bounds = builder.getActualBounds();
    const center = [
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2
    ];

    if (currentCamera) currentCamera.destroy();

    currentBuilder = builder;
    currentStructure = structure;
    currentRenderer = renderer;

    currentCamera = new InteractiveCanvas(canvas, view => renderer.drawStructure(view), center);

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

  document.getElementById('clear-button').addEventListener('click', () => {
    if (currentCamera) currentCamera.destroy();
    if (gl) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    originalBuffer = null;
    lastStackedNbt = null;

    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
    document.getElementById('stack-controls').style.display = 'none';
    document.getElementById('stack-count').value = 1;

    closeMenu();
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

  // ⭐ NEW: download litematic button
  document.getElementById('download-litematic').addEventListener('click', () => {
    if (!lastStackedNbt) return alert("No structure loaded!");

    const stackSize = document.getElementById('stack-count').value || 1;
    const filename = `stacked_${stackSize}x.litematic`;

    downloadLitematic(lastStackedNbt, filename);
  });

  document.getElementById('stack-count').addEventListener('change', async e => {
    if (!originalBuffer) return;

    const stackSize = Math.max(1, parseInt(e.target.value) || 1);
    const freshNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));

    await renderNbt(freshNbt, stackSize);
  });

  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Reading file...';
    closeMenu();

    originalBuffer = await file.arrayBuffer();

    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));

    const validation = validateStackingStructure(nbt);
    if (!validation.isValid) {
      progressDisplay.textContent = `Invalid structure: ${validation.errors.join('; ')}`;
      return;
    }

    document.getElementById('stack-controls').style.display = 'block';
    document.getElementById('stack-count').value = 1;

    const freshNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    await renderNbt(freshNbt, 1);
  });
}

init();