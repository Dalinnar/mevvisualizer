function localToWorld(position, size) {
    const originX = size.x >= 0 ? position.x : position.x + size.x;
    const originY = size.y >= 0 ? position.y : position.y + size.y;
    const originZ = size.z >= 0 ? position.z : position.z + size.z;
    const absX = Math.abs(size.x);
    const absY = Math.abs(size.y);
    const absZ = Math.abs(size.z);
    const endX = originX + absX - 1;
    const endY = originY + absY - 1;
    const endZ = originZ + absZ - 1;
    return {
        origin: { x: originX, y: originY, z: originZ },
        end: { x: endX, y: endY, z: endZ },
        size: { x: absX, y: absY, z: absZ },
        bounds: { minX: originX, maxX: endX, minY: originY, maxY: endY, minZ: originZ, maxZ: endZ }
    };
}

function getLitematicOrigin(regions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const region of regions) {
        const w = localToWorld(region.position, region.size);
        minX = Math.min(minX, w.origin.x);
        minY = Math.min(minY, w.origin.y);
        minZ = Math.min(minZ, w.origin.z);
    }
    return { x: minX, y: minY, z: minZ };
}

function getLitematicBounds(regions) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const region of regions) {
        const w = localToWorld(region.position, region.size);
        minX = Math.min(minX, w.bounds.minX); maxX = Math.max(maxX, w.bounds.maxX);
        minY = Math.min(minY, w.bounds.minY); maxY = Math.max(maxY, w.bounds.maxY);
        minZ = Math.min(minZ, w.bounds.minZ); maxZ = Math.max(maxZ, w.bounds.maxZ);
    }
    return {
        origin: { x: minX, y: minY, z: minZ },
        end: { x: maxX, y: maxY, z: maxZ },
        size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 }
    };
}




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
        const pos = region.get("Position");
        const size = region.get("Size");

        const posX = Number(pos.get("x").value ?? pos.get("x"));
        const posY = Number(pos.get("y").value ?? pos.get("y"));
        const posZ = Number(pos.get("z").value ?? pos.get("z"));
        const sizeX = Number(size.get("x").value ?? size.get("x"));
        const sizeY = Number(size.get("y").value ?? size.get("y"));
        const sizeZ = Number(size.get("z").value ?? size.get("z"));

        const worldCoords = localToWorld(
            { x: posX, y: posY, z: posZ },
            { x: sizeX, y: sizeY, z: sizeZ }
        );

        regionDataArray.push({
            name, posX, posY, posZ, sizeX, sizeY, sizeZ,
            absX: Math.abs(sizeX), absY: Math.abs(sizeY), absZ: Math.abs(sizeZ),
            ...worldCoords.bounds,
            worldCoords
        });

        result.regions.push({
            name,
            position: { x: posX, y: posY, z: posZ },
            size: { x: sizeX, y: sizeY, z: sizeZ },
            worldCoordinates: worldCoords
        });

        result.worldCoordinates[name] = worldCoords;
    }

    result.litematicOrigin = getLitematicOrigin(result.regions.map(r => ({ position: r.position, size: r.size })));
    result.litematicBounds = getLitematicBounds(result.regions.map(r => ({ position: r.position, size: r.size })));

    // ── All regions must share the same Y band ───────────────────────────────

    const firstRegion = regionDataArray[0];
    const allSameY = regionDataArray.every(r =>
        r.minY === firstRegion.minY && r.maxY === firstRegion.maxY
    );

    if (!allSameY) {
        result.errors.push("All regions must have the same Y position and height");
        return result;
    }

    // ── Detect stacking axis by trying both and seeing which works ───────────
    // Strategy: for each candidate stack axis, group regions by their position
    // on the OTHER axis (parallel axis). A valid grouping means every cluster
    // has >= 3 members and is adjacent along the stack axis.

    function tryAxis(strideAxis) {
        const parallelAxis = strideAxis === 'x' ? 'z' : 'x';
        const minKey = parallelAxis === 'x' ? 'minX' : 'minZ';
        const maxKey = parallelAxis === 'x' ? 'maxX' : 'maxZ';

        // Group regions that OVERLAP on the parallel axis into the same cluster.
        // We do a simple union-find: merge any two regions whose parallel ranges overlap.
        const clusters = [];

        for (const r of regionDataArray) {
            const rMin = r[minKey];
            const rMax = r[maxKey];

            // Find an existing cluster that overlaps with this region on the parallel axis
            const matchIndex = clusters.findIndex(cluster =>
                cluster.some(c => c[minKey] <= rMax && c[maxKey] >= rMin)
            );

            if (matchIndex !== -1) {
                clusters[matchIndex].push(r);
            } else {
                clusters.push([r]);
            }
        }

        // Every cluster must have >= 3 regions AND be adjacent along the stride axis
        for (const cluster of clusters) {
            if (cluster.length < 3) return null;

            const sorted = [...cluster].sort((a, b) =>
                strideAxis === 'x' ? a.minX - b.minX : a.minZ - b.minZ
            );
            for (let i = 0; i < sorted.length - 1; i++) {
                const gap = strideAxis === 'x'
                    ? sorted[i + 1].minX - sorted[i].maxX - 1
                    : sorted[i + 1].minZ - sorted[i].maxZ - 1;
                if (gap > 0) return null;
            }
        }

        // Convert back to a Map keyed by cluster index for compatibility
        const clusterMap = new Map();
        clusters.forEach((cluster, i) => clusterMap.set(i, cluster));
        return clusterMap;
    }

    let strideAxis = null;
    let parallelAxis = null;
    let clusterMap = null;

    const tryX = tryAxis('x');
    const tryZ = tryAxis('z');

    if (tryX && tryZ) {
        // Both work — pick the one with more clusters (more parallel lanes)
        // or just default to z since that's the most common stacking direction
        clusterMap = tryZ.size >= tryX.size ? tryZ : tryX;
        strideAxis = tryZ.size >= tryX.size ? 'z' : 'x';
        parallelAxis = strideAxis === 'x' ? 'z' : 'x';
        result.warnings.push("Both X and Z axes are valid stacking axes; defaulting to Z");
    } else if (tryX) {
        strideAxis = 'x';
        parallelAxis = 'z';
        clusterMap = tryX;
    } else if (tryZ) {
        strideAxis = 'z';
        parallelAxis = 'x';
        clusterMap = tryZ;
    } else {
        result.errors.push("Could not determine a valid stacking axis. Ensure each parallel cluster has at least 3 adjacent regions.");
        return result;
    }

    // Preserve sign from the actual region size for downstream code
    result.stackAxis = firstRegion[`size${strideAxis.toUpperCase()}`] >= 0
        ? strideAxis
        : `${strideAxis}-`;

    // ── Validate each cluster and build details ───────────────────────────────

    const allSortedNames = [];
    const clusterDetails = [];
    let hasErrors = false;

    for (const [parallelCoord, cluster] of clusterMap) {
        const sorted = [...cluster].sort((a, b) =>
            strideAxis === 'x' ? a.minX - b.minX : a.minZ - b.minZ
        );

        // Uniform size within cluster
        //const refWidth = sorted[0].absX;
        //const refDepth = sorted[0].absZ;
        //if (!sorted.every(r => r.absX === refWidth && r.absZ === refDepth)) {
        //    result.errors.push(
        //        `Cluster at ${parallelAxis}=${parallelCoord} has regions with inconsistent sizes`
        //    );
        //    hasErrors = true;
        //    continue;
        //}

        allSortedNames.push(...sorted.map(r => r.name));
        clusterDetails.push({
            parallelCoord,
            names: sorted.map(r => r.name),
            firstName: sorted[0].name,
            lastName: sorted[sorted.length - 1].name,
            middleNames: sorted.slice(1, -1).map(r => r.name),
        });
    }

    if (hasErrors) return result;

    result.details.sortedRegions = allSortedNames;
    result.details.clusters = clusterDetails;
    result.details.clusterCount = clusterDetails.length;
    result.isValid = true;

    return result;
}

