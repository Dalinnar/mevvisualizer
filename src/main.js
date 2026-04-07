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
  let lastStackedNbt = null;

  function rebuildWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    currentStructure = currentBuilder.buildStructure(minY, maxY);
    if (currentRenderer) {
      currentRenderer.setStructure(currentStructure);
      if (currentCamera) currentCamera.redraw();
    }
  }

  function downloadLitematic(nbtFile, filename = 'stacked.litematic') {
    try {
      nbtFile.compression = 'gzip';
      const data = nbtFile.write();
      const blob = new Blob([data], { type: 'application/octet-stream' });
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

  // ── Shared helper: build + render a StructureBuilder into the canvas ───────
  async function renderBuilder(builder) {
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

  // ── Shared helper: fill a StructureBuilder from an NBT regions map ─────────
  async function fillBuilder(builder, regions) {
    const regionNames = Array.from(regions.keys());
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
  }

  // ── Render a stackable structure (calls stackMiddle) ───────────────────────
  async function renderNbt(nbt, stackSize, gap = 0) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Stacking...';

    const stacked = stackMiddle(nbt, stackSize, gap);
    lastStackedNbt = stacked;

    const metadata = stacked.root.get("Metadata");
    const enclosing = metadata.get("EnclosingSize");

    const totalW = Math.abs(Number(enclosing.get("x").value ?? enclosing.get("x")));
    const totalH = Math.abs(Number(enclosing.get("y").value ?? enclosing.get("y")));
    const totalD = Math.abs(Number(enclosing.get("z").value ?? enclosing.get("z")));

    console.log("enclosing_size: ", totalD, totalH, totalW);
    document.getElementById('enclosing-size-display').textContent =
      `Size: ${totalW} x ${totalH} x ${totalD}`;

    const regions = stacked.root.get("Regions");
    const builder = new StructureBuilder(totalW, totalH, totalD);

    await fillBuilder(builder, regions);
    await renderBuilder(builder);
  }

  // ── Render a non-stackable structure as-is ─────────────────────────────────
  async function renderRaw(nbt) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Loading structure...';

    lastStackedNbt = null;

    const root = nbt.root || nbt;
    const metadata = root.get("Metadata");
    const enclosing = metadata.get("EnclosingSize");

    const totalW = Math.abs(Number(enclosing.get("x").value ?? enclosing.get("x")));
    const totalH = Math.abs(Number(enclosing.get("y").value ?? enclosing.get("y")));
    const totalD = Math.abs(Number(enclosing.get("z").value ?? enclosing.get("z")));

    const regions = root.get("Regions");
    const builder = new StructureBuilder(totalW, totalH, totalD);

    await fillBuilder(builder, regions);
    await renderBuilder(builder);
  }

  // ── Clear button ───────────────────────────────────────────────────────────
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
    document.getElementById('cluster-gap').value = 0;


  });

  // ── Download materials CSV ─────────────────────────────────────────────────
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

  // ── Download litematic ─────────────────────────────────────────────────────
  document.getElementById('download-litematic').addEventListener('click', () => {
    if (!lastStackedNbt) return alert("No stacked structure to download!");
    const stackSize = document.getElementById('stack-count').value || 1;
    const gap = document.getElementById('cluster-gap').value || 0;
    downloadLitematic(lastStackedNbt, `stacked_${stackSize}x_gap${gap}.litematic`);  // <-- gap in filename
  });
  // ── Stack count change ─────────────────────────────────────────────────────
  document.getElementById('stack-count').addEventListener('change', async e => {
    if (!originalBuffer) return;
    const stackSize = Math.max(1, parseInt(e.target.value) || 1);
    const gap = Math.max(0, parseInt(document.getElementById('cluster-gap').value) || 0);  // <-- read gap
    const freshNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    await renderNbt(freshNbt, stackSize, gap);
  });

  // ── Cluster gap change ─────────────────────────────────────────────────────
  document.getElementById('cluster-gap').addEventListener('change', async e => {
    if (!originalBuffer) return;
    const stackSize = Math.max(1, parseInt(document.getElementById('stack-count').value) || 1);
    const gap = Math.max(0, parseInt(e.target.value) || 0);
    const freshNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    await renderNbt(freshNbt, stackSize, gap);
  });

  // ── File input ─────────────────────────────────────────────────────────────
  document.getElementById('file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Reading file...';

    originalBuffer = await file.arrayBuffer();

    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));

    const validation = validateStackingStructure(nbt);

    if (validation.isValid) {
      // Stackable: show stack controls and render with stackMiddle
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      const freshNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
      await renderNbt(freshNbt, 1, 0);
    } else {
      // Not stackable: hide stack controls and render as-is
      document.getElementById('stack-controls').style.display = 'none';
      await renderRaw(nbt);
    }
  });
}

init();