# GIS-Forge TilingScheme 架构设计 v3（完整规格）

> **范围**：本文档是 v2 的全量展开。包含每个接口的完整类型签名、每个函数的入参/出参/前置条件/复杂度约束、扩展点设计、错误契约、测试策略、内存预算、帧时间拆分。
>
> **目标读者**：实现者。照此文档可直接编码，无需额外决策。

---

## 目录

1. [设计原则与约束](#1-设计原则与约束)
2. [L0 — TilingScheme 接口规格](#2-l0-tilingscheme-接口规格)
3. [L0 — 自由函数库规格](#3-l0-自由函数库规格)
4. [L0 — TileSource 接口规格](#4-l0-tilesource-接口规格)
5. [L0 — TileCoord 值类型](#5-l0-tilecoord-值类型)
6. [L0 — Projection 辅助接口（扩展预留）](#6-l0-projection-辅助接口扩展预留)
7. [L4 — globe-tile-mesh 改造规格](#7-l4-globe-tile-mesh-改造规格)
8. [L6 — 地形管线接口规格](#8-l6-地形管线接口规格)
9. [L6 — GPU 管线 / Shader 变更规格](#9-l6-gpu-管线shader-变更规格)
10. [L6 — 缓存架构规格](#10-l6-缓存架构规格)
11. [L6 — Globe3D 集成规格](#11-l6-globe3d-集成规格)
12. [扩展性设计](#12-扩展性设计)
13. [可维护性契约](#13-可维护性契约)
14. [性能预算](#14-性能预算)
15. [分阶段实施（精确任务）](#15-分阶段实施精确任务)
16. [完整文件清单](#16-完整文件清单)

---

## 1. 设计原则与约束

### 1.1 不可违反的硬约束

| ID | 约束 | 来源 |
|----|------|------|
| C1 | L0 层零外部依赖，不 import L1~L6 中任何符号 | 分层架构 |
| C2 | 所有 `TilingScheme` 实现必须是无状态冻结对象常量 | 性能 + 可测性 |
| C3 | 帧循环热路径（`coveringTilesGlobe`、`renderGlobeTiles`）零 GC 分配 | 60fps 预算 |
| C4 | `GlobeTileMesh` 的 `positions`/`normals`/`uvs`/`indices` 在创建后不可修改 | 缓存安全 |
| C5 | 默认参数行为 ≡ 改造前行为（所有新参数 optional，默认 WebMercator） | 向后兼容 |
| C6 | `GlobeCamera` 不持有 `TilingScheme`——scheme 是数据源属性而非视图属性 | 关注点分离 |
| C7 | GPU bind group layout 在 pipeline 创建时固定，运行时只替换 bind group 实例 | WebGPU 规范 |
| C8 | 每个导出符号必须有 JSDoc（含 `@param`、`@returns`、`@example`） | 项目规范 |

### 1.2 设计决策记录

| 决策 | 选项 A | 选项 B | 选择 | 理由 |
|------|--------|--------|------|------|
| 接口风格 | class + 继承 | interface + 对象字面量 | B | tree-shake、无原型链开销、冻结对象可 === 比较 |
| Scheme ID | string (`'webmercator'`) | numeric (`0 \| 1`) | numeric | 缓存键位运算、V8 Smi fast path |
| tileBounds | 接口方法 | 自由函数 | 自由函数 | 需要零分配版 + 分配版两个变体；接口只保留不可推导的原语 |
| UV 重映射 | CPU 逐顶点 | GPU uniform + shader | GPU | 270× CPU 节省、精度相同、无额外分配 |
| 高程应用 | 修改 mesh.positions | 高程纹理 + VS 位移 | 高程纹理 | 保持 mesh readonly、解耦 LOD、GPU HW 双线性插值 |
| 覆盖算法 | AABB 扁平枚举 | 四叉树自顶向下 | 四叉树 | 父级 horizon cull 剪枝整棵子树；SSE 自动 LOD |
| TileSource | L4 层可见 | 仅 L6 层可见 | 仅 L6 | L4 是纯数学层，不应知道 URL/缓存/TMS 等 IO 概念 |

---

## 2. L0 — TilingScheme 接口规格

### 2.1 文件位置

`core/src/geo/tiling-scheme.ts`

### 2.2 完整接口

```typescript
/**
 * 瓦片方案的最小抽象——定义地理坐标 ↔ 瓦片网格坐标的双向映射。
 *
 * 设计目标：
 * - 最小化：只包含不可从其他方法推导的 6 个核心映射 + 3 个只读属性
 * - 无状态：同一实现的所有调用仅依赖入参，无内部可变状态
 * - 高性能：所有方法 O(1) 时间复杂度，无分配
 *
 * 便利功能（tileBounds、touchesPole、tileKey 等）作为同文件自由函数导出，
 * 组合调用接口方法实现，避免接口膨胀。
 *
 * 标准实现：
 * - {@link WebMercator}：EPSG:3857，zoom=0 → 1×1 瓦片，纬度限制 ±85.051°
 * - {@link Geographic}：EPSG:4326，zoom=0 → 2×1 瓦片，覆盖全球 ±90°
 *
 * @stability stable — Phase 1 交付后接口锁定，仅通过新增自由函数扩展
 *
 * @example
 * import { WebMercator } from './web-mercator-tiling-scheme';
 * const x = Math.floor(WebMercator.lngX(121.47, 10)); // 瓦片列号
 * const y = Math.floor(WebMercator.latY(31.23, 10));   // 瓦片行号
 */
export interface TilingScheme {
  // ━━━ 标识属性 ━━━

  /**
   * 数值唯一标识。
   * 用于 {@link tileKey} 的高位编码和 `Map<number, ...>` 缓存键。
   *
   * 取值约定：
   * - `0` = WebMercator (EPSG:3857)
   * - `1` = Geographic (EPSG:4326)
   * - `2~7` = 预留给未来内置方案（见 §12 扩展性）
   *
   * 类型为 `number` 而非字面量联合，以支持用户注册自定义方案。
   * 内置方案保证 id ∈ [0, 7]，自定义方案 id ∈ [8, 31]。
   * tileKey 编码分配 5 bit → 最多 32 个并发方案。
   */
  readonly id: number;

  /**
   * 人类可读名称。仅用于调试日志和开发者工具面板。
   * 不参与任何比较或键计算。
   *
   * @example 'WebMercator', 'Geographic', 'WMTS:EPSG:2154'
   */
  readonly name: string;

  /**
   * 该方案覆盖的纬度有效范围（度），闭区间 [min, max]。
   * - WebMercator: [-85.05112878, 85.05112878]
   * - Geographic:  [-90, 90]
   *
   * 约束：latRange[0] < latRange[1]
   *
   * 用途：
   * 1. coveringTilesGlobe 裁剪无效纬度
   * 2. UI 限制相机平移范围
   * 3. 单元测试断言
   */
  readonly latRange: readonly [number, number];

  // ━━━ 网格维度 ━━━

  /**
   * 指定 zoom 下 X 方向（经度）的瓦片总列数。
   *
   * - WebMercator: `2^z`    （zoom=0 → 1 列）
   * - Geographic:  `2^(z+1)` （zoom=0 → 2 列）
   *
   * @param z - 整数 zoom 级别，范围 [0, 24]
   * @returns 正整数列数，>= 1
   *
   * @complexity O(1)，位移运算
   *
   * @example
   * WebMercator.numX(0) // 1
   * Geographic.numX(0)  // 2
   * WebMercator.numX(3) // 8
   * Geographic.numX(3)  // 16
   */
  numX(z: number): number;

  /**
   * 指定 zoom 下 Y 方向（纬度）的瓦片总行数。
   *
   * - WebMercator: `2^z`  （zoom=0 → 1 行）
   * - Geographic:  `2^z`  （zoom=0 → 1 行）
   *
   * 注意：两种方案在 Y 方向的瓦片数相同，但含义不同——
   * WebMercator 的每行覆盖非线性纬度范围（Mercator 投影），
   * Geographic 的每行覆盖等角度纬度范围。
   *
   * @param z - 整数 zoom 级别，范围 [0, 24]
   * @returns 正整数行数，>= 1
   * @complexity O(1)
   */
  numY(z: number): number;

  // ━━━ 地理坐标 → 瓦片坐标（正向映射）━━━

  /**
   * 经度（度）→ 连续瓦片列号。
   * 调用方 `Math.floor()` 取整得到离散列号。
   *
   * 两种方案的经度映射都是线性的（经度在球面上均匀分布），
   * 但 numX 不同导致缩放因子不同。
   *
   * @param lngDeg - 经度，范围 [-180, 180]。超出范围的值会被合法映射（环绕）
   * @param z - 整数 zoom 级别
   * @returns 浮点列号，范围 [0, numX(z))
   *
   * @complexity O(1)，一次乘法 + 一次加法
   *
   * @example
   * Math.floor(WebMercator.lngX(0, 2))    // 2（本初子午线在 zoom=2 的第 2 列）
   * Math.floor(Geographic.lngX(0, 2))     // 4（Geographic 在 zoom=2 有 8 列）
   */
  lngX(lngDeg: number, z: number): number;

  /**
   * 纬度（度）→ 连续瓦片行号。
   * 调用方 `Math.floor()` 取整得到离散行号。
   *
   * 映射方式因方案不同：
   * - WebMercator：Mercator 投影公式（非线性，极地压缩）
   *   `((1 - ln(tan(φ) + sec(φ)) / π) / 2) × numY`
   * - Geographic：线性映射
   *   `((90 - φ) / 180) × numY`
   *
   * 约定：行号 0 = 最北，行号 numY-1 = 最南。
   *
   * @param latDeg - 纬度，范围 [latRange[0], latRange[1]]
   *   WebMercator 超出 ±85.05° 时返回 clamp 到边界的行号（不抛错）
   * @param z - 整数 zoom 级别
   * @returns 浮点行号，范围 [0, numY(z))
   *
   * @complexity O(1)。WebMercator 含 1 次 tan + 1 次 log；Geographic 含 1 次减法 + 1 次除法
   */
  latY(latDeg: number, z: number): number;

  // ━━━ 瓦片坐标 → 地理坐标（逆向映射）━━━

  /**
   * 瓦片列号 → 该列西边界经度（度）。
   *
   * 对于列号 x 的瓦片，其经度范围为 [xLng(x, z), xLng(x+1, z)]。
   *
   * @param x - 整数或浮点列号。整数时返回瓦片西边界；分数时返回内部插值
   * @param z - 整数 zoom 级别
   * @returns 经度（度），范围 [-180, 180]
   *
   * @complexity O(1)
   *
   * @example
   * WebMercator.xLng(0, 1)  // -180（zoom=1 第 0 列西边界）
   * WebMercator.xLng(1, 1)  // 0（第 1 列西边界 = 第 0 列东边界）
   */
  xLng(x: number, z: number): number;

  /**
   * 瓦片行号 → 该行北边界纬度（度）。
   *
   * 对于行号 y 的瓦片，其纬度范围为 [yLat(y+1, z), yLat(y, z)]。
   * 注意：yLat(y, z) > yLat(y+1, z)，因为行号向南递增。
   *
   * 映射方式因方案不同：
   * - WebMercator：逆 Mercator 投影（含 atan + sinh）
   * - Geographic：线性 `90 - (y / numY) × 180`
   *
   * @param y - 整数或浮点行号
   * @param z - 整数 zoom 级别
   * @returns 纬度（度），范围 [latRange[0], latRange[1]]
   *
   * @complexity O(1)。WebMercator 含 1 次 atan + 1 次 sinh；Geographic 含 1 次乘除
   */
  yLat(y: number, z: number): number;
}
```

### 2.3 WebMercator 完整实现

```typescript
// core/src/geo/web-mercator-tiling-scheme.ts

import type { TilingScheme } from './tiling-scheme.ts';

/** Mercator 投影的最大有效纬度（度）。tan(85.051°) + sec(85.051°) 的对数有限 */
const MERC_MAX_LAT = 85.05112878;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const PI = Math.PI;

/**
 * WebMercator (EPSG:3857) 瓦片方案。
 *
 * 网格拓扑：
 * - zoom=0: 1×1（整个地球一个方形瓦片）
 * - zoom=z: 2^z × 2^z
 *
 * 纬度范围：±85.05112878°（Mercator 投影在极点处纬度趋向无穷）
 *
 * 兼容服务：OpenStreetMap, Google Maps, Mapbox, ArcGIS Online, Bing Maps
 *
 * @stability stable
 *
 * @example
 * import { WebMercator } from './web-mercator-tiling-scheme';
 * // zoom=10 东京站
 * const col = Math.floor(WebMercator.lngX(139.767, 10)); // 909
 * const row = Math.floor(WebMercator.latY(35.681, 10));   // 403
 */
export const WebMercator: TilingScheme = Object.freeze({
  id: 0,
  name: 'WebMercator',
  latRange: Object.freeze([-MERC_MAX_LAT, MERC_MAX_LAT]) as readonly [number, number],

  numX(z: number): number { return 1 << z; },
  numY(z: number): number { return 1 << z; },

  lngX(lngDeg: number, z: number): number {
    return ((lngDeg + 180) / 360) * (1 << z);
  },

  latY(latDeg: number, z: number): number {
    // 对极点附近纬度做 clamp，避免 tan 爆炸
    const clamped = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, latDeg));
    const r = clamped * DEG2RAD;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / PI) / 2) * (1 << z);
  },

  xLng(x: number, z: number): number {
    return (x / (1 << z)) * 360 - 180;
  },

  yLat(y: number, z: number): number {
    const n = PI - 2 * PI * y / (1 << z);
    return Math.atan(Math.sinh(n)) * RAD2DEG;
  },
});
```

### 2.4 Geographic 完整实现

```typescript
// core/src/geo/geographic-tiling-scheme.ts

import type { TilingScheme } from './tiling-scheme.ts';

/**
 * Geographic (EPSG:4326) 瓦片方案。
 *
 * 网格拓扑：
 * - zoom=0: 2×1（经度 360° 分两半，纬度 180° 一行）
 * - zoom=z: 2^(z+1) × 2^z
 *
 * 纬度范围：±90°（全球覆盖，含极地）
 *
 * 兼容服务：Cesium Ion Terrain, 国家测绘局 WMTS, TileMatrixSet EPSG:4326
 *
 * @stability stable
 *
 * @example
 * import { Geographic } from './geographic-tiling-scheme';
 * // zoom=0 只有 2 个瓦片：西半球 (0,0) 和东半球 (1,0)
 * Geographic.numX(0) // 2
 * Geographic.numY(0) // 1
 *
 * @example
 * // zoom=5 北极
 * const row = Math.floor(Geographic.latY(89.0, 5)); // 0（最北行）
 */
export const Geographic: TilingScheme = Object.freeze({
  id: 1,
  name: 'Geographic',
  latRange: Object.freeze([-90, 90]) as readonly [number, number],

  numX(z: number): number { return 2 << z; },
  numY(z: number): number { return 1 << z; },

  lngX(lngDeg: number, z: number): number {
    return ((lngDeg + 180) / 360) * (2 << z);
  },

  latY(latDeg: number, z: number): number {
    return ((90 - latDeg) / 180) * (1 << z);
  },

  xLng(x: number, z: number): number {
    return (x / (2 << z)) * 360 - 180;
  },

  yLat(y: number, z: number): number {
    return 90 - (y / (1 << z)) * 180;
  },
});
```

### 2.5 方案注册表（扩展支撑）

```typescript
// core/src/geo/tiling-scheme.ts 底部

/**
 * 全局方案注册表——通过 id 查找 TilingScheme 实例。
 * 内置方案在模块加载时自动注册。
 * 用户自定义方案通过 registerTilingScheme() 添加。
 *
 * 用途：
 * 1. GlobeTileID.schemeId → 完整 TilingScheme 查表
 * 2. 序列化/反序列化场景状态
 * 3. 开发者工具枚举所有可用方案
 */
const _schemeRegistry = new Map<number, TilingScheme>();

/**
 * 注册自定义 TilingScheme。
 * id 必须在 [8, 31] 范围内（0~7 为内置保留）。
 *
 * @param scheme - 要注册的方案实例
 * @throws 若 id 冲突或超出范围
 *
 * @example
 * const LambertFrance: TilingScheme = { id: 8, name: 'Lambert93', ... };
 * registerTilingScheme(LambertFrance);
 */
export function registerTilingScheme(scheme: TilingScheme): void {
  if (scheme.id < 8 || scheme.id > 31) {
    throw new Error(`Custom TilingScheme id must be in [8, 31], got ${scheme.id}`);
  }
  if (_schemeRegistry.has(scheme.id)) {
    throw new Error(`TilingScheme id ${scheme.id} already registered as "${_schemeRegistry.get(scheme.id)!.name}"`);
  }
  _schemeRegistry.set(scheme.id, Object.freeze(scheme));
}

/**
 * 通过数值 id 查找已注册的 TilingScheme。
 *
 * @param id - 方案 id
 * @returns 方案实例，未找到时返回 undefined
 */
export function getTilingSchemeById(id: number): TilingScheme | undefined {
  return _schemeRegistry.get(id);
}

// 内置方案自动注册（延迟导入避免循环依赖由调用方保证）
export function _registerBuiltins(webMercator: TilingScheme, geographic: TilingScheme): void {
  _schemeRegistry.set(webMercator.id, webMercator);
  _schemeRegistry.set(geographic.id, geographic);
}
```

---

## 3. L0 — 自由函数库规格

所有函数位于 `core/src/geo/tiling-scheme.ts`，与接口定义同文件。

### 3.1 tileBoundsInto（零分配版）

```typescript
/** 模块级预分配输出缓冲。格式：[west, south, east, north] */
const _boundsBuf = new Float64Array(4);

/**
 * 将瓦片 (z, x, y) 的地理边界写入预分配 Float64Array(4)。
 * 零 GC 分配，用于帧循环热路径。
 *
 * 输出格式：
 *   out[0] = west  （西经边界，度）
 *   out[1] = south （南纬边界，度）
 *   out[2] = east  （东经边界，度）
 *   out[3] = north （北纬边界，度）
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param x - 列号，范围 [0, s.numX(z))
 * @param y - 行号，范围 [0, s.numY(z))
 * @param out - 可选输出缓冲。省略时使用模块级 _boundsBuf（非线程安全）
 * @returns out 引用
 *
 * @complexity O(1) — 4 次 xLng/yLat 调用
 *
 * @warning 非线程安全。默认缓冲在下次调用时被覆盖。
 *   若需在回调或异步中保持值，传入独立的 Float64Array(4)。
 *
 * @example
 * const bounds = tileBoundsInto(WebMercator, 2, 1, 1);
 * console.log(bounds[3]); // north latitude
 *
 * @example
 * // 在循环中使用独立缓冲
 * const myBuf = new Float64Array(4);
 * for (const tile of tiles) {
 *   tileBoundsInto(scheme, tile.z, tile.x, tile.y, myBuf);
 *   // myBuf 在循环迭代间不会被覆盖
 * }
 */
export function tileBoundsInto(
  s: TilingScheme, z: number, x: number, y: number,
  out?: Float64Array,
): Float64Array {
  const buf = out ?? _boundsBuf;
  buf[0] = s.xLng(x, z);
  buf[1] = s.yLat(y + 1, z);
  buf[2] = s.xLng(x + 1, z);
  buf[3] = s.yLat(y, z);
  return buf;
}
```

### 3.2 tileBounds（分配版）

```typescript
/**
 * 瓦片 (z, x, y) 的地理边界。分配新对象，用于非热路径。
 */
export interface TileBounds {
  /** 西经边界（度） */
  readonly west: number;
  /** 南纬边界（度） */
  readonly south: number;
  /** 东经边界（度） */
  readonly east: number;
  /** 北纬边界（度） */
  readonly north: number;
}

/**
 * 返回瓦片边界对象。每次调用分配一个新 TileBounds。
 * 用于初始化、配置、测试等非帧循环路径。
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param x - 列号
 * @param y - 行号
 * @returns 不可变 TileBounds 对象
 *
 * @example
 * const b = tileBounds(Geographic, 0, 0, 0);
 * // b = { west: -180, south: 0, east: 0, north: 90 }（西半球北半部）
 */
export function tileBounds(s: TilingScheme, z: number, x: number, y: number): TileBounds {
  return {
    west:  s.xLng(x, z),
    south: s.yLat(y + 1, z),
    east:  s.xLng(x + 1, z),
    north: s.yLat(y, z),
  };
}
```

### 3.3 tileKey / decodeTileKey

```typescript
/**
 * 将 (schemeId, z, x, y) 编码为单个 JS 安全整数，用作 Map 键。
 *
 * 位布局（共 46 bit，JS 安全整数最大 53 bit）：
 *   bit 45-41: schemeId (5 bit → 最多 32 个方案)
 *   bit 40-36: z        (5 bit → 最大 zoom 31)
 *   bit 35-18: x       (18 bit → 最大 262143 列 → zoom 17+)
 *   bit 17-0:  y       (18 bit → 最大 262143 行)
 *
 * 注意：v2 用 20 bit x/y，但 5+5+20+20=50 bit 超过了 Smi 范围（31 bit）。
 * v3 改为 5+5+18+18=46 bit，仍在安全整数范围内。
 * 对于 zoom > 17 的高精度瓦片（x/y > 2^18），回退到字符串键。
 * 实际应用中 zoom 17 对应 ~1.2m/pixel，足够绝大多数场景。
 *
 * @param schemeId - 方案 ID [0, 31]
 * @param z - zoom [0, 31]
 * @param x - 列号 [0, 2^18 - 1]
 * @param y - 行号 [0, 2^18 - 1]
 * @returns 非负整数键
 *
 * @complexity O(1)
 *
 * @example
 * tileKey(0, 5, 16, 11) // 唯一数值
 * tileKey(1, 5, 33, 11) // 不同的数值（不同 scheme）
 */
export function tileKey(schemeId: number, z: number, x: number, y: number): number {
  // 使用乘法而非位移（JS 位运算截断到 32 bit）
  return ((schemeId & 0x1F) * 0x10000000000)  // bits 45-41
       + ((z & 0x1F)       * 0x400000000)     // bits 40-36
       + ((x & 0x3FFFF)    * 0x40000)         // bits 35-18
       + (y & 0x3FFFF);                       // bits 17-0
}

/**
 * 逆解码 tileKey，用于调试和日志。
 * @returns 解构后的 { schemeId, z, x, y }
 */
export function decodeTileKey(key: number): {
  schemeId: number; z: number; x: number; y: number
} {
  const y = key & 0x3FFFF;
  const x = Math.floor(key / 0x40000) & 0x3FFFF;
  const z = Math.floor(key / 0x400000000) & 0x1F;
  const schemeId = Math.floor(key / 0x10000000000) & 0x1F;
  return { schemeId, z, x, y };
}

/**
 * 对于 zoom > 17 或 x/y > 262143 的瓦片，使用字符串键回退。
 * 生产中极少触发（zoom 17 = 1.2m/pixel 精度）。
 */
export function tileKeyStr(schemeId: number, z: number, x: number, y: number): string {
  return `${schemeId}:${z}/${x}/${y}`;
}

/**
 * 统一键获取：优先数值键，zoom > 17 时回退字符串。
 * 返回类型 number | string，Map 的键类型需为 unknown 或使用重载 cache。
 *
 * 推荐：缓存使用两个 Map（numericCache + stringFallbackCache）而非 unknown 键。
 */
export function tileKeyAuto(schemeId: number, z: number, x: number, y: number): number | string {
  if (z <= 17 && x < 0x40000 && y < 0x40000) {
    return tileKey(schemeId, z, x, y);
  }
  return tileKeyStr(schemeId, z, x, y);
}
```

### 3.4 touchesPole

```typescript
/**
 * 判断瓦片是否触及极点（纬度达到 ±89.99°）。
 * 由瓦片实际纬度值判断，而非硬编码行号。
 * 对 WebMercator 和 Geographic 都正确。
 *
 * WebMercator zoom=0 的唯一瓦片 latMax ≈ 85.05° → 不触及极点。
 * Geographic zoom=0 的唯一行 latMax = 90° → 触及北极。
 *
 * @param s - TilingScheme 实例
 * @param z - zoom 级别
 * @param y - 行号
 * @returns 'north' | 'south' | null
 *
 * @example
 * touchesPole(Geographic, 0, 0) // 'north'（zoom=0 row=0 → lat 90°）
 * touchesPole(WebMercator, 0, 0) // null（lat ≈ 85°，不算极点）
 */
export function touchesPole(
  s: TilingScheme, z: number, y: number,
): 'north' | 'south' | null {
  const north = s.yLat(y, z);
  const south = s.yLat(y + 1, z);
  if (north >= 89.99) return 'north';
  if (south <= -89.99) return 'south';
  return null;
}
```

### 3.5 forEachOverlappingTile

```typescript
/**
 * 遍历与指定地理边界重叠的所有瓦片，零分配。
 * 使用回调模式替代返回数组，避免 GC 压力。
 *
 * 用途：地形瓦片渲染时，推导其覆盖的影像瓦片。
 *
 * @param bounds - 地理边界 Float64Array(4)，格式 [west, south, east, north]（度）
 * @param targetScheme - 目标方案（影像方案）
 * @param targetZoom - 目标 zoom 级别
 * @param callback - 每找到一个重叠瓦片调用一次。参数 (z, x, y)。
 *   回调中不应修改 bounds。
 *
 * @complexity O(M) 其中 M = 重叠瓦片数。通常 M ∈ [1, 4]。
 *
 * @example
 * // 查找覆盖某地形瓦片的所有 WebMercator 影像瓦片
 * const terrBounds = tileBoundsInto(Geographic, 5, 10, 3);
 * forEachOverlappingTile(terrBounds, WebMercator, 5, (z, x, y) => {
 *   loadImageryTile(z, x, y);
 * });
 */
export function forEachOverlappingTile(
  bounds: Float64Array,
  targetScheme: TilingScheme,
  targetZoom: number,
  callback: (z: number, x: number, y: number) => void,
): void {
  const west = bounds[0], south = bounds[1], east = bounds[2], north = bounds[3];
  const numX = targetScheme.numX(targetZoom);
  const numY = targetScheme.numY(targetZoom);

  // clamp 到有效纬度范围（WebMercator 不覆盖极地）
  const clampedNorth = Math.min(north, targetScheme.latRange[1]);
  const clampedSouth = Math.max(south, targetScheme.latRange[0]);

  if (clampedNorth <= clampedSouth) return; // 无重叠（地形瓦片完全在极地，影像 scheme 不覆盖）

  const minX = Math.max(0, Math.floor(targetScheme.lngX(west, targetZoom)));
  const maxX = Math.min(numX - 1, Math.floor(targetScheme.lngX(east - 1e-10, targetZoom)));
  const minY = Math.max(0, Math.floor(targetScheme.latY(clampedNorth, targetZoom)));
  const maxY = Math.min(numY - 1, Math.floor(targetScheme.latY(clampedSouth, targetZoom)));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      callback(targetZoom, x, y);
    }
  }
}
```

### 3.6 tileCenter

```typescript
/**
 * 计算瓦片中心经纬度（度），写入预分配 Float64Array(2)。
 * 用于 horizon cull 和距离排序。
 *
 * @param s - TilingScheme
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号
 * @param out - Float64Array(2)，格式 [lngDeg, latDeg]
 * @returns out 引用
 */
const _centerBuf = new Float64Array(2);

export function tileCenterInto(
  s: TilingScheme, z: number, x: number, y: number,
  out?: Float64Array,
): Float64Array {
  const buf = out ?? _centerBuf;
  buf[0] = s.xLng(x + 0.5, z);   // center longitude
  buf[1] = s.yLat(y + 0.5, z);   // center latitude
  return buf;
}
```

---

## 4. L0 — TileSource 接口规格

文件：`core/src/geo/tile-source.ts`

```typescript
/**
 * 瓦片数据源描述——不可变值类型，不持有 GPU 资源或网络连接。
 *
 * 设计目的：
 * 将 TilingScheme（纯数学）与 IO 层配置（URL 模板、zoom 范围、TMS 翻转）
 * 打包为一个不可变结构。L6 的 Globe3D 持有 TileSource 实例，
 * 传递给加载/渲染函数，而非逐个传递 scheme + url + maxZoom + ...
 *
 * TileSource 位于 L0 是因为它只包含值类型描述，不 import 任何上层模块。
 * 它不执行网络请求——那是 L6 `globe-tiles.ts` 的职责。
 *
 * @stability stable
 */
export interface TileSource {
  /** 所用的 tiling scheme 引用 */
  readonly scheme: TilingScheme;

  /**
   * URL 模板，支持以下占位符：
   * - `{z}` — zoom 级别
   * - `{x}` — 列号
   * - `{y}` — 行号（XYZ 标准：y=0 在北端）
   * - `{-y}` — 翻转行号（TMS 标准：y=0 在南端），等价于 numY-1-y
   * - `{s}` — 子域名（可选，轮询 a/b/c）
   *
   * @example 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
   * @example 'https://tiles.example.com/{z}/{x}/{-y}.terrain'
   */
  readonly urlTemplate: string;

  /**
   * 子域名列表。URL 中的 {s} 按瓦片坐标 hash 轮询。
   * 空数组表示不使用子域名。
   *
   * @example ['a', 'b', 'c']
   */
  readonly subdomains: readonly string[];

  /**
   * Y 轴翻转标记（TMS 兼容）。
   * 为 true 时，URL 中的 {y} 自动替换为 `numY(z) - 1 - y`。
   * 与 {-y} 占位符作用相同，但 {-y} 的优先级更高（显式翻转覆盖此标记）。
   */
  readonly tmsFlipY: boolean;

  /** 可请求的最低 zoom（含）。默认 0 */
  readonly minZoom: number;

  /** 可请求的最高 zoom（含）。默认 22 */
  readonly maxZoom: number;

  /**
   * 数据格式标识（影像 vs 地形 vs 矢量）。
   * 用于选择解码器和渲染管线。
   *
   * - 'raster': 栅格影像（PNG/JPEG/WebP）
   * - 'terrain-heightmap': 高程栅格（Mapzen Terrain RGB / Cesium Heightmap）
   * - 'terrain-quantized-mesh': Cesium Quantized Mesh 格式
   * - 'vector-pbf': Mapbox Vector Tile (PBF)
   */
  readonly format: TileSourceFormat;

  /**
   * 该数据源的用户可读名称（调试/图层面板）。
   * 与 scheme.name 不同——scheme 描述投影方式，name 描述数据内容。
   *
   * @example 'OpenStreetMap', 'Cesium World Terrain', 'Mapbox Satellite'
   */
  readonly name: string;
}

/**
 * 数据源格式枚举。
 * 使用字符串字面量联合而非 enum，便于 tree-shake 和 JSON 序列化。
 */
export type TileSourceFormat =
  | 'raster'
  | 'terrain-heightmap'
  | 'terrain-quantized-mesh'
  | 'vector-pbf';

/**
 * 创建 TileSource 的便捷工厂。
 * 填充默认值，冻结结果对象。
 *
 * @param config - 部分配置，仅 scheme 和 urlTemplate 必填
 * @returns 不可变 TileSource
 *
 * @example
 * const osm = createTileSource({
 *   scheme: WebMercator,
 *   urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
 * });
 */
export function createTileSource(config: {
  scheme: TilingScheme;
  urlTemplate: string;
  subdomains?: readonly string[];
  tmsFlipY?: boolean;
  minZoom?: number;
  maxZoom?: number;
  format?: TileSourceFormat;
  name?: string;
}): TileSource {
  return Object.freeze({
    scheme: config.scheme,
    urlTemplate: config.urlTemplate,
    subdomains: Object.freeze(config.subdomains ?? []),
    tmsFlipY: config.tmsFlipY ?? false,
    minZoom: config.minZoom ?? 0,
    maxZoom: config.maxZoom ?? 22,
    format: config.format ?? 'raster',
    name: config.name ?? 'Unnamed',
  });
}

/**
 * 将 TileSource 的 URL 模板实例化为具体瓦片 URL。
 *
 * @param src - 数据源
 * @param z - zoom
 * @param x - 列号
 * @param y - 行号（XYZ 标准方向）
 * @returns 完整 HTTP URL
 *
 * @complexity O(n) 其中 n = urlTemplate 长度（字符串替换）
 */
export function tileUrl(src: TileSource, z: number, x: number, y: number): string {
  const numY = src.scheme.numY(z);
  const flippedY = numY - 1 - y;
  const actualY = src.tmsFlipY ? flippedY : y;

  // 子域名轮询：(x + y + z) % subdomains.length
  let url = src.urlTemplate;
  if (src.subdomains.length > 0) {
    const idx = (x + y + z) % src.subdomains.length;
    url = url.replace('{s}', src.subdomains[idx]);
  }

  return url
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(actualY))
    .replace('{-y}', String(flippedY));
}
```

---

## 5. L0 — TileCoord 值类型

```typescript
// core/src/geo/tiling-scheme.ts

/**
 * 瓦片坐标三元组——轻量值类型，用于函数参数和返回值。
 * 与 GlobeTileID 不同：TileCoord 不含 distToCamera 等渲染状态。
 *
 * 为什么不用 [z, x, y] 元组：
 * - 元组下标语义不明确（z 是 [0] 还是 [2]?）
 * - 解构赋值不如字段访问可读
 * - TypeScript 元组的类型推断在嵌套泛型中不稳定
 */
export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/**
 * 瓦片坐标 + 方案 ID + 缓存键——渲染调度用的完整标识。
 * 这是 coveringTilesGlobe 的输出元素类型。
 */
export interface GlobeTileID extends TileCoord {
  /** 数值缓存键，由 tileKey() 生成 */
  readonly key: number;
  /** 瓦片中心到相机注视点的大圆距离（米），用于排序 */
  readonly distToCamera: number;
  /** 方案 ID，轻量引用而非完整 TilingScheme 对象 */
  readonly schemeId: number;
}
```

---

## 6. L0 — Projection 辅助接口（扩展预留）

```typescript
// core/src/geo/projection.ts — 未来 Phase 5+ 使用

/**
 * 投影接口——将地理坐标 (lng, lat) 投影到 2D 平面坐标 (px, py) 以及逆变换。
 * 这是 TilingScheme 的「上游」抽象：TilingScheme 定义瓦片网格编号规则，
 * Projection 定义坐标变换数学。
 *
 * 为什么 v3 不立即实现：
 * 当前两种 scheme 的投影逻辑已内联在 latY/yLat 中（WebMercator 的 tan+log / Geographic 的线性）。
 * 抽出独立 Projection 需要额外的间接调用，在 latY 每帧被调用上千次的场景下有可测开销。
 * 等未来确实需要第三种投影（如 UTM、Lambert）时再抽象。
 *
 * 此处仅记录设计意图，保证扩展路径畅通。
 *
 * @stability draft — 不导出，不实现
 */
interface Projection {
  readonly epsg: number;
  project(lngRad: number, latRad: number, out: Float64Array): Float64Array;
  unproject(x: number, y: number, out: Float64Array): Float64Array;
}
```

---

## 7. L4 — globe-tile-mesh 改造规格

### 7.1 tessellateGlobeTile

```typescript
/**
 * 生成一个 Globe 瓦片的曲面网格（含裙边抗接缝几何）。
 *
 * v3 变更：
 * - 新增 `scheme` 参数（默认 WebMercator，保持向后兼容）
 * - 内部通过 scheme.xLng / scheme.yLat 计算经纬度范围，替代硬编码 Mercator
 * - 极地判定通过 touchesPole(scheme, z, y) 替代 y===0 硬编码
 * - 非极地区域逻辑不变
 *
 * @param z - zoom 级别
 * @param x - 列号
 * @param y - 行号
 * @param segments - 细分段数（推荐 getSegments(z)）
 * @param ellipsoid - 椭球体参数，默认 WGS84
 * @param scheme - TilingScheme 实例，默认 WebMercator
 * @returns 完整网格数据（含裙边）
 *
 * @example
 * // WebMercator（与改造前行为一致）
 * const mesh = tessellateGlobeTile(5, 16, 11, 16);
 *
 * @example
 * // Geographic
 * import { Geographic } from '../../core/src/geo/geographic-tiling-scheme';
 * const mesh = tessellateGlobeTile(5, 33, 11, 16, WGS84_ELLIPSOID, Geographic);
 */
export function tessellateGlobeTile(
  z: number,
  x: number,
  y: number,
  segments: number,
  ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
  scheme: TilingScheme = WebMercator,
): GlobeTileMesh {
  // ── 改造后的内部逻辑骨架 ──

  // 1. 通过 scheme 获取地理边界
  const bounds = tileBoundsInto(scheme, z, x, y);
  const lngMin = bounds[0]; // west
  const latMin = bounds[1]; // south
  const lngMax = bounds[2]; // east
  const latMax = bounds[3]; // north

  // 2. 通过 touchesPole 判断极地
  const pole = touchesPole(scheme, z, y);
  const isNorthPole = pole === 'north';
  const isSouthPole = pole === 'south';

  // 3. 网格维度计算：不再依赖 numTiles = 1 << z
  const numYTiles = scheme.numY(z);

  // 4. 裙边判定
  const hasTopSkirt = !isNorthPole;
  const hasBottomSkirt = !isSouthPole;
  const hasLeftSkirt = true;
  const hasRightSkirt = true;

  // ...（其余顶点生成、索引生成、包围球计算逻辑不变）
  // 唯一区别：经纬度范围来自 tileBoundsInto 而非硬编码公式
}
```

### 7.2 coveringTilesGlobe（四叉树版）

```typescript
/**
 * 计算 3D Globe 视口覆盖的瓦片列表。
 *
 * v3 变更：
 * - 新增 `scheme` 参数（默认 WebMercator）
 * - 算法从 AABB 扁平枚举改为四叉树自顶向下遍历
 * - 移除 MERCATOR_LAT_LIMIT 极地 hack
 * - 移除 lodDrop hack（SSE 判定替代）
 *
 * 算法：
 * 1. 从 zoom=0 根瓦片开始递归
 * 2. 每个节点先做 Horizon Cull——背面则整棵子树跳过
 * 3. 可选 Frustum Cull——视锥外则跳过
 * 4. SSE 判定：屏幕空间误差 < 阈值则停止分裂，输出当前节点
 * 5. 否则分裂为 4 个子节点递归
 *
 * @param camera - Globe 相机状态（不含 scheme——scheme 是数据源属性）
 * @param scheme - 要计算覆盖的瓦片方案，默认 WebMercator
 * @returns 瓦片列表，按距相机排序
 *
 * @complexity O(T × log(z)) 其中 T = 输出瓦片数，z = 目标 zoom
 *   Horizon cull 在 zoom 0~2 即可剪掉 ~50% 子树
 */
export function coveringTilesGlobe(
  camera: GlobeCamera,
  scheme: TilingScheme = WebMercator,
): GlobeTileID[] {
  const targetZoom = Math.max(0, Math.min(24, Math.floor(camera.zoom)));
  const result: GlobeTileID[] = [];
  const rootNumX = scheme.numX(0);
  const rootNumY = scheme.numY(0);

  for (let y = 0; y < rootNumY; y++) {
    for (let x = 0; x < rootNumX; x++) {
      _subdivide(scheme, 0, x, y, targetZoom, camera, result);
    }
  }

  result.sort((a, b) => a.distToCamera - b.distToCamera);
  if (result.length > MAX_GLOBE_TILES) result.length = MAX_GLOBE_TILES;
  return result;
}

/** SSE 阈值（像素）。瓦片在屏幕上的几何误差低于此值则不再分裂。 */
const SSE_THRESHOLD = 2.0;

/** 四叉树递归栈上限（防止无限递归） */
const MAX_RECURSE_DEPTH = 25;

function _subdivide(
  scheme: TilingScheme,
  z: number, x: number, y: number,
  targetZoom: number,
  camera: GlobeCamera,
  result: GlobeTileID[],
): void {
  // 防御：递归深度保护
  if (z > MAX_RECURSE_DEPTH) return;

  // 1. Horizon Cull
  if (!isTileVisible_Horizon(x, y, z, camera.cameraECEF, undefined, scheme)) {
    return;
  }

  // 2. 到达最大 zoom → 输出
  if (z >= targetZoom) {
    _emitTile(scheme, z, x, y, camera, result);
    return;
  }

  // 3. SSE 判定
  const sse = _estimateSSE(scheme, z, x, y, camera);
  if (sse < SSE_THRESHOLD) {
    _emitTile(scheme, z, x, y, camera, result);
    return;
  }

  // 4. 分裂
  const cz = z + 1;
  const cx = x * 2;
  const cy = y * 2;
  _subdivide(scheme, cz, cx,     cy,     targetZoom, camera, result);
  _subdivide(scheme, cz, cx + 1, cy,     targetZoom, camera, result);
  _subdivide(scheme, cz, cx,     cy + 1, targetZoom, camera, result);
  _subdivide(scheme, cz, cx + 1, cy + 1, targetZoom, camera, result);
}

function _emitTile(
  scheme: TilingScheme, z: number, x: number, y: number,
  camera: GlobeCamera, result: GlobeTileID[],
): void {
  const center = tileCenterInto(scheme, z, x, y);
  const dist = haversineDistance(
    camera.center[0] * DEG2RAD, camera.center[1] * DEG2RAD,
    center[0] * DEG2RAD, center[1] * DEG2RAD,
  );
  result.push({
    z, x, y,
    key: tileKey(scheme.id, z, x, y),
    distToCamera: dist,
    schemeId: scheme.id,
  });
}

/**
 * 估算瓦片在屏幕上的几何误差（像素）。
 * 公式：SSE = (tileGeometricError × viewportHeight) / (distance × 2 × tan(fov/2))
 *
 * geometricError ≈ 瓦片对角线长度（地面米数）
 * distance = 相机到瓦片中心的直线距离
 */
function _estimateSSE(
  scheme: TilingScheme, z: number, x: number, y: number,
  camera: GlobeCamera,
): number {
  const center = tileCenterInto(scheme, z, x, y);
  const dist = haversineDistance(
    camera.center[0] * DEG2RAD, camera.center[1] * DEG2RAD,
    center[0] * DEG2RAD, center[1] * DEG2RAD,
  );

  // 瓦片地面对角线长度（米）的粗略估计
  const bounds = tileBoundsInto(scheme, z, x, y);
  const latSpan = (bounds[3] - bounds[1]) * DEG2RAD;
  const lngSpan = (bounds[2] - bounds[0]) * DEG2RAD;
  const avgLatRad = ((bounds[3] + bounds[1]) / 2) * DEG2RAD;
  const dLat = latSpan * WGS84_A;
  const dLng = lngSpan * WGS84_A * Math.cos(avgLatRad);
  const diag = Math.sqrt(dLat * dLat + dLng * dLng);

  const camDist = Math.max(dist + camera.altitude, 1.0);
  const tanHalfFov = Math.tan(camera.fov * 0.5);

  return (diag * camera.viewportHeight) / (camDist * 2 * tanHalfFov);
}
```

### 7.3 isTileVisible_Horizon

```typescript
/**
 * 瓦片是否在地平线以上（面向相机的半球上）。
 *
 * v3 变更：新增 scheme 参数，通过 tileCenterInto 获取瓦片中心。
 *
 * @param tx - 列号
 * @param ty - 行号
 * @param tz - zoom
 * @param camECEF - 相机 ECEF [x,y,z]
 * @param ellipsoid - 椭球体，默认 WGS84
 * @param scheme - TilingScheme，默认 WebMercator
 * @returns true = 可见
 */
export function isTileVisible_Horizon(
  tx: number, ty: number, tz: number,
  camECEF: [number, number, number],
  ellipsoid: Ellipsoid = WGS84_ELLIPSOID,
  scheme: TilingScheme = WebMercator,
): boolean {
  // 通过 scheme 获取瓦片中心经纬度
  const center = tileCenterInto(scheme, tz, tx, ty);
  const lngRad = center[0] * DEG2RAD;
  const latRad = center[1] * DEG2RAD;

  // 计算 ECEF 位置和法线
  localGeodeticToECEF(_ecefBuf, lngRad, latRad, 0, ellipsoid);
  surfaceNormal(_normalBuf, lngRad, latRad);

  const camToTileX = _ecefBuf[0] - camECEF[0];
  const camToTileY = _ecefBuf[1] - camECEF[1];
  const camToTileZ = _ecefBuf[2] - camECEF[2];

  const dot = camToTileX * _normalBuf[0]
            + camToTileY * _normalBuf[1]
            + camToTileZ * _normalBuf[2];

  // 角半径余量——根据方案获取正确的 numY
  const numYTiles = scheme.numY(tz);
  const numXTiles = scheme.numX(tz);
  const maxTiles = Math.max(numXTiles, numYTiles);
  const tileAngularRadius = PI / maxTiles;
  const margin = Math.sin(tileAngularRadius) * ellipsoid.a;

  return dot < margin;
}
```

### 7.4 废弃兼容层

```typescript
/**
 * @deprecated 使用 WebMercator.lngX(lngDeg, z) 替代。
 * 保留至 v4 移除，供外部依赖方迁移。
 */
export function lngToTileX(lngDeg: number, z: number): number {
  return WebMercator.lngX(lngDeg, z);
}

/**
 * @deprecated 使用 WebMercator.latY(latDeg, z) 替代。
 */
export function latToTileY(latDeg: number, z: number): number {
  return WebMercator.latY(latDeg, z);
}

/**
 * @deprecated 使用 WebMercator.yLat(y, z) 替代。
 */
export function tileYToLat(y: number, z: number): number {
  return WebMercator.yLat(y, z);
}
```

---

## 8. L6 — 地形管线接口规格

文件：`preset-3d/src/globe-terrain.ts`（新增）

```typescript
/**
 * 高程瓦片数据（CPU 侧解码结果）。
 *
 * 数据布局：行优先，从北到南、从西到东。
 * heights[row * width + col] 对应瓦片内 UV = (col/(width-1), row/(height-1))。
 * 单位为米（海拔高度）。
 */
export interface HeightmapData {
  /** 高程栅格值（米） */
  readonly heights: Float32Array;
  /** 栅格宽度（像素） */
  readonly width: number;
  /** 栅格高度（像素） */
  readonly height: number;
}

/**
 * 地形瓦片在 GPU 中的表示。
 * 由 uploadHeightmap() 创建，由 LRU 缓存管理生命周期。
 */
export interface TerrainGPUTile {
  /** R32Float 纹理，存储归一化高程值 */
  readonly texture: GPUTexture;
  /** 高程 = texel * heightScale + heightOffset（米） */
  readonly heightScale: number;
  /** 高程偏移（米） */
  readonly heightOffset: number;
  /** 绑定到 terrain bind group 的实例 */
  readonly bindGroup: GPUBindGroup;
}

/**
 * Terrain RGB 解码器（Mapzen / Mapbox / Terrarium 格式）。
 *
 * Mapzen Terrain RGB:  h = (R × 256 + G + B / 256) − 32768
 * Mapbox Terrain RGB:  h = ((R × 256 × 256 + G × 256 + B) × 0.1) − 10000
 * Terrarium:           h = (R × 256 + G + B / 256) − 32768
 *
 * @param format - 编码格式标识
 * @param imageData - RGBA ImageData（从 ImageBitmap 绘制到 OffscreenCanvas 获取）
 * @returns HeightmapData
 */
export function decodeTerrainRGB(
  format: 'mapzen' | 'mapbox' | 'terrarium',
  imageData: ImageData,
): HeightmapData { /* ... */ }

/**
 * 将 HeightmapData 上传为 GPU R32Float 纹理。
 *
 * @param device - GPU 设备
 * @param data - CPU 侧高程数据
 * @param layout - terrain bind group layout（来自 globe-gpu.ts）
 * @param sampler - 线性采样器
 * @param uniformBuffer - terrain params uniform buffer
 * @returns TerrainGPUTile
 */
export function uploadHeightmap(
  device: GPUDevice,
  data: HeightmapData,
  layout: GPUBindGroupLayout,
  sampler: GPUSampler,
  uniformBuffer: GPUBuffer,
): TerrainGPUTile { /* ... */ }
```

---

## 9. L6 — GPU 管线 / Shader 变更规格

### 9.1 Bind Group 布局总览

```
group(0): CameraUniforms     ← 所有 pass 共享
group(1): TileTexture        ← sampler + imagery texture
group(2): TileParams         ← UV offset/scale（纯影像模式）
                              或 DrapingParams（地形模式跨 scheme 纹理投影）
group(3): TerrainData        ← heightMap texture + sampler + TerrainParams uniform
                              仅地形 pipeline 使用
```

### 9.2 DrapingParams Uniform

```wgsl
// 16 bytes, vec4 对齐
struct DrapingParams {
  imgWest: f32,          // 影像瓦片西经边界（度）
  imgEast: f32,          // 影像瓦片东经边界（度）
  imgLatToV_scale: f32,  // Mercator V = mercY × scale + offset
  imgLatToV_offset: f32,
};
```

```typescript
// CPU 侧预计算——每影像瓦片一次，复用 Float32Array(4)
const _drapingBuf = new Float32Array(4);

export function computeDrapingParams(
  imgScheme: TilingScheme,
  imgZ: number, imgX: number, imgY: number,
): Float32Array {
  const west  = imgScheme.xLng(imgX, imgZ);
  const east  = imgScheme.xLng(imgX + 1, imgZ);
  const north = imgScheme.yLat(imgY, imgZ);
  const south = imgScheme.yLat(imgY + 1, imgZ);

  _drapingBuf[0] = west;
  _drapingBuf[1] = east;

  const northRad = north * DEG2RAD;
  const southRad = south * DEG2RAD;
  const mercNorth = Math.log(Math.tan(northRad) + 1 / Math.cos(northRad));
  const mercSouth = Math.log(Math.tan(southRad) + 1 / Math.cos(southRad));
  const range = mercSouth - mercNorth;

  _drapingBuf[2] = 1.0 / range;
  _drapingBuf[3] = -mercNorth / range;

  return _drapingBuf;
}
```

### 9.3 Terrain Vertex Shader

```wgsl
struct TerrainParams {
  exaggeration: f32,
  heightScale: f32,
  heightOffset: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var tileSampler: sampler;
@group(1) @binding(1) var tileTexture: texture_2d<f32>;
@group(2) @binding(0) var<uniform> draping: DrapingParams;
@group(3) @binding(0) var heightMap: texture_2d<f32>;
@group(3) @binding(1) var heightSampler: sampler;
@group(3) @binding(2) var<uniform> terrain: TerrainParams;

struct VsIn {
  @location(0) posRTE: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,      // 瓦片内 UV [0,1]²
  @location(3) lngDeg: f32,        // 新增 vertex attribute：经度
  @location(4) latDeg: f32,        // 新增 vertex attribute：纬度
};

fn drapeUV(lngDeg: f32, latDeg: f32) -> vec2<f32> {
  let u = (lngDeg - draping.imgWest) / (draping.imgEast - draping.imgWest);
  let latRad = latDeg * 0.017453293;
  let mercY = log(tan(latRad) + 1.0 / cos(latRad));
  let v = mercY * draping.imgLatToV_scale + draping.imgLatToV_offset;
  return vec2<f32>(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

@vertex fn terrain_vs(in: VsIn) -> VsOut {
  // 高程位移
  let h = textureSampleLevel(heightMap, heightSampler, in.uv, 0.0).r;
  let elevation = (h * terrain.heightScale + terrain.heightOffset) * terrain.exaggeration;
  let displaced = in.posRTE + in.normal * elevation;

  var out: VsOut;
  var clip = camera.vpMatrix * vec4<f32>(displaced, 1.0);
  out.clipPos = applyLogDepth(clip, camera.logDepthBufFC);

  // 跨 scheme 纹理坐标
  out.uv = drapeUV(in.lngDeg, in.latDeg);
  out.normal = in.normal;
  out.viewDir = -normalize(displaced);
  return out;
}
```

### 9.4 顶点格式扩展

```typescript
// 地形模式交错顶点：10 float/vertex
// [posRTE.x, posRTE.y, posRTE.z, nx, ny, nz, u, v, lngDeg, latDeg]
export const TERRAIN_VERTEX_FLOATS = 10;
export const TERRAIN_VERTEX_BYTES = TERRAIN_VERTEX_FLOATS * 4; // 40 bytes
```

`lngDeg` / `latDeg` 为地形模式新增属性。纯影像模式继续使用现有 8-float 格式。

---

## 10. L6 — 缓存架构规格

```typescript
// globe-types.ts

/**
 * 分层缓存结构。
 * 影像/地形 GPU 纹理各自独立 LRU。
 * 网格缓存按 (schemeId, z, x, y) 跨数据源共享。
 */
export interface TileCacheState {
  /** 影像纹理 LRU */
  readonly imagery: TileLRUCache<CachedImageryTile>;

  /** 地形高程纹理 LRU */
  readonly terrain: TileLRUCache<TerrainGPUTile>;

  /**
   * 网格缓存。
   * 键 = tileKey(schemeId, z, x, y)。
   * 同 scheme 的影像和地形共享同一几何。
   * 不同 scheme 通过 schemeId 区分。
   *
   * 无 LRU——mesh 的 GPU 资源（索引缓冲）远小于纹理，
   * 使用 Map.size 上限 + 全量清理策略。
   */
  readonly mesh: Map<number, CachedMesh>;

  /** mesh 缓存上限 */
  readonly meshMaxSize: number;
}

/**
 * 泛型 LRU 缓存——纹理类条目的通用容器。
 */
export interface TileLRUCache<T> {
  /** 键 → 值 */
  readonly entries: Map<number, T>;
  /** LRU 序列（头部最旧） */
  readonly lru: number[];
  /** 容量上限 */
  readonly maxSize: number;
}
```

---

## 11. L6 — Globe3D 集成规格

```typescript
// globe-3d.ts 新增字段

class Globe3D {
  /** 影像数据源（默认 OSM + WebMercator） */
  private _imagerySrc: TileSource;

  /** 地形数据源（null = 无地形 = 纯影像模式） */
  private _terrainSrc: TileSource | null;

  /** 分层缓存 */
  private readonly _cacheState: TileCacheState;

  // _renderFrame 内部逻辑分支：
  // if (_terrainSrc) → 地形驱动路径
  // else → 纯影像路径（与现有行为一致）
}
```

```typescript
// Globe3DOptions 扩展

export interface Globe3DOptions {
  readonly imagery?: {
    readonly url?: string;
    readonly scheme?: 'webmercator' | 'geographic';
    readonly subdomains?: string[];
    readonly tmsFlipY?: boolean;
    readonly maxZoom?: number;
  };
  readonly terrain?: {
    readonly url: string;
    readonly scheme?: 'webmercator' | 'geographic';  // 默认 geographic
    readonly format?: 'mapzen' | 'mapbox' | 'terrarium' | 'quantized-mesh';
    readonly exaggeration?: number;
    readonly tmsFlipY?: boolean;
    readonly maxZoom?: number;
  };
  // ...其余字段不变
}
```

---

## 12. 扩展性设计

### 12.1 新增 TilingScheme 的步骤

1. 创建 `core/src/geo/xxx-tiling-scheme.ts`，导出冻结常量
2. 为 `id` 选择 [2, 7]（内置）或 [8, 31]（用户自定义）
3. 实现 6 个方法：`numX`, `numY`, `lngX`, `latY`, `xLng`, `yLat`
4. 调用 `registerTilingScheme()` 注册到全局表
5. 所有自由函数（`tileBoundsInto`、`touchesPole`、`forEachOverlappingTile`）自动适配

**不需要修改的模块**：`globe-tile-mesh.ts`（通过 scheme 参数多态）、`globe-render.ts`（通过 `TileSource.scheme` 多态）、`globe-shaders.ts`（uniform 参数化）。

### 12.2 新增地形格式的步骤

1. 在 `TileSourceFormat` 联合中新增字面量（如 `'terrain-lerc'`）
2. 在 `globe-terrain.ts` 中新增解码函数（如 `decodeLERC`）
3. `loadTerrainTile` 内部根据 `source.format` 分派解码器
4. GPU 侧 `terrain_vs` 不变（只看 `R32Float` 纹理）

### 12.3 新增影像格式的步骤

1. 矢量瓦片：新增 `vector-pbf` 到 `TileSourceFormat`
2. 新增 `globe-vector.ts`（PBF 解码 → GPU 几何）
3. 新增 vector pipeline（独立 shader）
4. `renderFrame` 中新增 vector pass

### 12.4 多影像图层叠加

当前设计支持单个 `_imagerySrc`。多图层扩展路径：

```typescript
// 未来 Phase 5+
private _imageryLayers: TileSource[];

// 渲染时，每个地形瓦片对每个影像图层做一次 draw：
for (const imgSrc of this._imageryLayers) {
  forEachOverlappingTile(terrBounds, imgSrc.scheme, imgZoom, (z, x, y) => {
    draw(terrainMesh, imgTexture, drapingParams, imgSrc.alpha);
  });
}
```

Alpha 混合通过 `blend` 管线状态实现。

---

## 13. 可维护性契约

### 13.1 不变量

| ID | 不变量 | 验证方式 |
|----|--------|---------|
| I1 | `scheme.numX(z) * scheme.numY(z)` = 该 zoom 下瓦片总数 | 单元测试 zoom 0~20 |
| I2 | `Math.floor(scheme.lngX(scheme.xLng(x, z), z)) === x`（往返一致性） | 属性测试，随机 z/x |
| I3 | `scheme.yLat(y, z) > scheme.yLat(y+1, z)`（北大于南） | 单元测试 |
| I4 | `tileBoundsInto` 输出 `north > south` 且 `east > west`（日期线除外） | 单元测试 |
| I5 | `tileKey` 编码后 `decodeTileKey` 完全还原 | 属性测试 |
| I6 | Geographic zoom=0 → `numX=2, numY=1` | 单元测试 |
| I7 | WebMercator latY 在 ±85.05° 时返回有限值 | 边界测试 |
| I8 | `GlobeTileMesh` 创建后 `positions` 不被修改 | 只读类型 + Object.freeze |

### 13.2 测试策略

| 测试类型 | 范围 | 工具 |
|---------|------|------|
| 单元测试 | TilingScheme 6 个方法 × 2 个实现 × 边界值 | vitest |
| 属性测试 | 往返一致性、tileKey 编解码 | fast-check |
| 快照测试 | tessellateGlobeTile 输出（vertex count、index count、bounds） | vitest + toMatchSnapshot |
| 视觉回归 | 全球渲染截图对比（WebMercator / Geographic） | playwright + pixelmatch |
| 性能基准 | coveringTilesGlobe 帧时间 < 2ms @ zoom 10 | vitest.bench |

### 13.3 错误处理契约

| 场景 | 行为 | 理由 |
|------|------|------|
| `latY` 接收超出 `latRange` 的纬度 | WebMercator: clamp 到 ±85.05°；Geographic: 数学上合法 | 防止 tan/log 爆炸，不抛错（帧循环中抛错 = 帧丢失） |
| `tileKey` 接收 zoom > 17 | 返回的数值可能超出 Smi 范围 | 调用方应使用 `tileKeyAuto` 或自行检查 |
| `registerTilingScheme` 接收冲突 id | throw Error | 初始化阶段，非帧循环 |
| `forEachOverlappingTile` 接收 latRange 外的 bounds | 自动 clamp + 可能返回 0 个结果 | Geographic 极地瓦片 vs WebMercator 影像 → 无重叠是合法的 |

### 13.4 废弃迁移时间表

| 符号 | 废弃版本 | 移除版本 | 替代 |
|------|---------|---------|------|
| `lngToTileX` | Phase 1 | Phase 3 | `WebMercator.lngX` |
| `latToTileY` | Phase 1 | Phase 3 | `WebMercator.latY` |
| `tileYToLat` | Phase 1 | Phase 3 | `WebMercator.yLat` |
| `GlobeTileID.key: string` | Phase 1 | Phase 2 | `GlobeTileID.key: number` |
| `TileManagerState` | Phase 2 | Phase 3 | `TileCacheState` |

---

## 14. 性能预算

### 14.1 帧时间拆分（目标：16.6ms @ 60fps）

| 阶段 | 预算 | v2 估计 | 占比 |
|------|------|--------|------|
| Camera update | 0.2ms | 0.1ms | 1% |
| coveringTilesGlobe（四叉树） | 1.0ms | 0.5ms | 6% |
| meshToRTE（100 瓦片 × 1089 顶点） | 2.0ms | 1.5ms | 12% |
| computeDrapingParams（100 瓦片） | 0.1ms | 0.05ms | <1% |
| GPU uniform upload | 0.3ms | 0.2ms | 2% |
| GPU 渲染（天穹+瓦片+大气） | 8.0ms | 6.0ms | 48% |
| 异步 tile 加载回调 | 0.5ms | 0.3ms | 3% |
| JS 杂项 + GC | 1.0ms | 0.5ms | 6% |
| **余量** | **3.5ms** | | **21%** |

### 14.2 内存预算

| 资源 | 单位大小 | 数量上限 | 总预算 |
|------|---------|---------|--------|
| 影像纹理（256×256 RGBA） | 256KB | 200 | 50 MB |
| 地形纹理（256×256 R32F） | 256KB | 100 | 25 MB |
| 网格（1089 顶点） | ~45KB | 400 | 18 MB |
| 索引缓冲（12288 idx） | ~48KB | 400 | 19 MB |
| 总 GPU 内存 | | | **~112 MB** |

### 14.3 关键性能指标

| 指标 | 目标 | 测量方法 |
|------|------|---------|
| coveringTilesGlobe 耗时 | < 1ms @ zoom 10 | `performance.now()` 差值 |
| tileBoundsInto 调用次数/帧 | < 500 | 计数器 |
| GC minor pause/帧 | < 1ms | Chrome DevTools |
| 帧循环内 new 分配次数 | 0（除 result 数组） | ESLint 自定义规则 |
| GPU drawIndexed 次数/帧 | < 120 | 统计计数 |

---

## 15. 分阶段实施（精确任务）

### Phase 1 — L0 接口 + L4 抽象 (15 个任务)

| # | 任务 | 文件 | 估时 |
|---|------|------|------|
| 1.1 | 创建 `tiling-scheme.ts`：接口 + TileBounds + TileCoord | L0 新增 | 2h |
| 1.2 | 实现 `tileBoundsInto` + `tileBounds` + `tileKey` + `decodeTileKey` + `tileKeyAuto` | L0 | 2h |
| 1.3 | 实现 `touchesPole` + `forEachOverlappingTile` + `tileCenterInto` | L0 | 1h |
| 1.4 | 实现方案注册表 `registerTilingScheme` / `getTilingSchemeById` / `_registerBuiltins` | L0 | 1h |
| 1.5 | 创建 `web-mercator-tiling-scheme.ts`：`WebMercator` 冻结常量 | L0 新增 | 1h |
| 1.6 | 创建 `geographic-tiling-scheme.ts`：`Geographic` 冻结常量 | L0 新增 | 1h |
| 1.7 | 创建 `tile-source.ts`：接口 + `createTileSource` + `tileUrl` | L0 新增 | 1h |
| 1.8 | `tessellateGlobeTile` 加 `scheme` 参数，内部用 `tileBoundsInto` + `touchesPole` | L4 改造 | 3h |
| 1.9 | `coveringTilesGlobe` 加 `scheme` 参数，四叉树遍历 + SSE | L4 改造 | 4h |
| 1.10 | `isTileVisible_Horizon` 加 `scheme` 参数 | L4 改造 | 1h |
| 1.11 | 废弃 `lngToTileX` / `latToTileY` / `tileYToLat`，委托给 `WebMercator` | L4 | 0.5h |
| 1.12 | `GlobeTileID` 改为 number key + schemeId | L4 | 1h |
| 1.13 | 导出更新：`globe/src/index.ts` + `core/src/geo/index.ts` | 桶导出 | 0.5h |
| 1.14 | 单元测试：TilingScheme × 2 实现 × 边界值 + 往返一致性 | 测试 | 3h |
| 1.15 | 视觉回归：WebMercator 渲染截图与改造前对比 | 测试 | 1h |

### Phase 2 — Geographic 影像 + 缓存重构 (8 个任务)

| # | 任务 | 文件 | 估时 |
|---|------|------|------|
| 2.1 | `Globe3DOptions.imagery` 支持 `scheme` 字段 | L6 globe-types | 0.5h |
| 2.2 | `Globe3D` 构造时创建 `_imagerySrc: TileSource` | L6 globe-3d | 1h |
| 2.3 | `TileCacheState` 替换 `TileManagerState` | L6 globe-types | 2h |
| 2.4 | `globe-tiles.ts` 缓存键改 `tileKey()`；`loadTileTexture` 接收 `TileSource` | L6 | 2h |
| 2.5 | `globe-render.ts` 传 `scheme` 给 `coveringTilesGlobe` 和 `getOrCreateTileMesh` | L6 | 1h |
| 2.6 | `computeGlobeCamera` 不再写 tilingScheme 到 GlobeCamera | L6 globe-camera | 0.5h |
| 2.7 | Geographic 影像单元测试（zoom=0 时 2×1、极地覆盖） | 测试 | 2h |
| 2.8 | Geographic WMTS 影像源端到端测试 | 测试 | 2h |

### Phase 3 — 地形管线 (12 个任务)

| # | 任务 | 文件 | 估时 |
|---|------|------|------|
| 3.1 | 创建 `globe-terrain.ts`：HeightmapData + decodeTerrainRGB | L6 新增 | 3h |
| 3.2 | `uploadHeightmap`：R32Float GPU 纹理创建 | L6 globe-terrain | 2h |
| 3.3 | `globe-gpu.ts`：terrain bind group layout + pipeline | L6 | 3h |
| 3.4 | `globe-shaders.ts`：terrain_vs + drapeUV | L6 | 2h |
| 3.5 | `globe-buffers.ts`：新增 `_drapingParamsData` + `_terrainParamsData` | L6 | 0.5h |
| 3.6 | `globe-constants.ts`：`TERRAIN_UNIFORM_SIZE` / `DRAPING_UNIFORM_SIZE` / `SSE_THRESHOLD` | L6 | 0.5h |
| 3.7 | `computeDrapingParams` 实现 | L6 globe-render | 1h |
| 3.8 | `meshToRTE` 扩展：地形模式输出 10-float 交错（含 lngDeg/latDeg） | L4 | 2h |
| 3.9 | `globe-render.ts`：地形驱动渲染路径 | L6 | 4h |
| 3.10 | `Globe3D._renderFrame` 地形分支 | L6 globe-3d | 2h |
| 3.11 | `Globe3DOptions.terrain` 配置解析 | L6 globe-types + globe-3d | 1h |
| 3.12 | 端到端测试：Geographic DEM + WebMercator OSM 协同渲染 | 测试 | 3h |

### Phase 4 — 优化 (7 个任务)

| # | 任务 | 估时 |
|---|------|------|
| 4.1 | 地形裙边高程对齐（采样边缘高程） | 3h |
| 4.2 | 高程位移后法线重计算（中心差分或 Sobel 滤波） | 4h |
| 4.3 | 影像 texture array（最多 4 层，减少 draw call） | 6h |
| 4.4 | 网格缓存跨 source 共享验证 + 度量 | 2h |
| 4.5 | coveringTilesGlobe 性能基准 + profiling | 2h |
| 4.6 | GC profiling：确认帧循环零分配 | 2h |
| 4.7 | 文档更新：API 参考 + 迁移指南 | 3h |

---

## 16. 完整文件清单

### 新增 (6 个文件)

| 文件 | 层 | 代码量估计 |
|------|---|-----------|
| `core/src/geo/tiling-scheme.ts` | L0 | ~300 行 |
| `core/src/geo/tile-source.ts` | L0 | ~120 行 |
| `core/src/geo/web-mercator-tiling-scheme.ts` | L0 | ~40 行 |
| `core/src/geo/geographic-tiling-scheme.ts` | L0 | ~35 行 |
| `preset-3d/src/globe-terrain.ts` | L6 | ~250 行 |
| `tests/tiling-scheme.test.ts` | 测试 | ~400 行 |

### 修改 (11 个文件)

| 文件 | 主要改动 |
|------|---------|
| `globe/src/globe-tile-mesh.ts` | tessellate/covering/horizon 加 scheme；四叉树；废弃旧函数 |
| `globe/src/index.ts` | 新增导出 |
| `core/src/geo/index.ts`（如有） | 新增导出 |
| `preset-3d/src/globe-types.ts` | TileCacheState；Globe3DOptions 扩展 |
| `preset-3d/src/globe-tiles.ts` | 缓存键改 tileKey；loadTileTexture 接收 TileSource |
| `preset-3d/src/globe-render.ts` | 地形驱动路径 + draping |
| `preset-3d/src/globe-shaders.ts` | terrain_vs + drapeUV + DrapingParams + TerrainParams |
| `preset-3d/src/globe-gpu.ts` | terrain pipeline + bind group layout |
| `preset-3d/src/globe-3d.ts` | _imagerySrc + _terrainSrc + TileCacheState |
| `preset-3d/src/globe-buffers.ts` | _drapingParamsData + _terrainParamsData |
| `preset-3d/src/globe-constants.ts` | 新常量 |

### 不变 (8 个文件)

`GlobeRenderer.ts`, `atmosphere.ts`, `skybox.ts`, `sun.ts`, `globe-interaction.ts`, `globe-camera.ts`（仅删除 scheme 写入）, `Globe3D.ts`（PascalCase 别名）, `globe-atmosphere.ts`
