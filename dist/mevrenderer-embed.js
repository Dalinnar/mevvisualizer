var mevrenderer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/embed.js
  var embed_exports = {};
  __export(embed_exports, {
    renderLitematicImage: () => renderLitematicImage,
    setBlocklistUrl: () => setBlocklistUrl
  });

  // src/region.js
  function unpackBlockStates(regionData, paletteSize, width, height, depth) {
    const nbits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
    const mask = (1 << nbits) - 1;
    const totalBlocks = width * height * depth;
    const blockIds = paletteSize <= 256 ? new Uint8Array(totalBlocks) : paletteSize <= 65536 ? new Uint16Array(totalBlocks) : new Uint32Array(totalBlocks);
    const y_shift = Math.abs(width * depth);
    const z_shift = Math.abs(width);
    let idx = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
          const index = y * y_shift + z * z_shift + x;
          const start_offset = index * nbits;
          const start_arr_index = start_offset >>> 5;
          const end_arr_index = (index + 1) * nbits - 1 >>> 5;
          const start_bit_offset = start_offset & 31;
          const half_ind = start_arr_index >>> 1;
          let blockStart, blockEnd;
          if ((start_arr_index & 1) === 0) {
            blockStart = regionData[half_ind]?.[1] ?? 0;
            blockEnd = regionData[half_ind]?.[0] ?? 0;
          } else {
            blockStart = regionData[half_ind]?.[0] ?? 0;
            blockEnd = regionData[half_ind + 1]?.[1] ?? 0;
          }
          let value;
          if (start_arr_index === end_arr_index) {
            value = blockStart >>> start_bit_offset & mask;
          } else {
            const end_offset = 32 - start_bit_offset;
            value = (blockStart >>> start_bit_offset | blockEnd << end_offset) & mask;
          }
          blockIds[idx++] = value;
        }
      }
    }
    return blockIds;
  }
  function create3DBlocks(region) {
    const size = region.get("Size");
    const sx = Number(size.get("x").value ?? size.get("x"));
    const sy = Number(size.get("y").value ?? size.get("y"));
    const sz = Number(size.get("z").value ?? size.get("z"));
    const width = Math.abs(sx);
    const height = Math.abs(sy);
    const depth = Math.abs(sz);
    const pos = region.get("Position");
    const posX = Number(pos.get("x").value ?? pos.get("x"));
    const posY = Number(pos.get("y").value ?? pos.get("y"));
    const posZ = Number(pos.get("z").value ?? pos.get("z"));
    const paletteTag = region.get("BlockStatePalette");
    const palette = [];
    for (let i = 0; i < paletteTag.length; i++) {
      const p = paletteTag.get(i);
      const name = p.get("Name").value ?? p.get("Name");
      let props = {};
      const propsTag = p.get("Properties");
      if (propsTag) {
        for (const key of propsTag.keys()) {
          const val = propsTag.get(key);
          props[key] = val && typeof val === "object" ? val.value ?? val.toString() : String(val);
        }
      }
      palette.push({ Name: name, Properties: Object.keys(props).length ? props : null });
    }
    const raw = region.get("BlockStates");
    const regionData = [];
    if (raw) {
      for (let i = 0; i < raw.length; i++) {
        const entry = raw.get(i);
        let val = entry.value ?? entry;
        if (typeof val === "string" && val.includes(",")) {
          const parts = val.split(",").map((v) => Number(v.trim()));
          regionData.push(parts);
        } else if (Array.isArray(val)) {
          regionData.push(val);
        } else {
          regionData.push([Number(val), 0]);
        }
      }
    }
    const blockIds = unpackBlockStates(regionData, palette.length, width, height, depth);
    function localToWorld(lx, ly, lz) {
      const ox = sx >= 0 ? lx : lx + sx + 1;
      const oy = sy >= 0 ? ly : ly + sy + 1;
      const oz = sz >= 0 ? lz : lz + sz + 1;
      return [posX + ox, posY + oy, posZ + oz];
    }
    return { blockIds, palette, width, height, depth, localToWorld };
  }

  // src/resources.js
  var import_meta = {};
  var {
    BlockDefinition,
    BlockModel,
    Identifier,
    TextureAtlas,
    upperPowerOfTwo
  } = deepslate;
  var MCMETA = "https://raw.githubusercontent.com/misode/mcmeta/";
  var blocklistUrl;
  try {
    blocklistUrl = new URL("./blocklist.json", import_meta.url).toString();
  } catch {
    blocklistUrl = null;
  }
  function setBlocklistUrl(url) {
    blocklistUrl = url;
  }
  function normalizeName(name) {
    if (typeof name === "object" && name !== null) {
      if ("path" in name) name = name.path;
      else name = "";
    }
    if (typeof name !== "string") return "";
    if (name.startsWith("minecraft:")) name = name.slice("minecraft:".length);
    return name.toLowerCase().replace(/\s+/g, "_");
  }
  async function loadBlockData() {
    if (!blocklistUrl) {
      throw new Error(
        "resources.js couldn't resolve blocklist.json's URL automatically (this happens when this module has been bundled into a non-ESM script format). Call setBlocklistUrl(absoluteUrl) before loadBlockData()/renderLitematicImage() runs."
      );
    }
    const res = await fetch(blocklistUrl);
    return await res.json();
  }
  function isAnimatedTexture(u, v, du, dv) {
    return dv > du * 2;
  }
  function getFirstFrameUV(u, v, du, dv, size) {
    if (isAnimatedTexture(u, v, du, dv)) {
      return [u / size, v / size, (u + du) / size, (v + du) / size];
    }
    return [u / size, v / size, (u + du) / size, (v + dv) / size];
  }
  var ResourceLoader = class {
    constructor() {
      this.blockDefinitions = null;
      this.blockModels = null;
      this.textureAtlas = null;
      this.blockMap = null;
      this.loading = false;
      this.animatedTextures = /* @__PURE__ */ new Set();
    }
    async load(blockData, onProgress) {
      if (this.loading) return;
      this.loading = true;
      try {
        onProgress?.({ stage: "Fetching block states...", percent: 10 });
        const blockstates = await fetch(`${MCMETA}summary/assets/block_definition/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Fetching models...", percent: 25 });
        const models = await fetch(`${MCMETA}summary/assets/model/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Fetching UV map...", percent: 40 });
        const uvMap = await fetch(`${MCMETA}atlas/all/data.min.json`).then((r) => r.json());
        onProgress?.({ stage: "Loading texture atlas...", percent: 55 });
        const atlas = await new Promise((res) => {
          const img = new Image();
          img.onload = () => res(img);
          img.crossOrigin = "Anonymous";
          img.src = `${MCMETA}atlas/all/atlas.png`;
        });
        onProgress?.({ stage: "Processing block definitions...", percent: 65 });
        this.blockDefinitions = {};
        Object.keys(blockstates).forEach((id) => {
          this.blockDefinitions["minecraft:" + id] = BlockDefinition.fromJson(blockstates[id]);
        });
        onProgress?.({ stage: "Processing block models...", percent: 75 });
        this.blockModels = {};
        Object.keys(models).forEach((id) => {
          const model = models[id];
          if (model.textures) {
            for (const key in model.textures) {
              const tex = model.textures[key];
              if (typeof tex === "object" && tex.sprite) model.textures[key] = tex.sprite;
              else if (typeof tex !== "string") model.textures[key] = "#missing";
            }
          }
          this.blockModels["minecraft:" + id] = BlockModel.fromJson(model);
        });
        Object.values(this.blockModels).forEach((m) => m.flatten({ getBlockModel: (id) => this.blockModels[id] }));
        onProgress?.({ stage: "Building texture atlas...", percent: 85 });
        const atlasCanvas = document.createElement("canvas");
        const size = upperPowerOfTwo(Math.max(atlas.width, atlas.height));
        atlasCanvas.width = size;
        atlasCanvas.height = size;
        const ctx = atlasCanvas.getContext("2d");
        ctx.drawImage(atlas, 0, 0);
        const atlasData = ctx.getImageData(0, 0, size, size);
        const idMap = {};
        Object.keys(uvMap).forEach((id) => {
          const [u, v, du, dv] = uvMap[id];
          if (isAnimatedTexture(u, v, du, dv)) {
            this.animatedTextures.add(id);
          }
          const [u1, v1, u2, v2] = getFirstFrameUV(u, v, du, dv, size);
          idMap[Identifier.create(id).toString()] = [u1, v1, u2, v2];
        });
        this.textureAtlas = new TextureAtlas(atlasData, idMap);
        this.blockMap = {};
        blockData.forEach((block) => {
          const mainName = normalizeName(block.block);
          this.blockMap[mainName] = block;
          if (block.variants) {
            if (Array.isArray(block.variants)) {
              block.variants.forEach((v) => this.blockMap[normalizeName(v)] = block);
            } else {
              this.blockMap[normalizeName(block.variants)] = block;
            }
          }
        });
        onProgress?.({ stage: "Resources ready!", percent: 100 });
      } catch (err) {
        console.error("Resource loading failed:", err);
        throw err;
      }
    }
    getResources() {
      return {
        getBlockDefinition: (id) => this.blockDefinitions[id.toString()],
        getBlockModel: (id) => this.blockModels[id.toString()],
        getTextureUV: (id) => this.textureAtlas.getTextureUV(id),
        getTextureAtlas: () => this.textureAtlas.getTextureAtlas(),
        getPixelSize: () => this.textureAtlas.getPixelSize(),
        getBlockFlags: (name) => this.getBlockFlags(name),
        getBlockProperties: () => null,
        getDefaultBlockProperties: () => null
      };
    }
    getBlockFlags(name) {
      if (!name) return { opaque: false, semi_transparent: false, self_culling: false };
      const norm = normalizeName(name);
      const block = this.blockMap[norm];
      if (!block) return { opaque: false, semi_transparent: false, self_culling: false };
      const isGlass = norm.includes("glass");
      const opaque = !isGlass && block.full_cube === "Yes" && !block.transparent;
      const semi_transparent = isGlass || !opaque && block.transparent;
      const self_culling = opaque || isGlass;
      return { opaque, semi_transparent, self_culling };
    }
    isTextureAnimated(textureId) {
      return this.animatedTextures.has(textureId);
    }
  };

  // src/structure.js
  var { Structure } = deepslate;
  var StructureBuilder = class {
    constructor(totalW, totalH, totalD) {
      this.totalW = totalW;
      this.totalH = totalH;
      this.totalD = totalD;
      this.placedBlocks = [];
      this.blockCounts = {};
      this.regionBounds = {};
    }
    addRegionBlocks(regionName, { blockIds, palette, width, height, depth, localToWorld }) {
      let idx = 0;
      for (let ly = 0; ly < height; ly++) {
        for (let lz = 0; lz < depth; lz++) {
          for (let lx = 0; lx < width; lx++) {
            const paletteId = blockIds[idx++];
            const blockEntry = palette[paletteId];
            if (blockEntry && blockEntry.Name !== "minecraft:air") {
              const [wx, wy, wz] = localToWorld(lx, ly, lz);
              this.placedBlocks.push({ wx, wy, wz, entry: blockEntry });
              this.blockCounts[blockEntry.Name] = (this.blockCounts[blockEntry.Name] || 0) + 1;
            }
          }
        }
      }
      if (width > 0 && height > 0 && depth > 0) {
        const c1 = localToWorld(0, 0, 0);
        const c2 = localToWorld(width - 1, height - 1, depth - 1);
        this.regionBounds[regionName] = {
          minX: Math.min(c1[0], c2[0]),
          maxX: Math.max(c1[0], c2[0]),
          minY: Math.min(c1[1], c2[1]),
          maxY: Math.max(c1[1], c2[1]),
          minZ: Math.min(c1[2], c2[2]),
          maxZ: Math.max(c1[2], c2[2])
        };
      }
    }
    // Returns each region's bounding box translated into the same local
    // coordinate space that buildStructure() uses (relative to the overall
    // structure's minimum corner), so a box drawn at these coords lines up
    // exactly with the rendered structure.
    getRegionBoundsLocal() {
      const bounds = this.getActualBounds();
      const local = {};
      for (const [name, rb] of Object.entries(this.regionBounds)) {
        local[name] = {
          min: [rb.minX - bounds.minX, rb.minY - bounds.minY, rb.minZ - bounds.minZ],
          max: [rb.maxX - bounds.minX, rb.maxY - bounds.minY, rb.maxZ - bounds.minZ]
        };
      }
      return local;
    }
    getActualBounds() {
      if (this.placedBlocks.length === 0) {
        return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
      }
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const { wx, wy, wz } of this.placedBlocks) {
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz);
      }
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }
    buildStructure(filterMinY = -Infinity, filterMaxY = Infinity) {
      const bounds = this.getActualBounds();
      const width = bounds.maxX - bounds.minX + 1;
      const height = bounds.maxY - bounds.minY + 1;
      const depth = bounds.maxZ - bounds.minZ + 1;
      const structure = new Structure([width, height, depth]);
      for (const { wx, wy, wz, entry } of this.placedBlocks) {
        if (wy >= filterMinY && wy <= filterMaxY) {
          const lx = wx - bounds.minX;
          const ly = wy - bounds.minY;
          const lz = wz - bounds.minZ;
          structure.addBlock([lx, ly, lz], entry.Name, entry.Properties || {});
        }
      }
      return structure;
    }
    generateMaterialsCSV() {
      let csv = "Block Name,Count\n";
      for (const [name, count] of Object.entries(this.blockCounts)) {
        csv += `${name},${count}
`;
      }
      return csv;
    }
  };

  // src/embed.js
  if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
    setBlocklistUrl(new URL("./blocklist.json", document.currentScript.src).toString());
  }
  var { StructureRenderer } = deepslate;
  var { mat4 } = glMatrix;
  var resourcesPromise = null;
  function getSharedResources(onProgress) {
    if (!resourcesPromise) {
      resourcesPromise = (async () => {
        const blockData = await loadBlockData();
        const loader = new ResourceLoader();
        await loader.load(blockData, onProgress);
        return loader.getResources();
      })();
    }
    return resourcesPromise;
  }
  function getEnclosing(root) {
    const enc = root.get("Metadata").get("EnclosingSize");
    const n = (k) => Math.abs(Number(enc.get(k).value ?? enc.get(k)));
    return { w: n("x"), h: n("y"), d: n("z") };
  }
  function computeFitViewDist(bounds, width, height, marginFactor = 1.1) {
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    const radius = 0.5 * Math.hypot(dx, dy, dz);
    if (radius <= 0 || !Number.isFinite(radius)) return 4;
    const aspect = width / height;
    const vFov = 70 * Math.PI / 180;
    const hFov = 2 * Math.atan(aspect * Math.tan(vFov / 2));
    const limitingHalfAngle = Math.min(vFov, hFov) / 2;
    return Math.max(radius / Math.sin(limitingHalfAngle) * marginFactor, 2);
  }
  function buildViewMatrix(center, viewDist, xRotation, yRotation) {
    const view = mat4.create();
    mat4.translate(view, view, [0, 0, -viewDist]);
    mat4.rotate(view, view, xRotation, [1, 0, 0]);
    mat4.rotate(view, view, yRotation, [0, 1, 0]);
    mat4.translate(view, view, [-center[0], -center[1], -center[2]]);
    return view;
  }
  function parseCssColor(css) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    const normalized = ctx.fillStyle;
    const hex = normalized.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    const rgb = normalized.match(/rgba?\(([^)]+)\)/);
    if (rgb) {
      const [r, g, b] = rgb[1].split(",").map((v) => parseFloat(v) / 255);
      return [r, g, b];
    }
    return [0.1, 0.1, 0.1];
  }
  async function renderLitematicImage(options = {}) {
    const {
      url,
      buffer,
      width = 800,
      height = 600,
      xRotation = 0.6,
      yRotation = 0.8,
      background = "#1a1a1a",
      asBlob = false,
      onProgress = null
    } = options;
    if (!url && !buffer) {
      throw new Error("renderLitematicImage: pass either `url` or `buffer`");
    }
    const [arrayBuffer, resources] = await Promise.all([
      buffer ?? fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch litematic: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      getSharedResources(onProgress)
    ]);
    const nbt = deepslate.NbtFile.read(new Uint8Array(arrayBuffer));
    const root = nbt.root ?? nbt;
    const { w, h, d } = getEnclosing(root);
    const builder = new StructureBuilder(w, h, d);
    const regions = root.get("Regions");
    for (const name of regions.keys()) {
      builder.addRegionBlocks(name, create3DBlocks(regions.get(name)));
    }
    const structure = builder.buildStructure();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "-100000px";
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    document.body.appendChild(canvas);
    try {
      const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL is not available in this browser");
      gl.viewport(0, 0, width, height);
      if (background === null) {
        gl.clearColor(0, 0, 0, 0);
      } else {
        const [r, g, b] = parseCssColor(background);
        gl.clearColor(r, g, b, 1);
      }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const renderer = new StructureRenderer(gl, structure, resources, {
        useInvisibleBlockBuffer: false,
        chunkSize: 16
      });
      const bounds = builder.getActualBounds();
      const center = ["x", "y", "z"].map(
        (k) => (bounds[`min${k.toUpperCase()}`] + bounds[`max${k.toUpperCase()}`]) / 2
      );
      const viewDist = computeFitViewDist(bounds, width, height);
      const view = buildViewMatrix(center, viewDist, xRotation, yRotation);
      renderer.drawStructure(view);
      return await new Promise((resolve, reject) => {
        if (asBlob) {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("canvas.toBlob failed")), "image/png");
        } else {
          resolve(canvas.toDataURL("image/png"));
        }
      });
    } finally {
      canvas.remove();
    }
  }
  return __toCommonJS(embed_exports);
})();
