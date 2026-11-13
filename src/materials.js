// Material list: turns the placed blocks of a loaded litematic into the
// items a player actually needs (wall torches -> torches, double slabs -> 2
// slabs, only the lower half of doors, ...), and shows them in a dialog with
// icons from the minemev item atlas, plus a CSV download.

// Local copy of https://www.minemev.com/mc/items.json and its 64px atlas
// (src/mcassets). Atlas paths inside items.json are relative to the JSON file.
const ITEMS_URL = new URL('./mcassets/items.json', import.meta.url).href;
const ATLAS_CELL = 64; // px per icon in the "64" atlas sheet
const SHULKER_SLOTS = 27;

// ---------------------------------------------------------------------------
// Item catalog (items.json), fetched once and cached.
// ---------------------------------------------------------------------------
let catalogPromise = null;

export function loadItemCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(ITEMS_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        const byId = new Map();
        for (const it of data.items || []) byId.set(it.n, it);
        const sheets = data.atlas?.sheets || {};
        return {
          version: data.version || null,
          byId,
          columns: data.atlas?.columns || 32,
          rows: data.atlas?.rows || 1,
          atlasUrl: (() => {
            const sheet = sheets['64'] || Object.values(sheets)[0];
            return sheet ? new URL(sheet, ITEMS_URL).href : null;
          })(),
        };
      })
      .catch(err => {
        console.warn('[materials] item catalog unavailable, showing plain list:', err);
        catalogPromise = null; // allow a retry next time the dialog opens
        return null;
      });
  }
  return catalogPromise;
}

// ---------------------------------------------------------------------------
// Block state -> item(s) needed to place it.
// ---------------------------------------------------------------------------
const SKIP_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'piston_head', 'moving_piston', 'fire', 'soul_fire',
  'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'light',
]);

const BLOCK_TO_ITEM = {
  wall_torch: 'torch',
  soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch',
  redstone_wire: 'redstone',
  tripwire: 'string',
  water: 'water_bucket',
  lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket',
  frosted_ice: 'ice',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  kelp_plant: 'kelp',
  twisting_vines_plant: 'twisting_vines',
  weeping_vines_plant: 'weeping_vines',
  tall_seagrass: 'seagrass',
  bamboo_sapling: 'bamboo',
  big_dripleaf_stem: 'big_dripleaf',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  wheat: 'wheat_seeds',
  melon_stem: 'melon_seeds',
  attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
  cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries',
  torchflower_crop: 'torchflower_seeds',
  pitcher_crop: 'pitcher_pod',
  dirt_path: 'dirt',
  farmland: 'dirt',
  water_cauldron: 'cauldron',
  lava_cauldron: 'cauldron',
  powder_snow_cauldron: 'cauldron',
};

// Blocks made of two halves where only one half should be counted.
function isSecondaryHalf(id, props) {
  if (props.half === 'upper') return true;                 // doors, tall flowers, tall grass, pitcher plant
  if (id.endsWith('_bed') && props.part === 'head') return true;
  return false;
}

const strip = name => name.replace(/^minecraft:/, '');

