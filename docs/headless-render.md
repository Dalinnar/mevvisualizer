# Headless rendering (generating an image of a litematic)

The renderer is a WebGL app, so the practical way to script an image out of
it isn't to reimplement the rendering logic elsewhere — it's to drive the
*same* `index.html` + `src/` files in headless Chrome and screenshot the
canvas. That's what `scripts/headless-render.js` does.

## What was added to support this

1. **`?no_controls=true`** (also accepts `1` / `yes`) — hides the controls
   panel and its toggle button, so the page is just the 3D view. Set on
   `index.html`, e.g.:

   ```
   index.html?ext_link=<url>&no_controls=true
   ```

2. **Auto-fit camera** — on first load of a structure, the camera's initial
   distance is computed from the structure's bounding sphere (see
   `computeFitViewDist()` in `src/main.js`) instead of a fixed zoom level, so
   the whole schematic is inside the frame from the first frame, at any
   canvas size/aspect ratio, before any screenshot is taken. Because it's
   fit to a bounding *sphere* rather than the box at one particular
   rotation, it stays fully in frame at every rotation angle too. (Rotating
   is still possible in-page — this only sets the *default* distance;
   manual zoom/pan via mouse is untouched and is preserved across
   stack-count changes as before.)

3. **A render-ready signal** — `window.mevRendererReady` is set to `false`
   at the start of every render and back to `true` (plus a
   `window.dispatchEvent(new CustomEvent('mev-render-complete'))`) once the
   structure is built, the camera is positioned, and a frame has actually
   been drawn. A headless script waits on this instead of guessing a fixed
   delay — needed because build time depends on structure/region size.

4. **`window.mevRenderer`** — the live `InteractiveCanvas` instance, mainly
   so a resize (including a headless tool calling `page.setViewport()`
   after navigation) can force a redraw; see the `resize` listener in
   `index.html`.

## Using the existing `?ext_link=` auto-load

The renderer already supports loading a `.litematic` straight from a URL via
`?ext_link=<url>` (see `loadFromExtLink()` in `src/main.js`) — this predates
these changes and needed no modification. Combined with `no_controls`, that
URL alone is enough to describe "the litematic at this URL, with nothing but
the 3D view visible":

```
index.html?ext_link=https://example.com/build.litematic&no_controls=true
```

## Running the example script

```bash
npm install puppeteer   # or puppeteer-core + a local Chrome, see below
npx serve .             # serve this folder over http:// (any static server works)

node scripts/headless-render.js \
  --url "http://localhost:3000/index.html" \
  --litematic "https://example.com/build.litematic" \
  --out "./render.png" \
  --width 1600 --height 900
```

The script:
- launches headless Chrome with software WebGL enabled (`--use-gl=swiftshader`),
- opens `?ext_link=...&no_controls=true` at the requested viewport size,
- waits for `window.mevRendererReady === true`,
- screenshots only `#structure-display` (not the full page), and saves it.

### If Puppeteer's Chromium download isn't reachable

Some environments can't reach the Chromium download used by a plain
`puppeteer` install. In that case, install `puppeteer-core` instead (no
bundled browser) and point it at a Chrome/Chromium already on disk:

```js
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', // or wherever Chrome lives
  headless: 'new',
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
```

### Serving vs. `file://`

Point `--url` at a *served* copy of `index.html` (any static file server),
not a bare `file://` path — the page itself does a `fetch()` for
`ext_link`, and `src/main.js` is loaded as an ES module, both of which
behave inconsistently under `file://` depending on the browser/flags. A
plain static server avoids that entirely.
