// src/embed.js
//
// A DOM-free API for turning a .litematic straight into an image, entirely
// in the visitor's own browser — no controls panel, no headless browser,
// no server. Meant to be embedded on any page (e.g. a GitHub Pages post):
//
//   <script src="https://unpkg.com/deepslate@0.25.1"></script>
//   <script src="https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/gl-matrix-min.js"></script>
//   <script src="https://unpkg.com/pako@2.1.0/dist/pako.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/YOU/mevrenderer@main/dist/mevrenderer-embed.js"></script>
//   <img id="preview">
//   <script>
//     mevrenderer.renderLitematicImage({ url: 'https://.../build.litematic' })
//       .then(dataUrl => { document.getElementById('preview').src = dataUrl; });
//   </script>
//
// (That last script is a UMD/IIFE bundle built from this file — see
// docs/embedding.md for the one-line esbuild command, and why a *raw*
// `<script src="src/embed.js">` can't work unbundled: this file is an ES
// module with `import`s, which only classic browsers' `<script
// type="module">` can load directly.)
//
// This intentionally does not reuse main.js/index.html's DOM (no
// #controls-panel, no #structure-display) — it builds everything it needs
// (an offscreen canvas, the structure, the camera) itself, so it works on
// a page that has none of that markup.

import { create3DBlocks } from './region.js';
import { loadBlockData, ResourceLoader, setBlocklistUrl } from './resources.js';
import { StructureBuilder } from './structure.js';
import { FastStructureRenderer } from './chunkMesher.js';

// When this file is loaded natively as an ES module, resources.js already
// resolves blocklist.json's URL itself (via import.meta.url). When it's
// instead been bundled into a classic, non-module <script src="..."> (an
// IIFE/UMD build — see docs/embedding.md for the one-line esbuild command),
// import.meta doesn't survive bundling, so it's resolved here instead,
// relative to *this* <script> tag's own src, via the standard
// document.currentScript trick — only reliable synchronously while a
// classic (non-async, non-dynamically-inserted) script is first executing,
// which is exactly the case for a plain <script src="...embed.js">.
//
// This assumes blocklist.json is hosted next to the bundled file (e.g. both
// in dist/). If it isn't, or this fallback doesn't fire for your setup,
// call mevrenderer.setBlocklistUrl(absoluteUrl) yourself before the first
// renderLitematicImage() call.
if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
  setBlocklistUrl(new URL('./blocklist.json', document.currentScript.src).toString());
}

export { setBlocklistUrl };

const { mat4, vec3 } = glMatrix;

// The block-definition/model/texture-atlas set is identical for every
// litematic, so it's loaded once per page and reused across every
// renderLitematicImage() call (e.g. a whole gallery of <img>s) instead of
// re-fetching several megabytes of Minecraft assets per image.
let resourcesPromise = null;
function getSharedResources(onProgress) {
  if (!resourcesPromise) {
    resourcesPromise = (async () => {
      const blockData = await loadBlockData();
      const loader = new ResourceLoader();
      await loader.load(blockData, onProgress);
      return loader.getResources();
    })();
  }
  return resourcesPromise;
}

function getEnclosing(root) {
  const enc = root.get('Metadata').get('EnclosingSize');
  const n = k => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
  return { w: n('x'), h: n('y'), d: n('z') };
}

// The mesher (chunkMesher.js) draws every block relative to the bounds' min
// corner, so the structure occupies [0, size] on each axis in render space —
// not [min, max]. Bounds' max values are inclusive block indices, hence +1.
function localBox(bounds) {
  return [
    bounds.maxX - bounds.minX + 1,
    bounds.maxY - bounds.minY + 1,
    bounds.maxZ - bounds.minZ + 1,
  ];
}

// Half-extents (in view-space units) of the box's 8 corners after rotating
// them by the camera's pitch/yaw, measured from the box center. Since a box
// is centrally symmetric, its projection is too — so aiming at the box
// center *and* fitting these extents frames it exactly, with equal margins.
function projectedHalfExtents(size, xRotation, yRotation) {
  const rot = mat4.create();
  mat4.rotate(rot, rot, xRotation, [1, 0, 0]);
  mat4.rotate(rot, rot, yRotation, [0, 1, 0]);
  let hx = 0, hy = 0, hz = 0;
  const v = vec3.create();
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    vec3.transformMat4(v, [sx * size[0], sy * size[1], sz * size[2]], rot);
    hx = Math.max(hx, Math.abs(v[0]));
    hy = Math.max(hy, Math.abs(v[1]));
    hz = Math.max(hz, Math.abs(v[2]));
  }
  return { hx, hy, hz };
}

// Perspective fallback: bounding-sphere fit (same idea as main.js's
// computeFitViewDist()), so the whole build stays in frame.
function computeFitViewDist(radius, width, height, marginFactor) {
  if (radius <= 0 || !Number.isFinite(radius)) return 4;
  const aspect = width / height;
  const vFov = 70 * Math.PI / 180;
  const hFov = 2 * Math.atan(aspect * Math.tan(vFov / 2));
  const limitingHalfAngle = Math.min(vFov, hFov) / 2;
  return Math.max((radius / Math.sin(limitingHalfAngle)) * marginFactor, 2);
}

function buildViewMatrix(center, viewDist, xRotation, yRotation) {
  const view = mat4.create();
  mat4.translate(view, view, [0, 0, -viewDist]);
  mat4.rotate(view, view, xRotation, [1, 0, 0]);
  mat4.rotate(view, view, yRotation, [0, 1, 0]);
  mat4.translate(view, view, [-center[0], -center[1], -center[2]]);
  return view;
}

