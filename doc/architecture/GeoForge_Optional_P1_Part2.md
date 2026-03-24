# GeoForge 可选功能包完整接口设计 — P1 核心 3D 包（下）

> view-morph / layer-3dtiles

---

## 3. @geoforge/view-morph

### 3.1 类型依赖

```typescript
import type { CameraController, CameraAnimation } from '@geoforge/runtime';
import type { CameraState, Mat4f, Vec3f, Viewport } from '@geoforge/core';
import type { InternalBus } from '@geoforge/core/infra/internal-bus';
import { mat4, vec3, quat } from '@geoforge/core/math';
import { lerp as lerpScalar } from '@geoforge/core/math/interpolate';
import { lngLatToMerc, mercToLngLat } from '@geoforge/core/geo/mercator';
import { geodeticToECEF, ecefToGeodetic } from '@geoforge/core/geo/ellipsoid';
```

### 3.2 ViewMorphOptions

```typescript
export type ViewMode = '2d' | '25d' | '3d';

export interface ViewMorphOptions {
  /**
   * 过渡总时长（毫秒）。
   * @unit 毫秒
   * @range [500, 10000]
   * @default 2000
   */
  readonly duration?: number;

  /**
   * 缓动函数。
   * @default easeInOutCubic
   */
  readonly easing?: (t: number) => number;

  /**
   * 过渡中间的最大 zoom out 偏移。
   * 2D→3D 过渡时先 zoom out 再 zoom in，此值控制 zoom out 幅度。
   * @range [0, 5]
   * @default 2
   */
  readonly maxZoomOffset?: number;

  /**
   * 投影矩阵混合方法。
   * 'parameter': 分别插值 fov/near/far 参数后重建矩阵（推荐，数学正确）
   * 'matrix':    直接矩阵元素 lerp（简单但可能产生畸变）
   * @default 'parameter'
   */
  readonly projectionBlendMethod?: 'parameter' | 'matrix';
}
```

### 3.3 内部数据结构

```typescript
/**
 * 视图过渡的完整状态。
 */
interface MorphInternalState {
  /** 当前模式 */
  currentMode: ViewMode;
  /** 目标模式 */
  targetMode: ViewMode;
  /** 过渡进度 [0, 1] */
  progress: number;
  /** 是否正在过渡 */
  isMorphing: boolean;

  /** 起始相机控制器 */
  fromCamera: CameraController;
  /** 目标相机控制器 */
  toCamera: CameraController;

  /** 起始相机状态（过渡开始时的快照） */
  fromState: CameraState;
  /** 目标相机状态（过渡结束时的目标） */
  toState: CameraState;

  /** 总时长（毫秒） */
  duration: number;
  /** 已经过时间（毫秒） */
  elapsed: number;
  /** 缓动函数 */
  easing: (t: number) => number;
  /** zoom 偏移 */
  maxZoomOffset: number;
  /** 投影混合方法 */
  projectionBlendMethod: 'parameter' | 'matrix';

  /** Promise resolve/reject */
  resolve: () => void;
  reject: (reason: string) => void;

  /**
   * 两阶段配置（2D→3D 使用，其他过渡不用）。
   * phase1End: phase1 结束的进度值（如 0.4 = 前 40% 是 phase1）。
   */
  phase1End: number;
}

/**
 * 投影参数插值中间值。
 * 用于 'parameter' 混合方法。
 */
interface ProjectionParams {
  /** FOV（弧度），正交投影为 0 */
  fov: number;
  /** 近裁面 */
  near: number;
  /** 远裁面（Infinity 用 1e20 表示） */
  far: number;
  /** 是否正交（正交=true，透视=false） */
  isOrtho: boolean;
  /** 正交半宽（仅正交时有效） */
  orthoHalfWidth: number;
  /** 正交半高 */
  orthoHalfHeight: number;
}
```

### 3.4 ViewMorph 公共接口

