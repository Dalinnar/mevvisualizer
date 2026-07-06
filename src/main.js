import { InteractiveCanvas } from './camera.js';
import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader } from './resources.js';
import { StructureBuilder } from './structure.js';
import { DoubleRangeSlider } from './slider.js';
const { StructureRenderer } = deepslate;
import { validateStackingStructure, stackMiddle, computeEnclosingSizeAtStack } from './validate.js';


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

function syncVersionInput(nbt) {
  const root = nbt.root ?? nbt;
  document.getElementById('version-override').value = root.get('Version').value;
  document.getElementById('version-controls').style.display = 'block';
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
    currentBuilder = null, slider = null, originalBuffer = null, lastStackedNbt = null,
    currentStrideAxis = null, currentClusterCount = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getEnclosing = (root) => {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  };

  // Renders "Size: n x n x n" with the axis that grows via stacking (strideAxis)
  // as an editable <input>, and — when the structure has more than one cluster,
  // so the "Cluster Gap" control actually does something — the parallel axis
  // (the free axis gap scales) as an editable <input> too. The remaining axis
  // (height, unaffected by either control) stays a plain, disabled number.
  function updateEnclosingSizeDisplay(w, h, d, strideAxis, clusterCount) {
    const container = document.getElementById('enclosing-size-display');
    const dims = { x: w, y: h, z: d };
    const order = ['x', 'y', 'z'];

    const parallelAxis = strideAxis ? (strideAxis === 'x' ? 'z' : 'x') : null;
    const gapEditable = parallelAxis && clusterCount > 1;

    container.innerHTML = 'Size: ' + order.map(axis => {
      const isStride = axis === strideAxis;
      const isParallel = gapEditable && axis === parallelAxis;
      const editable = isStride || isParallel;
      const role = isStride ? 'stride' : (isParallel ? 'parallel' : '');
      const cls = editable ? 'size-axis-input size-axis-editable' : 'size-axis-input';
      return `<input type="number" min="1" step="1" class="${cls}" data-axis="${axis}" data-role="${role}" value="${dims[axis]}" ${editable ? '' : 'disabled'}>`;
    }).join(' x ');

    const bind = (axis, role) => {
      const input = container.querySelector(`input[data-axis="${axis}"]`);
      if (!input) return;
      let committing = false;

      const commit = async () => {
        if (committing) return;
        committing = true;
        const target = Math.max(1, parseInt(input.value, 10) || 1);
        if (role === 'stride') await applyTargetStrideSize(target, axis);
        else await applyTargetParallelSize(target, axis);
        committing = false;
      };

      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', commit);
    };

    if (strideAxis) bind(strideAxis, 'stride');
    if (gapEditable) bind(parallelAxis, 'parallel');
  }

  // Given a desired total size along the growing axis, figures out the stack
  // count needed to reach it (growth is linear per stack unit), applies it,
  // and re-renders.
  async function applyTargetStrideSize(targetSize, strideAxis) {
    if (!originalBuffer) return;
    const gap = Math.max(0, parseInt(document.getElementById('cluster-gap').value) || 0);

    let size1, size2;
    try {
      size1 = computeEnclosingSizeAtStack(originalBuffer, 1, gap)[strideAxis];
      size2 = computeEnclosingSizeAtStack(originalBuffer, 2, gap)[strideAxis];
    } catch (err) {
      console.error('Failed to probe size for target stride:', err);
      return;
    }

    const perStack = size2 - size1;
    let neededStack = 1;
    if (perStack > 0) {
      neededStack = Math.max(1, Math.round(1 + (targetSize - size1) / perStack));
    }

    document.getElementById('stack-count').value = neededStack;
    await rerender();
  }

  // Given a desired total size along the parallel (free) axis, figures out
  // the cluster gap needed to reach it (growth is linear per gap unit),
  // applies it, and re-renders.
  async function applyTargetParallelSize(targetSize, parallelAxis) {
    if (!originalBuffer) return;
    const stackSize = Math.max(1, parseInt(document.getElementById('stack-count').value) || 1);

    let size1, size2;
    try {
      size1 = computeEnclosingSizeAtStack(originalBuffer, stackSize, 0)[parallelAxis];
      size2 = computeEnclosingSizeAtStack(originalBuffer, stackSize, 1)[parallelAxis];
    } catch (err) {
      console.error('Failed to probe size for target parallel axis:', err);
      return;
    }

    const perGap = size2 - size1;
    let neededGap = 0;
    if (perGap > 0) {
      neededGap = Math.max(0, Math.round((targetSize - size1) / perGap));
    }

    document.getElementById('cluster-gap').value = neededGap;
    await rerender();
  }

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
      const versionInput = document.getElementById('version-override');
      const versionOverride = versionInput?.value ? parseInt(versionInput.value) : null;

      console.log(nbtFile.root.get("Version"))

      if (versionOverride !== null && !isNaN(versionOverride)) {
        const root = nbtFile.root ?? nbtFile;

        

        root.set('Version', new deepslate.NbtInt(versionOverride));
      }

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
    Object.assign({ currentBuilder: builder, currentStructure: structure, currentRenderer: renderer },
      (currentBuilder = builder, currentStructure = structure, currentRenderer = renderer, {}));

    currentCamera = new InteractiveCanvas(canvas, view => {
      renderer.drawStructure(view);
      if (showGrid) {
        renderer.drawGrid(view);
      }
    }, center);

    if (!slider) {
      slider = new DoubleRangeSlider('slider-container', {
        min: Math.floor(bounds.minY), max: Math.floor(bounds.maxY),
        currentMin: Math.floor(bounds.minY), currentMax: Math.floor(bounds.maxY),
        onChange: (minY, maxY) => rebuildWithYRange(minY, maxY)
      });
    } else {
      slider.setRange(Math.floor(bounds.minY), Math.floor(bounds.maxY));
    }

    document.getElementById('slider-container').classList.add('active');
    renderer.setStructure(structure);
    progressDisplay.style.display = 'none';
  }

  // ── Main render entry point ────────────────────────────────────────────────
  async function renderStructure(nbt, stackSize = null, gap = 0) {
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = stackSize ? 'Stacking...' : 'Loading structure...';

    let root = nbt.root || nbt;
    lastStackedNbt = null;
    currentStrideAxis = null;
    currentClusterCount = 0;

    if (stackSize) {
      const validation = validateStackingStructure(nbt);
      currentStrideAxis = validation.isValid && validation.stackAxis
        ? validation.stackAxis.replace('-', '')
        : null;
      currentClusterCount = validation.isValid ? validation.details.clusterCount : 0;

      const stacked = stackMiddle(nbt, stackSize, gap);
      lastStackedNbt = stacked;
      root = stacked.root;
    }

    const { w, h, d } = getEnclosing(root);
    if (stackSize) {
      updateEnclosingSizeDisplay(w, h, d, currentStrideAxis, currentClusterCount);
    }

    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, root.get("Regions"), w, h, d);
  }

  // ── Shared stack re-render ─────────────────────────────────────────────────
  const rerender = async () => {
    if (!originalBuffer) return;
    const stackSize = Math.max(1, parseInt(document.getElementById('stack-count').value) || 1);
    const gap = Math.max(0, parseInt(document.getElementById('cluster-gap').value) || 0);
    await renderStructure(deepslate.NbtFile.read(new Uint8Array(originalBuffer)), stackSize, gap);
  };

  // ── Fetch from external URL (with allorigins fallback) ────────────────────
  async function fetchExternalFile(url) {
    // First attempt: direct fetch
    try {
      progressDisplay.style.display = 'block';
      progressDisplay.textContent = 'Fetching file...';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (directErr) {
      console.warn('Direct fetch failed, trying allorigins...', directErr);
    }

    // Second attempt: allorigins proxy
    try {
      progressDisplay.textContent = 'Fetching via proxy...';
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (proxyErr) {
      console.warn('Allorigins fetch failed.', proxyErr);
    }

    // Both failed
    progressDisplay.style.display = 'none';
    alert(
      `Failed to fetch the file from the provided URL.\n\n` +
      `Both direct and proxy attempts failed.\n\n` +
      `Please add the file manually using the file input.`
    );
    return null;
  }

  // ── Load from ?ext_link= URL parameter ────────────────────────────────────
  async function loadFromExtLink() {
    const params = new URLSearchParams(window.location.search);
    const extLink = params.get('ext_link');
    if (!extLink) return;

    const buffer = await fetchExternalFile(extLink);
    if (!buffer) return;

    originalBuffer = buffer;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    syncVersionInput(nbt);
    const validation = validateStackingStructure(nbt);

    if (validation.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      const hasMultipleClusters = validation.details.clusterCount > 1;
      document.getElementById('gap-controls').style.display = hasMultipleClusters ? '' : 'none';

      await renderStructure(deepslate.NbtFile.read(new Uint8Array(originalBuffer)), 1, 0);
    } else {
      document.getElementById('stack-controls').style.display = 'none';
      await renderStructure(nbt);
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  document.getElementById('stack-count').addEventListener('change', rerender);
  document.getElementById('cluster-gap').addEventListener('change', rerender);

  document.getElementById('clear-button').addEventListener('click', () => {
    currentCamera?.destroy();
    gl?.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    originalBuffer = lastStackedNbt = null;
    currentStrideAxis = null;
    currentClusterCount = 0;
    document.getElementById('enclosing-size-display').innerHTML = '';
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
    document.getElementById('stack-controls').style.display = 'none';
    document.getElementById('gap-controls').style.display = 'none';
    document.getElementById('stack-count').value = 1;
    document.getElementById('cluster-gap').value = 0;
    document.getElementById('version-controls').style.display = 'none';
    document.getElementById('version-override').value = '';
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
    currentCamera?.redraw(); // force re-render
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
    originalBuffer = await file.arrayBuffer();

    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    syncVersionInput(nbt); // ← add this
    const validation = validateStackingStructure(nbt);

    if (validation.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      // Show gap controls only when there are multiple clusters
      const hasMultipleClusters = validation.details.clusterCount > 1;
      document.getElementById('gap-controls').style.display = hasMultipleClusters ? '' : 'none';

      await renderStructure(deepslate.NbtFile.read(new Uint8Array(originalBuffer)), 1, 0);
    } else {
      document.getElementById('stack-controls').style.display = 'none';
      await renderStructure(nbt);
    }
  });

  // ── Auto-load from URL param if present ───────────────────────────────────
  await loadFromExtLink();
}

init();