// ── Helpers ───────────────────────────────────────────────────────────────────

export function nbtNum(node) {
    return Number(node.value ?? node);
}

export function localToWorld(position, size) {
    const ox = size.x >= 0 ? position.x : position.x + size.x;
    const oy = size.y >= 0 ? position.y : position.y + size.y;
    const oz = size.z >= 0 ? position.z : position.z + size.z;
    const ax = Math.abs(size.x);
    const ay = Math.abs(size.y);
    const az = Math.abs(size.z);
    return {
        origin: { x: ox, y: oy, z: oz },
        end:    { x: ox + ax - 1, y: oy + ay - 1, z: oz + az - 1 },
        size:   { x: ax, y: ay, z: az },
        bounds: { minX: ox, maxX: ox + ax - 1, minY: oy, maxY: oy + ay - 1, minZ: oz, maxZ: oz + az - 1 }
    };
}

export function deepCloneNbtCompound(compound) {
    return deepslate.NbtCompound.fromJson(compound.toJson());
}

// Clones a region entry cheaply for re-positioning. A region's Position is
// the only thing stacking ever changes on a copy — everything else
// (BlockStatePalette, BlockStates, TileEntities, Entities, PendingBlockTicks,
// etc.) is read-only downstream and identical across copies, so it's shared
// by reference instead of being deep-cloned. This matters because a naive
// full clone (toJson()/fromJson() round trip) re-serializes a region's
// entire block-state data for every single stacked copy, on every stack
// change — the cost was scaling with stackSize * regionBlockCount for no
// reason. Only the small Position compound is actually deep-cloned here.
export function cloneRegionWithPosition(sourceEntry, newPos) {
    const cloned = new deepslate.NbtCompound();
    for (const key of sourceEntry.keys()) {
        cloned.set(key, key === "Position" ? deepCloneNbtCompound(sourceEntry.get(key)) : sourceEntry.get(key));
    }
    const pos = cloned.get("Position");
    for (const axis of ['x', 'y', 'z']) {
        const node = pos.get(axis);
        node.value !== undefined ? (node.value = newPos[axis]) : pos.set(axis, newPos[axis]);
    }
    return cloned;
}