```typescript
export interface ViewMorphState {
  /** 当前是否在过渡中 */
  readonly isMorphing: boolean;
  /** 过渡进度 0~1 */
  readonly progress: number;
  /** 当前模式 */
  readonly currentMode: ViewMode;
  /** 目标模式（过渡中有值，非过渡时等于 currentMode） */
  readonly targetMode: ViewMode;
  /** 混合后的 CameraState（过渡中两个相机的 blend 结果） */
  readonly blendedState: CameraState;
}

export interface ViewMorphAnimation {
  /** 完成 Promise */
  readonly finished: Promise<void>;
  /** 取消过渡 */
  cancel(): void;
}

export interface ViewMorph {
  // ═══════════════════════════════════════
  // 过渡控制
  // ═══════════════════════════════════════

  /**
   * 执行视图过渡。
   *
   * @param targetMode - 目标模式
   * @param fromCamera - 起始相机控制器
   * @param toCamera - 目标相机控制器
   * @param options - 过渡选项
   * @returns ViewMorphAnimation（含 finished Promise 和 cancel 方法）
   *
   * @stability stable
   *
   * 内部流程：
   *   1. 快照 fromCamera.state
   *   2. 根据 fromState 计算 toCamera 的目标状态（保持用户当前视角的等效表示）
   *   3. 确定过渡路径（见 3.5 过渡算法）
   *   4. 设置 isMorphing = true
   *   5. InternalBus.emit('viewmorph:start', { from, to })
   *   6. 启动动画（由 update() 每帧推进）
   *
   * @throws GeoForgeError(CONFIG) 如果 fromMode === targetMode
   */
  morphTo(
    targetMode: ViewMode,
    fromCamera: CameraController,
    toCamera: CameraController,
    options?: ViewMorphOptions,
  ): ViewMorphAnimation;

  /**
   * 取消当前过渡。
   * 相机停留在当前混合状态位置。
   *
   * @stability stable
   */
  cancel(): void;

  /** 当前过渡状态（只读） */
  readonly state: ViewMorphState;

  // ═══════════════════════════════════════
  // 每帧更新
  // ═══════════════════════════════════════

  /**
   * 每帧由 FrameScheduler 调用。
   * 仅在 isMorphing=true 时执行。
   *
   * @param deltaTime - 帧间隔（秒）
   * @returns 混合后的 CameraState，null 表示无过渡
   *
   * @stability stable
   *
   * 算法：
   *   1. elapsed += deltaTime * 1000
   *   2. rawProgress = clamp(elapsed / duration, 0, 1)
   *   3. progress = easing(rawProgress)
   *   4. 根据过渡路径（见 3.5）计算混合 CameraState：
   *      a. center = lerpLngLat(fromState.center, toState.center, progress)
   *      b. zoom = lerpZoom(fromState.zoom, toState.zoom, progress, maxZoomOffset)
   *      c. bearing = lerpAngle(fromState.bearing, toState.bearing, progress)
   *      d. pitch = lerp(fromState.pitch, toState.pitch, progress)
   *      e. projectionMatrix = blendProjection(fromProj, toProj, progress)
   *      f. viewMatrix = blendView(fromView, toView, progress)
   *      g. vpMatrix = projectionMatrix × viewMatrix
   *      h. inverseVPMatrix = invert(vpMatrix)
   *   5. if (rawProgress >= 1.0) → 完成
   *      a. isMorphing = false
   *      b. resolve()
   *      c. InternalBus.emit('viewmorph:end', { mode: targetMode })
   */
  update(deltaTime: number): CameraState | null;

  // ═══════════════════════════════════════
  // 事件
  // ═══════════════════════════════════════

  /** @stability stable */
  onMorphStart(callback: (from: ViewMode, to: ViewMode) => void): () => void;

  /** @stability experimental */
  onMorphProgress(callback: (progress: number) => void): () => void;

  /** @stability stable */
  onMorphEnd(callback: (mode: ViewMode) => void): () => void;

  /** @stability stable */
  destroy(): void;
}

export function createViewMorph(): ViewMorph;
```

### 3.5 过渡算法详细步骤

```
═══ 2D → 2.5D（简单，单阶段）═══

  progress: 0 → 1 线性

  pitch:   lerp(0, targetPitch, progress)
  bearing: lerp(0, targetBearing, progress)
  zoom:    lerp(fromZoom, toZoom, progress)
  center:  lerp(fromCenter, toCenter, progress)

  投影混合（正交→透视）：
    if (projectionBlendMethod === 'parameter') {
      // 参数插值后重建矩阵
      fov_t = lerp(0.0001, targetFOV, progress)  // 正交≈fov→0
      near_t = lerp(fromNear, toNear, progress)
      far_t = lerp(fromFar, toFar, progress)
      projMatrix = mat4.perspectiveReversedZ(fov_t, aspect, near_t, far_t)
    } else {
      // 直接矩阵 lerp
      for (i = 0; i < 16; i++)
        projMatrix[i] = lerp(orthoProjMatrix[i], perspProjMatrix[i], progress)
    }

  视图矩阵：
    根据混合后的 center/bearing/pitch/altitude 重新计算
    （不是直接 lerp 两个 viewMatrix——矩阵 lerp 不保证正交性）

═══ 2D → 3D（两阶段）═══

  Phase 1（progress: 0 → phase1End，默认 0.4）：2D → 2.5D
    localProgress = progress / phase1End

    pitch:   lerp(0, 60°, localProgress)          // 升起到 60°
    zoom:    lerp(fromZoom, fromZoom - maxZoomOffset, localProgress)  // 先 zoom out
    center:  lerp(fromCenter, midCenter, localProgress)  // 向目标方向移动一半
    bearing: lerp(0, targetBearing * 0.5, localProgress)

    投影：ortho → perspective（同 2D→2.5D 逻辑）

  Phase 2（progress: phase1End → 1.0）：2.5D → 3D
    localProgress = (progress - phase1End) / (1 - phase1End)

    顶点坐标变形（核心！）：
      在 Vertex Shader 中：
        mercatorPos = 当前顶点的墨卡托 3D 坐标（x, y, z）
        ecefPos = 当前顶点的 ECEF 坐标（通过 ellipsoid.geodeticToECEF 预计算）
        morphedPos = mix(mercatorPos, ecefPos, localProgress)
        // 地图从平面逐渐"卷曲"成球体

    投影矩阵：
      perspective → perspectiveReversedZInfinite
      fov:  lerp(2.5D_fov, 3D_fov, localProgress)
      near: lerp(2.5D_near, max(1.0, altitude * 0.001), localProgress)

    相机位置：
      墨卡托空间位置 → ECEF 位置
      altitude: lerp(2.5D_altitude, 3D_altitude, localProgress)
      orientation: quat.slerp(2.5D_quat, 3D_quat, localProgress)

    pitch:   lerp(60°, targetPitch, localProgress)
    bearing: lerp(targetBearing * 0.5, targetBearing, localProgress)
    center:  lerp(midCenter, targetCenter, localProgress)

═══ 2.5D → 3D（单阶段，等同 Phase 2）═══

  直接执行上述 Phase 2 逻辑，localProgress = progress

═══ 3D → 2D（两阶段，反向）═══

  Phase 1（0 → 0.6）：3D → 2.5D（地球"展开"）
    反向执行 2D→3D 的 Phase 2：
    ecefPos → mercatorPos（顶点变形）
    perspectiveInfinite → perspective
    ECEF 位置 → 墨卡托位置

  Phase 2（0.6 → 1.0）：2.5D → 2D
    pitch 降回 0
    perspective → ortho
    bearing 归零

═══ 3D → 2.5D / 2.5D → 2D（单阶段，对应的反向逻辑）═══
```

