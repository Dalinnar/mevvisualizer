// ── Cluster Stacking ─────────────────────────────────────────────────────────
//
// The user groups regions into clusters. Inside a cluster every region has
// a role:
//   - region: stays where it is (the fixed base of the cluster)
//   - step:   repeated. All step regions together form one repeating block
//   - cap:    moved to the end of the last step copy
//
// A cluster grows from its steps toward its cap. The axis/direction is
// inferred from where the cap block sits compared with the step block (it
// must be past it along one axis and line up on the other two; an air gap
// between them is kept).
//
// Clusters move each other:
//   - growth: a cluster whose Region+Steps sit entirely past another
//     cluster's steps (along that cluster's growth direction) is pushed by
//     that cluster's growth
//   - cluster gap: a cluster beside another one (overlapping it along its
//     growth axis and on the remaining axis) and entirely past it sideways
//     (toward +) is pushed by the gap
// A cluster's shift is the largest (pusher shift + amount) over all its
// pushers, per kind of push, so clusters side by side don't add up; different
// kinds add together. Regions that aren't in a cluster are never moved.

import { nbtNum, localToWorld, deepCloneNbtCompound } from './validate.js';

export const ROLES = ['region', 'step', 'cap'];
const AXES = ['x', 'y', 'z'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readVec3(entry, tag) {
  const v = entry.get(tag);
  return {
    x: nbtNum(v.get("x")),
    y: nbtNum(v.get("y")),
    z: nbtNum(v.get("z")),
  };
}

// Clone an entry and overwrite its Position.
function cloneWithPosition(sourceEntry, newPos) {
  const cloned = deepCloneNbtCompound(sourceEntry);
  const pos = cloned.get("Position");
  for (const axis of AXES) {
    const node = pos.get(axis);
    node.value !== undefined ? (node.value = newPos[axis]) : pos.set(axis, newPos[axis]);
  }
  return cloned;
}

function setVal(compound, key, val) {
  const node = compound.get(key);
  node.value !== undefined ? (node.value = val) : compound.set(key, val);
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function lcm(a, b) {
  return Math.abs(a / gcd(a, b) * b);
}

// Bounding box { min: {x,y,z}, max: {x,y,z} } (inclusive) of a list of
// localToWorld results.
function unionBox(worlds) {
  const min = {}, max = {};
  for (const a of AXES) {
    const A = a.toUpperCase();
    min[a] = Math.min(...worlds.map(w => w.bounds[`min${A}`]));
    max[a] = Math.max(...worlds.map(w => w.bounds[`max${A}`]));
  }
  return { min, max };
}

const overlaps = (a, b, axis) => a.min[axis] <= b.max[axis] && b.min[axis] <= a.max[axis];
const dirKey = (axis, dir) => `${dir > 0 ? '+' : '−'}${axis.toUpperCase()}`;

// World-space info (localToWorld output) for every region, keyed by name.
export function getRegionWorlds(nbt) {
  const regions = (nbt.root || nbt).get("Regions");
  const out = {};
  for (const name of regions.keys()) {
    const e = regions.get(name);
    out[name] = localToWorld(readVec3(e, "Position"), readVec3(e, "Size"));
  }
  return out;
}

// ── Planning ─────────────────────────────────────────────────────────────────

// Works out, for every cluster, how it grows and how far it gets pushed.
//
// `clusters` is an array of { regions: [{ name, role }] }.
// Returns one plan per cluster (same order):
//   ok:       false when the cluster can't be stacked (see `error`)
//   axis/dir: growth direction, from the steps toward the cap
//   capGap:   air between the step block and the cap block (kept)
//   stride:   length of the step block along the axis
//   count:    number of step copies (LCM of strides on the same axis / stride × cycles)
//   growth:   (count − 1) × stride
//   shift:    { x, y, z } the whole cluster is moved by
//   pushedBy: { "<key>": { by: clusterIndex, amount } } for explaining moves
//   gapSides: axes this cluster gets pushed along by the cluster gap (even
//             when the gap is 0 — tells which axes the gap controls)
//   warnings: strings
export function planClusters(worlds, clusters, cycles = 1, clusterGap = 0) {
  const safeCycles = Math.max(1, cycles);
  const gap = Math.max(0, clusterGap);

  const plans = clusters.map((cluster, index) => {
    const plan = { index, ok: false, warnings: [], shift: { x: 0, y: 0, z: 0 }, pushedBy: {} };
    const byRole = role => cluster.regions.filter(r => r.role === role).map(r => r.name);
    const missing = cluster.regions.map(r => r.name).filter(n => !worlds[n]);
    if (missing.length) { plan.error = `region${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`; return plan; }

    const steps = byRole('step'), caps = byRole('cap'), bases = byRole('region');
    if (!steps.length || !caps.length) { plan.error = 'needs at least one Step and one Cap'; return plan; }

    const stepBox = unionBox(steps.map(n => worlds[n]));
    const capBox = unionBox(caps.map(n => worlds[n]));

    let det = null;
    for (const axis of AXES) {
      if (!AXES.filter(a => a !== axis).every(a => overlaps(stepBox, capBox, a))) continue;
      if (capBox.min[axis] > stepBox.max[axis]) det = { axis, dir: 1, capGap: capBox.min[axis] - stepBox.max[axis] - 1 };
      else if (capBox.max[axis] < stepBox.min[axis]) det = { axis, dir: -1, capGap: stepBox.min[axis] - capBox.max[axis] - 1 };
      if (det) break;
    }
    if (!det) { plan.error = 'the Cap must sit past the Steps along one axis, lined up on the other two'; return plan; }

    if (bases.length) {
      const baseBox = unionBox(bases.map(n => worlds[n]));
      const fixedSide = det.dir > 0 ? baseBox.max[det.axis] < stepBox.min[det.axis] : baseBox.min[det.axis] > stepBox.max[det.axis];
      if (!fixedSide) plan.warnings.push('its Region isn\'t on the opposite side of the Steps from the Cap');
    }

    Object.assign(plan, det, {
      ok: true, steps, caps, bases, stepBox,
      stride: stepBox.max[det.axis] - stepBox.min[det.axis] + 1,
      anchor: unionBox([...bases, ...steps].map(n => worlds[n])),
      full: unionBox(cluster.regions.map(r => worlds[r.name])),
    });
    return plan;
  });

  const ok = plans.filter(p => p.ok);

  // Copies: clusters on the same axis share the LCM of their strides, so
  // their step blocks end up the same total length.
  const lcmByAxis = {};
  for (const p of ok) lcmByAxis[p.axis] = lcmByAxis[p.axis] ? lcm(lcmByAxis[p.axis], p.stride) : p.stride;
  for (const p of ok) {
    p.count = Math.max(1, Math.round((lcmByAxis[p.axis] / p.stride) * safeCycles));
    p.growth = (p.count - 1) * p.stride;
  }

  // Who pushes whom.
  for (const b of ok) {
    b.growthPushers = [];
    b.gapPushers = [];
    for (const a of ok) {
      if (a === b) continue;

      const past = a.dir > 0
        ? b.anchor.min[a.axis] > a.stepBox.max[a.axis]
        : b.anchor.max[a.axis] < a.stepBox.min[a.axis];
      if (past) b.growthPushers.push(a);

      // Found even at gap 0, so callers know which axes the gap would affect.
      if (overlaps(b.full, a.full, a.axis)) {
        for (const side of AXES.filter(x => x !== a.axis)) {
          const rest = AXES.find(x => x !== a.axis && x !== side);
          if (overlaps(b.full, a.full, rest) && b.full.min[side] > a.full.max[side]) b.gapPushers.push({ a, side });
        }
      }
    }
  }

  // Shift = max over pushers of (pusher shift + amount), per key.
  const shifts = new Map(ok.map(p => [p, {}]));
  const relax = (b, a, key, amount) => {
    const val = (shifts.get(a)[key] || 0) + amount;
    if (val > (shifts.get(b)[key] || 0)) {
      shifts.get(b)[key] = val;
      b.pushedBy[key] = { by: a.index, amount: val };
      return true;
    }
    return false;
  };
  for (let i = 0; i <= ok.length * 2; i++) {
    let changed = false;
    for (const b of ok) {
      for (const a of b.growthPushers) if (a.growth > 0) changed = relax(b, a, dirKey(a.axis, a.dir), a.growth) || changed;
      if (gap > 0) {
        for (const { a, side } of b.gapPushers) changed = relax(b, a, `gap ${dirKey(side, 1)}`, gap) || changed;
      }
    }
    if (!changed) break;
  }
  for (const p of ok) {
    for (const [key, val] of Object.entries(shifts.get(p))) {
      const d = key.replace('gap ', '');
      p.shift[d[1].toLowerCase()] += (d[0] === '+' ? 1 : -1) * val;
    }
    p.gapSides = [...new Set(p.gapPushers.map(g => g.side))];
    delete p.growthPushers;
    delete p.gapPushers;
  }

  return plans;
}

// ── Stacking ─────────────────────────────────────────────────────────────────

// Applies the plans from planClusters to `nbt` (mutated in place, so pass a
// fresh parse). Regions of clusters that can't be stacked, and regions that
// aren't in any cluster, are passed through unchanged.
//
// Returns { nbt, roles } where roles maps every placed region name (copies
// included) to { cluster, role } — handy for highlighting.
export function stackClusters(nbt, plans) {
  const root = nbt.root || nbt;
  const regions = root.get("Regions");
  const names = new Set(regions.keys());

  const handled = new Set(plans.filter(p => p.ok).flatMap(p => [...p.bases, ...p.steps, ...p.caps]));
  const newRegions = new Map();
  const roles = {};

  for (const name of names) {
    if (!handled.has(name)) newRegions.set(name, deepCloneNbtCompound(regions.get(name)));
  }

  const uniqueName = base => {
    let name = base, n = 2;
    while (names.has(name) || newRegions.has(name)) name = `${base}~${n++}`;
    return name;
  };
  const place = (name, src, offset, cluster, role) => {
    const entry = regions.get(src);
    const pos = readVec3(entry, "Position");
    newRegions.set(name, cloneWithPosition(entry, { x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z }));
    roles[name] = { cluster, role };
  };

  for (const p of plans.filter(p => p.ok)) {
    const along = k => ({ ...p.shift, [p.axis]: p.shift[p.axis] + k * p.dir });
    for (const n of p.bases) place(n, n, p.shift, p.index, 'region');
    for (const n of p.steps) {
      for (let k = 0; k < p.count; k++) {
        place(k === 0 ? n : uniqueName(`${n}_${k}`), n, along(k * p.stride), p.index, 'step');
      }
    }
    for (const n of p.caps) place(n, n, along(p.growth), p.index, 'cap');
  }

  // ── Patch EnclosingSize from the actual bounding box of every region ──────
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const region of newRegions.values()) {
    const { bounds: b } = localToWorld(readVec3(region, "Position"), readVec3(region, "Size"));
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
    minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
  }
  const enclosing = root.get("Metadata").get("EnclosingSize");
  setVal(enclosing, 'x', maxX - minX + 1);
  setVal(enclosing, 'y', maxY - minY + 1);
  setVal(enclosing, 'z', maxZ - minZ + 1);

  // ── Write back ─────────────────────────────────────────────────────────────
  const regionsCompound = new deepslate.NbtCompound();
  for (const [name, region] of newRegions) regionsCompound.set(name, region);
  root.set("Regions", regionsCompound);

  return { nbt, roles };
}

// ── Shareable configuration ──────────────────────────────────────────────────
//
// Encodes clusters + cycles + cluster gap into a compact, URL-safe base64
// string used as the `config` query parameter (alongside `ext_link`).
// Copy counts aren't stored — they're re-derived on load. Older configs
// made of Step/Cap pairs still decode: each pair becomes a cluster.

export function encodeStackConfig(clusters, cycles = 1, clusterGap = 0) {
  const json = JSON.stringify({
    v: 2,
    cycles,
    gap: clusterGap,
    clusters: clusters.map(c => {
      const out = {};
      for (const [key, role] of [['r', 'region'], ['s', 'step'], ['c', 'cap']]) {
        const list = c.regions.filter(r => r.role === role).map(r => r.name);
        if (list.length) out[key] = list;
      }
      return out;
    }),
  });
  // Percent-encode then repack as Latin1 so btoa (which only handles Latin1)
  // can safely base64-encode arbitrary UTF-8 region names.
  const latin1 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return btoa(latin1);
}

export function decodeStackConfig(str) {
  try {
    const latin1 = atob(str);
    const json = decodeURIComponent(
      Array.from(latin1).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const parsed = JSON.parse(json);
    if (!parsed) return null;

    const names = list => (Array.isArray(list) ? list.filter(n => typeof n === 'string') : []);
    let clusters = [];

    if (Array.isArray(parsed.clusters)) {
      clusters = parsed.clusters.map(c => ({
        regions: [
          ...names(c?.r).map(name => ({ name, role: 'region' })),
          ...names(c?.s).map(name => ({ name, role: 'step' })),
          ...names(c?.c).map(name => ({ name, role: 'cap' })),
        ],
      }));
    } else if (Array.isArray(parsed.pairs)) {
      // Old format: one Step/Cap pair per entry.
      clusters = parsed.pairs
        .filter(p => p && typeof p.step === 'string' && typeof p.cap === 'string')
        .map(p => ({ regions: [{ name: p.step, role: 'step' }, { name: p.cap, role: 'cap' }] }));
    }

    clusters = clusters.filter(c => c.regions.length);
    if (!clusters.length) return null;

    return {
      clusters,
      cycles: Math.max(1, parseInt(parsed.cycles, 10) || 1),
      gap: Math.max(0, parseInt(parsed.gap, 10) || 0),
    };
  } catch (err) {
    console.error('Failed to decode stacking config:', err);
    return null;
  }
}