// Returns [[itemId, count], ...] for one block state.
export function blockToItems(name, props = {}) {
  let id = strip(name);
  if (SKIP_BLOCKS.has(id)) return [];
  if (isSecondaryHalf(id, props)) return [];

  // Only source fluids can be placed from a bucket.
  if ((id === 'water' || id === 'lava') && props.level && props.level !== '0') return [];

  if (BLOCK_TO_ITEM[id]) return [[BLOCK_TO_ITEM[id], 1]];

  if (id.startsWith('potted_')) {
    const plant = id.slice('potted_'.length);
    return [['flower_pot', 1], [plant === 'azalea_bush' ? 'azalea' : plant === 'flowering_azalea_bush' ? 'flowering_azalea' : plant, 1]];
  }
  if (id.endsWith('candle_cake')) {
    const candle = id.slice(0, -'_cake'.length);
    return [['cake', 1], [candle, 1]];
  }

  // Wall variants of signs, banners, heads/skulls, fans.
  id = id
    .replace(/_wall_hanging_sign$/, '_hanging_sign')
    .replace(/_wall_sign$/, '_sign')
    .replace(/_wall_banner$/, '_banner')
    .replace(/_wall_head$/, '_head')
    .replace(/_wall_skull$/, '_skull')
    .replace(/_wall_fan$/, '_fan');

  let count = 1;
  if (id.endsWith('_slab') && props.type === 'double') count = 2;
  else if (props.candles) count = Number(props.candles) || 1;
  else if (props.pickles) count = Number(props.pickles) || 1;
  else if (props.eggs) count = Number(props.eggs) || 1;
  else if (props.flower_amount) count = Number(props.flower_amount) || 1;
  else if (props.segment_amount) count = Number(props.segment_amount) || 1;
  else if (id === 'snow' && props.layers) count = Number(props.layers) || 1;

  return [[id, count]];
}

