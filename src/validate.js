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

    const result = {
        origin: { x: originX, y: originY, z: originZ },
        end: { x: endX, y: endY, z: endZ },
        size: { x: absX, y: absY, z: absZ },
        bounds: {
            minX: originX,
            maxX: endX,
            minY: originY,
            maxY: endY,
            minZ: originZ,
            maxZ: endZ
        }
    };


    return result;
}

function getLitematicOrigin(regions) {
    console.log("getLitematicOrigin input:", regions);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;

    for (const region of regions) {
        const worldCoords = localToWorld(region.position, region.size);
        console.log("Origin check region:", region, worldCoords);

        minX = Math.min(minX, worldCoords.origin.x);
        minY = Math.min(minY, worldCoords.origin.y);
        minZ = Math.min(minZ, worldCoords.origin.z);
    }

    const result = { x: minX, y: minY, z: minZ };
    console.log("getLitematicOrigin result:", result);
    return result;
}

function getLitematicBounds(regions) {
    console.log("getLitematicBounds input:", regions);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const region of regions) {
        const worldCoords = localToWorld(region.position, region.size);
        console.log("Bounds check region:", region, worldCoords);

        minX = Math.min(minX, worldCoords.bounds.minX);
        maxX = Math.max(maxX, worldCoords.bounds.maxX);
        minY = Math.min(minY, worldCoords.bounds.minY);
        maxY = Math.max(maxY, worldCoords.bounds.maxY);
        minZ = Math.min(minZ, worldCoords.bounds.minZ);
        maxZ = Math.max(maxZ, worldCoords.bounds.maxZ);
    }

    const result = {
        origin: { x: minX, y: minY, z: minZ },
        end: { x: maxX, y: maxY, z: maxZ },
        size: {
            x: maxX - minX + 1,
            y: maxY - minY + 1,
            z: maxZ - minZ + 1
        }
    };

    console.log("getLitematicBounds result:", result);
    return result;
}

