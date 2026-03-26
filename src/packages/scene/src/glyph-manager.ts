// ============================================================
// L4/scene — GlyphManager：MSDF 字体与 Unicode 块加载（MVP 占位）
// 无网络加载、无 GPU 纹理上传；后续接 L1 TextureManager。
// ============================================================

/**
 * WebGPU 纹理句柄的最小形状（避免 L4 import L1 具体类）。
 *
 * @example
 * const h: TextureHandleLike = { id: 'msdf-atlas-0' };
 */
export interface TextureHandleLike {
  /** 纹理资源在 ResourceManager / 缓存中的唯一 id。 */
  readonly id: string;
}

/**
 * 单个码位的 MSDF 图集度量信息。
 *
 * @example
 * const m: GlyphMetrics = {
 *   codePoint: 0x4e2d,
 *   width: 20,
 *   height: 22,
 *   bearingX: 1,
 *   bearingY: 18,
 *   advance: 21,
 *   atlasRegion: { u0: 0, v0: 0, u1: 0.1, v1: 0.1 },
 * };
 */
export interface GlyphMetrics {
  /** Unicode 码位（标量值）。 */
  readonly codePoint: number;
  /** 字形位图/距离场在图集中的像素宽度。 */
  readonly width: number;
  /** 字形位图/距离场在图集中的像素高度。 */
  readonly height: number;
  /** 水平 bearing（基线左侧偏移，像素）。 */
  readonly bearingX: number;
  /** 垂直 bearing（基线到字形顶部，像素）。 */
  readonly bearingY: number;
  /** 前进宽度（水平 advance，像素）。 */
  readonly advance: number;
  /** 图集 UV 包围盒（归一化 0~1）。 */
  readonly atlasRegion: { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number };
}

/**
 * Unicode 块描述（用于按需加载字形子集）。
 *
 * @example
 * const block: UnicodeBlock = { name: 'CJK Unified Ideographs', start: 0x4e00, end: 0x9fff };
 */
export interface UnicodeBlock {
  /** 可读块名称。 */
  readonly name: string;
  /** 起始码位（含）。 */
  readonly start: number;
  /** 结束码位（含）。 */
  readonly end: number;
}

/**
 * 字体注册信息：名称 + 字形缓存 + URL 模板（MVP 仅存元数据）。
 *
 * @example
 * const stack: FontStack = {
 *   name: 'Noto',
 *   glyphs: new Map(),
 *   urlTemplate: 'https://cdn.example.com/{name}/{block}.pbf',
 * };
 */
export interface FontStack {
  /** 字体族名称（与 registerFont 一致）。 */
  readonly name: string;
  /** 已解码字形度量缓存（MVP 通常为空）。 */
  readonly glyphs: Map<number, GlyphMetrics>;
  /**
   * 远程资源 URL 模板（占位）。
   * 可包含 `{name}`、`{block}`、`{range}` 等占位符；MVP 不发起请求。
   */
  readonly urlTemplate?: string;
}

/**
 *  shaping 输出的单个字形四边形（屏幕或局部坐标，MVP 无实际顶点）。
 *
 * @example
 * const q: ShapedGlyphQuad = { codePoint: 65, x: 0, y: 0, width: 10, height: 12 };
 */
export interface ShapedGlyphQuad {
  /** Unicode 码位。 */
  readonly codePoint: number;
  /** 局部 x（像素）。 */
  readonly x: number;
  /** 局部 y（像素）。 */
  readonly y: number;
  /** 宽度（像素）。 */
  readonly width: number;
  /** 高度（像素）。 */
  readonly height: number;
}

/**
 * `shape()` 的返回体：字形四边形 + 估算包围尺寸。
 *
 * @example
 * const s: ShapedTextResult = { quads: [], width: 100, height: 16 };
 */