### 3.6 RenderGraph 过渡期处理

```
过渡期间的每帧渲染：

  1. ViewMorph.update(dt) → blendedState（混合后的 CameraState）

  2. FrameGraphBuilder.begin(surface, blendedState)
     // 使用混合后的 VP 矩阵

  3. Phase 2（2.5D→3D）期间：
     // 同时存在两种坐标系的顶点，需要特殊处理

     顶点 Shader 中注入 morph 逻辑：
       uniform morphProgress: f32;  // @group(2) perObject 中传入
       // 每个瓦片图层的顶点同时有 mercatorPos 和 ecefPos 属性
       // （在 Worker 解码时预计算 ECEF 坐标并打包到 vertexBuffer）
       worldPos = mix(mercatorPos, ecefPos, morphProgress);

     RenderGraph：
       仍然按单投影处理（混合投影），不需要 Compositor 多投影合成
       （因为是渐进过渡，不是同时存在两种投影）

  4. 过渡完成后：
     切换到目标相机控制器
     FrameGraphBuilder 使用 toCamera.state
     清除 morph Uniform
```

### 3.7 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| ← 输入 | L6/MapFull.setMode() | morphTo(targetMode, fromCamera, toCamera) | 用户触发 |
| → 输出 | L3/FrameScheduler | update() 返回 blendedState | 每帧驱动 |
| → 输出 | L2/FrameGraphBuilder | blendedState.vpMatrix | 渲染使用混合矩阵 |
| → GPU | L2/ShaderAssembler | 注入 morphProgress uniform 到 VertexShader | 顶点变形 |
| → GPU | 各图层 encode() | morphProgress 传入 perObject BindGroup | 顶点 mix |
| → 事件 | InternalBus 'viewmorph:start'/'viewmorph:end'/'viewmorph:progress' | 通知 |
| ← 数据 | L0/ellipsoid | geodeticToECEF / ecefToGeodetic | 坐标系转换 |
| ← 数据 | L0/quat | slerp | 朝向插值 |

### 3.8 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| fromMode === targetMode | CONFIG_INVALID_PARAM | throw GeoForgeError（无需过渡） |
| duration ≤ 0 | — | 等效 jumpTo（立即切换） |
| 过渡期间用户交互 | — | cancel() 当前过渡，相机停在当前混合位置 |
| inverseVPMatrix 不可逆（混合矩阵退化） | — | 使用上一帧的 inverseVP + log.warn |
| 过渡期间帧率骤降（两套坐标系同时计算） | — | PerformanceManager 降级：过渡期自动降低渲染分辨率到 0.75 + 关闭后处理 |
| fromCamera 或 toCamera 为 null | CONFIG_INVALID_PARAM | throw GeoForgeError |
| 3D 顶点 ECEF 坐标未预计算 | DATA | 跳过顶点变形，直接使用目标坐标系 + log.warn |

### 3.9 常量 / ObjectPool / __DEV__ / @stability / Tree-Shaking

```typescript
// 常量
const DEFAULT_MORPH_DURATION = 2000;        // ms
const DEFAULT_MAX_ZOOM_OFFSET = 2;
const DEFAULT_PHASE1_END_2D_TO_3D = 0.4;   // Phase1 占前 40%
const DEFAULT_PHASE1_END_3D_TO_2D = 0.6;   // 反向 Phase1 占前 60%
const MIN_FOV_FOR_ORTHO = 0.0001;           // 正交投影的等效 FOV（趋近 0）

// ObjectPool
// 1. blendedState CameraState 复用（预分配对象，不池化——单例）
// 2. 临时四元数 _tempQuat：预分配 Float32Array[4]
// 3. ProjectionParams：预分配对象复用

// __DEV__
// 1. if (__DEV__) { 过渡进度日志 + 矩阵混合数值检查 }
// 2. if (__DEV__) { 参数验证（duration/fromCamera/toCamera） }

// @stability: 见 3.4 各方法标注

// Tree-Shaking
// export { createViewMorph } from './ViewMorph';
// export type { ViewMorph, ViewMorphState, ViewMorphOptions, ViewMorphAnimation, ViewMode } from './ViewMorph';
```

---

## 4. @geoforge/layer-3dtiles

### 4.1 类型依赖

```typescript
import type { Layer, LayerContext } from '@geoforge/scene';
import type { CameraState, CameraController, Vec3f, Mat4f, BBox3D, Viewport, Feature } from '@geoforge/core';
import type { BufferHandle, TextureHandle } from '@geoforge/gpu';
import type { CameraAnimation } from '@geoforge/runtime';
import type { InternalBus } from '@geoforge/core/infra/internal-bus';
import type { GeoForgeError, GeoForgeErrorCode } from '@geoforge/core/infra/errors';
```