// Normalizes any CSS color string to [r,g,b] in 0..1, via a scratch 2D
// canvas (so it accepts anything CSS does: 'skyblue', '#112233', 'rgb(...)').
function parseCssColor(css) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  const normalized = ctx.fillStyle;
  const hex = normalized.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = normalized.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map(v => parseFloat(v) / 255);
    return [r, g, b];
  }
  return [0.1, 0.1, 0.1];
}

/**
 * Renders a .litematic to a still image, resolving with a PNG data URL
 * (ready to drop straight into an <img src>), or a Blob if `asBlob: true`.
 *
 * @param {object} options
 * @param {string} [options.url] - URL of the .litematic to fetch. Give
 *   either this or `buffer`.
 * @param {ArrayBuffer|Uint8Array} [options.buffer] - an already-fetched/
 *   read .litematic, if you'd rather load it yourself (e.g. a <input
 *   type=file>) than have this function fetch a URL.
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @param {'orthographic'|'perspective'} [options.projection='orthographic']
 *   - orthographic gives a true isometric look with a tight fit; perspective
 *   uses a 70° FOV like the main viewer.
 * @param {number} [options.xRotation] - camera pitch, in radians. Defaults
 *   to the isometric pitch, atan(1/√2) ≈ 35.26°.
 * @param {number} [options.yRotation] - camera yaw, in radians. Defaults to
 *   -π/4 (the main viewer's "iso" preset). The framing is always auto-fit
 *   and centered on the structure, at any angle you pick.
 * @param {number} [options.padding=0.06] - empty margin around the build,
 *   as a fraction of the image size.
 * @param {string|null} [options.background='#1a1a1a'] - CSS color cleared
 *   behind the structure, or `null` for a transparent PNG.
 * @param {boolean} [options.asBlob=false] - resolve with a Blob instead of
 *   a data URL (useful for `URL.createObjectURL()` on very large images,
 *   or for uploading the result somewhere).
 * @param {function} [options.onProgress] - ({stage, percent}) callback for
 *   the one-time (cached) resource load.
 * @returns {Promise<string|Blob>}
 */
export async function renderLitematicImage(options = {}) {
  const {
    url, buffer,
    width = 800, height = 600,
    projection = 'orthographic',
    xRotation = Math.atan(1 / Math.SQRT2), yRotation = -Math.PI / 4,
    padding = 0.06,
    background = '#1a1a1a',
    asBlob = false,
    onProgress = null,
  } = options;

  if (!url && !buffer) {
    throw new Error('renderLitematicImage: pass either `url` or `buffer`');
  }

  const [arrayBuffer, resources] = await Promise.all([
    buffer ?? fetch(url).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch litematic: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    getSharedResources(onProgress),
  ]);

  const nbt = deepslate.NbtFile.read(new Uint8Array(arrayBuffer));
  const root = nbt.root ?? nbt;
  const { w, h, d } = getEnclosing(root);

  const builder = new StructureBuilder(w, h, d);
  const regions = root.get('Regions');
  for (const name of regions.keys()) {
    // Decoded in time slices so a huge schematic doesn't freeze the page.
    let sliceStart = performance.now();
    for (const _ of builder.addRegionBlocksSteps(name, create3DBlocks(regions.get(name)))) {
      if (performance.now() - sliceStart > 30) {
        await new Promise(r => setTimeout(r, 0));
        sliceStart = performance.now();
      }
    }
  }

  // An offscreen canvas, never appended visibly — but it *is* briefly
  // attached (off-screen, via position/left rather than display:none) so
  // it has real layout dimensions: deepslate's Renderer computes its
  // aspect ratio from canvas.clientWidth/clientHeight, which are always 0
  // for an element that was never attached to the document at all.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '-100000px';
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.appendChild(canvas);

  try {
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser');

    gl.viewport(0, 0, width, height);
    if (background === null) {
      gl.clearColor(0, 0, 0, 0);
    } else {
      const [r, g, b] = parseCssColor(background);
      gl.clearColor(r, g, b, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const renderer = new FastStructureRenderer(gl, builder, resources);

    const size = localBox(builder.getActualBounds());
    const center = size.map(v => v / 2);
    const radius = 0.5 * Math.hypot(...size);
    const aspect = width / height;
    const margin = 1 / Math.max(0.05, 1 - 2 * padding);

    let view;
    if (projection === 'perspective') {
      const viewDist = computeFitViewDist(radius, width, height, margin);
      view = buildViewMatrix(center, viewDist, xRotation, yRotation);
      // deepslate's perspective stops at 500 blocks; fit the far plane to the build.
      const far = Math.max(500, viewDist + radius * 2 + 50);
      renderer.projMatrix = mat4.perspective(mat4.create(), 70 * Math.PI / 180, aspect, Math.max(0.1, far / 50000), far);
    } else {
      const { hx, hy, hz } = projectedHalfExtents(size, xRotation, yRotation);
      const halfH = Math.max(hy, hx / aspect, 0.5) * margin;
      const halfW = halfH * aspect;
      const viewDist = hz + 10;
      view = buildViewMatrix(center, viewDist, xRotation, yRotation);
      renderer.projMatrix = mat4.ortho(mat4.create(), -halfW, halfW, -halfH, halfH, 0.1, viewDist + hz + 10);
    }

    try {
      renderer.setFocus(center);
      await renderer.buildAll();
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      renderer.drawStructure(view);
    } finally {
      // The canvas is thrown away; free its GPU buffers right away.
      renderer.dispose();
    }

    return await new Promise((resolve, reject) => {
      if (asBlob) {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), 'image/png');
      } else {
        resolve(canvas.toDataURL('image/png'));
      }
    });
  } finally {
    canvas.remove();
  }
}
