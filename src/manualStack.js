// ── Cluster Stacking ─────────────────────────────────────────────────────────
//
// The user groups regions into clusters. Inside a cluster every region has
// a role:
//   - region: stays where it is (the fixed base of the cluster)
//   - step:   repeated
//   - cap:    moved to the end of the last step copy
//
// A cluster has one or more arms. Each cap takes the steps right behind it
// (lined up on the other two axes; an air gap between them is kept) plus the
// steps chained behind those in a straight line. An arm grows from its
// steps toward its caps — so one cluster can grow both ways (e.g. a world
// eater with a step + cap on each side of a fixed middle).
//
// Clusters move each other:
//   - growth: a cluster whose Region+Steps sit entirely past one of another
//     cluster's arms (along that arm's direction) is pushed by that arm's
//     growth
//   - cluster gap: a cluster beside another one (overlapping it on every axis
//     but one it doesn't grow along) and entirely past it on that axis
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

// Largest air gap (blocks) allowed between a Cap and the Steps it belongs to.
const MAX_CAP_GAP = 32;

const linedUp = (a, b, axis) => AXES.filter(x => x !== axis).every(x => overlaps(a, b, x));

// Splits a cluster's steps and caps into arms, starting from each cap:
//   1. pick the axis/direction where the nearest lined-up steps sit right
//      behind the cap (smallest air gap wins),
//   2. take those steps plus any steps chained behind them in a straight
//      line along that axis (a step made of several pieces in a row).
// Steps only touching sideways (e.g. the next row) don't join that arm.
// Caps whose step chains overlap and grow the same way share one arm.
// Every step must end up in exactly one arm.
// Returns { arms } or { error }.
function buildArms(worlds, steps, caps) {
  const box = n => unionBox([worlds[n]]);
  const arms = [];

  for (const cap of caps) {
    const cb = box(cap);
    let best = null;
    for (const axis of AXES) {
      for (const dir of [1, -1]) {
        const cands = steps
          .map(n => ({ n, b: box(n) }))
          .filter(({ b }) => linedUp(b, cb, axis))
          .map(c => ({ ...c, gap: dir > 0 ? cb.min[axis] - c.b.max[axis] - 1 : c.b.min[axis] - cb.max[axis] - 1 }))
          .filter(c => c.gap >= 0 && c.gap <= MAX_CAP_GAP);
        if (!cands.length) continue;
        const gap = Math.min(...cands.map(c => c.gap));
        if (best && gap >= best.capGap) continue;

        const chain = new Set(cands.filter(c => c.gap === gap).map(c => c.n));
        for (let grew = true; grew;) {
          grew = false;
          for (const n of steps) {
            if (chain.has(n)) continue;
            const b = box(n);
            const behind = [...chain].some(m => {
              const mb = box(m);
              const touching = dir > 0 ? b.max[axis] + 1 === mb.min[axis] : b.min[axis] - 1 === mb.max[axis];
              return touching && linedUp(b, mb, axis);
            });
            if (behind) { chain.add(n); grew = true; }
          }
        }
        best = { axis, dir, capGap: gap, steps: [...chain] };
      }
    }
    if (!best) return { error: `Cap "${cap}" has no Step right behind it (lined up on the other two axes)` };

    const same = arms.find(a => a.axis === best.axis && a.dir === best.dir && a.steps.some(s => best.steps.includes(s)));
    if (same) {
      same.caps.push(cap);
      same.steps = [...new Set([...same.steps, ...best.steps])];
      same.capGap = Math.min(same.capGap, best.capGap);
    } else {
      arms.push({ ...best, caps: [cap] });
    }
  }

  const owner = new Map();
  for (const arm of arms) {
    for (const s of arm.steps) {
      if (owner.has(s)) return { error: `Step "${s}" has Caps on different sides; use one Step per direction` };
      owner.set(s, arm);
    }
  }
  const orphans = steps.filter(s => !owner.has(s));
  if (orphans.length) {
    return { error: `Step${orphans.length > 1 ? 's' : ''} "${orphans.join(', ')}" ha${orphans.length > 1 ? 've' : 's'} no Cap in front` };
  }

  for (const arm of arms) {
    arm.stepBox = unionBox(arm.steps.map(n => worlds[n]));
    arm.stride = arm.stepBox.max[arm.axis] - arm.stepBox.min[arm.axis] + 1;
  }
  return { arms };
}