### 4.2 Tiles3DLayerOptions

```typescript
export interface Tiles3DLayerOptions {
  /** 图层唯一 ID */
  readonly id: string;

  /**
   * tileset.json 的 URL。
   * 支持相对路径和绝对路径。
   */
  readonly url: string;

  /**
   * 最大屏幕空间误差（像素）。
   * 控制 LOD 精度：值越小加载的 tile 越精细（更多请求和内存）。
   * CesiumJS 默认 16，高质量场景建议 2~8。
   * @unit 像素
   * @range [1, 256]
   * @default 16
   */
  readonly maximumScreenSpaceError?: number;

  /**
   * GPU 内存预算（MB）。
   * 超过此值时触发 LRU 淘汰。
   * @unit MB
   * @range [64, 4096]
   * @default 512
   */
  readonly maximumMemoryUsage?: number;

  /**
   * 显示/隐藏。
   * @default true
   */
  readonly show?: boolean;

  /**
   * 模型整体缩放系数。
   * @range (0, 1000]
   * @default 1.0
   */
  readonly modelScale?: number;

  /**
   * 模型坐标偏移 [x, y, z]（米）。
   * 用于微调模型位置（如偏移到正确的地面高度）。
   * @unit 米
   * @default [0, 0, 0]
   */
  readonly modelOffset?: [number, number, number];

  /**
   * 是否投射阴影。
   * 需要 GlobeRenderer.shadows = true。
   * @default false
   */
  readonly castShadow?: boolean;

  /**
   * 是否接收阴影。
   * @default true
   */
  readonly receiveShadow?: boolean;

  /**
   * 点云模式下的点大小（像素）。
   * 仅当 tile 内容为 pnts 格式时有效。
   * @unit 像素
   * @range [0.5, 50]
   * @default 2.0
   */
  readonly pointSize?: number;

  /**
   * 3D Tiles 样式覆盖。
   * 使用 3D Tiles Styling Language（类 CSS 表达式）。
   */
  readonly style?: Tiles3DStyle;

  /**
   * 并发加载请求数上限（该图层独占的配额）。
   * @range [1, 32]
   * @default 6
   */
  readonly maxConcurrentRequests?: number;
}

/**
 * 3D Tiles Styling Language 样式。
 * 参考：https://docs.ogc.org/cs/22-025r4/22-025r4.html
 */
export interface Tiles3DStyle {
  /**
   * 颜色条件表达式。
   * string: 3D Tiles 表达式，如 "color('#ff0000')"
   * conditions: 条件列表，按顺序匹配第一个为 true 的条件
   *
   * @example
   * { conditions: [
   *   ["${height} > 100", "color('#ff0000')"],  // 高于100m 红色
   *   ["${height} > 50", "color('#ffff00')"],   // 高于50m 黄色
   *   ["true", "color('#00ff00')"],              // 其他绿色
   * ]}
   */
  readonly color?: string | { conditions: Array<[string, string]> };

  /**
   * 显示/隐藏条件。
   * string: 表达式，如 "${area} > 100"
   * boolean: true/false
   */
  readonly show?: string | boolean;

  /**
   * 点大小（点云模式）。
   * number: 固定大小
   * string: 表达式，如 "${intensity} / 10"
   */
  readonly pointSize?: number | string;
}
```

### 4.3 内部数据结构

