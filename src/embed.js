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

const { StructureRenderer } = deepslate;
const { mat4 } = glMatrix;

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

// Same bounding-sphere fit as main.js's computeFitViewDist() (kept as a
// separate copy here so this file has no dependency on main.js/its DOM
// wiring) — see that function's comment for why a sphere fit is used.
function computeFitViewDist(bounds, width, height, marginFactor = 1.1) {
  const dx = bounds.maxX - bounds.minX;
  const dy = bounds.maxY - bounds.minY;
  const dz = bounds.maxZ - bounds.minZ;
  const radius = 0.5 * Math.hypot(dx, dy, dz);
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
 * @param {number} [options.xRotation=0.6] - camera pitch, in radians.
 * @param {number} [options.yRotation=0.8] - camera yaw, in radians. The
 *   camera *distance* is always auto-fit from the structure's bounding
 *   sphere, so the whole schematic stays in frame at any angle you pick.
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
    xRotation = 0.6, yRotation = 0.8,
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
    builder.addRegionBlocks(name, create3DBlocks(regions.get(name)));
  }
  const structure = builder.buildStructure();

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

    const renderer = new StructureRenderer(gl, structure, resources, {
      useInvisibleBlockBuffer: false, chunkSize: 16,
    });

    const bounds = builder.getActualBounds();
    const center = ['x', 'y', 'z'].map(
      k => (bounds[`min${k.toUpperCase()}`] + bounds[`max${k.toUpperCase()}`]) / 2
    );
    const viewDist = computeFitViewDist(bounds, width, height);
    const view = buildViewMatrix(center, viewDist, xRotation, yRotation);

    renderer.drawStructure(view);

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