export interface ShapedTextResult {
  /** 字形四边形（MVP 为空数组）。 */
  readonly quads: readonly ShapedGlyphQuad[];
  /** 估算文本总宽（像素）。 */
  readonly width: number;
  /** 估算文本总高（像素）。 */
  readonly height: number;
}

/**
 * GlyphManager 聚合统计。
 *
 * @example
 * const st = gm.stats;
 */
export interface GlyphManagerStats {
  /** registerFont 调用次数。 */
  readonly registerCount: number;
  /** getGlyph 调用次数。 */
  readonly getGlyphCalls: number;
  /** loadBlock 调用次数。 */
  readonly loadBlockCalls: number;
}

/**
 * 图集尺寸（像素）。
 *
 * @example
 * const sz = { width: 2048, height: 2048 };
 */
export interface AtlasSize {
  /** 图集宽度（像素）。 */
  readonly width: number;
  /** 图集高度（像素）。 */
  readonly height: number;
}

/**
 * MSDF 字形管理器：注册字体、查询字形、Unicode 块加载、文本 shaping。
 *
 * @example
 * const gm = createGlyphManager();
 * gm.registerFont('sans', { urlTemplate: 'https://x/{name}.woff2' });
 */
export interface GlyphManager {
  /**
   * 注册或更新字体栈元数据（不下载二进制）。
   *
   * @param name - 字体逻辑名（非空字符串）
   * @param options - 可含 urlTemplate 等
   * @returns void
   *
   * @example
   * gm.registerFont('serif', { urlTemplate: 'https://fonts/{name}.woff2' });
   */
  registerFont(name: string, options?: { readonly urlTemplate?: string }): void;

  /**
   * 查询单个码位度量；MVP 恒返回 null。
   *
   * @param fontName - 字体名
   * @param codePoint - Unicode 标量
   * @returns 字形度量或 null
   *
   * @example
   * const m = gm.getGlyph('sans', 65);
   */
  getGlyph(fontName: string, codePoint: number): GlyphMetrics | null;

  /**
   * 批量查询码位度量；MVP 全为 null。
   *
   * @param fontName - 字体名
   * @param codePoints - 码位数组
   * @returns 与输入等长的度量数组（null 占位）
   *
   * @example
   * const row = gm.getGlyphs('sans', [72, 105]);
   */
  getGlyphs(fontName: string, codePoints: readonly number[]): readonly (GlyphMetrics | null)[];

  /**
   * 某 Unicode 块是否已加载（MVP：loadBlock 后即为 true）。
   *
   * @param fontName - 字体名
   * @param block - 块描述
   * @returns 是否已标记加载
   *
   * @example
   * const ok = gm.isBlockLoaded('sans', { name: 'Basic Latin', start: 32, end: 127 });
   */
  isBlockLoaded(fontName: string, block: UnicodeBlock): boolean;

  /**
   * 异步加载某 Unicode 块（MVP：无 I/O，立即 resolve）。
   *
   * @param fontName - 字体名
   * @param block - 块描述
   * @returns 完成时 resolve，失败时 reject
   *
   * @example
   * await gm.loadBlock('sans', { name: 'Latin', start: 0, end: 255 });
   */
  loadBlock(fontName: string, block: UnicodeBlock): Promise<void>;

  /**
   * 将文本 shaping 为字形四边形序列（MVP：空四边形 + 估算宽高）。
   *
   * @param fontName - 字体名
   * @param text - UTF-16 字符串
   * @param fontSize - 字号（像素）
   * @returns  shaping 结果
   *
   * @example
   * const shaped = gm.shape('sans', 'Hi', 16);
   */
  shape(fontName: string, text: string, fontSize: number): ShapedTextResult;

  /** 当前 MSDF 图集纹理句柄；未分配时为 null。 */
  readonly atlas: TextureHandleLike | null;

  /** 图集像素尺寸；未创建时为 {0,0}。 */
  readonly atlasSize: AtlasSize;

  /** 统计信息。 */
  readonly stats: GlyphManagerStats;
}