```typescript
/**
 * tileset.json 解析后的数据结构。
 */
interface TilesetJSON {
  readonly asset: { version: string; tilesetVersion?: string };
  readonly geometricError: number;
  readonly root: TileJSON;
  readonly properties?: Record<string, { minimum: number; maximum: number }>;
}

/**
 * 单个 tile 节点（BVH 树中的节点）。
 */
interface TileJSON {
  readonly boundingVolume: BoundingVolume;
  readonly geometricError: number;
  readonly content?: { uri: string; boundingVolume?: BoundingVolume };
  readonly children?: TileJSON[];
  readonly refine?: 'ADD' | 'REPLACE';
  readonly transform?: number[];            // 4×4 列主序变换矩阵
  readonly viewerRequestVolume?: BoundingVolume;
}

/**
 * 包围体（3 种类型）。
 */
type BoundingVolume =
  | { box: number[] }      // 12 元素：center[3] + halfAxes[9]（3×3 矩阵列主序）
  | { region: number[] }   // 6 元素：[west, south, east, north, minHeight, maxHeight]（弧度+米）
  | { sphere: number[] };  // 4 元素：[centerX, centerY, centerZ, radius]

/**
 * 运行时 tile 节点（BVH 遍历用）。
 */
interface RuntimeTile {
  /** 唯一 ID */
  readonly id: string;
  /** 原始 JSON 数据 */
  readonly json: TileJSON;
  /** 世界空间包围体（应用了祖先 transform 链） */
  readonly worldBoundingVolume: BoundingVolumeComputed;
  /** 几何误差（米） */
  readonly geometricError: number;
  /** 细化模式 */
  readonly refine: 'ADD' | 'REPLACE';
  /** 累积变换矩阵（从根到此节点的 transform 链乘积） */
  readonly worldTransform: Mat4f;
  /** 父节点 */
  readonly parent: RuntimeTile | null;
  /** 子节点 */
  readonly children: RuntimeTile[];
  /** 内容 URL */
  readonly contentUri: string | null;

  // 运行时状态
  /** 内容加载状态 */
  contentState: 'unloaded' | 'loading' | 'loaded' | 'failed';
  /** GPU 渲染数据 */
  renderData: TileRenderData | null;
  /** 最后一次被渲染的帧号 */
  lastRenderedFrame: number;
  /** GPU 资源占用（字节） */
  gpuBytes: number;
  /** 上一帧计算的 SSE 值 */
  screenSpaceError: number;
  /** 在当前帧是否可见 */
  isVisible: boolean;
  /** 在当前帧是否需要细化（SSE > threshold） */
  needsRefine: boolean;
}

/**
 * 计算后的包围体（已转为世界空间，统一为 OBB + 球体双表示）。
 */
interface BoundingVolumeComputed {
  /** 中心（ECEF 米） */
  readonly center: Vec3f;
  /** OBB 半轴（3 个向量，列主序 Mat3） */
  readonly halfAxes: Float32Array;  // 9 elements
  /** 包围球半径 */
  readonly radius: number;
}

/**
 * 单个 tile 的 GPU 渲染数据。
 */
interface TileRenderData {
  /** 类型：网格 / 点云 / 实例化网格 */
  readonly type: 'mesh' | 'pointcloud' | 'instanced';
  /** 顶点缓冲 */
  readonly vertexBuffer: BufferHandle;
  /** 索引缓冲（点云无索引） */
  readonly indexBuffer: BufferHandle | null;
  /** 顶点数 */
  readonly vertexCount: number;
  /** 索引数 */
  readonly indexCount: number;
  /** 材质（PBR / Unlit） */
  readonly material: TileMaterial;
  /** 纹理列表 */
  readonly textures: TextureHandle[];
  /** 实例化矩阵缓冲（仅 i3dm） */
  readonly instanceBuffer: BufferHandle | null;
  /** 实例数 */
  readonly instanceCount: number;
  /** Batch Table（属性数据，用于样式和查询） */
  readonly batchTable: Record<string, any[]> | null;
  /** GPU 占用字节 */
  readonly gpuBytes: number;
}

/**
 * 材质信息。
 */
interface TileMaterial {
  readonly type: 'pbr' | 'unlit';
  readonly baseColor: [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly baseColorTexture: TextureHandle | null;
  readonly normalTexture: TextureHandle | null;
  readonly emissiveTexture: TextureHandle | null;
  readonly doubleSided: boolean;
  readonly alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff: number;
}
```

### 4.4 Tiles3DLayer 公共接口

```typescript
export interface Tiles3DLayer extends Layer {
  // ═══════════════════════════════════════
  // 状态
  // ═══════════════════════════════════════

  /** tileset 是否加载完成（tileset.json 解析 + 根 tile 加载）@stability stable */
  readonly isReady: boolean;

  /** 当前已加载到 GPU 的 tile 数量 @stability stable */
  readonly loadedTileCount: number;

  /** 当前帧渲染的 tile 数量 @stability stable */
  readonly renderedTileCount: number;

  /** 当前 GPU 内存使用（字节） @stability stable */
  readonly gpuMemoryUsage: number;

  /** BVH 树总节点数 @stability experimental */
  readonly totalTileCount: number;

  // ═══════════════════════════════════════
  // 配置
  // ═══════════════════════════════════════

  /**
   * @stability stable
   */
  setMaximumScreenSpaceError(value: number): void;

  /**
   * @stability stable
   */
  setMaximumMemoryUsage(mb: number): void;

  /**
   * @stability stable
   */
  setModelScale(scale: number): void;

  /**
   * @stability stable
   */
  setModelOffset(offset: [number, number, number]): void;

  /**
   * @stability experimental
   */
  setStyle(style: Tiles3DStyle): void;

  // ═══════════════════════════════════════
  // 查询
  // ═══════════════════════════════════════

  /**
   * 获取 tileset 的包围体。
   * 返回根 tile 的 OBB（center + halfAxes）。
   *
   * @returns { center: Vec3f, halfAxes: Mat4f } 或 null（未加载时）
   *
   * @stability experimental
   */
  getBoundingVolume(): { center: Vec3f; halfAxes: Float32Array } | null;

  /**
   * 飞行到 tileset 的最佳视角。
   * 计算一个能看到整个 tileset 的相机位置。
   *
   * @stability experimental
   *
   * 算法：
   *   1. 获取根 tile 包围球 (center, radius)
   *   2. 计算最佳距离 = radius / sin(fov/2) * 1.5（乘 1.5 留边距）
   *   3. 计算相机位置 = center + surfaceNormal * distance
   *   4. camera.flyToPosition(pos, { bearing:0, pitch:-45° })
   */
  flyTo(camera: CameraController, options?: { duration?: number }): CameraAnimation;

  // ═══════════════════════════════════════
  // 事件
  // ═══════════════════════════════════════

  /** tileset.json 加载解析完成 @stability stable */
  onReady(callback: () => void): () => void;

  /** 单个 tile 内容加载完成 @stability experimental */
  onTileLoaded(callback: (tileUrl: string) => void): () => void;

  /** 所有可见 tile 加载完成 @stability experimental */
  onAllTilesLoaded(callback: () => void): () => void;

  // ═══════════════════════════════════════
  // Layer 生命周期
  // ═══════════════════════════════════════

  /**
   * onAdd 步骤：
   *   1. fetch(url) → 解析 tileset.json → 构建 BVH 树
   *   2. 递归处理 transform 链（每个节点的 worldTransform = parent.worldTransform × node.transform）
   *   3. 计算每个节点的 worldBoundingVolume
   *   4. 编译 Shader：
   *      PBR mesh: { projection:'globe', geometry:'mesh', style:'pbr', features:['splitDouble'] }
   *      Point cloud: { projection:'globe', geometry:'point', style:'pointcloud', features:['splitDouble'] }
   *   5. 创建 Pipeline（PBR + Unlit + PointCloud，共 3 种）
   *   6. InternalBus.emit('3dtiles:ready', { layerId, tileCount })
   *
   * @stability stable
   */
  onAdd(context: LayerContext): void;

  /**
   * onUpdate 步骤（每帧）：
   *   1. BVH 遍历（见 4.5）→ 确定 toRender[] + toLoad[] + toUnload[]
   *   2. 对 toLoad[]：提交到 RequestScheduler → fetch → Worker 解码
   *   3. 对 toUnload[]：释放 GPU 资源
   *   4. 内存管理（见 4.6）
   *   5. 更新样式 Uniform（如果 style 有变化）
   *
   * @stability stable
   */
  onUpdate(deltaTime: number, camera: CameraState): void;

  /**
   * encode 步骤：
   *   for each tile in toRender[]:
   *     if (tile.renderData === null) continue  // 还在加载
   *     setPipeline(tile.renderData.type === 'mesh' ? meshPipeline : pointPipeline)
   *     setVertexBuffer(0, tile.renderData.vertexBuffer)
   *     if (tile.renderData.indexBuffer) setIndexBuffer(tile.renderData.indexBuffer, 'uint32')
   *     setBindGroup(0, perFrame)
   *     setBindGroup(1, perLayer)               // style uniform
   *     setBindGroup(2, perTile)                // tile.worldTransform + RTC center
   *     setBindGroup(3, tile.renderData.textures + sampler)
   *     if (tile.renderData.indexBuffer) drawIndexed(indexCount, instanceCount)
   *     else draw(vertexCount, instanceCount)
   *
   * @stability stable
   */
  encode(encoder: GPURenderPassEncoder, camera: CameraState): void;

  /**
   * 阴影 Pass 编码（如果 castShadow=true）。
   * 使用简化 Shader（仅输出深度，不计算材质）。
   *
   * @stability experimental
   */
  encodeShadow?(encoder: GPURenderPassEncoder, lightVPMatrix: Mat4f): void;
}

export function createTiles3DLayer(options: Tiles3DLayerOptions): Tiles3DLayer;
```

