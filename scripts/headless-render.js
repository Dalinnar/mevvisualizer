#!/usr/bin/env node
/**
 * headless-render.js
 *
 * Drives the renderer's own index.html in headless Chrome (via Puppeteer)
 * to produce a PNG of just the litematic — no controls panel, no page
 * chrome, cropped to the canvas — instead of rendering the whole page.
 *
 * How it works:
 *   1. Launches headless Chrome and sets the viewport to the requested
 *      output size (the canvas fills its container, so viewport size ==
 *      image size).
 *   2. Navigates to `index.html?ext_link=<url>&no_controls=true`. The
 *      renderer already knows how to auto-load a litematic from
 *      `?ext_link=` (see src/main.js loadFromExtLink()), and `no_controls`
 *      hides the side panel/toggle so nothing but the 3D view is on screen.
 *   3. Waits for `window.mevRendererReady` (set by main.js once the
 *      structure is built, camera is framed, and a frame has actually been
 *      drawn — see buildAndRender() in src/main.js).
 *   4. Screenshots only the #structure-display canvas element (not the
 *      full page), so the output is exactly the litematic render.
 *
 * Usage:
 *   node scripts/headless-render.js \
 *     --url "http://localhost:8080/index.html" \
 *     --litematic "https://example.com/path/to/file.litematic" \
 *     --out "./render.png" \
 *     --width 1600 --height 900
 *
 * Notes:
 *   - `--url` must point at a served copy of this app (index.html + src/),
 *     e.g. `npx serve .` or any static file server — not a bare file://
 *     path, since the page itself fetches `ext_link` over HTTP(S) and
 *     ES module imports are picky about file:// origins in some setups.
 *   - `--litematic` is whatever URL you'd otherwise put in `?ext_link=`;
 *     it must be reachable from wherever headless Chrome is running (the
 *     page's own fetchExternalFile() already falls back to an allorigins
 *     proxy for CORS-blocked hosts, same as interactive use).
 *   - If Puppeteer's bundled Chromium download isn't reachable from your
 *     environment, install `puppeteer-core` instead and pass
 *     `executablePath` pointing at a Chrome/Chromium already on disk.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function parseArgs(argv) {
  const out = { width: 1600, height: 900, out: './render.png', timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    switch (key) {
      case 'url': out.url = val; i++; break;
      case 'litematic': out.litematic = val; i++; break;
      case 'out': out.out = val; i++; break;
      case 'width': out.width = parseInt(val, 10); i++; break;
      case 'height': out.height = parseInt(val, 10); i++; break;
      case 'timeout': out.timeoutMs = parseInt(val, 10); i++; break;
      default: break;
    }
  }
  if (!out.url) throw new Error('--url is required (a served index.html)');
  if (!out.litematic) throw new Error('--litematic is required (a URL the page can fetch)');
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const target = new URL(opts.url);
  target.searchParams.set('ext_link', opts.litematic);
  target.searchParams.set('no_controls', 'true');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });

    page.on('console', msg => console.log('[page]', msg.text()));
    page.on('pageerror', err => console.error('[page error]', err));

    await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });

    // Wait for main.js's render-complete signal rather than a fixed delay —
    // build time scales with structure size/region count.
    await page.waitForFunction('window.mevRendererReady === true', { timeout: opts.timeoutMs });

    const canvasHandle = await page.$('#structure-display');
    if (!canvasHandle) throw new Error('#structure-display canvas not found on page');

    const outPath = path.resolve(opts.out);
    await canvasHandle.screenshot({ path: outPath, omitBackground: false });

    console.log(`Saved: ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