// Aggregates a StructureBuilder's placed blocks into a sorted material list.
export function computeMaterials(builder) {
  const totals = new Map();
  for (const { entry } of builder.placedBlocks) {
    for (const [item, n] of blockToItems(entry.Name, entry.Properties || {})) {
      totals.set(item, (totals.get(item) || 0) + n);
    }
  }
  return [...totals].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const titleCase = id => id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function describeStacks(count, stackSize) {
  if (stackSize <= 1) return `${count} item${count === 1 ? '' : 's'}`;
  const stacks = Math.floor(count / stackSize);
  const rest = count % stackSize;
  const parts = [];
  if (stacks) parts.push(`${stacks}×${stackSize}`);
  if (rest || !stacks) parts.push(String(rest));
  return parts.join(' + ');
}

const shulkersFor = (count, stackSize) => Math.ceil(count / (stackSize * SHULKER_SLOTS));

function decorate(materials, catalog) {
  return materials.map(m => {
    const info = catalog?.byId.get(m.id);
    const stackSize = info?.s ?? 64;
    return {
      ...m,
      name: info?.d ?? titleCase(m.id),
      stackSize,
      atlasIndex: info?.i ?? null,
      stacks: Math.ceil(m.count / stackSize),
      shulkers: shulkersFor(m.count, stackSize),
    };
  });
}

export function materialsToCSV(rows) {
  const esc = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = ['Item,ID,Count,Stack Size,Stacks,Shulker Boxes'];
  for (const r of rows) {
    lines.push([r.name, `minecraft:${r.id}`, r.count, r.stackSize, r.stacks, r.shulkers].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Share link: minemev.com/material_list/new?code=<code>
//
// minemev uses the same items.json/atlas, so items are referenced by their
// atlas index `i`. The code is base64url(zlib-deflate(UTF-8 JSON)):
//   {
//     "v": 1,                      // format version
//     "mc": "1.21.1",              // items.json version the indexes refer to
//     "n": "My Farm",              // schematic name
//     "a": "Steve",                // author (omitted if unknown)
//     "f": "my_farm.litematic",    // file name (omitted if unknown)
//     "s": [w, h, d],              // structure size in blocks (omitted if unknown)
//     "i": [[index, count], ...],  // items found in items.json
//     "x": [["id", count], ...]    // items NOT in items.json (id without "minecraft:"; omitted if empty)
//   }
// ---------------------------------------------------------------------------
const MINEMEV_NEW_LIST_URL = 'https://www.minemev.com/material_list/new';

function base64url(bytes) {
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeMaterialCode(rows, catalog, meta = {}) {
  const payload = { v: 1, mc: catalog?.version ?? null, n: meta.name || meta.fileName || 'Untitled' };
  if (meta.author) payload.a = meta.author;
  if (meta.fileName) payload.f = meta.fileName;
  if (meta.size) payload.s = meta.size;
  payload.i = [];
  const extra = [];
  for (const r of rows) {
    const info = catalog?.byId.get(r.id);
    if (info) payload.i.push([info.i, r.count]);
    else extra.push([r.id, r.count]);
  }
  if (extra.length) payload.x = extra;
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return base64url(pako.deflate(json, { level: 9 }));
}

export function decodeMaterialCode(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(pako.inflate(bytes)));
}

export const materialListUrl = code => `${MINEMEV_NEW_LIST_URL}?code=${code}`;

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
let dialogEl = null;
let state = { rows: [], catalog: null, filter: '', sort: 'count', fileName: 'materials', meta: {} };

function ensureDialog() {
  if (dialogEl) return dialogEl;
  dialogEl = document.createElement('dialog');
  dialogEl.className = 'materials-dialog';
  dialogEl.innerHTML = `
    <div class="materials-header">
      <div>
        <div class="materials-title">Material List</div>
        <div class="materials-summary" id="materials-summary"></div>
      </div>
      <button type="button" class="materials-close" id="materials-close" title="Close (Esc)">✕</button>
    </div>
    <div class="materials-toolbar">
      <input type="search" id="materials-search" placeholder="Filter materials…" autocomplete="off">
      <select id="materials-sort" title="Sort by">
        <option value="count">Most needed</option>
        <option value="name">Name</option>
      </select>
    </div>
    <div class="materials-notice" id="materials-notice" hidden></div>
    <div class="materials-list" id="materials-list" role="list"></div>
    <div class="materials-footer">
      <button type="button" id="materials-copy" title="Copy as plain text">📋 Copy</button>
      <button type="button" id="materials-csv">📥 CSV</button>
      <button type="button" id="materials-share-copy" title="Copy the minemev material list link">🔗 Copy link</button>
      <a id="materials-share" class="materials-share" target="_blank" rel="noopener">Open on minemev ↗</a>
    </div>`;
  document.body.appendChild(dialogEl);

  // Keep the viewer's global shortcuts (Del, C, arrows, H/Y...) from firing
  // while the person is interacting with the dialog.
  dialogEl.addEventListener('keydown', e => e.stopPropagation());
  // Click on the backdrop closes it.
  dialogEl.addEventListener('click', e => { if (e.target === dialogEl) dialogEl.close(); });

  dialogEl.querySelector('#materials-close').addEventListener('click', () => dialogEl.close());
  dialogEl.querySelector('#materials-search').addEventListener('input', e => { state.filter = e.target.value; renderList(); });
  dialogEl.querySelector('#materials-sort').addEventListener('change', e => { state.sort = e.target.value; renderList(); });
  dialogEl.querySelector('#materials-csv').addEventListener('click', downloadCSV);
  dialogEl.querySelector('#materials-copy').addEventListener('click', copyText);
  dialogEl.querySelector('#materials-share-copy').addEventListener('click', copyShareLink);
  // Build the link right as it's followed, so it reflects the latest state.
  dialogEl.querySelector('#materials-share').addEventListener('click', e => { e.currentTarget.href = shareUrl(); });
  return dialogEl;
}

function visibleRows() {
  const q = state.filter.trim().toLowerCase();
  let rows = q ? state.rows.filter(r => r.name.toLowerCase().includes(q) || r.id.includes(q)) : [...state.rows];
  if (state.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function iconStyle(row) {
  const c = state.catalog;
  if (!c?.atlasUrl || row.atlasIndex == null) return null;
  const col = row.atlasIndex % c.columns;
  const rowIdx = Math.floor(row.atlasIndex / c.columns);
  // Size the sheet relative to the 32px icon box so it works with any cell size.
  return `background-image:url("${c.atlasUrl}");` +
    `background-size:${c.columns * 100}% ${c.rows * 100}%;` +
    `background-position:${c.columns > 1 ? (col / (c.columns - 1)) * 100 : 0}% ${c.rows > 1 ? (rowIdx / (c.rows - 1)) * 100 : 0}%;`;
}

function renderList() {
  const list = dialogEl.querySelector('#materials-list');
  const rows = visibleRows();
  if (!rows.length) {
    list.innerHTML = `<div class="materials-empty">${state.rows.length ? 'No materials match the filter.' : 'This structure has no blocks.'}</div>`;
    return;
  }
  const max = state.rows[0]?.count || 1;
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'materials-row';
    el.setAttribute('role', 'listitem');
    const style = iconStyle(r);
    el.innerHTML = `
      <span class="materials-icon${style ? '' : ' missing'}"${style ? ` style='${style}'` : ''}></span>
      <span class="materials-name">
        <span class="materials-display"></span>
        <span class="materials-id"></span>
      </span>
      <span class="materials-qty">
        <span class="materials-count">${r.count.toLocaleString()}</span>
        <span class="materials-stacks">${describeStacks(r.count, r.stackSize)}${r.shulkers > 1 || r.count > r.stackSize * 4 ? ` · ${r.shulkers} SB` : ''}</span>
      </span>
      <span class="materials-bar" style="width:${Math.max(1, (r.count / max) * 100)}%"></span>`;
    el.querySelector('.materials-display').textContent = r.name;
    el.querySelector('.materials-id').textContent = `minecraft:${r.id}`;
    el.title = `${r.name}: ${r.count} (${r.stacks} stack${r.stacks === 1 ? '' : 's'}, ${r.shulkers} shulker box${r.shulkers === 1 ? '' : 'es'})`;
    frag.appendChild(el);
  }
  list.replaceChildren(frag);
}

function renderSummary() {
  const total = state.rows.reduce((s, r) => s + r.count, 0);
  const shulkers = state.rows.reduce((s, r) => s + r.count / (r.stackSize * SHULKER_SLOTS), 0);
  dialogEl.querySelector('#materials-summary').textContent =
    `${state.rows.length} types · ${total.toLocaleString()} items · ~${Math.ceil(shulkers)} shulker box${Math.ceil(shulkers) === 1 ? '' : 'es'}`;
}

function downloadCSV() {
  const blob = new Blob([materialsToCSV(visibleRows())], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `${state.fileName}_materials.csv` }).click();
  URL.revokeObjectURL(url);
}

// The share link always carries the full list, not just the filtered rows.
const shareUrl = () => materialListUrl(encodeMaterialCode(state.rows, state.catalog, state.meta));

async function copyToClipboard(btnId, text, label) {
  const btn = dialogEl.querySelector(btnId);
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Copied';
  } catch {
    btn.textContent = '⚠️ Failed';
  }
  setTimeout(() => { btn.textContent = label; }, 1500);
}

const copyText = () => copyToClipboard('#materials-copy', visibleRows().map(r => `${r.count}x ${r.name}`).join('\n'), '📋 Copy');
const copyShareLink = () => copyToClipboard('#materials-share-copy', shareUrl(), '🔗 Copy link');

// meta: { name, author, fileName, size: [w, h, d] } — all optional.
export async function openMaterialsDialog(builder, meta = {}) {
  const dlg = ensureDialog();
  const materials = computeMaterials(builder);
  const base = (meta.fileName || '').replace(/\.litematic$/i, '');
  state = { ...state, meta, fileName: base || 'materials', filter: '' };
  dlg.querySelector('#materials-search').value = '';

  // Show immediately with plain names, then upgrade once the catalog arrives.
  state.catalog = null;
  state.rows = decorate(materials, null);
  renderSummary();
  renderList();
  const notice = dlg.querySelector('#materials-notice');
  notice.hidden = true;
  if (!dlg.open) dlg.showModal();

  const catalog = await loadItemCatalog();
  if (!dlg.open) return;
  if (catalog) {
    state.catalog = catalog;
    state.rows = decorate(materials, catalog);
    renderSummary();
    renderList();
  } else {
    notice.textContent = 'Item icons could not be loaded; showing names only.';
    notice.hidden = false;
  }
}
