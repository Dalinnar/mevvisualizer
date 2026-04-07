// ── Helpers ───────────────────────────────────────────────────────────────────

function nbtNum(node) {
    return Number(node.value ?? node);
}

function localToWorld(position, size) {
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

function getLitematicOrigin(regions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const { position, size } of regions) {
        const { origin } = localToWorld(position, size);
        if (origin.x < minX) minX = origin.x;
        if (origin.y < minY) minY = origin.y;
        if (origin.z < minZ) minZ = origin.z;
    }
    return { x: minX, y: minY, z: minZ };
}

function getLitematicBounds(regions) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const { position, size } of regions) {
        const { bounds: b } = localToWorld(position, size);
        if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
        if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
        if (b.minZ < minZ) minZ = b.minZ; if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    return {
        origin: { x: minX, y: minY, z: minZ },
        end:    { x: maxX, y: maxY, z: maxZ },
        size:   { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 }
    };
}

function deepCloneNbtCompound(compound) {
    return deepslate.NbtCompound.fromJson(compound.toJson());
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateStackingStructure(nbt) {
    const result = {
        isValid: false,
        errors: [],
        warnings: [],
        regionCount: 0,
        regions: [],
        stackAxis: null,
        details: {},
        worldCoordinates: {},
        litematicOrigin: null,
        litematicBounds: null
    };

    const root = nbt.root || nbt;
    const regions = root.get("Regions");

    if (!regions) {
        result.errors.push("Invalid NBT structure: missing Regions");
        return result;
    }

    const regionNames = Array.from(regions.keys());
    result.regionCount = regionNames.length;

    if (regionNames.length < 3) {
        result.errors.push(`Expected at least 3 regions, found ${regionNames.length}`);
        return result;
    }

    // ── Parse all regions ────────────────────────────────────────────────────

    const regionDataArray = [];

    for (const name of regionNames) {
        const region = regions.get(name);
        const pos  = region.get("Position");
        const size = region.get("Size");

        const position = {
            x: nbtNum(pos.get("x")),
            y: nbtNum(pos.get("y")),
            z: nbtNum(pos.get("z")),
        };
        const sz = {
            x: nbtNum(size.get("x")),
            y: nbtNum(size.get("y")),
            z: nbtNum(size.get("z")),
        };

        const worldCoords = localToWorld(position, sz);
        const { bounds: b } = worldCoords;

        regionDataArray.push({
            name,
            posX: position.x, posY: position.y, posZ: position.z,
            sizeX: sz.x, sizeY: sz.y, sizeZ: sz.z,
            absX: Math.abs(sz.x), absY: Math.abs(sz.y), absZ: Math.abs(sz.z),
            minX: b.minX, maxX: b.maxX,
            minY: b.minY, maxY: b.maxY,
            minZ: b.minZ, maxZ: b.maxZ,
            worldCoords,
        });

        result.regions.push({ name, position, size: sz, worldCoordinates: worldCoords });
        result.worldCoordinates[name] = worldCoords;
    }

    const regionsMeta = result.regions.map(r => ({ position: r.position, size: r.size }));
    result.litematicOrigin = getLitematicOrigin(regionsMeta);
    result.litematicBounds = getLitematicBounds(regionsMeta);

    // ── All regions must share the same Y band ───────────────────────────────

    const { minY: refMinY, maxY: refMaxY } = regionDataArray[0];
    if (!regionDataArray.every(r => r.minY === refMinY && r.maxY === refMaxY)) {
        result.errors.push("All regions must have the same Y position and height");
        return result;
    }

    // ── Detect stacking axis ─────────────────────────────────────────────────
    // For each candidate stride axis, group regions into clusters that OVERLAP
    // on the parallel axis, then verify each cluster is contiguous along stride.

    function tryAxis(strideAxis) {
        const minKey = strideAxis === 'x' ? 'minZ' : 'minX';
        const maxKey = strideAxis === 'x' ? 'maxZ' : 'maxX';
        const strideMin = strideAxis === 'x' ? 'minX' : 'minZ';
        const strideMax = strideAxis === 'x' ? 'maxX' : 'maxZ';

        const clusters = [];

        for (const r of regionDataArray) {
            const rMin = r[minKey], rMax = r[maxKey];
            const idx = clusters.findIndex(c =>
                c.some(m => m[minKey] <= rMax && m[maxKey] >= rMin)
            );
            if (idx !== -1) clusters[idx].push(r);
            else clusters.push([r]);
        }

        for (const cluster of clusters) {
            if (cluster.length < 3) return null;
            cluster.sort((a, b) => a[strideMin] - b[strideMin]);
            for (let i = 0; i < cluster.length - 1; i++) {
                if (cluster[i + 1][strideMin] - cluster[i][strideMax] > 1) return null;
            }
        }

        return clusters;
    }

    const tryX = tryAxis('x');
    const tryZ = tryAxis('z');

    let strideAxis, clusters;

    if (tryX && tryZ) {
        const useZ = tryZ.length >= tryX.length;
        strideAxis = useZ ? 'z' : 'x';
        clusters   = useZ ? tryZ : tryX;
        result.warnings.push("Both X and Z axes are valid stacking axes; defaulting to Z");
    } else if (tryZ) {
        strideAxis = 'z'; clusters = tryZ;
    } else if (tryX) {
        strideAxis = 'x'; clusters = tryX;
    } else {
        result.errors.push("Could not determine a valid stacking axis. Ensure each parallel cluster has at least 3 adjacent regions.");
        return result;
    }

    const parallelAxis = strideAxis === 'x' ? 'z' : 'x';

    result.stackAxis = regionDataArray[0][`size${strideAxis.toUpperCase()}`] >= 0
        ? strideAxis
        : `${strideAxis}-`;

    // ── Build details ─────────────────────────────────────────────────────────

    const allSortedNames  = [];
    const clusterDetails  = [];
    const strideMin       = strideAxis === 'x' ? 'minX' : 'minZ';
    const clusterMap      = new Map();

    clusters.forEach((cluster, i) => {
        cluster.sort((a, b) => a[strideMin] - b[strideMin]);
        const names = cluster.map(r => r.name);
        allSortedNames.push(...names);
        clusterDetails.push({
            parallelCoord: i,
            names,
            firstName:   names[0],
            lastName:    names[names.length - 1],
            middleNames: names.slice(1, -1),
        });
        clusterMap.set(i, cluster);
    });

    result.details.sortedRegions = allSortedNames;
    result.details.clusters      = clusterDetails;
    result.details.clusterCount  = clusterDetails.length;
    result.isValid = true;

    return result;
}

// ── Stacking ──────────────────────────────────────────────────────────────────

export function stackMiddle(nbt, stackSize, gap = 0) {
    const validation = validateStackingStructure(nbt);
    if (!validation.isValid) {
        throw new Error(`Cannot stack invalid structure: ${validation.errors.join('; ')}`);
    }

    const { stackAxis, details } = validation;
    const root    = nbt.root || nbt;
    const regions = root.get("Regions");

    const strideAxis   = stackAxis.startsWith('x') ? 'x' : 'z';
    const parallelAxis = strideAxis === 'x' ? 'z' : 'x';

    // Read a Position/Size vec3 from an NBT region entry
    function readVec3(entry, tag) {
        const v = entry.get(tag);
        return {
            x: nbtNum(v.get("x")),
            y: nbtNum(v.get("y")),
            z: nbtNum(v.get("z")),
        };
    }

    // Clone an entry and overwrite its Position
    function cloneWithPosition(sourceEntry, newPos) {
        const cloned = deepCloneNbtCompound(sourceEntry);
        const pos = cloned.get("Position");
        for (const axis of ['x', 'y', 'z']) {
            const node = pos.get(axis);
            node.value !== undefined ? (node.value = newPos[axis]) : pos.set(axis, newPos[axis]);
        }
        return cloned;
    }

    // Compute the local-space position after shifting the parallel axis origin
    function shiftedPos(originalPos, originalSize, shift) {
        const world  = localToWorld(originalPos, originalSize);
        const offset = {
            x: originalPos.x - world.origin.x,
            y: originalPos.y - world.origin.y,
            z: originalPos.z - world.origin.z,
        };
        return {
            x: world.origin.x + offset.x + (parallelAxis === 'x' ? shift : 0),
            y: world.origin.y + offset.y,
            z: world.origin.z + offset.z + (parallelAxis === 'z' ? shift : 0),
        };
    }

    // Sort clusters by their first region's parallel-axis world origin
    const sortedClusters = [...details.clusters].sort((a, b) => {
        function parallelOrigin(name) {
            const entry = regions.get(name);
            return localToWorld(readVec3(entry, "Position"), readVec3(entry, "Size")).origin[parallelAxis];
        }
        return parallelOrigin(a.firstName) - parallelOrigin(b.firstName);
    });

    const newRegions     = new Map();
    let cumulativeShift  = 0;

    for (const { firstName, middleNames, lastName } of sortedClusters) {
        if (!middleNames?.length) {
            throw new Error(`Cluster starting with "${firstName}" has no middle regions to stack`);
        }

        const shift = cumulativeShift;

        // ── First region ──────────────────────────────────────────────────────
        const firstEntry = regions.get(firstName);
        const firstPos   = readVec3(firstEntry, "Position");
        const firstSize  = readVec3(firstEntry, "Size");
        const firstWorld = localToWorld(firstPos, firstSize);

        newRegions.set(firstName, cloneWithPosition(firstEntry, shiftedPos(firstPos, firstSize, shift)));

        // Stride = width of first middle region along the stride axis
        const firstMidEntry = regions.get(middleNames[0]);
        const stride = Math.abs(readVec3(firstMidEntry, "Size")[strideAxis]);

        let coord = firstWorld.end[strideAxis] + 1;

        // ── Middle copies ─────────────────────────────────────────────────────
        for (let copy = 0; copy < stackSize; copy++) {
            for (const midName of middleNames) {
                const midEntry = regions.get(midName);
                const midPos   = readVec3(midEntry, "Position");
                const midSize  = readVec3(midEntry, "Size");
                const midWorld = localToWorld(midPos, midSize);

                const newOrigin = { ...midWorld.origin, [strideAxis]: coord, [parallelAxis]: midWorld.origin[parallelAxis] + shift };
                newRegions.set(`${midName}_${copy}`, cloneWithPosition(midEntry, {
                    x: newOrigin.x + (midPos.x - midWorld.origin.x),
                    y: newOrigin.y + (midPos.y - midWorld.origin.y),
                    z: newOrigin.z + (midPos.z - midWorld.origin.z),
                }));
                coord += stride;
            }
        }

        // ── Last region ───────────────────────────────────────────────────────
        const lastEntry = regions.get(lastName);
        const lastPos   = readVec3(lastEntry, "Position");
        const lastSize  = readVec3(lastEntry, "Size");
        const lastWorld = localToWorld(lastPos, lastSize);

        const newLastOrigin = { ...lastWorld.origin, [strideAxis]: coord, [parallelAxis]: lastWorld.origin[parallelAxis] + shift };
        newRegions.set(lastName, cloneWithPosition(lastEntry, {
            x: newLastOrigin.x + (lastPos.x - lastWorld.origin.x),
            y: newLastOrigin.y + (lastPos.y - lastWorld.origin.y),
            z: newLastOrigin.z + (lastPos.z - lastWorld.origin.z),
        }));

        cumulativeShift += gap;
    }

    // ── Patch EnclosingSize from actual bounding box ──────────────────────────
    const PA = parallelAxis.toUpperCase();
    const SA = strideAxis.toUpperCase();
    let minP = Infinity, maxP = -Infinity;
    let minS = Infinity, maxS = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const region of newRegions.values()) {
        const { bounds: b } = localToWorld(readVec3(region, "Position"), readVec3(region, "Size"));
        if (b[`min${PA}`] < minP) minP = b[`min${PA}`];
        if (b[`max${PA}`] > maxP) maxP = b[`max${PA}`];
        if (b[`min${SA}`] < minS) minS = b[`min${SA}`];
        if (b[`max${SA}`] > maxS) maxS = b[`max${SA}`];
        if (b.minY < minY) minY = b.minY;
        if (b.maxY > maxY) maxY = b.maxY;
    }

    const enclosing = root.get("Metadata").get("EnclosingSize");
    function setVal(compound, key, val) {
        const node = compound.get(key);
        node.value !== undefined ? (node.value = val) : compound.set(key, val);
    }
    setVal(enclosing, parallelAxis, maxP - minP + 1);
    setVal(enclosing, strideAxis,   maxS - minS + 1);
    setVal(enclosing, 'y',          maxY - minY + 1);

    // ── Write back ────────────────────────────────────────────────────────────
    const regionsCompound = new deepslate.NbtCompound();
    for (const [name, region] of newRegions) {
        regionsCompound.set(name, region);
    }
    root.set("Regions", regionsCompound);
    return nbt;
}