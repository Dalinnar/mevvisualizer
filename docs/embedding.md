# Embedding: `<script src="...">` → `<img src="...">`

This is the "just give me an image of the litematic" path — no headless
browser, no server. `src/embed.js` renders straight into an offscreen
`<canvas>` in the *visitor's own browser* and hands you back a PNG data URL
(or Blob) you drop into an `<img>`. It doesn't use or need any of
`index.html`'s markup (no controls panel, no `#structure-display`) — it
builds everything itself.

## Option A — prebuilt bundle (matches `<script src="mevrenderer">` literally)

This repo already ships a built bundle at `dist/mevrenderer-embed.js`
(rebuild it any time with `npm run build`, see below). Host `dist/` however
you host the rest of the repo (GitHub Pages, jsdelivr's gh CDN, etc.) and
use it like this:

```html
<script src="https://unpkg.com/deepslate@0.25.1"></script>
<script src="https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/gl-matrix-min.js"></script>
<script src="https://unpkg.com/pako@2.1.0/dist/pako.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/YOU/mevrenderer@main/dist/mevrenderer-embed.js"></script>

<img id="preview" alt="litematic preview">

<script>
  mevrenderer.renderLitematicImage({
    url: 'https://example.com/path/to/build.litematic',
    width: 900,
    height: 600,
  }).then(dataUrl => {
    document.getElementById('preview').src = dataUrl;
  }).catch(console.error);
</script>
```

That's the whole thing: one `<script src="...">` for the renderer, one for
the `<img>`, three lines of JS to wire them together.

**`dist/blocklist.json` must be published alongside `dist/mevrenderer-embed.js`**
(same folder) — `npm run build` copies it there for you. The bundle finds it
automatically next to wherever its own `<script src>` was loaded from; if
your hosting setup doesn't preserve that (e.g. you're loading it via
`import()`-injected `<script>` rather than a static tag), call
`mevrenderer.setBlocklistUrl('https://.../blocklist.json')` yourself before
the first render.

## Option B — no build step, native ES modules

If you'd rather not maintain a bundle, `src/embed.js` also works loaded
directly as a real ES module (skips the classic-script fallback entirely,
since `import.meta.url` works natively here):

```html
<script src="https://unpkg.com/deepslate@0.25.1"></script>
<script src="https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/gl-matrix-min.js"></script>
<script src="https://unpkg.com/pako@2.1.0/dist/pako.min.js"></script>

<img id="preview" alt="litematic preview">

<script type="module">
  import { renderLitematicImage } from 'https://cdn.jsdelivr.net/gh/YOU/mevrenderer@main/src/embed.js';

  renderLitematicImage({ url: 'https://example.com/build.litematic' })
    .then(dataUrl => { document.getElementById('preview').src = dataUrl; });
</script>
```

No build, no `dist/`, no manual `blocklistUrl` — `src/resources.js` resolves
`blocklist.json`'s URL itself from `import.meta.url`. The only real
difference from Option A is `type="module"` on that last `<script>` tag and
importing from `src/embed.js` instead of `dist/mevrenderer-embed.js`.

## Rebuilding the bundle

```bash
npm install        # installs esbuild (devDependency)
npm run build       # writes dist/mevrenderer-embed.js, .esm.js, and blocklist.json
```

## API

```ts
mevrenderer.renderLitematicImage({
  url,               // string — .litematic URL to fetch (or pass `buffer` instead)
  buffer,            // ArrayBuffer|Uint8Array — an already-loaded .litematic
  width = 800,
  height = 600,
  xRotation = 0.6,   // camera pitch, radians
  yRotation = 0.8,   // camera yaw, radians — distance is always auto-fit,
                     // so the whole structure stays in frame at any angle
  background = '#1a1a1a', // CSS color, or null for a transparent PNG
  asBlob = false,    // resolve a Blob instead of a data URL
  onProgress,        // ({stage, percent}) — fires once per page load
}) => Promise<string | Blob>
```

Calling it repeatedly (e.g. a gallery of several litematics on one page)
only downloads the shared block/texture assets once — later calls reuse
what the first call loaded.

## Why not a bare `<script src="mevrenderer.js">` with zero build step?

`src/embed.js` is written as an ES module (it `import`s the existing
`region.js`/`resources.js`/`structure.js` rather than duplicating them) —
browsers only load that directly via `<script type="module">` (Option B).
A classic, non-module `<script src="...">` (Option A) needs everything
bundled into one file first, which is exactly what `dist/mevrenderer-embed.js`
already is. Either way you never hand-maintain more than one `<script>` tag
plus the three existing CDN dependency tags this project already used.
