// ── Manual Stacking ─────────────────────────────────────────────────────────
//
// Unlike automatic stacking (validate.js), the user explicitly designates two
// regions:
//   - Step: the region that gets duplicated `stackCount` times
//   - Cap:  the fixed end region, which is never duplicated but is
//           translated so it stays attached past the last generated Step copy
//
// The stacking axis/direction is *not* chosen by the user — it's inferred
// from how Step and Cap are actually adjacent to each other in the source
// litematic (see detectManualStackAxis).

import { nbtNum, localToWorld, deepCloneNbtCompound } from './validate.js';

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
  for (const axis of ['x', 'y', 'z']) {
    const node = pos.get(axis);
    node.value !== undefined ? (node.value = newPos[axis]) : pos.set(axis, newPos[axis]);
  }
  return cloned;
}

function setVal(compound, key, val) {
  const node = compound.get(key);
  node.value !== undefined ? (node.value = val) : compound.set(key, val);
}

function boundsOverlap(aMin, aMax, bMin, bMax) {
  return aMin <= bMax && bMin <= aMax;
}

// ── Direction detection ──────────────────────────────────────────────────────

// Given the world-space Position/Size info (as returned by localToWorld) for
// the Step and Cap regions, figures out which single axis they're adjacent
// on (touching, with full overlap on the other two axes) and which side of
// Step the Cap sits on.
//
// Returns { axis: 'x'|'y'|'z', direction: 1 | -1 } or null if the two
// regions aren't cleanly adjacent along exactly one axis.
//
// `direction` is the sign, along `axis`, of the direction from Step toward
// Cap. Growth always proceeds in this direction: additional Step copies are
// inserted on the Cap side, pushing Cap further away.
export function detectManualStackAxis(stepWorld, capWorld) {
  const axes = ['x', 'y', 'z'];

  for (const axis of axes) {
    const others = axes.filter(a => a !== axis);
    const overlapsOnOthers = others.every(a => {
      const A = a.toUpperCase();
      return boundsOverlap(
        stepWorld.bounds[`min${A}`], stepWorld.bounds[`max${A}`],
        capWorld.bounds[`min${A}`], capWorld.bounds[`max${A}`]
      );
    });
    if (!overlapsOnOthers) continue;

    const Ax = axis.toUpperCase();
    const stepMin = stepWorld.bounds[`min${Ax}`], stepMax = stepWorld.bounds[`max${Ax}`];
    const capMin = capWorld.bounds[`min${Ax}`], capMax = capWorld.bounds[`max${Ax}`];

    // Cap sits immediately past Step's positive face along this axis.
    if (capMin === stepMax + 1) return { axis, direction: 1 };
    // Cap sits immediately before Step's negative face along this axis.
    if (stepMin === capMax + 1) return { axis, direction: -1 };
  }

  return null;
}

// ── Stacking ──────────────────────────────────────────────────────────────────

// Builds a manually-stacked structure. Mutates and returns `nbt` (matching
// the convention used by stackMiddle in validate.js).
//
// Returns { nbt, axis, direction, stride } on success. Throws if the
// regions can't be found or aren't adjacent along a single axis.
export function manualStack(nbt, stepName, capName, stackCount) {
  const root = nbt.root || nbt;
  const regions = root.get("Regions");

  const stepEntry = regions.get(stepName);
  const capEntry = regions.get(capName);

  if (!stepEntry) throw new Error(`Step region "${stepName}" not found`);
  if (!capEntry) throw new Error(`Cap region "${capName}" not found`);
  if (stepName === capName) throw new Error('Step and Cap must be different regions');

  const stepPos = readVec3(stepEntry, "Position");
  const stepSize = readVec3(stepEntry, "Size");
  const capPos = readVec3(capEntry, "Position");
  const capSize = readVec3(capEntry, "Size");

  const stepWorld = localToWorld(stepPos, stepSize);
  const capWorld = localToWorld(capPos, capSize);

  const detected = detectManualStackAxis(stepWorld, capWorld);
  if (!detected) {
    throw new Error(
      'Could not determine a stacking direction: the selected Step and Cap ' +
      'regions must be directly adjacent (touching, with full overlap on the ' +
      'other two axes) along exactly one axis.'
    );
  }
  const { axis, direction } = detected;
  const stride = stepWorld.size[axis];
  const count = Math.max(1, stackCount);

  const newRegions = new Map();

  // Every region other than Step/Cap is passed through completely unchanged.
  for (const name of regions.keys()) {
    if (name === stepName || name === capName) continue;
    newRegions.set(name, deepCloneNbtCompound(regions.get(name)));
  }

  // Step copies: copy 0 keeps the original position/name; each following
  // copy is shifted further along `axis`, toward where Cap currently sits.
  for (let i = 0; i < count; i++) {
    const shift = i * stride * direction;
    const newPos = { ...stepPos, [axis]: stepPos[axis] + shift };
    const name = i === 0 ? stepName : `${stepName}_${i}`;
    newRegions.set(name, cloneWithPosition(stepEntry, newPos));
  }

  // Cap: never duplicated — just translated so it remains attached past the
  // last generated Step copy. With count === 1 this is a zero shift, i.e.
  // Cap stays exactly where it started.
  const capShift = (count - 1) * stride * direction;
  const newCapPos = { ...capPos, [axis]: capPos[axis] + capShift };
  newRegions.set(capName, cloneWithPosition(capEntry, newCapPos));

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
  for (const [name, region] of newRegions) {
    regionsCompound.set(name, region);
  }
  root.set("Regions", regionsCompound);

  return { nbt, axis, direction, stride };
}

// ── Shareable URL configuration ───────────────────────────────────────────────
//
// Encodes { stepName, capName, stackCount } into a compact, URL-safe base64
// string suitable for use as a `config` query parameter, alongside an
// `ext_link` parameter pointing at the source litematic. See main.js's
// loadFromExtLink for the corresponding restore logic.

export function encodeManualConfig({ stepName, capName, stackCount }) {
  const json = JSON.stringify({ step: stepName, cap: capName, count: stackCount });
  // Percent-encode then repack as Latin1 so btoa (which only handles Latin1)
  // can safely base64-encode arbitrary UTF-8 region names.
  const latin1 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return btoa(latin1);
}

export function decodeManualConfig(str) {
  try {
    const latin1 = atob(str);
    const json = decodeURIComponent(
      Array.from(latin1).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed.step !== 'string' || typeof parsed.cap !== 'string') return null;
    return {
      stepName: parsed.step,
      capName: parsed.cap,
      stackCount: Math.max(1, parseInt(parsed.count, 10) || 1),
    };
  } catch (err) {
    console.error('Failed to decode manual stacking config:', err);
    return null;
  }
}
