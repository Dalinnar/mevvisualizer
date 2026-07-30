import { InteractiveCanvas } from './camera.js';
import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader } from './resources.js';
import { StructureBuilder } from './structure.js';
import { DoubleRangeSlider } from './slider.js';
const { StructureRenderer, Mesh, Quad, Vertex, Vector, ShaderProgram } = deepslate;
const { mat4: mat4Pick, vec4: vec4Pick } = glMatrix;
import { validateStackingStructure, stackMiddle, computeEnclosingSizeAtStack } from './validate.js';
import { manualStackMulti, resolveManualCycleCounts, encodeManualConfig, decodeManualConfig } from './manualStack.js';

// Distinct colors (RGB, 0-1) cycled across regions for their outline boxes.
const REGION_BOX_COLORS = [
  [1, 0.25, 0.25], [0.25, 1, 0.35], [0.3, 0.55, 1], [1, 0.85, 0.2],
  [1, 0.3, 1], [0.25, 1, 1], [1, 0.6, 0.15], [0.65, 0.35, 1],
];

// Simple unlit, alpha-blended shader used to paint the translucent gray
// highlight over a selected region's faces. (Blending is already enabled
// globally by deepslate's Renderer.initialize().)
const vsSelect = `
  attribute vec4 vertPos;
  attribute vec3 vertColor;

  uniform mat4 mView;
  uniform mat4 mProj;

  varying highp vec3 vColor;

  void main(void) {
    gl_Position = mProj * mView * vertPos;
    vColor = vertColor;
  }
`;
const fsSelect = `
  precision highp float;
  varying highp vec3 vColor;

  void main(void) {
    gl_FragColor = vec4(vColor, 0.35);
  }
`;

// Builds one line-cube mesh per region (in the structure's local coordinate
// space) so region boundaries can be drawn through the same shader pipeline
// as the grid. Called once per structure build, not per animation frame.
function buildRegionMeshes(gl, builder) {
  const boundsByRegion = builder.getRegionBoundsLocal();
  return Object.entries(boundsByRegion).map(([name, { min, max }], i) => {
    const color = REGION_BOX_COLORS[i % REGION_BOX_COLORS.length];
    const mesh = new Mesh()
      .addLineCube(min[0], min[1], min[2], max[0] + 1, max[1] + 1, max[2] + 1, color)
      .rebuild(gl, { pos: true, color: true });
    return { name, color, mesh };
  });
}

// Builds a filled (quads) box mesh spanning [min, max], used to paint the
// translucent selection highlight over a region's faces.
function buildBoxFillMesh(gl, min, max, color) {
  const [x1, y1, z1] = min;
  const [x2, y2, z2] = max;
  const P = (x, y, z) => new Vector(x, y, z);
  const quads = [
    Quad.fromPoints(P(x1, y1, z1), P(x2, y1, z1), P(x2, y2, z1), P(x1, y2, z1)), // -Z face
    Quad.fromPoints(P(x1, y1, z2), P(x1, y2, z2), P(x2, y2, z2), P(x2, y1, z2)), // +Z face
    Quad.fromPoints(P(x1, y1, z1), P(x1, y2, z1), P(x1, y2, z2), P(x1, y1, z2)), // -X face
    Quad.fromPoints(P(x2, y1, z1), P(x2, y1, z2), P(x2, y2, z2), P(x2, y2, z1)), // +X face
    Quad.fromPoints(P(x1, y1, z1), P(x2, y1, z1), P(x2, y1, z2), P(x1, y1, z2)), // -Y face
    Quad.fromPoints(P(x1, y2, z1), P(x1, y2, z2), P(x2, y2, z2), P(x2, y2, z1)), // +Y face
  ].map(q => q.setColor(color));
  return new Mesh(quads, []).rebuild(gl, { pos: true, color: true });
}

// Unprojects a click position (in CSS pixels) into a ray, in the same local
// coordinate space the structure/region boxes are drawn in.
function screenPointToRay(canvas, clientX, clientY, viewMatrix, projMatrix) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

  const viewProj = mat4Pick.create();
  mat4Pick.multiply(viewProj, projMatrix, viewMatrix);
  const invViewProj = mat4Pick.create();
  mat4Pick.invert(invViewProj, viewProj);

  const unproject = ndcZ => {
    const v = vec4Pick.fromValues(ndcX, ndcY, ndcZ, 1);
    vec4Pick.transformMat4(v, v, invViewProj);
    if (v[3] !== 0) {
      v[0] /= v[3]; v[1] /= v[3]; v[2] /= v[3];
    }
    return [v[0], v[1], v[2]];
  };

  const near = unproject(-1);
  const far = unproject(1);
  const dir = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const len = Math.hypot(...dir) || 1;
  return { origin: near, dir: dir.map(d => d / len) };
}