function checkZAxisAdjacency(regionDataArray) {
    console.log("checkZAxisAdjacency input:", regionDataArray);

    const sorted = [...regionDataArray].sort((a, b) => a.minZ - b.minZ);

    for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];

        console.log("Z adjacency check:", current.name, next.name, {
            currentMax: current.maxZ,
            nextMin: next.minZ
        });

        if (next.minZ > current.maxZ + 1) {
            console.log("Gap detected on Z axis");
            return false;
        }
    }

    return true;
}

function checkXAxisAdjacency(regionDataArray) {
    console.log("checkXAxisAdjacency input:", regionDataArray);

    const sorted = [...regionDataArray].sort((a, b) => a.minX - b.minX);

    for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];

        console.log("X adjacency check:", current.name, next.name, {
            currentMax: current.maxX,
            nextMin: next.minX
        });

        if (next.minX > current.maxX + 1) {
            console.log("Gap detected on X axis");
            return false;
        }
    }

    return true;
}



function deepCloneNbtCompound(compound) {
    return deepslate.NbtCompound.fromJson(compound.toJson());
}


/**
 * Groups sorted region names into clusters based on gaps along the stack axis.
 * A "gap" is when the distance between one region's world-end and the next's
 * world-start is greater than `gapThreshold` blocks.
 */