export function validateStackingStructure(nbt) {
    console.log("validateStackingStructure input:", nbt);

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

    console.log("Root + Regions:", { root, regions });

    if (!regions) {
        result.errors.push("Invalid NBT structure: missing Regions");
        console.log("Error:", result.errors);
        return result;
    }

    const regionNames = Array.from(regions.keys());
    result.regionCount = regionNames.length;

    console.log("Region names:", regionNames);

    if (regionNames.length < 3) {
        result.errors.push(`Expected at least 3 regions, found ${regionNames.length}`);
        console.log("Error:", result.errors);
        return result;
    }

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

        console.log("Region raw:", name, { posX, posY, posZ, sizeX, sizeY, sizeZ });

        const worldCoords = localToWorld(
            { x: posX, y: posY, z: posZ },
            { x: sizeX, y: sizeY, z: sizeZ }
        );

        const regionData = {
            name,
            posX,
            posY,
            posZ,
            sizeX,
            sizeY,
            sizeZ,
            absX: Math.abs(sizeX),
            absY: Math.abs(sizeY),
            absZ: Math.abs(sizeZ),
            endX: worldCoords.end.x,
            endZ: worldCoords.end.z,
            minX: worldCoords.bounds.minX,
            maxX: worldCoords.bounds.maxX,
            minY: worldCoords.bounds.minY,
            maxY: worldCoords.bounds.maxY,
            minZ: worldCoords.bounds.minZ,
            maxZ: worldCoords.bounds.maxZ,
            worldCoords
        };

        console.log("Processed region:", regionData);

        regionDataArray.push(regionData);

        result.regions.push({
            name,
            position: { x: posX, y: posY, z: posZ },
            size: { x: sizeX, y: sizeY, z: sizeZ },
            worldCoordinates: worldCoords
        });

        result.worldCoordinates[name] = worldCoords;
    }

    result.litematicOrigin = getLitematicOrigin(
        result.regions.map(r => ({ position: r.position, size: r.size }))
    );

    result.litematicBounds = getLitematicBounds(
        result.regions.map(r => ({ position: r.position, size: r.size }))
    );

    console.log("Global origin:", result.litematicOrigin);
    console.log("Global bounds:", result.litematicBounds);



    const firstRegion = regionDataArray[0];

    const allSameY = regionDataArray.every(r =>
        r.minY === firstRegion.minY && r.maxY === firstRegion.maxY
    );

    //console.log("allSameY details:", regionDataArray.map(r => ({ name: r.name, minY: r.minY, maxY: r.maxY })));
    //console.log("allSameXPosition details:", regionDataArray.map(r => ({ name: r.name, minX: r.minX, maxX: r.maxX })));
    //console.log("allSameZPosition details:", regionDataArray.map(r => ({ name: r.name, minZ: r.minZ, maxZ: r.maxZ })));
    //console.log("flags:", { allSameY, allSameWidth, allSameDepth, allSameXPosition, allSameZPosition });
    //console.log("Check allSameY:", allSameY);


    if (!allSameY) {
        result.errors.push("All regions must have the same Y position and height");
    }

    const allSameWidth = regionDataArray.every(r => r.absX === firstRegion.absX);
    const allSameDepth = regionDataArray.every(r => r.absZ === firstRegion.absZ);

    console.log("Check width/depth:", { allSameWidth, allSameDepth });

    const allSameXPosition = regionDataArray.every(
        r => r.minX === firstRegion.minX && r.maxX === firstRegion.maxX
    );

    const allSameZPosition = regionDataArray.every(
        r => r.minZ === firstRegion.minZ && r.maxZ === firstRegion.maxZ
    );

    console.log("Check positions:", { allSameXPosition, allSameZPosition });

    let stackingAxis = null;
    let isAdjacent = false;

    if (allSameWidth && allSameXPosition && !allSameZPosition) {
        stackingAxis = firstRegion.sizeZ > 0 ? 'z' : 'z-';
        console.log("Detected Z stacking axis:", stackingAxis);
        isAdjacent = checkZAxisAdjacency(regionDataArray);
    } else if (allSameDepth && allSameZPosition && !allSameXPosition) {
        stackingAxis = firstRegion.sizeX > 0 ? 'x' : 'x-';
        console.log("Detected X stacking axis:", stackingAxis);
        isAdjacent = checkXAxisAdjacency(regionDataArray);
    } else if (!allSameXPosition && !allSameZPosition) {
        result.errors.push("Regions cannot vary on both X and Z axes simultaneously");
    } else if (allSameXPosition && allSameZPosition) {
        result.errors.push("All regions have identical positions - cannot determine stacking pattern");
    }

    console.log("Adjacency result:", isAdjacent);

    result.stackAxis = stackingAxis;
    result.details.isAdjacent = isAdjacent;

    if (!isAdjacent && stackingAxis) {
        result.errors.push(`Regions are not adjacent on the ${stackingAxis} axis`);
    }

    if (isAdjacent) {
        const sortedRegions = [...regionDataArray].sort((a, b) => {
            return (stackingAxis === 'x' || stackingAxis === 'x-')
                ? a.minX - b.minX
                : a.minZ - b.minZ;
        });

        console.log("Sorted regions:", sortedRegions);

        result.details.sortedRegions = sortedRegions.map(r => r.name);
        result.details.sortedRegionDetails = sortedRegions.map(r => ({
            name: r.name,
            worldBounds: {
                minX: r.minX,
                maxX: r.maxX,
                minY: r.minY,
                maxY: r.maxY,
                minZ: r.minZ,
                maxZ: r.maxZ
            }
        }));
    }

    if (result.errors.length === 0 && isAdjacent && stackingAxis) {
        result.isValid = true;
    }

    console.log("Final result:", result);
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