### 4.5 BVH 遍历算法详细步骤

```
每帧 onUpdate 中执行 BVH 遍历，确定哪些 tile 需要渲染/加载/卸载。

═══ 输入 ═══
  camera: CameraState（vpMatrix, position, viewport）
  maximumScreenSpaceError: number
  根节点: root RuntimeTile

═══ 遍历算法（深度优先）═══

function traverseBVH(tile: RuntimeTile, camera, viewport):
  // 1. 视锥剔除
  if (!frustumIntersects(camera.vpMatrix, tile.worldBoundingVolume)) {
    tile.isVisible = false
    return  // 不可见，跳过整个子树
  }
  tile.isVisible = true

  // 2. 计算 Screen Space Error (SSE)
  //    SSE = tile.geometricError / distanceToCamera * viewport.height / (2 * tan(fov/2))
  //
  //    其中：
  //      distanceToCamera = distance(tile.worldBoundingVolume.center, camera.position)
  //      不能简单用欧氏距离——需要用包围体到相机的最近距离：
  //      dist = max(0, distance(camera.position, tile.boundingVolume.center) - tile.boundingVolume.radius)
  //      如果相机在包围体内部 → dist = 0 → SSE = Infinity → 始终细化
  //
  //    SSE 物理含义：该 tile 的几何误差投影到屏幕上是多少像素。
  //    如果 SSE > maximumScreenSpaceError，说明精度不够，需要加载子 tile。
  tile.screenSpaceError = computeSSE(tile.geometricError, distanceToCamera, viewport, camera.fov)

  // 3. 决定是否细化
  tile.needsRefine = tile.screenSpaceError > maximumScreenSpaceError && tile.children.length > 0

  // 4. 细化模式处理
  if (tile.refine === 'REPLACE') {
    // REPLACE：子 tile 替换父 tile
    if (tile.needsRefine) {
      // 检查所有子 tile 是否已加载
      allChildrenLoaded = tile.children.every(c => c.contentState === 'loaded')
      if (allChildrenLoaded) {
        // 使用子 tile，不渲染父 tile
        for each child in tile.children:
          traverseBVH(child, camera, viewport)
      } else {
        // 子 tile 未全部加载，暂时渲染父 tile + 请求加载子 tile
        toRender.push(tile)
        for each child in tile.children:
          if (child.contentState === 'unloaded')
            toLoad.push(child)
          traverseBVH(child, camera, viewport)
      }
    } else {
      // 精度足够，渲染当前 tile
      toRender.push(tile)
    }
  } else { // 'ADD'
    // ADD：父子 tile 同时渲染（叠加）
    toRender.push(tile)
    if (tile.needsRefine) {
      for each child in tile.children:
        traverseBVH(child, camera, viewport)
    }
  }

═══ SSE 计算公式 ═══

  function computeSSE(geometricError, distanceToCamera, viewport, fov):
    if (distanceToCamera < 0.001) return Infinity  // 相机在 tile 内部
    // 将几何误差（米）投影到屏幕像素
    // 公式推导：geometricError / distance = tanθ
    //           screenPixels = tanθ * viewport.height / (2 * tan(fov/2))
    sseFactor = viewport.height / (2 * Math.tan(fov / 2))
    return geometricError / distanceToCamera * sseFactor

═══ 输出 ═══
  toRender: RuntimeTile[]  — 需要在 encode() 中渲染的 tile 列表
  toLoad:   RuntimeTile[]  — 需要加载内容的 tile 列表（按 SSE 降序排列 = 优先加载误差最大的）
  toUnload: RuntimeTile[]  — 可以卸载的 tile（内存超预算时，按 LRU 排序）
```