// Works out, for every cluster, how it grows and how far it gets pushed.
//
// `clusters` is an array of { regions: [{ name, role }] }.
// Returns one plan per cluster (same order):
//   ok:       false when the cluster can't be stacked (see `error`)
//   arms:     one per step block: { steps, caps, axis, dir, capGap, stride,
//             count, growth } — grows from its steps toward its caps;
//             count = LCM of strides on the same axis / stride × cycles,
//             growth = (count − 1) × stride
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

    const { arms, error } = buildArms(worlds, steps, caps);
    if (error) { plan.error = error; return plan; }

    // A Region on the cap side of an arm would be overrun by its Step copies.
    for (const name of bases) {
      const box = unionBox([worlds[name]]);
      const overrun = arms.find(arm => (arm.dir > 0
        ? box.min[arm.axis] > arm.stepBox.max[arm.axis]
        : box.max[arm.axis] < arm.stepBox.min[arm.axis]) &&
        AXES.filter(a => a !== arm.axis).every(a => overlaps(box, arm.stepBox, a)));
      if (overrun) plan.warnings.push(`Region "${name}" is on the Cap side of Steps "${overrun.steps.join(', ')}"`);
    }

    Object.assign(plan, {
      ok: true, steps, caps, bases, arms,
      growthAxes: [...new Set(arms.map(a => a.axis))],
      anchor: unionBox([...bases, ...steps].map(n => worlds[n])),
      full: unionBox(cluster.regions.map(r => worlds[r.name])),
    });
    return plan;
  });

  const ok = plans.filter(p => p.ok);
  const allArms = ok.flatMap(p => p.arms);

  // Copies: arms on the same axis share the LCM of their strides, so their
  // step blocks end up the same total length.
  const lcmByAxis = {};
  for (const arm of allArms) lcmByAxis[arm.axis] = lcmByAxis[arm.axis] ? lcm(lcmByAxis[arm.axis], arm.stride) : arm.stride;
  for (const arm of allArms) {
    arm.count = Math.max(1, Math.round((lcmByAxis[arm.axis] / arm.stride) * safeCycles));
    arm.growth = (arm.count - 1) * arm.stride;
  }

  // Who pushes whom: each arm of A pushes clusters whose Region+Steps sit
  // entirely past that arm's steps; the cluster gap pushes clusters beside
  // A (overlapping it on every axis but one that A doesn't grow along) and
  // entirely past it on that axis.
  for (const b of ok) {
    b.growthPushers = [];
    b.gapPushers = [];
    for (const a of ok) {
      if (a === b) continue;

      for (const arm of a.arms) {
        const past = arm.dir > 0
          ? b.anchor.min[arm.axis] > arm.stepBox.max[arm.axis]
          : b.anchor.max[arm.axis] < arm.stepBox.min[arm.axis];
        if (past) b.growthPushers.push({ a, arm });
      }

      // Found even at gap 0, so callers know which axes the gap would affect.
      for (const side of AXES.filter(x => !a.growthAxes.includes(x))) {
        const lined = AXES.filter(x => x !== side).every(x => overlaps(b.full, a.full, x));
        if (lined && b.full.min[side] > a.full.max[side]) b.gapPushers.push({ a, side });
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
      for (const { a, arm } of b.growthPushers) {
        if (arm.growth > 0) changed = relax(b, a, dirKey(arm.axis, arm.dir), arm.growth) || changed;
      }
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
    for (const n of p.bases) place(n, n, p.shift, p.index, 'region');
    for (const arm of p.arms) {
      const along = k => ({ ...p.shift, [arm.axis]: p.shift[arm.axis] + k * arm.dir });
      for (const n of arm.steps) {
        for (let k = 0; k < arm.count; k++) {
          place(k === 0 ? n : uniqueName(`${n}_${k}`), n, along(k * arm.stride), p.index, 'step');
        }
      }
      for (const n of arm.caps) place(n, n, along(arm.growth), p.index, 'cap');
    }
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