export function stackMiddle(nbt, stackSize) {
    const validation = validateStackingStructure(nbt);
    if (!validation.isValid) {
        throw new Error(`Cannot stack invalid structure: ${validation.errors.join('; ')}`);
    }

    const { stackAxis, details } = validation;
    const sortedNames = details.sortedRegions; // e.g. ["a", "b", "c"]

    // Identify first, middle(s), and last
    const firstName = sortedNames[0];
    const lastName = sortedNames[sortedNames.length - 1];
    const middleNames = sortedNames.slice(1, -1); // everything between first and last

    const root = nbt.root || nbt;
    const regions = root.get("Regions");

    // Deep-clone the NBT — we'll rebuild Regions from scratch
    const newNbt = nbt; // mutate in place, or clone if your NBT lib supports it
    const newRegions = new Map();

    // Helper: get region data by name
    function getRegionEntry(name) {
        return regions.get(name);
    }

    // Helper: read position/size from a region entry
    function readVec3(entry, tag) {
        const v = entry.get(tag);
        return {
            x: Number(v.get("x").value ?? v.get("x")),
            y: Number(v.get("y").value ?? v.get("y")),
            z: Number(v.get("z").value ?? v.get("z")),
        };
    }

    // Helper: clone a region entry and set a new position
    function cloneWithPosition(sourceEntry, newPos) {
        // Deep clone the region (NBT map)
        const cloned = deepCloneNbtCompound(sourceEntry);
        const pos = cloned.get("Position");
        pos.get("x").value !== undefined
            ? (pos.get("x").value = newPos.x)
            : pos.set("x", newPos.x);
        pos.get("y").value !== undefined
            ? (pos.get("y").value = newPos.y)
            : pos.set("y", newPos.y);
        pos.get("z").value !== undefined
            ? (pos.get("z").value = newPos.z)
            : pos.set("z", newPos.z);
        return cloned;
    }

    // --- Compute the stride (size along the stacking axis) of a middle region ---
    const firstMiddleName = middleNames[0];
    const firstMiddleEntry = getRegionEntry(firstMiddleName);
    const firstMiddleSize = readVec3(firstMiddleEntry, "Size");
    const strideAxis = stackAxis.startsWith('x') ? 'x' : 'z';
    const stride = Math.abs(firstMiddleSize[strideAxis]); // blocks per middle copy

    // --- Read positions of the original first/last to find where middles start ---
    const firstEntry = getRegionEntry(firstName);
    const lastEntry = getRegionEntry(lastName);
    const firstPos = readVec3(firstEntry, "Position");
    const firstSize = readVec3(firstEntry, "Size");
    const firstWorld = localToWorld(firstPos, firstSize);



    // The first copy of the first middle starts right after "first" ends
    const middleStartCoord = firstWorld.end[strideAxis] + 1;

    // --- Build new region map ---

    // 1. Keep "first" as-is
    newRegions.set(firstName, getRegionEntry(firstName));

    // 2. Emit stackSize copies of each middle region, renaming them
    let coord = middleStartCoord;

    console.log("firstName:", firstName);
    console.log("firstPos:", firstPos);
    console.log("firstSize:", firstSize);
    console.log("firstWorld:", firstWorld);
    console.log("middleStartCoord:", middleStartCoord);

    const dbgMid = getRegionEntry(middleNames[0]);
    const dbgMidPos = readVec3(dbgMid, "Position");
    const dbgMidSize = readVec3(dbgMid, "Size");
    const dbgMidWorld = localToWorld(dbgMidPos, dbgMidSize);
    console.log("original middle pos:", dbgMidPos);
    console.log("original middle world:", dbgMidWorld);

    for (let copy = 0; copy < stackSize; copy++) {
        for (const midName of middleNames) {
            const midEntry = getRegionEntry(midName);
            const midPos = readVec3(midEntry, "Position");
            const midSize = readVec3(midEntry, "Size");
            const midWorld = localToWorld(midPos, midSize);

            // The offset from its world-origin to its NBT position (may differ when size is negative)
            const offsetX = midPos.x - midWorld.origin.x;
            const offsetY = midPos.y - midWorld.origin.y;
            const offsetZ = midPos.z - midWorld.origin.z;

            const newWorldOrigin = { ...midWorld.origin };
            newWorldOrigin[strideAxis] = coord;

            const newPos = {
                x: newWorldOrigin.x + offsetX,
                y: newWorldOrigin.y + offsetY,
                z: newWorldOrigin.z + offsetZ,
            };

            const newName = middleNames.length === 1
                ? `${midName}_${copy}`           // "b_0", "b_1", …
                : `${midName}_${copy}`;          // same pattern for multi-middle

            newRegions.set(newName, cloneWithPosition(midEntry, newPos));
            coord += stride;
        }
    }

    // 3. Place "last" right after all the middles
    const lastPos = readVec3(lastEntry, "Position");
    const lastSize = readVec3(lastEntry, "Size");
    const lastWorld = localToWorld(lastPos, lastSize);

    const lastOffsetX = lastPos.x - lastWorld.origin.x;
    const lastOffsetY = lastPos.y - lastWorld.origin.y;
    const lastOffsetZ = lastPos.z - lastWorld.origin.z;

    const newLastWorldOrigin = { ...lastWorld.origin };
    newLastWorldOrigin[strideAxis] = coord;

    const newLastPos = {
        x: newLastWorldOrigin.x + lastOffsetX,
        y: newLastWorldOrigin.y + lastOffsetY,
        z: newLastWorldOrigin.z + lastOffsetZ,
    };

    newRegions.set(lastName, cloneWithPosition(lastEntry, newLastPos));

    // --- Swap the Regions map back into the NBT ---
    const regionsCompound = new deepslate.NbtCompound();

    for (const [name, region] of newRegions.entries()) {
        regionsCompound.set(name, region);
    }

    root.set("Regions", regionsCompound);

    return nbt;
}