### 4.6 内存管理算法

```
每帧 onUpdate 末尾执行内存检查：

  currentUsage = sum(tile.gpuBytes for all loaded tiles)

  if (currentUsage > maximumMemoryUsage * 1024 * 1024) {
    // 需要淘汰

    // 1. 收集候选淘汰 tile
    candidates = allLoadedTiles
      .filter(t => !t.isVisible && t.contentState === 'loaded')
      // 不淘汰当前帧可见的 tile

    // 2. 按优先级排序（优先淘汰价值低的）
    candidates.sort((a, b) => {
      // 屏幕占比小的优先淘汰
      if (a.screenSpaceError !== b.screenSpaceError)
        return a.screenSpaceError - b.screenSpaceError  // SSE 小的先淘汰
      // 最久未渲染的优先淘汰
      return a.lastRenderedFrame - b.lastRenderedFrame   // 帧号小的先淘汰
    })

    // 3. 逐个淘汰直到内存回到预算内
    for each candidate in candidates:
      if (currentUsage <= maximumMemoryUsage * 1024 * 1024 * 0.9)  // 淘汰到 90%
        break
      unloadTile(candidate)
      currentUsage -= candidate.gpuBytes
  }

  function unloadTile(tile):
    if (tile.renderData === null) return
    for each texture in tile.renderData.textures:
      TextureManager.release(texture)          // via L1
    BufferPool.release(tile.renderData.vertexBuffer)  // via L1
    if (tile.renderData.indexBuffer)
      BufferPool.release(tile.renderData.indexBuffer)
    if (tile.renderData.instanceBuffer)
      BufferPool.release(tile.renderData.instanceBuffer)
    tile.renderData = null
    tile.contentState = 'unloaded'
    tile.gpuBytes = 0
```

### 4.7 glTF 解码管线（Worker: 'tiles3d-bvh'）

```
内容加载触发：
  RequestScheduler.schedule({ url: tile.contentUri, priority: 'high' })
  → fetch → ArrayBuffer
  → WorkerPool.submit({ type: 'tiles3d-bvh', input: { buffer, format } })

Worker 内部：

═══ 格式检测 ═══
  magic = readUint32(buffer, 0)
  if (magic === 0x62336474) → b3dm（Batched 3D Model）
  if (magic === 0x69336474) → i3dm（Instanced 3D Model）
  if (magic === 0x736E7470) → pnts（Point Cloud）
  if (magic === 0x46546C67) → glb（glTF Binary）

═══ b3dm 解析 ═══
  1. 读取 header（28 字节）
  2. 读取 Feature Table（批次属性元数据）
  3. 读取 Batch Table（批次属性数据）
  4. 读取 glb（嵌入的 glTF Binary）
  5. 解析 glb（见下）
  6. 将 Batch Table 属性映射到每个三角形（用于 picking 和样式）

═══ pnts 解析 ═══
  1. 读取 header
  2. 读取 Feature Table：
     POSITION: Float32Array[N*3]（必需）
     POSITION_QUANTIZED: Uint16Array[N*3]（量化版本，需要 QUANTIZED_VOLUME_OFFSET/SCALE 解码）
     RGB: Uint8Array[N*3]（可选颜色）
     RGBA: Uint8Array[N*4]
     NORMAL: Float32Array[N*3]（可选法线）
     BATCH_ID: Uint16Array[N]（可选分类）
  3. 解量化（如果使用 POSITION_QUANTIZED）：
     position[i] = quantized[i] / 65535 * scale + offset
  4. 输出：Float32Array[N * stride]（position + color + normal）

═══ glb 解析 ═══
  1. 读取 glb header（12 字节）：magic, version, length
  2. 读取 JSON chunk → meshes, accessors, bufferViews, materials, textures, images
  3. 读取 BIN chunk → binary data
  4. 对每个 mesh.primitive：
     a. 提取顶点属性：
        POSITION:   accessor → bufferView → Float32Array
        NORMAL:     accessor → bufferView → Float32Array
        TEXCOORD_0: accessor → bufferView → Float32Array
        COLOR_0:    accessor → bufferView → (Float32Array 或 Uint8Array)
     b. 提取索引：
        indices: accessor → bufferView → (Uint16Array 或 Uint32Array)
     c. 坐标转换：
        顶点位置应用 tile.worldTransform
        对 ECEF 坐标使用 Split-Double：
          rtcCenter = tile.worldBoundingVolume.center
          posHigh[i] = splitHigh(worldPos[i] - rtcCenter)
          posLow[i]  = splitLow(worldPos[i] - rtcCenter)
  5. 提取材质：
     baseColorFactor, metallicFactor, roughnessFactor, emissiveFactor
     baseColorTexture, normalTexture, emissiveTexture → ImageBitmap
  6. 输出：
     vertices: Float32Array（多属性交错）
     indices: Uint32Array
     material: TileMaterial
     textures: ImageBitmap[]
     transferables: [vertices.buffer, indices.buffer, ...]
```