function detectClusters(sortedNames, regions, strideAxis, gapThreshold = 1) {
    function readVec3(entry, tag) {
        const v = entry.get(tag);
        return {
            x: Number(v.get("x").value ?? v.get("x")),
            y: Number(v.get("y").value ?? v.get("y")),
            z: Number(v.get("z").value ?? v.get("z")),
        };
    }

    const clusters = [];
    let current = [sortedNames[0]];

    for (let i = 1; i < sortedNames.length; i++) {
        const prevName = sortedNames[i - 1];
        const currName = sortedNames[i];

        const prevEntry = regions.get(prevName);
        const currEntry = regions.get(currName);

        const prevPos = readVec3(prevEntry, "Position");
        const prevSize = readVec3(prevEntry, "Size");
        const currPos = readVec3(currEntry, "Position");
        const currSize = readVec3(currEntry, "Size");

        const prevWorld = localToWorld(prevPos, prevSize);
        const currWorld = localToWorld(currPos, currSize);

        // Gap between previous region's end and current region's start
        const gap = currWorld.origin[strideAxis] - prevWorld.end[strideAxis] - 1;

        if (gap > gapThreshold) {
            clusters.push(current);
            current = [currName];
        } else {
            current.push(currName);
        }
    }
    clusters.push(current);
    return clusters;
}

export function stackMiddle(nbt, stackSize) {
    const validation = validateStackingStructure(nbt);
    if (!validation.isValid) {
        throw new Error(`Cannot stack invalid structure: ${validation.errors.join('; ')}`);
    }

    const { stackAxis, details } = validation;
    const root = nbt.root || nbt;
    const regions = root.get("Regions");
    const strideAxis = stackAxis.startsWith('x') ? 'x' : 'z';

    function readVec3(entry, tag) {
        const v = entry.get(tag);
        return {
            x: Number(v.get("x").value ?? v.get("x")),
            y: Number(v.get("y").value ?? v.get("y")),
            z: Number(v.get("z").value ?? v.get("z")),
        };
    }

    function cloneWithPosition(sourceEntry, newPos) {
        const cloned = deepCloneNbtCompound(sourceEntry);
        const pos = cloned.get("Position");
        pos.get("x").value !== undefined
            ? (pos.get("x").value = newPos.x) : pos.set("x", newPos.x);
        pos.get("y").value !== undefined
            ? (pos.get("y").value = newPos.y) : pos.set("y", newPos.y);
        pos.get("z").value !== undefined
            ? (pos.get("z").value = newPos.z) : pos.set("z", newPos.z);
        return cloned;
    }

    const newRegions = new Map();

    for (const { firstName, middleNames, lastName } of details.clusters) {
        if (!middleNames || middleNames.length === 0) {
            throw new Error(`Cluster starting with "${firstName}" has no middle regions to stack`);
        }

        // 1. Keep "first" as-is
        newRegions.set(firstName, regions.get(firstName));

        // Stride = size of first middle along the stack axis
        const firstMiddleEntry = regions.get(middleNames[0]);
        const firstMiddleSize = readVec3(firstMiddleEntry, "Size");
        const stride = Math.abs(firstMiddleSize[strideAxis]);

        // Start coord: right after "first" ends
        const firstEntry = regions.get(firstName);
        const firstPos = readVec3(firstEntry, "Position");
        const firstSize = readVec3(firstEntry, "Size");
        const firstWorld = localToWorld(firstPos, firstSize);
        let coord = firstWorld.end[strideAxis] + 1;

        // 2. Emit stackSize copies of each middle
        for (let copy = 0; copy < stackSize; copy++) {
            for (const midName of middleNames) {
                const midEntry = regions.get(midName);
                const midPos = readVec3(midEntry, "Position");
                const midSize = readVec3(midEntry, "Size");
                const midWorld = localToWorld(midPos, midSize);

                const offset = {
                    x: midPos.x - midWorld.origin.x,
                    y: midPos.y - midWorld.origin.y,
                    z: midPos.z - midWorld.origin.z,
                };
                const newWorldOrigin = { ...midWorld.origin, [strideAxis]: coord };
                const newPos = {
                    x: newWorldOrigin.x + offset.x,
                    y: newWorldOrigin.y + offset.y,
                    z: newWorldOrigin.z + offset.z,
                };

                newRegions.set(`${midName}_${copy}`, cloneWithPosition(midEntry, newPos));
                coord += stride;
            }
        }

        // 3. Place "last" right after all middles
        const lastEntry = regions.get(lastName);
        const lastPos = readVec3(lastEntry, "Position");
        const lastSize = readVec3(lastEntry, "Size");
        const lastWorld = localToWorld(lastPos, lastSize);

        const lastOffset = {
            x: lastPos.x - lastWorld.origin.x,
            y: lastPos.y - lastWorld.origin.y,
            z: lastPos.z - lastWorld.origin.z,
        };
        const newLastWorldOrigin = { ...lastWorld.origin, [strideAxis]: coord };
        const newLastPos = {
            x: newLastWorldOrigin.x + lastOffset.x,
            y: newLastWorldOrigin.y + lastOffset.y,
            z: newLastWorldOrigin.z + lastOffset.z,
        };

        newRegions.set(lastName, cloneWithPosition(lastEntry, newLastPos));
    }

    // ── Write back ────────────────────────────────────────────────────────────

    const regionsCompound = new deepslate.NbtCompound();
    for (const [name, region] of newRegions.entries()) {
        regionsCompound.set(name, region);
    }
    root.set("Regions", regionsCompound);
    return nbt;
}