// Ray vs axis-aligned bounding box (slab method). Returns the entry t, or
// null if the ray misses the box or the box is entirely behind the origin.
function rayIntersectsAABB(origin, dir, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const o = origin[i], d = dir[i];
    if (Math.abs(d) < 1e-9) {
      if (o < min[i] || o > max[i]) return null;
      continue;
    }
    let t1 = (min[i] - o) / d;
    let t2 = (max[i] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmax < 0 ? null : Math.max(tmin, 0);
}

// Finds the name of the region whose box is closest along the ray cast from
// a click position, or null if the click didn't hit any region.
function pickRegionAt(canvas, clientX, clientY, viewMatrix, projMatrix, boundsByRegion) {
  if (!viewMatrix) return null;
  const { origin, dir } = screenPointToRay(canvas, clientX, clientY, viewMatrix, projMatrix);

  let closestName = null;
  let closestT = Infinity;
  for (const [name, { min, max }] of Object.entries(boundsByRegion)) {
    const boxMax = [max[0] + 1, max[1] + 1, max[2] + 1];
    const t = rayIntersectsAABB(origin, dir, min, boxMax);
    if (t !== null && t < closestT) {
      closestT = t;
      closestName = name;
    }
  }
  return closestName;
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

function syncVersionInput(nbt) {
  const root = nbt.root ?? nbt;
  document.getElementById('version-override').value = root.get('Version').value;
  document.getElementById('version-controls').style.display = 'block';
}

async function init() {
  const blockData = await loadBlockData();
  const resourceLoader = new ResourceLoader();
  let showGrid = true;
  let showRegionBoxes = true;

  const canvas = document.getElementById('structure-display');
  const gl = canvas.getContext('webgl');
  const progressDisplay = document.getElementById('progress-display') || createProgressDisplay();

  // Shader used only for the translucent region-selection highlight.
  const selectionShaderProgram = new ShaderProgram(gl, vsSelect, fsSelect).getProgram();

  await resourceLoader.load(blockData, ({ stage, percent }) => {
    progressDisplay.textContent = `${stage} ${percent}%`;
  });
  progressDisplay.style.display = 'none';

  const resources = resourceLoader.getResources();

  let currentStructure = null, currentRenderer = null, currentCamera = null,
    currentBuilder = null, slider = null, originalBuffer = null, originalNbt = null, lastStackedNbt = null,
    currentStrideAxis = null, currentClusterCount = 0, currentRegionMeshes = [],
    selectedRegionName = null, selectionMesh = null,
    manualMode = false, manualCurrentStep = null, manualCurrentCap = null,
    manualConfigs = [], currentExtLink = null, lastAutoValidation = null;

  // Selects (or, if regionName is null/unmatched, deselects) a region: logs
  // it and rebuilds the small translucent highlight mesh for it. Not run
  // per-frame — only when the selection actually changes via a click.
  function selectRegion(regionName) {
    selectedRegionName = regionName;

    if (!regionName || !currentBuilder) {
      selectionMesh = null;
      currentCamera?.redraw();
      return;
    }

    console.log('Selected region:', regionName);

    const { min, max } = currentBuilder.getRegionBoundsLocal()[regionName];
    const boxMax = [max[0] + 1, max[1] + 1, max[2] + 1];
    selectionMesh = buildBoxFillMesh(gl, min, boxMax, [0.55, 0.55, 0.55]);
    currentCamera?.redraw();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getEnclosing = (root) => {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  };

  // Automatic/Manual stacking only make sense with more than 2 regions (a
  // Step/Cap or Start/End pair alone leaves nothing to stack in between).
  // Shows/hides the mode-toggle section accordingly, and if the section is
  // being hidden while manual mode was active, falls back to automatic.
  function updateStackingModeVisibility(nbt) {
    const root = nbt.root ?? nbt;
    const regionCount = Array.from(root.get("Regions").keys()).length;
    const visible = regionCount > 2;
    document.getElementById('stacking-mode-section').style.display = visible ? '' : 'none';
    if (!visible && manualMode) {
      document.getElementById('mode-automatic').checked = true;
      setManualMode(false);
    }
    return visible;
  }

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

  // ── Manual Stacking ─────────────────────────────────────────────────────────

  // Toggles between the automatic and manual stacking UI. The Stack Count
  // input (inside #stack-controls) is shared by both modes; only the
  // automatic-only Cluster Gap control is hidden while in manual mode.
  function setManualMode(enabled) {
    manualMode = enabled;
    document.getElementById('manual-stack-controls').style.display = enabled ? 'block' : 'none';

    // Entering manual mode with no saved pairs yet: the 3D view may still be
    // showing an automatically-stacked render (e.g. "middle_0", "middle_1"
    // copies from stackMiddle()). Manual stacking always resolves region
    // names against the pristine original NBT, so if we let the user click
    // regions from a stacked render, they can select names that don't exist
    // in the original (see resolveManualCycleCounts's "region not found"
    // error). Reset to the original, unstacked structure so what's
    // clickable matches what manual stacking will actually operate on.
    if (enabled && !manualConfigs.length && originalBuffer) {
      renderStructure(deepslate.NbtFile.read(new Uint8Array(originalBuffer)));
    }

    if (enabled) {
      // Manual stacking only needs a Stack Count, not a cluster gap — and it
      // doesn't require automatic validity, so show it as long as a file is
      // loaded at all.
      document.getElementById('gap-controls').style.display = 'none';
      document.getElementById('stack-controls').style.display = originalBuffer ? 'block' : 'none';
    } else if (lastAutoValidation?.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('gap-controls').style.display =
        lastAutoValidation.details.clusterCount > 1 ? '' : 'none';
    } else {
      document.getElementById('stack-controls').style.display = 'none';
      document.getElementById('gap-controls').style.display = 'none';
    }

    updateManualStatus();
  }

  // Renders the list of saved Step/Cap pairs. Each pair's stack count is no
  // longer set manually — it's auto-computed from the LCM of step widths
  // sharing an axis (see resolveManualCycleCounts), scaled by the shared
  // Stack Count field acting as a cycle multiplier. This keeps Caps from
  // differently-sized Step regions evenly spaced instead of drifting apart.
  function renderManualConfigList() {
    const container = document.getElementById('manual-config-list');
    container.innerHTML = '';

    if (!manualConfigs.length) return;

    let resolved = null;
    let errorMsg = null;
    if (originalBuffer) {
      try {
        const cycles = Math.max(1, parseInt(document.getElementById('stack-count').value, 10) || 1);
        const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
        resolved = resolveManualCycleCounts(nbt, manualConfigs, cycles);
      } catch (err) {
        errorMsg = err.message;
      }
    }

    manualConfigs.forEach((cfg, i) => {
      const info = resolved ? resolved[i] : null;
      const countLabel = info
        ? `×${info.stackCount} auto (stride ${info.stride}, ${info.direction > 0 ? '+' : '-'}${info.axis})`
        : (errorMsg ? `⚠️ ${errorMsg}` : '…');

      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px;';
      row.innerHTML = `
        <span style="flex:1;">${i + 1}. Step: <b>${cfg.stepName}</b> → Cap: <b>${cfg.capName}</b> — ${countLabel}</span>
        <button data-index="${i}" class="manual-remove-config" title="Remove this pair">✕</button>
      `;
      container.appendChild(row);
    });

    container.querySelectorAll('.manual-remove-config').forEach(btn => {
      btn.addEventListener('click', async () => {
        manualConfigs.splice(parseInt(btn.dataset.index, 10), 1);
        renderManualConfigList();
        updateManualStatus();
        if (manualConfigs.length && originalBuffer) {
          await applyManualStack();
        } else {
          clearConfigFromUrl();
        }
      });
    });
  }

  // Refreshes the Step/Cap labels and enables/disables the Save/Apply/Copy
  // buttons based on current selections and saved pairs.
  function updateManualStatus() {
    document.getElementById('manual-step-label').textContent = manualCurrentStep || '(none selected)';
    document.getElementById('manual-cap-label').textContent = manualCurrentCap || '(none selected)';
    document.getElementById('manual-save-config').disabled = !(manualCurrentStep && manualCurrentCap);
    document.getElementById('manual-apply-button').disabled = !(manualConfigs.length && originalBuffer);
    document.getElementById('manual-copy-link').disabled = !(manualConfigs.length && currentExtLink);
  }

  // Runs manualStackMulti() with either the given list of pairs (used when
  // restoring from a shared URL) or the currently-saved list, then renders
  // the result the same way automatic stacking does. Per-pair stack counts
  // are always re-derived from the LCM logic (see resolveManualCycleCounts),
  // scaled by the shared Stack Count field as a cycle multiplier — never
  // read from a per-pair value.
  async function applyManualStack(pairsOverride) {
    if (!originalBuffer) { alert('Load a litematic first.'); return; }

    const pairs = pairsOverride ?? manualConfigs;
    if (!pairs || pairs.length === 0) {
      alert('Save at least one Step/Cap pair first.');
      return;
    }

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Applying manual stack...';

    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    const cycles = Math.max(1, parseInt(document.getElementById('stack-count').value, 10) || 1);

    let resolvedConfigs, result;
    try {
      resolvedConfigs = resolveManualCycleCounts(nbt, pairs, cycles);
      result = manualStackMulti(nbt, resolvedConfigs);
    } catch (err) {
      console.error(err);
      progressDisplay.style.display = 'none';
      document.getElementById('manual-status').textContent = err.message;
      alert(err.message);
      return;
    }

    document.getElementById('manual-status').textContent = result.results
      .map(r => `${r.stepName}→${r.capName}: ${r.direction > 0 ? '+' : '-'}${r.axis} ×${r.count}`)
      .join(' | ');

    renderManualConfigList();
    syncConfigToUrl();

    lastStackedNbt = result.nbt;
    currentStrideAxis = null;
    currentClusterCount = 0;

    const root = result.nbt.root || result.nbt;
    const { w, h, d } = getEnclosing(root);
    updateEnclosingSizeDisplay(w, h, d, null, 0);

    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, root.get("Regions"), w, h, d);
  }

  // Copies the current shareable URL to the clipboard. The address bar is
  // already kept in sync with the applied configuration via syncConfigToUrl,
  // so this just needs to make sure that's up to date and an ext_link is
  // actually present (otherwise a recipient would have nothing to fetch).
  function copyManualShareLink() {
    if (!currentExtLink) {
      alert('Shareable links are only available for litematics loaded via a ?ext_link= URL.');
      return;
    }
    if (!manualConfigs.length) {
      alert('Save at least one Step/Cap pair first.');
      return;
    }

    syncConfigToUrl();

    navigator.clipboard?.writeText(window.location.href).then(() => {
      alert('Shareable link copied to clipboard!');
    }).catch(() => {
      prompt('Copy this link:', window.location.href);
    });
  }

  // If the URL has a `config` parameter, restores it onto whatever file was
  // just loaded (regardless of whether it came from ?ext_link= or a manual
  // upload) and applies it immediately. Returns true if a config was found
  // and applied, false otherwise — callers should fall back to automatic
  // detection when this returns false.
  async function restoreManualConfigFromUrl() {
    const configParam = new URLSearchParams(window.location.search).get('config');
    if (!configParam) return false;

    const decoded = decodeManualConfig(configParam);
    if (!decoded) {
      console.warn('Failed to parse manual stacking config from URL; falling back to automatic detection.');
      return false;
    }

    document.getElementById('mode-manual').checked = true;
    setManualMode(true);
    manualConfigs = decoded.pairs;
    document.getElementById('stack-count').value = decoded.cycles;
    document.getElementById('stack-controls').style.display = 'block';
    renderManualConfigList();
    updateManualStatus();
    await applyManualStack(decoded.pairs);
    return true;
  }

  // Keeps the address bar's `config` parameter (and `ext_link`, if known) in
  // sync with the currently-applied manual stacking configuration, without
  // adding browser history entries. Called automatically every time a
  // manual stack is (re-)applied.
  function syncConfigToUrl() {
    if (!manualMode || !manualConfigs.length) return;

    const cycles = Math.max(1, parseInt(document.getElementById('stack-count').value, 10) || 1);
    const config = encodeManualConfig(manualConfigs, cycles);

    const url = new URL(window.location.href);
    url.searchParams.set('config', config);
    if (currentExtLink) url.searchParams.set('ext_link', currentExtLink);
    window.history.replaceState({}, '', url.toString());
  }

  // Removes the `config` parameter from the address bar (e.g. once all
  // saved pairs are cleared).
  function clearConfigFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('config');
    window.history.replaceState({}, '', url.toString());
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

    // Carry the previous camera's rotation/zoom/position forward instead of
    // resetting to defaults every time this runs (e.g. on every stack-count
    // change). Only fall back to the freshly-computed center/default zoom
    // when there's no prior camera to inherit from (first load).
    const prevCameraState = currentCamera ? {
      xRotation: currentCamera.xRotation,
      yRotation: currentCamera.yRotation,
      viewDist: currentCamera.viewDist,
      center: currentCamera.center,
    } : null;

    currentCamera?.destroy();
    Object.assign({ currentBuilder: builder, currentStructure: structure, currentRenderer: renderer },
      (currentBuilder = builder, currentStructure = structure, currentRenderer = renderer, {}));

    // Built once here (not inside the render callback), so region boxes are
    // reused across every frame instead of being rebuilt each render.
    currentRegionMeshes = buildRegionMeshes(gl, builder);
    selectedRegionName = null;
    selectionMesh = null;

    currentCamera = new InteractiveCanvas(canvas, view => {
      renderer.drawStructure(view);
      if (showGrid) {
        renderer.drawGrid(view);
      }
      if (showRegionBoxes && currentRegionMeshes.length) {
        // Same pipeline drawGrid() uses: one shader/prepare pass, then draw
        // each region's mesh (mirrors how drawStructure batches its meshes).
        renderer.setShader(renderer.gridShaderProgram);
        renderer.prepareDraw(view);
        currentRegionMeshes.forEach(({ mesh }) => renderer.drawMesh(mesh, { pos: true, color: true }));
      }
      if (selectionMesh) {
        // Translucent gray fill over the selected region's faces. Cull face
        // is disabled for this draw so both sides of each box face render.
        renderer.setShader(selectionShaderProgram);
        renderer.prepareDraw(view);
        gl.disable(gl.CULL_FACE);
        renderer.drawMesh(selectionMesh, { pos: true, color: true });
        gl.enable(gl.CULL_FACE);
      }
    }, prevCameraState ? prevCameraState.center : center, prevCameraState ? prevCameraState.viewDist : 4, (clientX, clientY, viewMatrix) => {
      const boundsByRegion = currentBuilder.getRegionBoundsLocal();
      const regionName = pickRegionAt(canvas, clientX, clientY, viewMatrix, currentRenderer.projMatrix, boundsByRegion);
      selectRegion(regionName);
    });

    // Rotation isn't a constructor param, so restore it post-construction.
    // Safe to do synchronously: the constructor's own redraw() is deferred
    // via requestAnimationFrame, so this runs before the first render.
    if (prevCameraState) {
      currentCamera.xRotation = prevCameraState.xRotation;
      currentCamera.yRotation = prevCameraState.yRotation;
    }

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
    // stackMiddle() no longer mutates its input, so the cached parse can be
    // reused directly here instead of re-parsing (and re-decompressing) the
    // raw litematic bytes on every single stack-count/gap tick.
    await renderStructure(originalNbt ?? deepslate.NbtFile.read(new Uint8Array(originalBuffer)), stackSize, gap);
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

    currentExtLink = extLink;

    const buffer = await fetchExternalFile(extLink);
    if (!buffer) return;

    originalBuffer = buffer;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Parsing NBT...';
    const nbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));
    originalNbt = nbt;
    syncVersionInput(nbt);
    updateStackingModeVisibility(nbt);

    // A `config` parameter means a manual stacking configuration should be
    // restored onto this file — regardless of whether it came via ?ext_link=
    // or a manual upload (see the file-input handler below for the other case).
    if (await restoreManualConfigFromUrl()) return;

    const validation = validateStackingStructure(nbt);
    lastAutoValidation = validation;

    if (validation.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      const hasMultipleClusters = validation.details.clusterCount > 1;
      document.getElementById('gap-controls').style.display =
        (!manualMode && hasMultipleClusters) ? '' : 'none';

      await renderStructure(originalNbt, 1, 0);
    } else {
      document.getElementById('stack-controls').style.display = manualMode ? 'block' : 'none';
      await renderStructure(nbt);
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  // Collapses a rapid burst of calls (e.g. holding down the stack-count
  // spinner arrows) into a single trailing call, instead of doing a full
  // rebuild for every intermediate value.
  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }
  const debouncedRerender = debounce(rerender, 120);

  document.getElementById('stack-count').addEventListener('change', async () => {
    if (manualMode) {
      renderManualConfigList();
      if (manualConfigs.length && originalBuffer) await applyManualStack();
      return;
    }
    debouncedRerender();
  });
  document.getElementById('cluster-gap').addEventListener('change', () => {
    if (manualMode) return; // cluster gap doesn't apply to manual stacking
    debouncedRerender();
  });

  document.getElementById('mode-automatic').addEventListener('change', e => {
    if (e.target.checked) setManualMode(false);
  });
  document.getElementById('mode-manual').addEventListener('change', e => {
    if (e.target.checked) setManualMode(true);
  });

  document.getElementById('manual-set-step').addEventListener('click', () => {
    if (!selectedRegionName) { alert('Click a region in the 3D view first.'); return; }
    manualCurrentStep = selectedRegionName;
    updateManualStatus();
  });
  document.getElementById('manual-set-cap').addEventListener('click', () => {
    if (!selectedRegionName) { alert('Click a region in the 3D view first.'); return; }
    manualCurrentCap = selectedRegionName;
    updateManualStatus();
  });
  document.getElementById('manual-save-config').addEventListener('click', async () => {
    if (!manualCurrentStep || !manualCurrentCap) {
      alert('Select both a Step region and a Cap region first.');
      return;
    }
    manualConfigs.push({ stepName: manualCurrentStep, capName: manualCurrentCap });
    manualCurrentStep = null;
    manualCurrentCap = null;
    renderManualConfigList();
    updateManualStatus();
    if (originalBuffer) await applyManualStack();
  });
  document.getElementById('manual-clear-configs').addEventListener('click', () => {
    manualConfigs = [];
    manualCurrentStep = null;
    manualCurrentCap = null;
    renderManualConfigList();
    updateManualStatus();
    clearConfigFromUrl();
  });
  document.getElementById('manual-apply-button').addEventListener('click', () => applyManualStack());
  document.getElementById('manual-copy-link').addEventListener('click', () => copyManualShareLink());

  document.getElementById('clear-button').addEventListener('click', () => {
    currentCamera?.destroy();
    gl?.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    originalBuffer = lastStackedNbt = null;
    originalNbt = null;
    currentStrideAxis = null;
    currentClusterCount = 0;
    currentRegionMeshes = [];
    selectedRegionName = null;
    selectionMesh = null;
    manualCurrentStep = null;
    manualCurrentCap = null;
    manualConfigs = [];
    currentExtLink = null;
    lastAutoValidation = null;
    document.getElementById('mode-automatic').checked = true;
    setManualMode(false);
    document.getElementById('stacking-mode-section').style.display = 'none';
    renderManualConfigList();
    clearConfigFromUrl();
    document.getElementById('enclosing-size-display').innerHTML = '';
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
    document.getElementById('stack-controls').style.display = 'none';
    document.getElementById('gap-controls').style.display = 'none';
    document.getElementById('stack-count').value = 1;
    document.getElementById('cluster-gap').value = 0;
    document.getElementById('version-controls').style.display = 'none';
    document.getElementById('version-override').value = '';
    document.getElementById('manual-status').textContent = '';
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

  document.getElementById('toggle-region-boxes').addEventListener('change', (e) => {
    showRegionBoxes = e.target.checked;
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
    originalNbt = nbt;
    syncVersionInput(nbt); // ← add this
    currentExtLink = null; // manually-uploaded files have no shareable source URL
    updateStackingModeVisibility(nbt);
    updateManualStatus();

    // If the URL already carries a manual stacking `config` (e.g. the page
    // was opened via a shared link but the litematic itself had to be
    // uploaded manually), restore and apply it onto this file too.
    if (await restoreManualConfigFromUrl()) return;

    const validation = validateStackingStructure(nbt);
    lastAutoValidation = validation;

    if (validation.isValid) {
      document.getElementById('stack-controls').style.display = 'block';
      document.getElementById('stack-count').value = 1;
      document.getElementById('cluster-gap').value = 0;

      // Show gap controls only when there are multiple clusters (and only
      // in automatic mode; manual stacking doesn't use a cluster gap).
      const hasMultipleClusters = validation.details.clusterCount > 1;
      document.getElementById('gap-controls').style.display =
        (!manualMode && hasMultipleClusters) ? '' : 'none';

      await renderStructure(originalNbt, 1, 0);
    } else {
      // Automatic stacking isn't available for this structure, but manual
      // stacking doesn't require automatic validity — keep the shared Stack
      // Count control visible if manual mode is active.
      document.getElementById('stack-controls').style.display = manualMode ? 'block' : 'none';
      await renderStructure(nbt);
    }
  });

  // ── Auto-load from URL param if present ───────────────────────────────────
  await loadFromExtLink();
}

init();