/** MVP 默认图集边长（像素），与零 npm 占位资源对应。 */
const DEFAULT_ATLAS_SIZE_PX = 2048;

/** 估算宽度：字符数 × fontSize × 系数（与 label-manager  heuristic 对齐）。 */
const SHAPING_WIDTH_FACTOR = 0.6;

/** 估算高度：fontSize × 行高系数。 */
const SHAPING_HEIGHT_FACTOR = 1.2;

/**
 * 校验码位为有效 Unicode 标量（非代理对半体）。
 *
 * @param cp - 码位
 * @returns 是否 [0, 0x10ffff] 且非代理
 *
 * @example
 * const ok = isValidScalarValue(65);
 */
function isValidScalarValue(cp: number): boolean {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
    return false;
  }
  // UTF-16 代理区：非法作为标量
  if (cp >= 0xd800 && cp <= 0xdfff) {
    return false;
  }
  return true;
}

/**
 * 将字符串展开为 Unicode 标量数组（处理代理对）。
 *
 * @param text - 输入文本
 * @returns 码位数组
 *
 * @example
 * const cps = stringToCodePoints('A𐌀');
 */
function stringToCodePoints(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // 高位代理：与低位组合成 supplementary
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
        out.push(cp);
        i += 1;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * 生成块缓存键（字体名 + 起止码位）。
 *
 * @param fontName - 字体名
 * @param block - 块
 * @returns 键字符串
 *
 * @example
 * const k = blockKey('sans', { name: 'L', start: 0, end: 127 });
 */
function blockKey(fontName: string, block: UnicodeBlock): string {
  return `${fontName}:${block.start}-${block.end}:${block.name}`;
}

/**
 * 创建 GlyphManager（MVP：无真实纹理与网络）。
 *
 * @returns GlyphManager 实例
 *
 * @example
 * const gm = createGlyphManager();
 */
export function createGlyphManager(): GlyphManager {
  /** 字体名 → 栈元数据。 */
  const fonts = new Map<string, FontStack>();
  /** 已标记加载的块键集合。 */
  const loadedBlocks = new Set<string>();
  /** 统计：注册次数。 */
  let registerCount = 0;
  /** 统计：getGlyph 调用。 */
  let getGlyphCalls = 0;
  /** 统计：loadBlock 调用。 */
  let loadBlockCalls = 0;
  /** 占位图集 id（惰性创建字符串）。 */
  let atlasId: string | null = null;

  const api: GlyphManager = {
    registerFont(name: string, options?: { readonly urlTemplate?: string }): void {
      // 拒绝空名称，避免 Map 键被污染
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('GlyphManager.registerFont: name must be a non-empty string.');
      }
      const urlTemplate =
        options !== undefined && typeof options.urlTemplate === 'string' ? options.urlTemplate : undefined;
      const existing = fonts.get(name);
      // 复用同一 Map 实例以保留潜在未来缓存
      const glyphs = existing !== undefined ? existing.glyphs : new Map<number, GlyphMetrics>();
      fonts.set(name, { name, glyphs, urlTemplate });
      registerCount += 1;
      // 首次注册字体时分配占位 atlas id
      if (atlasId === null) {
        atlasId = `msdf-atlas-placeholder-${Date.now().toString(36)}`;
      }
    },

    getGlyph(fontName: string, codePoint: number): GlyphMetrics | null {
      getGlyphCalls += 1;
      if (typeof fontName !== 'string' || fontName.length === 0) {
        throw new TypeError('GlyphManager.getGlyph: fontName must be a non-empty string.');
      }
      if (!isValidScalarValue(codePoint)) {
        throw new RangeError('GlyphManager.getGlyph: codePoint must be a valid Unicode scalar value.');
      }
      if (!fonts.has(fontName)) {
        throw new RangeError(`GlyphManager.getGlyph: font "${fontName}" is not registered.`);
      }
      // MVP：未加载真实字形，返回 null 由上层回退占位
      return null;
    },

    getGlyphs(fontName: string, codePoints: readonly number[]): readonly (GlyphMetrics | null)[] {
      if (!Array.isArray(codePoints)) {
        throw new TypeError('GlyphManager.getGlyphs: codePoints must be an array.');
      }
      const out: (GlyphMetrics | null)[] = [];
      for (let i = 0; i < codePoints.length; i++) {
        out.push(api.getGlyph(fontName, codePoints[i]));
      }
      return out;
    },

    isBlockLoaded(fontName: string, block: UnicodeBlock): boolean {
      if (typeof fontName !== 'string' || fontName.length === 0) {
        throw new TypeError('GlyphManager.isBlockLoaded: fontName must be a non-empty string.');
      }
      if (block === null || typeof block !== 'object') {
        throw new TypeError('GlyphManager.isBlockLoaded: block is required.');
      }
      if (
        typeof block.name !== 'string' ||
        !Number.isFinite(block.start) ||
        !Number.isFinite(block.end) ||
        block.start > block.end
      ) {
        throw new RangeError('GlyphManager.isBlockLoaded: invalid UnicodeBlock range.');
      }
      return loadedBlocks.has(blockKey(fontName, block));
    },

    loadBlock(fontName: string, block: UnicodeBlock): Promise<void> {
      loadBlockCalls += 1;
      if (typeof fontName !== 'string' || fontName.length === 0) {
        return Promise.reject(new TypeError('GlyphManager.loadBlock: fontName must be a non-empty string.'));
      }
      if (!fonts.has(fontName)) {
        return Promise.reject(new RangeError(`GlyphManager.loadBlock: font "${fontName}" is not registered.`));
      }
      if (block === null || typeof block !== 'object') {
        return Promise.reject(new TypeError('GlyphManager.loadBlock: block is required.'));
      }
      if (
        typeof block.name !== 'string' ||
        !Number.isFinite(block.start) ||
        !Number.isFinite(block.end) ||
        block.start > block.end
      ) {
        return Promise.reject(new RangeError('GlyphManager.loadBlock: invalid UnicodeBlock range.'));
      }
      // MVP：无网络；标记为已加载
      loadedBlocks.add(blockKey(fontName, block));
      return Promise.resolve();
    },

    shape(fontName: string, text: string, fontSize: number): ShapedTextResult {
      if (typeof fontName !== 'string' || fontName.length === 0) {
        throw new TypeError('GlyphManager.shape: fontName must be a non-empty string.');
      }
      if (!fonts.has(fontName)) {
        throw new RangeError(`GlyphManager.shape: font "${fontName}" is not registered.`);
      }
      if (typeof text !== 'string') {
        throw new TypeError('GlyphManager.shape: text must be a string.');
      }
      if (!Number.isFinite(fontSize) || fontSize <= 0) {
        throw new RangeError('GlyphManager.shape: fontSize must be a finite positive number.');
      }
      const cps = stringToCodePoints(text);
      const charCount = cps.length;
      // MVP：无真实 shaping；宽≈字符数 × fontSize × 系数，高≈行高
      const width = Math.max(0, charCount * fontSize * SHAPING_WIDTH_FACTOR);
      const height = Math.max(0, fontSize * SHAPING_HEIGHT_FACTOR);
      return {
        quads: [],
        width,
        height,
      };
    },

    get atlas(): TextureHandleLike | null {
      // 无注册字体时不暴露图集句柄
      if (atlasId === null) {
        return null;
      }
      return { id: atlasId };
    },

    get atlasSize(): AtlasSize {
      // 未注册字体时尺寸为 0
      if (atlasId === null) {
        return { width: 0, height: 0 };
      }
      return { width: DEFAULT_ATLAS_SIZE_PX, height: DEFAULT_ATLAS_SIZE_PX };
    },

    get stats(): GlyphManagerStats {
      return {
        registerCount,
        getGlyphCalls,
        loadBlockCalls,
      };
    },
  };

  return api;
}
