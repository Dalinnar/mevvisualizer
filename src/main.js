import { InteractiveCanvas } from './camera.js';
import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader } from './resources.js';
import { StructureBuilder } from './structure.js';
import { DoubleRangeSlider } from './slider.js';

const { StructureRenderer } = deepslate;

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

  function rebuildWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    currentStructure = currentBuilder.buildStructure(minY, maxY);
    if (currentRenderer) {
      currentRenderer.setStructure(currentStructure);
      if (currentCamera) currentCamera.redraw();
    }
  }

  document.getElementById('clear-button').addEventListener('click', () => {
    if (currentCamera) currentCamera.destroy();
    if (gl) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
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

  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Reading file...';
    closeMenu();

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
  });


  // --- URL param loading ---
  async function loadFromUrl(url) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Fetching file...';
    closeMenu();

    let buffer;

    async function fetchArrayBuffer(fetchUrl) {
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.arrayBuffer();
    }

    try {
      try {
        buffer = await fetchArrayBuffer(url);
      } catch (directErr) {
        console.warn('Direct fetch failed, falling back to proxy...', directErr);
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        buffer = await fetchArrayBuffer(proxyUrl);
      }
    } catch (err) {
      progressDisplay.textContent = `Failed to fetch: ${err.message}`;
      setTimeout(() => { progressDisplay.style.display = 'none'; }, 4000);
      return;
    }

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

  // Check for ?ext_link= on load
  const params = new URLSearchParams(window.location.search);
  const extLink = params.get('ext_link');
  if (extLink) {
    loadFromUrl(extLink);
  }
}

init();