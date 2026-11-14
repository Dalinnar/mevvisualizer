import { InteractiveCanvas } from './camera.js';
import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader } from './resources.js';
import { StructureBuilder } from './structure.js';
import { openMaterialsDialog, loadItemCatalog } from './materials.js';
import { DoubleRangeSlider } from './slider.js';
const { StructureRenderer, Mesh, Quad, Vertex, Vector, ShaderProgram } = deepslate;
const { mat4: mat4Pick, vec4: vec4Pick } = glMatrix;
import { localToWorld, nbtNum, cloneRegionWithPosition } from './validate.js';
import { planClusters, stackClusters, getRegionWorlds, encodeStackConfig, decodeStackConfig } from './manualStack.js';

// Region names come from the uploaded file, so escape them before they go
// anywhere near innerHTML.
function esc(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fill colors for the cluster Region / Step / Cap highlights in the 3D view
// (match the REGION / STEP / CAP tags in the panel, see style.css).
const REGION_COLOR = [0.95, 0.3, 0.3];
const STEP_COLOR = [0.25, 0.75, 0.35];
const CAP_COLOR = [0.25, 0.55, 1];

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

// Computes an orbit-camera distance (from InteractiveCanvas's `center`) that
// guarantees the whole structure's bounding sphere stays inside the frame,
// no matter how the camera is rotated around that center. Using the sphere
// (rather than fitting the box for the current rotation only) means the fit
// stays valid as the user drags to look around, instead of only being
// correct for the angle it was computed at.
//
// Matches deepslate's Renderer.getPerspective(): 70° vertical FOV, aspect
// from the canvas's rendered (CSS) size, near/far 0.1/500.
function computeFitViewDist(bounds, canvas, marginFactor = 1.1) {
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  const radius = 0.5 * Math.hypot(dx, dy, dz);

  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  const aspect = width / height;

  const vFov = 70 * Math.PI / 180;
  const hFov = 2 * Math.atan(aspect * Math.tan(vFov / 2));
  // Whichever axis (horizontal or vertical) has the narrower FOV is the one
  // that would clip the sphere first, so fit against that one.
  const limitingHalfAngle = Math.min(vFov, hFov) / 2;

  if (radius <= 0 || !Number.isFinite(radius)) return 4;

  const dist = radius / Math.sin(limitingHalfAngle);
  return Math.max(dist * marginFactor, 2);
}

function syncVersionInput(nbt) {
  const root = nbt.root ?? nbt;
  document.getElementById('version-override').value = root.get('Version').value;
  document.getElementById('version-controls').style.display = 'block';
}

// Orthographic view presets as camera pitch (x) / yaw (y), in radians. The
// name is the side the camera sits on: "north" looks at the structure from
// the -Z side, "east" from the +X side, and so on.
const VIEW_PRESETS = {
  top:    { x:  Math.PI / 2, y: 0 },
  bottom: { x: -Math.PI / 2, y: 0 },
  north:  { x: 0, y:  Math.PI },
  south:  { x: 0, y: 0 },
  east:   { x: 0, y: -Math.PI / 2 },
  west:   { x: 0, y:  Math.PI / 2 },
  iso:    { x: Math.atan(1 / Math.SQRT2), y: -Math.PI / 4 },
};

function matchViewPreset(x, y) {
  const TAU = Math.PI * 2, EPS = 0.02;
  const angDiff = (a, b) => {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return Math.abs(d);
  };
  for (const [name, p] of Object.entries(VIEW_PRESETS)) {
    if (Math.abs(x - p.x) < EPS && angDiff(y, p.y) < EPS) return name;
  }
  return null;
}

async function init() {
  const blockData = await loadBlockData();
  const resourceLoader = new ResourceLoader();
  let showGrid = true;
  let showRegionBoxes = true;
  // Red/green/blue tint over cluster regions; off by default.
  let showClusterHighlight = false;

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
    currentRegionMeshes = [],
    selectedRegionName = null, selectionMesh = null, markerMeshes = [],
    // Axes the size card lets the user edit (see updateEnclosingSizeDisplay).
    sizeEditable = [],
    // Stacking clusters: [{ regions: [{ name, role: 'region'|'step'|'cap' }] }],
    // the one new regions get added to, and the role of every region in the
    // last stacked result (copies included) for the 3D highlights.
    clusters = [], activeCluster = 0, lastRoles = null,
    currentExtLink = null,
    // The root NBT compound backing whatever is currently on screen (post
    // stack if any, otherwise the original) — kept in sync so
    // the keyboard region-editing controls (move/delete) always mutate the
    // exact Regions compound that's actually being rendered.
    currentActiveRoot = null,
    // True once a move/delete has happened since the last save (or load).
    // Stacking always re-derives from originalBuffer, so moves
    // are invisible to them until "Save Region Edits" bakes the current
    // layout back into originalBuffer/originalNbt.
    hasUnsavedRegionEdits = false,
    // True while the "C" clone GUI overlay is open. Kept separate from the
    // GUI element's own visibility so the keydown handler can toggle it
    // without querying the DOM every keystroke.
    cloneGuiOpen = false;

  // Shows/hides every panel section that only makes sense once a litematic
  // is loaded (region editing, stacking, size).
  function showRegionEditControls(show) {
    for (const id of ['region-edit-controls', 'stacking-section', 'size-section']) {
      document.getElementById(id).style.display = show ? 'block' : 'none';
    }
  }

  function updateSaveEditsButton() {
    const btn = document.getElementById('save-region-edits');
    const status = document.getElementById('region-edit-status');
    btn.disabled = !hasUnsavedRegionEdits;
    status.textContent = hasUnsavedRegionEdits
      ? 'Unsaved edits — stacking ignores them until you save.'
      : '';
  }

  // Selects (or, if regionName is null/unmatched, deselects) a region: logs
  // it and rebuilds the small translucent highlight mesh for it. Not run
  // per-frame — only when the selection actually changes via a click.
  function selectRegion(regionName) {
    // The clone GUI's offsets/defaults are specific to whatever was selected
    // when it opened, so swapping the selection (clicking another region)
    // closes it rather than leaving it silently targeting the old one.
    if (cloneGuiOpen && regionName !== selectedRegionName) closeCloneGui();

    selectedRegionName = regionName;
    updateSelectionHud(regionName);

    if (!regionName || !currentBuilder) {
      selectionMesh = null;
      updateManualStatus();
      currentCamera?.redraw();
      return;
    }

    console.log('Selected region:', regionName);

    const { min, max } = currentBuilder.getRegionBoundsLocal()[regionName];
    const boxMax = [max[0] + 1, max[1] + 1, max[2] + 1];
    selectionMesh = buildBoxFillMesh(gl, min, boxMax, [0.55, 0.55, 0.55]);
    updateManualStatus();
    currentCamera?.redraw();
  }

  // Shows the "◄►▲▼ move · H/Y up/down · C clone · Del delete" HUD over the
  // canvas whenever a region is selected, and hides it on deselect. Purely
  // informational — doesn't itself bind any keys.
  function updateSelectionHud(regionName) {
    const hud = document.getElementById('selection-hud');
    if (!regionName) {
      hud.classList.add('hidden');
      return;
    }
    document.getElementById('selection-hud-name').textContent = regionName;
    hud.classList.remove('hidden');
  }

  // ── Region editing (keyboard move/delete) ───────────────────────────────────

  function readRegionVec(entry, tag) {
    const v = entry.get(tag);
    return { x: nbtNum(v.get("x")), y: nbtNum(v.get("y")), z: nbtNum(v.get("z")) };
  }

  function nudgeRegionPosition(entry, dx, dy, dz) {
    const pos = entry.get("Position");
    for (const [axis, delta] of [['x', dx], ['y', dy], ['z', dz]]) {
      if (!delta) continue;
      const node = pos.get(axis);
      const next = nbtNum(node) + delta;
      node.value !== undefined ? (node.value = next) : pos.set(axis, next);
    }
  }

  // Recomputes EnclosingSize from the actual bounding box of every remaining
  // region (same math as manualStackMulti's patch step), so a downloaded
  // litematic stays consistent after moving/deleting regions via keyboard.
  function recomputeEnclosingSize(root) {
    const regions = root.get("Regions");
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const name of regions.keys()) {
      const entry = regions.get(name);
      const { bounds: b } = localToWorld(readRegionVec(entry, "Position"), readRegionVec(entry, "Size"));
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
      minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
    }
    if (!isFinite(minX)) return; // no regions left

    const enclosing = root.get("Metadata").get("EnclosingSize");
    const setAxis = (axis, val) => {
      const node = enclosing.get(axis);
      node.value !== undefined ? (node.value = val) : enclosing.set(axis, val);
    };
    setAxis('x', maxX - minX + 1);
    setAxis('y', maxY - minY + 1);
    setAxis('z', maxZ - minZ + 1);
  }

  // Rebuilds the 3D view from currentActiveRoot's current Regions (after a
  // move/delete), re-selecting the same region afterward if it still exists
  // so the highlight and further nudges keep working without re-clicking.
  async function rerenderCurrentRegions() {
    if (!currentActiveRoot) return;
    const regions = currentActiveRoot.get("Regions");
    const stillSelected = selectedRegionName && regions.has(selectedRegionName) ? selectedRegionName : null;

    const { w, h, d } = getEnclosing(currentActiveRoot);
    updateEnclosingSizeDisplay(w, h, d, sizeEditable); // edits can change the size
    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, regions, w, h, d);

    if (stillSelected) selectRegion(stillSelected);
  }

  function moveSelectedRegion(dx, dy, dz) {
    if (!selectedRegionName || !currentActiveRoot) return;
    const regions = currentActiveRoot.get("Regions");
    const entry = regions.get(selectedRegionName);
    if (!entry) return;
    nudgeRegionPosition(entry, dx, dy, dz);
    recomputeEnclosingSize(currentActiveRoot);
    hasUnsavedRegionEdits = true;
    updateSaveEditsButton();
    debouncedRegionRerender();
  }

  function deleteSelectedRegion() {
    if (!selectedRegionName || !currentActiveRoot) return;
    const regions = currentActiveRoot.get("Regions");
    if (!regions.has(selectedRegionName)) return;
    if (regions.size <= 1) {
      alert("Can't delete the last remaining region.");
      return;
    }
    regions.delete(selectedRegionName);
    recomputeEnclosingSize(currentActiveRoot);
    selectedRegionName = null;
    selectionMesh = null;
    updateSelectionHud(null);
    hasUnsavedRegionEdits = true;
    updateSaveEditsButton();
    closeCloneGui();
    rerenderCurrentRegions();
  }

  // ── Region cloning ("C" GUI) ─────────────────────────────────────────────────
  // Picks the first unused "<baseName>_clone", "<baseName>_clone2", ... name
  // so repeated cloning (including cloning a clone) never collides with an
  // existing region.
  function uniqueCloneName(regions, baseName) {
    let name = `${baseName}_clone`;
    let n = 1;
    while (regions.has(name)) {
      n += 1;
      name = `${baseName}_clone${n}`;
    }
    return name;
  }

  // Opens the transparent clone overlay for the currently selected region,
  // pre-filling the X offset with the region's own width so the default
  // clone lands fully clear of the original instead of overlapping it.
  function openCloneGui() {
    if (!selectedRegionName || !currentActiveRoot) return;
    const regions = currentActiveRoot.get("Regions");
    const entry = regions.get(selectedRegionName);
    if (!entry) return;

    const size = readRegionVec(entry, "Size");
    document.getElementById('clone-gui-target-name').textContent = selectedRegionName;
    document.getElementById('clone-offset-x').value = Math.abs(size.x) || 1;
    document.getElementById('clone-offset-y').value = 0;
    document.getElementById('clone-offset-z').value = 0;

    document.getElementById('clone-gui').classList.remove('hidden');
    cloneGuiOpen = true;

    const xInput = document.getElementById('clone-offset-x');
    xInput.focus();
    xInput.select();
  }

  function closeCloneGui() {
    document.getElementById('clone-gui').classList.add('hidden');
    cloneGuiOpen = false;
  }

  // Duplicates the selected region at Position + (dx, dy, dz), gives it a
  // fresh unique name, and selects the new copy. Like moves/deletes, this is
  // an on-screen edit only until "Save Region Edits" bakes it into
  // originalBuffer/originalNbt.
  function performClone() {
    if (!selectedRegionName || !currentActiveRoot) return;
    const regions = currentActiveRoot.get("Regions");
    const entry = regions.get(selectedRegionName);
    if (!entry) return;

    const dx = parseInt(document.getElementById('clone-offset-x').value, 10) || 0;
    const dy = parseInt(document.getElementById('clone-offset-y').value, 10) || 0;
    const dz = parseInt(document.getElementById('clone-offset-z').value, 10) || 0;

    const pos = readRegionVec(entry, "Position");
    const newPos = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
    const newName = uniqueCloneName(regions, selectedRegionName);

    regions.set(newName, cloneRegionWithPosition(entry, newPos));
    recomputeEnclosingSize(currentActiveRoot);
    hasUnsavedRegionEdits = true;
    updateSaveEditsButton();

    closeCloneGui();
    selectedRegionName = newName; // rerenderCurrentRegions re-selects whatever this points at
    rerenderCurrentRegions();
  }

  // Bakes whatever is currently on screen (with any keyboard moves/deletes
  // applied) into a fresh originalBuffer/originalNbt, via a write()+read()
  // round trip through the *same* NbtFile settings (name/compression/
  // littleEndian/bedrockHeader) the upload already had. This is the "reload
  // the litematic" step: from this point on, stacking and the Download button all treat the edited layout as the new base,
  // exactly as if it had been uploaded that way to begin with.
  async function saveRegionEditsAsOriginal() {
    if (!currentActiveRoot || !originalNbt) return;

    const rebuilt = new deepslate.NbtFile(
      originalNbt.name, currentActiveRoot, originalNbt.compression,
      originalNbt.littleEndian, originalNbt.bedrockHeader
    );
    const bytes = rebuilt.write();
    originalBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    originalNbt = deepslate.NbtFile.read(new Uint8Array(originalBuffer));

    // Drop cluster entries for regions that no longer exist (e.g. one was
    // just deleted), and clusters left empty by that.
    const remainingNames = new Set(originalNbt.root.get('Regions').keys());
    clusters = clusters
      .map(c => ({ regions: c.regions.filter(r => remainingNames.has(r.name)) }))
      .filter(c => c.regions.length);
    activeCluster = Math.min(activeCluster, Math.max(0, clusters.length - 1));
    renderClusterList();

    hasUnsavedRegionEdits = false;
    updateSaveEditsButton();
    selectedRegionName = null;
    selectionMesh = null;
    updateSelectionHud(null);
    currentExtLink = null; // baked edits no longer match the original source URL
    clearConfigFromUrl();

    syncVersionInput(originalNbt);
    updateManualStatus();

    if (hasStackableCluster()) {
      await applyManualStack();
    } else {
      await renderStructure(originalNbt);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getEnclosing = (root) => {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  };

  // ── Size probing ───────────────────────────────────────────────────────────
  // Stacking grows the structure linearly, so to turn a wanted size back into
  // a cycle count we measure the size at two settings and interpolate.
  // Results are cached per loaded file (originalBuffer never changes until a
  // new file is loaded or edits are saved, which swaps the buffer).
  const probeCache = new WeakMap();
  const readEnclosing = root => {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { x: n('x'), y: n('y'), z: n('z') };
  };
  function memoProbe(key, compute) {
    let cache = probeCache.get(originalBuffer);
    if (!cache) { cache = new Map(); probeCache.set(originalBuffer, cache); }
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  }
  const parseOriginal = () => deepslate.NbtFile.read(new Uint8Array(originalBuffer));

  function probeManualSize(cycles, gap = readClusterGap()) {
    // Clusters and gap are part of the key: the same file gives different
    // sizes when they change.
    const key = `m|${cycles}|${gap}|${JSON.stringify(clusters)}`;
    return memoProbe(key, () => {
      const plans = planClusters(getOriginalRegionWorlds(), clusters, cycles, gap);
      return readEnclosing(stackClusters(parseOriginal(), plans).nbt.root);
    });
  }

  // Describes which size axes are editable, so the size card can render them
  // as steppers with a short "what this does" note: every axis a cluster
  // grows along changes Cycles; an axis clusters sit side by side on (and
  // don't grow along) changes the Cluster gap.
  function describeEditableAxes(plans) {
    const ok = (plans || []).filter(p => p.ok);
    const out = [];
    try {
      const growthAxes = [...new Set(ok.map(p => p.axis))];
      if (growthAxes.length) {
        const s1 = probeManualSize(1), s2 = probeManualSize(2);
        for (const axis of growthAxes) {
          const per = s2[axis] - s1[axis];
          out.push({ axis, role: 'cycle', note: per > 0 ? `+${per} per cycle` : 'cycles' });
        }
      }
      const gapAxes = [...new Set(ok.flatMap(p => p.gapSides))].filter(a => !growthAxes.includes(a));
      if (gapAxes.length) {
        const cycles = readCycles();
        const g0 = probeManualSize(cycles, 0), g1 = probeManualSize(cycles, 1);
        for (const axis of gapAxes) {
          const per = g1[axis] - g0[axis];
          if (per > 0) out.push({ axis, role: 'gap', note: `+${per} per gap block` });
        }
      }
    } catch (err) {
      console.error('Failed to describe editable axes:', err);
    }
    return out;
  }

  // Renders the size card: one cell per axis (X / Y / Z). Axes that stacking
  // can change get −/+ buttons and an editable field with a note saying what
  // moving them does; the rest are read-only. Typing a size and pressing
  // Enter (or leaving the field) finds the cycle count (or cluster gap) that
  // gets closest to it.
  function updateEnclosingSizeDisplay(w, h, d, editable = []) {
    sizeEditable = editable;
    const container = document.getElementById('enclosing-size-display');
    const dims = { x: w, y: h, z: d };
    const byAxis = Object.fromEntries(editable.map(e => [e.axis, e]));

    // One row per axis: tag · value (or −/input/+ when editable) · note.
    container.innerHTML = ['x', 'y', 'z'].map(axis => {
      const e = byAxis[axis];
      const tag = `<span class="size-axis-tag axis-${axis}">${axis.toUpperCase()}</span>`;
      if (!e) {
        return `<div class="size-row">${tag}<span class="size-value">${dims[axis]}</span><span class="size-note">fixed</span></div>`;
      }
      return `<div class="size-row editable">${tag}
        <div class="size-field">
          <button type="button" class="size-step" data-axis="${axis}" data-delta="-1" title="One less">−</button>
          <input type="number" min="1" step="1" class="size-axis-input size-axis-editable" data-axis="${axis}" value="${dims[axis]}">
          <button type="button" class="size-step" data-axis="${axis}" data-delta="1" title="One more">+</button>
        </div>
        <span class="size-note">${esc(e.note)}</span></div>`;
    }).join('');

    // −/+ move the underlying control (Cycles or Cluster gap) by one unit.
    const controlFor = axis => document.getElementById(byAxis[axis]?.role === 'gap' ? 'cluster-gap' : 'stack-count');
    container.querySelectorAll('.size-step').forEach(btn => btn.addEventListener('click', () => {
      stepNumberInput(controlFor(btn.dataset.axis), parseInt(btn.dataset.delta, 10));
    }));

    container.querySelectorAll('input.size-axis-editable').forEach(input => {
      const axis = input.dataset.axis;
      let committing = false;
      const commit = async () => {
        if (committing) return;
        committing = true;
        const target = Math.max(1, parseInt(input.value, 10) || 1);
        if (target !== dims[axis]) {
          if (byAxis[axis]?.role === 'gap') await applyTargetGapSize(target, axis);
          else await applyTargetCycleSize(target, axis);
        }
        committing = false;
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', commit);
    });
  }

  // Bumps a number input by `delta` (respecting its min) and fires the same
  // 'change' event a typed edit would, so all existing listeners run.
  function stepNumberInput(input, delta) {
    if (!input) return;
    const min = input.min !== '' ? Number(input.min) : -Infinity;
    const next = Math.max(min, (parseInt(input.value, 10) || 0) + delta);
    if (String(next) === input.value) return;
    input.value = next;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Finds the cycle count (the Cycles field) whose resulting size along
  // `axis` is closest to the target (growth is linear per cycle), applies
  // it, and re-renders.
  async function applyTargetCycleSize(targetSize, axis) {
    if (!originalBuffer || !hasStackableCluster()) return;

    let size1, size2;
    try {
      size1 = probeManualSize(1)[axis];
      size2 = probeManualSize(2)[axis];
    } catch (err) {
      console.error('Failed to probe size for target cycles:', err);
      return;
    }

    const perCycle = size2 - size1;
    const needed = perCycle > 0
      ? Math.max(1, Math.round(1 + (targetSize - size1) / perCycle))
      : 1;

    document.getElementById('stack-count').value = needed;
    renderClusterList();
    await applyManualStack();
  }

  // Finds the cluster gap whose resulting size along `axis` is closest to
  // the target (each gap block adds a fixed amount), applies it, re-renders.
  async function applyTargetGapSize(targetSize, axis) {
    if (!originalBuffer || !hasStackableCluster()) return;

    let size0, size1;
    try {
      const cycles = readCycles();
      size0 = probeManualSize(cycles, 0)[axis];
      size1 = probeManualSize(cycles, 1)[axis];
    } catch (err) {
      console.error('Failed to probe size for target gap:', err);
      return;
    }

    const perGap = size1 - size0;
    const needed = perGap > 0 ? Math.max(0, Math.round((targetSize - size0) / perGap)) : 0;

    document.getElementById('cluster-gap').value = needed;
    renderClusterList();
    await applyManualStack();
  }

  function rebuildWithYRange(minY, maxY) {
    if (!currentBuilder) return;
    currentStructure = currentBuilder.buildStructure(minY, maxY);
    if (currentRenderer) {
      currentRenderer.setStructure(currentStructure);
      currentCamera?.redraw();
    }
  }

  // ── Cluster stacking ───────────────────────────────────────────────────────

  // World-space info for every region of the *original* file (what stacking
  // actually operates on), memoized per loaded file.
  function getOriginalRegionWorlds() {
    return memoProbe('regionWorlds', () => getRegionWorlds(parseOriginal()));
  }

  const clusterName = i => (i < 26 ? String.fromCharCode(65 + i) : `C${i + 1}`);
  const readCycles = () => Math.max(1, parseInt(document.getElementById('stack-count').value, 10) || 1);
  const readClusterGap = () => Math.max(0, parseInt(document.getElementById('cluster-gap').value, 10) || 0);
  const ROLE_ORDER = ['region', 'step', 'cap'];
  const ROLE_COLOR = { region: REGION_COLOR, step: STEP_COLOR, cap: CAP_COLOR };

  // Plans for the saved clusters (see planClusters), or null without a file.
  function currentPlans() {
    if (!originalBuffer || !clusters.length) return null;
    try {
      return planClusters(getOriginalRegionWorlds(), clusters, readCycles(), readClusterGap());
    } catch (err) {
      console.error('Failed to plan clusters:', err);
      return null;
    }
  }
  function hasStackableCluster() {
    return !!currentPlans()?.some(p => p.ok);
  }

  // Adds the selected region to the active cluster with `role` (creating
  // cluster A if there's none yet). A region belongs to one cluster with one
  // role, so it's taken out of wherever it was before.
  async function addSelectedToCluster(role) {
    const name = selectedRegionName;
    if (!name || !originalBuffer) return;
    const status = document.getElementById('manual-status');
    if (!getOriginalRegionWorlds()[name]) {
      status.textContent = `"${name}" is a generated copy, not an original region. Pick an original one.`;
      return;
    }
    if (!clusters.length) { clusters.push({ regions: [] }); activeCluster = 0; }
    for (const c of clusters) c.regions = c.regions.filter(r => r.name !== name);
    clusters[activeCluster].regions.push({ name, role });
    status.textContent = '';
    await clustersChanged();
  }

  // Refreshes the panel and the 3D view after any change to the clusters:
  // stacks when at least one cluster is complete, otherwise shows the plain
  // structure (only re-rendering if a stacked result is on screen).
  async function clustersChanged() {
    renderClusterList();
    updateManualStatus();
    if (!originalBuffer) return;
    if (hasStackableCluster()) {
      await applyManualStack();
      return;
    }
    if (clusters.length) syncConfigToUrl(); else clearConfigFromUrl();
    if (lastStackedNbt) await renderStructure(parseOriginal());
  }

  // Paints every cluster region in the 3D view by role: Region red, Step
  // green, Cap blue. On a stacked result the Step copies are painted too.
  function rebuildMarkerMeshes() {
    markerMeshes = [];
    if (currentBuilder) {
      const bounds = currentBuilder.getRegionBoundsLocal();
      const roles = {};
      clusters.forEach((c, i) => c.regions.forEach(r => { roles[r.name] = { cluster: i, role: r.role }; }));
      if (lastStackedNbt && lastRoles) Object.assign(roles, lastRoles);
      for (const [name, { role }] of Object.entries(roles)) {
        const b = bounds[name];
        if (!b) continue;
        markerMeshes.push(buildBoxFillMesh(gl, b.min, [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1], ROLE_COLOR[role]));
      }
    }
    currentCamera?.redraw();
  }

  // One card per cluster: its regions grouped by role (each removable), how
  // it grows and what pushed it. Clicking a card makes it the active one.
  function renderClusterList() {
    const container = document.getElementById('manual-config-list');
    container.innerHTML = '';
    if (!clusters.length) return;

    const plans = currentPlans();

    clusters.forEach((cluster, i) => {
      const plan = plans?.[i];
      const lines = [];
      if (!cluster.regions.length) {
        lines.push('<div class="pair-meta">Empty: select a region and add it.</div>');
      } else {
        for (const role of ROLE_ORDER) {
          for (const r of cluster.regions.filter(r => r.role === role)) {
            lines.push(`<div class="pair-line"><span class="slot-tag ${role}">${role.toUpperCase()}</span>` +
              `<span class="pair-name">${esc(r.name)}</span>` +
              `<button type="button" class="icon-btn cluster-remove-region" data-cluster="${i}" data-name="${esc(r.name)}" title="Take out of the cluster">✕</button></div>`);
          }
        }
        let meta = '…';
        if (plan && !plan.ok) {
          meta = `⚠️ ${plan.error}`;
        } else if (plan) {
          const parts = [`grows ${plan.dir > 0 ? '+' : '−'}${plan.axis.toUpperCase()}`, `step ${plan.stride}`, `×${plan.count}`];
          if (plan.capGap) parts.push(`${plan.capGap}-block gap kept`);
          const pushes = Object.entries(plan.pushedBy).map(([key, { by, amount }]) => key.startsWith('gap ')
            ? `${amount} ${key.slice(4)} (gap after ${clusterName(by)})`
            : `${amount} ${key} (by ${clusterName(by)})`);
          if (pushes.length) parts.push(`pushed ${pushes.join(', ')}`);
          meta = parts.join(' · ') + plan.warnings.map(w => ` · ⚠️ ${w}`).join('');
        }
        lines.push(`<div class="pair-meta">${esc(meta)}</div>`);
      }

      const card = document.createElement('div');
      card.className = 'pair-card cluster-card' + (i === activeCluster ? ' active' : '') + (plan && !plan.ok ? ' pair-card-error' : '');
      card.dataset.cluster = i;
      card.title = i === activeCluster ? 'New regions are added to this cluster' : 'Click to add new regions to this cluster';
      card.innerHTML = `
        <span class="pair-index">${clusterName(i)}</span>
        <div class="pair-body">${lines.join('')}</div>
        <button type="button" data-cluster="${i}" class="cluster-remove icon-btn" title="Delete this cluster">✕</button>
      `;
      container.appendChild(card);
    });
  }

  document.getElementById('manual-config-list').addEventListener('click', async e => {
    const removeRegion = e.target.closest('.cluster-remove-region');
    const removeCluster = e.target.closest('.cluster-remove');
    const card = e.target.closest('.cluster-card');
    if (removeRegion) {
      const c = clusters[parseInt(removeRegion.dataset.cluster, 10)];
      if (c) c.regions = c.regions.filter(r => r.name !== removeRegion.dataset.name);
      await clustersChanged();
    } else if (removeCluster) {
      const i = parseInt(removeCluster.dataset.cluster, 10);
      clusters.splice(i, 1);
      if (activeCluster >= i) activeCluster = Math.max(0, activeCluster - 1);
      await clustersChanged();
    } else if (card) {
      activeCluster = parseInt(card.dataset.cluster, 10);
      renderClusterList();
      updateManualStatus();
    }
  });

  // Refreshes everything in the panel that depends on the selection or the
  // clusters: the selected-region line, the add buttons (panel and 3D HUD),
  // which cluster they add to, the Copy button and the 3D highlights.
  function updateManualStatus() {
    const sel = selectedRegionName;
    document.getElementById('manual-selected-name').textContent = sel || 'click a region in the 3D view';
    document.getElementById('manual-selected').classList.toggle('empty', !sel);

    const target = clusterName(clusters.length ? activeCluster : 0);
    document.getElementById('cluster-add-label').textContent =
      clusters.length ? `Add to cluster ${target} as` : 'Add to a new cluster A as';
    document.getElementById('hud-cluster-label').textContent = `→ ${target}`;
    for (const id of ['add-as-region', 'add-as-step', 'add-as-cap', 'hud-add-region', 'hud-add-step', 'hud-add-cap']) {
      document.getElementById(id).disabled = !sel;
    }

    const copyBtn = document.getElementById('manual-copy-link');
    copyBtn.disabled = !clusters.length;
    copyBtn.title = 'Copy the encoded stacking config (clusters, cycles and cluster gap)';

    rebuildMarkerMeshes();
  }

  // Stacks the original structure with the current clusters, cycles and
  // cluster gap (see planClusters / stackClusters) and renders the result.
  async function applyManualStack() {
    if (!originalBuffer) return;
    const plans = currentPlans();
    if (!plans?.some(p => p.ok)) return;

    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Stacking clusters...';

    let result;
    try {
      result = stackClusters(parseOriginal(), plans);
    } catch (err) {
      console.error(err);
      progressDisplay.style.display = 'none';
      document.getElementById('manual-status').textContent = err.message;
      return;
    }

    // Per-cluster details are on each card; this line is for edit warnings.
    document.getElementById('manual-status').textContent = hasUnsavedRegionEdits
      ? 'Heads up: stacking uses the layout from the last save, not your unsaved edits.'
      : '';

    renderClusterList();
    syncConfigToUrl();

    lastStackedNbt = result.nbt;
    lastRoles = result.roles;

    const root = result.nbt.root || result.nbt;
    currentActiveRoot = root;
    const { w, h, d } = getEnclosing(root);
    updateEnclosingSizeDisplay(w, h, d, describeEditableAxes(plans));

    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, root.get("Regions"), w, h, d);
  }

  // Copies the encoded stacking config (the same string used for the URL's
  // `config` parameter) to the clipboard.
  function copyManualStackingConfig() {
    if (!clusters.length) {
      alert('Make a cluster first.');
      return;
    }

    syncConfigToUrl();
    const config = encodeStackConfig(clusters, readCycles(), readClusterGap());

    const copy = navigator.clipboard?.writeText(config) ?? Promise.reject();
    copy.then(() => {
      alert('Stacking config copied to clipboard!');
    }).catch(() => {
      prompt('Copy this stacking config:', config);
    });
  }

  // With a preloaded config, the Size card is moved up right under the
  // download buttons, so everything needed to resize and download is
  // visible without scrolling. Otherwise it sits in its normal spot at
  // the bottom of the panel.
  const sizeSection = document.getElementById('size-section');
  const sizeSectionHome = { parent: sizeSection.parentNode, next: sizeSection.nextSibling };
  function placeSizeSectionAtTop(top) {
    if (top) {
      document.querySelector('.file-actions').after(sizeSection);
    } else {
      sizeSectionHome.parent.insertBefore(sizeSection, sizeSectionHome.next);
    }
  }

  // If the URL has a `config` parameter, restores it onto whatever file was
  // just loaded (regardless of whether it came from ?ext_link= or a manual
  // upload) and applies it immediately. Returns true if a config was found
  // and applied, false otherwise — callers should render the plain structure
  // when this returns false.
  async function restoreManualConfigFromUrl() {
    const configParam = new URLSearchParams(window.location.search).get('config');
    const decoded = configParam ? decodeStackConfig(configParam) : null;
    if (configParam && !decoded) {
      console.warn('Failed to parse manual stacking config from URL; showing the plain structure.');
    }
    placeSizeSectionAtTop(!!decoded);
    if (!decoded) return false;

    clusters = decoded.clusters;
    activeCluster = 0;
    document.getElementById('stack-count').value = decoded.cycles;
    document.getElementById('cluster-gap').value = decoded.gap;
    renderClusterList();
    updateManualStatus();
    if (!hasStackableCluster()) return false;
    await applyManualStack();
    return true;
  }

  // Keeps the address bar's `config` parameter (and `ext_link`, if known) in
  // sync with the currently-applied manual stacking configuration, without
  // adding browser history entries. Called automatically every time a
  // manual stack is (re-)applied.
  function syncConfigToUrl() {
    if (!clusters.length) return;

    const config = encodeStackConfig(clusters, readCycles(), readClusterGap());

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

    // Orthographic support: deepslate hard-codes a perspective projection, so
    // after its prepareDraw() has uploaded that one, overwrite the active
    // program's mProj uniform with an orthographic matrix while the camera
    // is in ortho mode. Every draw path (structure, grid, region boxes,
    // selection) goes through prepareDraw, so they all pick this up.
    const basePrepareDraw = renderer.prepareDraw.bind(renderer);
    renderer.prepareDraw = view => {
      basePrepareDraw(view);
      const cam = currentCamera;
      if (!cam || !cam.ortho) return;
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      const loc = program && gl.getUniformLocation(program, 'mProj');
      if (loc) gl.uniformMatrix4fv(loc, false, cam.getOrthoProjection(canvasAspect()));
    };

    const bounds = builder.getActualBounds();
    const center = ['x', 'y', 'z'].map(k => (bounds[`min${k.toUpperCase()}`] + bounds[`max${k.toUpperCase()}`]) / 2);
    // Only used when there's no previous camera to inherit from (first
    // load of a structure) — see prevCameraState below. A user's manual
    // zoom/pan is never overridden by this.
    const fitViewDist = computeFitViewDist(bounds, canvas);

    // Carry the previous camera's rotation/zoom/position forward instead of
    // resetting to defaults every time this runs (e.g. on every stack-count
    // change). Only fall back to the freshly-computed center/default zoom
    // when there's no prior camera to inherit from (first load).
    const prevCameraState = currentCamera ? {
      xRotation: currentCamera.xRotation,
      yRotation: currentCamera.yRotation,
      viewDist: currentCamera.viewDist,
      center: currentCamera.center,
      ortho: currentCamera.ortho,
    } : null;

    currentCamera?.destroy();
    Object.assign({ currentBuilder: builder, currentStructure: structure, currentRenderer: renderer },
      (currentBuilder = builder, currentStructure = structure, currentRenderer = renderer, {}));

    // Built once here (not inside the render callback), so region boxes are
    // reused across every frame instead of being rebuilt each render.
    currentRegionMeshes = buildRegionMeshes(gl, builder);
    selectedRegionName = null;
    selectionMesh = null;
    updateSelectionHud(null);

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
      if (showClusterHighlight && markerMeshes.length) {
        // Blue (Step) / orange (Cap) highlights for the pair being built.
        renderer.setShader(selectionShaderProgram);
        renderer.prepareDraw(view);
        gl.disable(gl.CULL_FACE);
        markerMeshes.forEach(m => renderer.drawMesh(m, { pos: true, color: true }));
        gl.enable(gl.CULL_FACE);
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
    }, prevCameraState ? prevCameraState.center : center, prevCameraState ? prevCameraState.viewDist : fitViewDist, (clientX, clientY, viewMatrix) => {
      const boundsByRegion = currentBuilder.getRegionBoundsLocal();
      const regionName = pickRegionAt(canvas, clientX, clientY, viewMatrix, getActiveProjMatrix(), boundsByRegion);
      selectRegion(regionName);
    });

    // Rotation isn't a constructor param, so restore it post-construction.
    // Safe to do synchronously: the constructor's own redraw() is deferred
    // via requestAnimationFrame, so this runs before the first render.
    if (prevCameraState) {
      currentCamera.xRotation = prevCameraState.xRotation;
      currentCamera.yRotation = prevCameraState.yRotation;
      currentCamera.ortho = !!prevCameraState.ortho;
    }
    currentCamera.depthRadius = 0.5 * Math.hypot(
      bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
    currentCamera.onViewChange = updateViewToolbar;
    updateViewToolbar();
    updateManualStatus(); // also rebuilds the Step/Cap highlights for the new builder

    // Exposed so index.html's window-resize handler (and any external
    // driver, e.g. a headless screenshot script) can force a redraw after
    // resizing the canvas — see the `resize` listener in index.html.
    window.mevRenderer = currentCamera;

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

    // Signal that a frame reflecting the current structure/camera is on
    // screen. Deferred one frame so the InteractiveCanvas's own initial
    // redraw() (scheduled via requestAnimationFrame in its constructor)
    // has actually run and the canvas isn't blank/stale when read.
    requestAnimationFrame(() => {
      window.mevRendererReady = true;
      window.dispatchEvent(new CustomEvent('mev-render-complete'));
    });
  }

  // ── Main render entry point ────────────────────────────────────────────────
  // Renders an unstacked structure (stacked results go through applyManualStack).
  async function renderStructure(nbt) {
    // Cleared here and set once buildAndRender finishes below — a headless
    // screenshot tool can poll/await window.mevRendererReady (or listen for
    // the 'mev-render-complete' event) instead of guessing a fixed delay.
    // See docs/headless-render.md.
    window.mevRendererReady = false;
    progressDisplay.style.display = 'block';
    progressDisplay.textContent = 'Loading structure...';

    const root = nbt.root || nbt;
    lastStackedNbt = null;
    currentActiveRoot = root;

    const { w, h, d } = getEnclosing(root);
    // Always show the size; only stacked renders have editable axes.
    updateEnclosingSizeDisplay(w, h, d, []);

    const builder = new StructureBuilder(w, h, d);
    await buildAndRender(builder, root.get("Regions"), w, h, d);
  }

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
    hasUnsavedRegionEdits = false;
    updateSaveEditsButton();
    showRegionEditControls(true);

    // A `config` parameter means a manual stacking configuration should be
    // restored onto this file — regardless of whether it came via ?ext_link=
    // or a manual upload (see the file-input handler below for the other case).
    if (await restoreManualConfigFromUrl()) return;

    await renderStructure(nbt);
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
  // Movement is applied immediately (so held/repeated keys accumulate
  // correctly) but the expensive full rebuild is debounced.
  const debouncedRegionRerender = debounce(rerenderCurrentRegions, 100);

  // ── Keyboard controls for the selected region ──────────────────────────────
  // Arrow keys nudge the selection on the horizontal (X/Z) plane, "h"/"y"
  // nudge it up/down on the vertical (Y) axis, and Delete (the "Supr" key)
  // removes it. Remap by editing REGION_MOVE_KEYS below.
  const REGION_MOVE_KEYS = {
    ArrowLeft: ['x', -1], ArrowRight: ['x', 1],
    ArrowUp: ['z', -1], ArrowDown: ['z', 1],
    h: ['y', 1], H: ['y', 1],   // "h" raises the region
    y: ['y', -1], Y: ['y', -1], // "y" lowers the region
  };

  document.addEventListener('keydown', e => {
    // Escape always closes the clone GUI, even while an offset input is
    // focused (checked before the input-tag bailout below).
    if (cloneGuiOpen && e.key === 'Escape') {
      e.preventDefault();
      closeCloneGui();
      return;
    }

    // Don't hijack typing in the stack-count/version/size/clone-offset
    // number inputs — except Enter inside a clone-offset input, which
    // confirms the clone instead of doing nothing.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (cloneGuiOpen && e.key === 'Enter' && document.activeElement.closest('#clone-gui')) {
        e.preventDefault();
        performClone();
      }
      return;
    }
    if (!selectedRegionName) return;

    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      cloneGuiOpen ? closeCloneGui() : openCloneGui();
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      deleteSelectedRegion();
      return;
    }

    const binding = REGION_MOVE_KEYS[e.key];
    if (!binding) return;
    e.preventDefault();
    const [axis, delta] = binding;
    moveSelectedRegion(axis === 'x' ? delta : 0, axis === 'y' ? delta : 0, axis === 'z' ? delta : 0);
  });

  // Cycles and Cluster gap both re-stack with the current clusters.
  const onStackSettingChange = async () => {
    renderClusterList();
    if (hasStackableCluster()) await applyManualStack();
  };
  document.getElementById('stack-count').addEventListener('change', onStackSettingChange);
  document.getElementById('cluster-gap').addEventListener('change', onStackSettingChange);

  // −/+ buttons next to number inputs (Cycles, Cluster gap): data-step-target
  // names the input, data-delta the amount.
  document.querySelectorAll('[data-step-target]').forEach(btn => btn.addEventListener('click', () => {
    stepNumberInput(document.getElementById(btn.dataset.stepTarget), parseInt(btn.dataset.delta, 10));
    btn.blur();
  }));

  // Region / Step / Cap: add the selected region to the active cluster, from
  // the panel or the quick buttons in the 3D HUD.
  for (const role of ['region', 'step', 'cap']) {
    for (const id of [`add-as-${role}`, `hud-add-${role}`]) {
      document.getElementById(id).addEventListener('click', e => { e.currentTarget.blur(); addSelectedToCluster(role); });
    }
  }
  document.getElementById('add-cluster').addEventListener('click', e => {
    e.currentTarget.blur();
    clusters.push({ regions: [] });
    activeCluster = clusters.length - 1;
    renderClusterList();
    updateManualStatus();
  });
  document.getElementById('manual-clear-configs').addEventListener('click', async () => {
    clusters = [];
    activeCluster = 0;
    document.getElementById('manual-status').textContent = '';
    await clustersChanged();
  });
  document.getElementById('manual-copy-link').addEventListener('click', () => copyManualStackingConfig());
  document.getElementById('save-region-edits').addEventListener('click', () => saveRegionEditsAsOriginal());

  document.getElementById('clone-confirm').addEventListener('click', () => performClone());
  document.getElementById('clone-cancel').addEventListener('click', () => closeCloneGui());

  // ── Orthographic view toolbar ──────────────────────────────────────────────
  function canvasAspect() {
    return (canvas.clientWidth || canvas.width || 1) / (canvas.clientHeight || canvas.height || 1);
  }

  // Projection currently on screen, so click-picking unprojects correctly in
  // both perspective and orthographic mode.
  function getActiveProjMatrix() {
    if (currentCamera?.ortho) return currentCamera.getOrthoProjection(canvasAspect());
    return currentRenderer.projMatrix;
  }

  function updateViewToolbar() {
    const bar = document.getElementById('view-toolbar');
    if (!bar) return;
    const ortho = !!currentCamera?.ortho;
    const active = ortho ? matchViewPreset(currentCamera.xRotation, currentCamera.yRotation) : null;
    bar.querySelectorAll('button[data-view]').forEach(b =>
      b.classList.toggle('active', b.dataset.view === active));
    bar.querySelectorAll('button[data-projection]').forEach(b =>
      b.classList.toggle('active', (b.dataset.projection === 'orthographic') === ortho));
  }

  document.getElementById('view-toolbar')?.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn || !currentCamera) return;
    if (btn.dataset.projection) {
      currentCamera.ortho = btn.dataset.projection === 'orthographic';
      currentCamera.redraw();
      updateViewToolbar();
    } else if (btn.dataset.view && VIEW_PRESETS[btn.dataset.view]) {
      const p = VIEW_PRESETS[btn.dataset.view];
      currentCamera.ortho = true;
      // The camera is still at the old angle until the animation runs, so
      // highlight the clicked preset right away, then re-check at the end.
      updateViewToolbar();
      e.currentTarget.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b === btn));
      currentCamera.animateTo(p.x, p.y, undefined, updateViewToolbar);
    }
    // Drop focus so Space/Shift (camera up/down) don't re-trigger the button.
    btn.blur();
  });

  document.getElementById('clear-button').addEventListener('click', () => {
    currentCamera?.destroy();
    gl?.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    currentStructure = currentRenderer = currentCamera = currentBuilder = null;
    originalBuffer = lastStackedNbt = null;
    originalNbt = null;
    currentRegionMeshes = [];
    selectedRegionName = null;
    selectionMesh = null;
    markerMeshes = [];
    sizeEditable = [];
    updateSelectionHud(null);
    clusters = [];
    activeCluster = 0;
    lastRoles = null;
    currentExtLink = null;
    currentActiveRoot = null;
    hasUnsavedRegionEdits = false;
    updateSaveEditsButton();
    closeCloneGui();
    showRegionEditControls(false);
    placeSizeSectionAtTop(false);
    renderClusterList();
    updateManualStatus();
    clearConfigFromUrl();
    document.getElementById('enclosing-size-display').innerHTML = '';
    document.getElementById('slider-container').classList.remove('active');
    document.getElementById('file-input').value = '';
    document.getElementById('stack-count').value = 1;
    document.getElementById('cluster-gap').value = 0;
    document.getElementById('version-controls').style.display = 'none';
    document.getElementById('version-override').value = '';
    document.getElementById('manual-status').textContent = '';
  });

  // Name of the loaded litematic: the uploaded file's name, or the last path
  // segment of the ?ext_link= URL. Empty string if neither is known.
  function getSourceFileName() {
    const uploaded = document.getElementById('file-input').files[0]?.name;
    if (uploaded) return uploaded;
    if (!currentExtLink) return '';
    try {
      return decodeURIComponent(currentExtLink.split(/[?#]/)[0].split('/').pop() || '');
    } catch {
      return currentExtLink.split(/[?#]/)[0].split('/').pop() || '';
    }
  }

  // Source file name without its .litematic extension, for building download names.
  function getSourceBaseName() {
    return getSourceFileName().replace(/\.litematic$/i, '').trim() || 'structure';
  }

  document.getElementById('download-materials').addEventListener('click', () => {
    if (!currentBuilder) return alert("No structure loaded!");
    const meta = currentActiveRoot?.get?.('Metadata') ?? originalNbt?.root?.get?.('Metadata');
    const str = key => { const t = meta?.get?.(key); return (t?.getAsString?.() ?? t?.value ?? '').toString().trim(); };
    const b = currentBuilder.getActualBounds();
    const fileName = getSourceFileName();
    openMaterialsDialog(currentBuilder, {
      name: str('Name'),
      author: str('Author'),
      fileName,
      size: [b.maxX - b.minX + 1, b.maxY - b.minY + 1, b.maxZ - b.minZ + 1],
    });
  });

  // Warm the item catalog in the background so icons are ready on first open.
  loadItemCatalog();

  document.getElementById('toggle-grid').addEventListener('change', (e) => {
    showGrid = e.target.checked;
    currentCamera?.redraw(); // force re-render
  });

  document.getElementById('toggle-region-boxes').addEventListener('change', (e) => {
    showRegionBoxes = e.target.checked;
    currentCamera?.redraw(); // force re-render
  });

  document.getElementById('toggle-cluster-highlight').addEventListener('change', (e) => {
    showClusterHighlight = e.target.checked;
    currentCamera?.redraw(); // force re-render
  });

  document.getElementById('download-litematic').addEventListener('click', () => {
    // Stacking produces its own dedicated NbtFile in
    // lastStackedNbt — prefer that when present. Otherwise, fall back to
    // whatever's actually on screen (the original load, or any moves/
    // deletes/clones applied to it) by wrapping currentActiveRoot in a
    // fresh NbtFile using the original upload's file settings, the same
    // way saveRegionEditsAsOriginal() does.
    const nbtToDownload = lastStackedNbt ?? (currentActiveRoot && originalNbt
      ? new deepslate.NbtFile(
          originalNbt.name, currentActiveRoot, originalNbt.compression,
          originalNbt.littleEndian, originalNbt.bedrockHeader
        )
      : null);

    if (!nbtToDownload) return alert("Load a litematic first!");

    const base = getSourceBaseName();

    if (!lastStackedNbt) {
      downloadLitematic(nbtToDownload, `${base}_edited.litematic`);
      return;
    }

    const gap = readClusterGap();
    downloadLitematic(nbtToDownload, `${base}_stack${readCycles()}x${gap ? `_gap${gap}` : ''}.litematic`);
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
    updateManualStatus();
    hasUnsavedRegionEdits = false;
    updateSaveEditsButton();
    showRegionEditControls(true);

    // If the URL already carries a manual stacking `config` (e.g. the page
    // was opened via a shared link but the litematic itself had to be
    // uploaded manually), restore and apply it onto this file too.
    if (await restoreManualConfigFromUrl()) return;

    await renderStructure(nbt);
  });

  // ── Auto-load from URL param if present ───────────────────────────────────
  await loadFromExtLink();
}

init();