### 4.8 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| ← 数据 | L3/RequestScheduler | schedule({ url, priority }) | 内容下载 |
| ← 数据 | L3/WorkerPool('tiles3d-bvh') | glTF/b3dm/pnts 解码 | Worker 端 |
| → GPU | L1/GPUUploader.uploadFromTransferable | 顶点/索引/实例缓冲 | 禁止 device.create* |
| → GPU | L1/GPUUploader.uploadTexture | 材质纹理 | |
| → GPU | L1/TextureManager/BufferPool | 资源释放（淘汰时） | |
| → GPU | L2/ShaderAssembler | pbr/unlit/pointcloud Shader 组合 | |
| → GPU | L2/PipelineCache | 3 种 Pipeline（PBR/Unlit/PointCloud） | |
| → GPU | L0/precision/split-double | ECEF 坐标精度处理 | |
| → 阴影 | GlobeRenderer.encodeShadowPass | encodeShadow() 被调用 | 如果 castShadow |
| → 事件 | InternalBus '3dtiles:ready'/'3dtiles:tile-loaded'/'3dtiles:all-loaded' | |
| → 查询 | PickingEngine.registerLayer | Batch Table 属性查询 | Color-ID picking |

### 4.9 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| tileset.json 加载失败 | DATA_TILE_LOAD | ErrorRecovery 重试 3 次，最终 throw |
| tileset.json 解析失败（格式错误） | DATA_TILE_DECODE | throw GeoForgeError 附带 URL |
| tile 内容加载失败 | DATA_TILE_LOAD | 标记 contentState='failed'，不重试（可能是 404） |
| glb 解析失败（损坏的文件） | DATA_TILE_DECODE | 跳过该 tile + log.warn |
| GPU OOM（上传 tile 内容时） | GPU_BUFFER_OOM | 触发紧急淘汰 → 重试一次 |
| Worker 超时（>30s） | WORKER_TIMEOUT | 取消该 tile 加载 + log.warn |
| BoundingVolume 类型不支持 | — | 退化为包围球 + log.warn |
| transform 矩阵退化（不可逆） | — | 使用 identity + log.warn |
| maximumScreenSpaceError 超范围 | CONFIG_INVALID_PARAM | clamp [1, 256] + if(__DEV__) warn |
| 持续帧率低于目标 | — | PerformanceManager 降级链：增大 SSE(16→32→64) → 降低 maxMemory → 关闭阴影投射 |

### 4.10 常量 / ObjectPool / __DEV__ / Tree-Shaking

```typescript
// 常量
const DEFAULT_MAX_SSE = 16;                      // 像素
const DEFAULT_MAX_MEMORY_MB = 512;               // MB
const DEFAULT_POINT_SIZE = 2.0;                  // 像素
const DEFAULT_MAX_CONCURRENT = 6;
const B3DM_MAGIC = 0x62336474;
const I3DM_MAGIC = 0x69336474;
const PNTS_MAGIC = 0x736E7470;
const GLB_MAGIC = 0x46546C67;
const MEMORY_EVICT_TARGET = 0.9;                 // 淘汰到预算的 90%
const MAX_TILE_LOAD_TIME_MS = 30000;             // Worker 超时
const MIN_SSE = 1;
const MAX_SSE = 256;

// ObjectPool
// 1. BVH 遍历中的 toRender/toLoad/toUnload 数组：预分配固定容量数组复用
//    toRenderPool = new Array(1024), toRenderCount = 0
// 2. SSE 计算中的临时向量：预分配 _tempVec3
// 3. UniformWriter 池化

// __DEV__
// 1. if (__DEV__) { BVH 遍历统计：traversed/culled/loaded/rendered 数量 }
// 2. if (__DEV__) { 内存淘汰日志：evicted ${count} tiles, freed ${mb}MB }
// 3. if (__DEV__) { glb 解析耗时日志 }
// 4. if (__DEV__) { maximumScreenSpaceError/maximumMemoryUsage 范围验证 }

// Tree-Shaking
// export { createTiles3DLayer } from './Tiles3DLayer';
// export type { Tiles3DLayer, Tiles3DLayerOptions, Tiles3DStyle } from './Tiles3DLayer';
```

---

## P1 完整统计

| 包 | 公共方法 | 内部结构 | WGSL 模块 | 对接模块 | 错误场景 | 常量 | 算法步骤 |
|---|---------|---------|----------|---------|---------|------|---------|
| layer-terrain | 10 | 3 struct | terrain_mesh + terrain_lit | 10 个 | 8 种 | 12 | DEM 解码 8 步 + LOD 约束 + Morphing |
| globe | 20 | 4 struct | globe + atmo + sky + shadow | 9 个 | 5 种 | 18 | 大气 LUT 3 步 + CSM 4 步 + 太阳位置 |
| view-morph | 8 | 2 struct | morphProgress uniform | 7 个 | 6 种 | 5 | 5 种过渡路径 + RenderGraph 处理 |
| layer-3dtiles | 12 | 6 struct | pbr + unlit + pointcloud | 10 个 | 9 种 | 12 | BVH 遍历 + 内存淘汰 + glTF 解析 |
| **合计** | **50** | **15 struct** | **10 WGSL** | | **28 种** | **47** | |
