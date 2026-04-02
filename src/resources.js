const {
  BlockDefinition,
  BlockModel,
  Identifier,
  TextureAtlas,
  upperPowerOfTwo
} = deepslate;

const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta/';

export function normalizeName(name) {
  if (typeof name === 'object' && name !== null) {
    if ('path' in name) name = name.path;
    else name = '';
  }
  if (typeof name !== 'string') return '';
  if (name.startsWith('minecraft:')) name = name.slice('minecraft:'.length);
  return name.toLowerCase().replace(/\s+/g, '_');
}

export async function loadBlockData() {
  const res = await fetch('./src/blocklist.json');
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

export class ResourceLoader {
  constructor() {
    this.blockDefinitions = null;
    this.blockModels = null;
    this.textureAtlas = null;
    this.blockMap = null;
    this.loading = false;
    this.animatedTextures = new Set(); // Track which textures are animated
  }

  async load(blockData, onProgress) {
    if (this.loading) return;
    this.loading = true;

    try {
      onProgress?.({ stage: 'Fetching block states...', percent: 10 });
      const blockstates = await fetch(`${MCMETA}summary/assets/block_definition/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Fetching models...', percent: 25 });
      const models = await fetch(`${MCMETA}summary/assets/model/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Fetching UV map...', percent: 40 });
      const uvMap = await fetch(`${MCMETA}atlas/all/data.min.json`).then(r => r.json());

      onProgress?.({ stage: 'Loading texture atlas...', percent: 55 });
      const atlas = await new Promise(res => {
        const img = new Image();
        img.onload = () => res(img);
        img.crossOrigin = 'Anonymous';
        img.src = `${MCMETA}atlas/all/atlas.png`;
      });

      onProgress?.({ stage: 'Processing block definitions...', percent: 65 });
      this.blockDefinitions = {};
      Object.keys(blockstates).forEach(id => {
        this.blockDefinitions['minecraft:' + id] = BlockDefinition.fromJson(blockstates[id]);
      });

      onProgress?.({ stage: 'Processing block models...', percent: 75 });
      this.blockModels = {};
      Object.keys(models).forEach(id => {
        const model = models[id];
        if (model.textures) {
          for (const key in model.textures) {
            const tex = model.textures[key];
            if (typeof tex === "object" && tex.sprite) model.textures[key] = tex.sprite;
            else if (typeof tex !== "string") model.textures[key] = "#missing";
          }
        }
        this.blockModels['minecraft:' + id] = BlockModel.fromJson(model);
      });

      Object.values(this.blockModels).forEach(m => m.flatten({ getBlockModel: id => this.blockModels[id] }));

      onProgress?.({ stage: 'Building texture atlas...', percent: 85 });
      const atlasCanvas = document.createElement('canvas');
      const size = upperPowerOfTwo(Math.max(atlas.width, atlas.height));
      atlasCanvas.width = size;
      atlasCanvas.height = size;
      const ctx = atlasCanvas.getContext('2d');
      ctx.drawImage(atlas, 0, 0);
      const atlasData = ctx.getImageData(0, 0, size, size);

      const idMap = {};
      Object.keys(uvMap).forEach(id => {
        const [u, v, du, dv] = uvMap[id];
        
        // Detect and track animated textures
        if (isAnimatedTexture(u, v, du, dv)) {
          this.animatedTextures.add(id);
        }
        
        // Use first frame for animated textures
        const [u1, v1, u2, v2] = getFirstFrameUV(u, v, du, dv, size);
        idMap[Identifier.create(id).toString()] = [u1, v1, u2, v2];
      });

      this.textureAtlas = new TextureAtlas(atlasData, idMap);

      // Build block map from blocklist.json data
      this.blockMap = {};
      blockData.forEach(block => {
        const mainName = normalizeName(block.block);
        this.blockMap[mainName] = block;
        if (block.variants) {
          if (Array.isArray(block.variants)) {
            block.variants.forEach(v => this.blockMap[normalizeName(v)] = block);
          } else {
            this.blockMap[normalizeName(block.variants)] = block;
          }
        }
      });

      onProgress?.({ stage: 'Resources ready!', percent: 100 });
    } catch (err) {
      console.error('Resource loading failed:', err);
      throw err;
    }
  }

  getResources() {
    return {
      getBlockDefinition: id => this.blockDefinitions[id.toString()],
      getBlockModel: id => this.blockModels[id.toString()],
      getTextureUV: id => this.textureAtlas.getTextureUV(id),
      getTextureAtlas: () => this.textureAtlas.getTextureAtlas(),
      getPixelSize: () => this.textureAtlas.getPixelSize(),
      getBlockFlags: name => this.getBlockFlags(name),
      getBlockProperties: () => null,
      getDefaultBlockProperties: () => null
    };
  }

  getBlockFlags(name) {
    if (!name) return { opaque: false, semi_transparent: false, self_culling: false };
    const norm = normalizeName(name);
    const block = this.blockMap[norm];
    if (!block) return { opaque: false, semi_transparent: false, self_culling: false };

    const isGlass = norm.includes('glass');

    const opaque = !isGlass && block.full_cube === "Yes" && !block.transparent;
    const semi_transparent = isGlass || (!opaque && block.transparent);
    const self_culling = opaque || isGlass; 

    return { opaque, semi_transparent, self_culling };
  }

  isTextureAnimated(textureId) {
    return this.animatedTextures.has(textureId);
  }
}