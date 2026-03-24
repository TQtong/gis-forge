# GeoForge 可选功能包完整接口设计 — P0 相机包（camera-2d / camera-25d / camera-3d）

> **完整版**：每个接口的每个字段、每个方法的每个参数、每种错误情况、每个对接点全部展开。

---

## 1. @geoforge/camera-2d

### 1.1 类型依赖

```typescript
import type { Mat4f, Vec3f, BBox2D, Viewport, CameraState } from '@geoforge/core';
import type { CameraController, CameraAnimation, CameraConstraints } from '@geoforge/runtime';
import type { InternalBus } from '@geoforge/core/infra/internal-bus';
import { mat4, vec3 } from '@geoforge/core/math';
import { mapSize, lngLatToMerc, mercToLngLat } from '@geoforge/core/geo/mercator';
import { lerp as lerpScalar } from '@geoforge/core/math/interpolate';
```

### 1.2 Camera2DOptions — 创建配置

```typescript
export interface Camera2DOptions {
  /**
   * 初始中心坐标。
   * @type [longitude, latitude] 度
   * @range longitude: [-180, 180], latitude: [-85.051129, 85.051129]（墨卡托极限）
   * @default [0, 0]
   */
  readonly center?: [number, number];

  /**
   * 初始缩放级别。
   * 0 = 全球视图，18 = 街道级别，22 = 建筑级别。
   * @range [minZoom, maxZoom]
   * @default 1
   */
  readonly zoom?: number;

  /**
   * 最小缩放级别。用户无法 zoom out 到此值以下。
   * @range [0, maxZoom]
   * @default 0
   */
  readonly minZoom?: number;

  /**
   * 最大缩放级别。用户无法 zoom in 到此值以上。
   * @range [minZoom, 22]
   * @default 22
   */
  readonly maxZoom?: number;

  /**
   * 可视范围约束。设置后用户无法 pan 到此范围之外。
   * 当 viewport 覆盖的地理范围大于 maxBounds 时，center 被限制在 bounds 内。
   * @default undefined（无限制）
   */
  readonly maxBounds?: BBox2D;

  /**
   * 惯性动画开关。
   * 启用后，用户松手时地图会根据滑动速度继续滑动一段距离。
   * @default true
   */
  readonly inertia?: boolean;

  /**
   * 惯性衰减系数。每帧速度乘以此值。
   * 0.9 = 缓慢停止，0.7 = 快速停止。
   * @range (0, 1)
   * @default 0.85
   */
  readonly inertiaDecay?: number;

  /**
   * 惯性速度采样帧数。
   * 取最近 N 次 panMove 的位移计算平均速度，作为松手后的初始惯性速度。
   * 值越大越平滑，但延迟越高。
   * @range [1, 20]
   * @default 5
   */
  readonly inertiaSampleFrames?: number;

  /**
   * 最大惯性速度（像素/秒）。
   * 限制惯性初始速度的上限，防止快速甩动导致地图飞出视野。
   * @unit 像素/秒
   * @range [0, Infinity]
   * @default 4000
   */
  readonly maxInertiaVelocity?: number;
}
```

### 1.3 内部数据结构

```typescript
/**
 * 惯性速度采样点。
 * 每次 handlePanMove 时记录一个样本到环形缓冲区。
 * handlePanEnd 时取最近 N 个样本计算平均速度。
 */
interface InertiaSample {
  /** X 方向屏幕位移，单位：CSS 像素 */
  readonly dx: number;
  /** Y 方向屏幕位移，单位：CSS 像素 */
  readonly dy: number;
  /** 采样时间戳，单位：毫秒（performance.now()） */
  readonly time: number;
}

/**
 * 相机动画内部状态。
 * flyTo / easeTo 创建此对象，update() 中每帧推进。
 */
interface AnimationState {
  /** 唯一 ID（递增计数器生成） */
  readonly id: string;
  /** 起始中心 [lon, lat] */
  readonly fromCenter: [number, number];
  /** 目标中心 [lon, lat] */
  readonly toCenter: [number, number];
  /** 起始缩放 */
  readonly fromZoom: number;
  /** 目标缩放 */
  readonly toZoom: number;
  /** 总时长（毫秒） */
  readonly duration: number;
  /** 缓动函数 (t: 0~1) → 0~1 */
  readonly easing: (t: number) => number;
  /**
   * flyTo 模式下的峰值缩放（鸟瞰弧线的最高点）。
   * easeTo 模式下为 null（线性插值无弧线）。
   */
  readonly peakZoom: number | null;
  /** 已经过的时间（毫秒），每帧累加 deltaTime */
  elapsed: number;
  /** 动画运行状态 */
  state: 'running' | 'finished' | 'cancelled';
  /** Promise resolve 回调（动画完成时调用） */
  resolve: () => void;
  /** Promise reject 回调（动画取消时调用） */
  reject: (reason: string) => void;
}
```

### 1.4 预分配资源

```typescript
/**
 * 每帧 update() 需要计算 4 个矩阵和 2 个向量。
 * 全部预分配为模块级变量，避免每帧 new Float32Array。
 *
 * 注意：这些是 Camera2D 模块级单例。如果同时存在多个 Camera2D 实例，
 * 它们会共享这些缓冲——在单帧内同时 update 多个实例是不安全的。
 * 当前设计下引擎只有一个活跃相机，所以是安全的。
 */
const _viewMatrix: Mat4f = mat4.create();    // 16 × Float32 = 64 字节
const _projMatrix: Mat4f = mat4.create();
const _vpMatrix: Mat4f = mat4.create();
const _inverseVP: Mat4f = mat4.create();
const _eye: Vec3f = vec3.create();           // 3 × Float32 = 12 字节
const _target: Vec3f = vec3.create();
const _up: Vec3f = vec3.create(0, 1, 0);
```

### 1.5 Camera2D 公共接口

```typescript
export interface Camera2D extends CameraController {
  readonly type: '2d';

  // ═══════════════════════════════════════
  // 状态访问
  // ═══════════════════════════════════════

  /**
   * 获取当前相机状态快照。
   *
   * 返回的对象是复用的——下次 update() 会覆盖其内容。
   * 如需长期持有，必须深拷贝。
   *
   * 矩阵字段（viewMatrix/projectionMatrix/vpMatrix/inverseVPMatrix）
   * 指向预分配的 Float32Array，每帧 update 时被重写。
   */
  readonly state: CameraState;

  /** 当前是否有 flyTo/easeTo 动画在运行 */
  readonly isAnimating: boolean;

  /** 当前是否有惯性滑动在进行 */
  readonly isInertiaActive: boolean;

  /** 当前是否在被用户拖拽（panStart 到 panEnd 之间） */
  readonly isPanning: boolean;

  /** 当前是否在移动（panning || animating || inertia） */
  readonly isMoving: boolean;

  /** 惯性是否启用 */
  readonly inertiaEnabled: boolean;

  /** 当前约束配置 */
  readonly constraints: CameraConstraints;

  // ═══════════════════════════════════════
  // 视图控制（立即生效，无动画）
  // ═══════════════════════════════════════

  /**
   * 设置中心坐标。
   * 如果设置了 maxBounds，坐标会被约束在范围内。
   *
   * @param center - [longitude, latitude] 度
   * @throws GeoForgeError(CONFIG) 如果 center 包含 NaN 或 Infinity
   */
  setCenter(center: [number, number]): void;

  /**
   * 设置缩放级别。
   * 值会被 clamp 到 [minZoom, maxZoom] 范围。
   * zoom 变化后会重新应用 maxBounds 约束（因为可视范围变了）。
   *
   * @param zoom - 目标缩放级别
   * @throws GeoForgeError(CONFIG) 如果 zoom 是 NaN
   */
  setZoom(zoom: number): void;

  /**
   * 2D 模式下空操作。保留以满足 CameraController 接口。
   * 调用不报错但不产生任何效果。
   */
  setBearing(bearing: number): void;

  /**
   * 2D 模式下空操作。保留以满足 CameraController 接口。
   */
  setPitch(pitch: number): void;

  /**
   * 批量设置视图参数。
   * 一次性更新，内部只触发一次约束检查和矩阵重算。
   * 会取消正在运行的动画和惯性。
   *
   * @param options - center/zoom（bearing/pitch 在 2D 下忽略）
   */
  jumpTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;  // 忽略
    pitch?: number;    // 忽略
  }): void;

  // ═══════════════════════════════════════
  // 动画导航
  // ═══════════════════════════════════════

  /**
   * 飞行到目标视图。
   *
   * 使用鸟瞰弧线：先 zoom out 到一个峰值 zoom（可以看到起点和终点），
   * 再 zoom in 到目标 zoom。距离越远弧线越高。
   *
   * 飞行期间用户交互（pan/zoom）会取消飞行。
   *
   * @param options.center - 目标中心 [lon, lat]，默认保持当前
   * @param options.zoom - 目标缩放，默认保持当前
   * @param options.bearing - 忽略（2D）
   * @param options.pitch - 忽略（2D）
   * @param options.altitude - 忽略（2D）
   * @param options.duration - 飞行时长（毫秒），默认 1500
   * @param options.easing - 缓动函数，默认 ease-in-out-cubic
   * @returns CameraAnimation 对象（含 finished Promise 和 cancel 方法）
   *
   * 飞行弧线算法：
   *   1. 计算起点和终点的墨卡托距离 d
   *   2. peakZoom = min(fromZoom, toZoom) - log2(d / screenDiagonal) - 1
   *   3. peakZoom = clamp(peakZoom, minZoom, min(fromZoom, toZoom) - 0.5)
   *   4. 每帧 t ∈ [0,1]：
   *      zoom(t) = t < 0.5
   *        ? lerp(fromZoom, peakZoom, easing(t*2))
   *        : lerp(peakZoom, toZoom, easing((t-0.5)*2))
   *      center(t) = lerp(fromCenter, toCenter, easing(t))
   */
  flyTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    altitude?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation;

  /**
   * 平滑过渡到目标视图。
   *
   * 与 flyTo 的区别：
   *   - 无鸟瞰弧线，center 和 zoom 独立线性插值
   *   - 适合短距离移动（如点击地图某处居中）
   *   - 默认时长更短（500ms vs 1500ms）
   *
   * @param options - 同 flyTo，duration 默认 500
   * @returns CameraAnimation
   *
   * 算法：
   *   每帧 t ∈ [0,1]：
   *     center(t) = lerp(fromCenter, toCenter, easing(t))
   *     zoom(t) = lerp(fromZoom, toZoom, easing(t))
   */
  easeTo(options: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    easing?: (t: number) => number;
  }): CameraAnimation;

  /**
   * 停止当前动画和惯性。
   * 相机停在当前位置。
   * 如果有动画 Promise，状态变为 'cancelled'，reject 被调用。
   */
  stop(): void;

  // ═══════════════════════════════════════
  // 约束
  // ═══════════════════════════════════════

  /**
   * 更新约束配置。
   * 合并传入的字段到现有约束。
   * 更新后立即应用新约束（可能导致 zoom/center 变化）。
   *
   * @param constraints - 要更新的约束字段
   */
  setConstraints(constraints: Partial<CameraConstraints>): void;

  /**
   * 开关惯性动画。
   */
  setInertiaEnabled(enabled: boolean): void;

  // ═══════════════════════════════════════
  // 每帧更新
  // ═══════════════════════════════════════

  /**
   * 每帧由 FrameScheduler 调用。
   * 执行顺序：
   *   1. 推进动画（如果有 flyTo/easeTo 在运行）
   *   2. 推进惯性（如果松手后有惯性速度）
   *   3. 应用约束（maxBounds）
   *   4. 计算投影矩阵（mat4.ortho）
   *   5. 计算视图矩阵（mat4.lookAt）
   *   6. 计算 VP 矩阵和逆 VP 矩阵
   *   7. 更新 CameraState 快照
   *   8. 触发 move 事件（如果位置有变化）
   *   9. 检测 moveStart/moveEnd 边界
   *
   * @param deltaTime - 上一帧耗时（秒）
   * @param viewport - 当前视口尺寸
   * @returns 更新后的 CameraState（复用对象）
   *
   * 矩阵计算：
   *   worldSize = 512 * 2^zoom（墨卡托世界尺寸，像素）
   *   halfW = viewport.width / 2
   *   halfH = viewport.height / 2
   *
   *   投影：mat4.ortho(-halfW, halfW, -halfH, halfH, -1, 1)
   *   注意：使用 Reversed-Z 正交变体（near=-1 映射到 depth=1，far=1 映射到 depth=0）
   *
   *   中心墨卡托坐标：[mercX, mercY] = lngLatToMerc(center[0], center[1])
   *   像素坐标：[px, py] = [mercX * worldSize, mercY * worldSize]
   *
   *   视图：mat4.lookAt(
   *     eye    = [px, py, 1],     // 相机在地图正上方
   *     target = [px, py, 0],     // 看向地图表面
   *     up     = [0, 1, 0]
   *   )
   *
   *   VP = projMatrix × viewMatrix
   *   inverseVP = invert(VP)
   *
   *   altitude = 地球周长 / (2^zoom × tileSize × cos(lat))
   */
  update(deltaTime: number, viewport: Viewport): CameraState;

  // ═══════════════════════════════════════
  // 输入处理（由 InteractionManager 调用）
  // ═══════════════════════════════════════

  /**
   * Pan 开始（用户按下鼠标/手指触摸）。
   * 记录起始屏幕坐标和当前 center，取消动画。
   *
   * @param screenX - CSS 像素 X
   * @param screenY - CSS 像素 Y
   *
   * 副作用：
   *   - 取消正在运行的 flyTo/easeTo 动画
   *   - 停止惯性滑动
   *   - 设置 isPanning = true
   *   - 记录 panStartScreen、panStartCenter
   *   - 清空惯性采样队列
   *   - 通过 InternalBus emit 'camera:changed'
   */
  handlePanStart(screenX: number, screenY: number): void;

  /**
   * Pan 移动（用户拖动鼠标/手指滑动）。
   * 根据屏幕位移计算新的 center。
   *
   * @param screenX - 当前 CSS 像素 X
   * @param screenY - 当前 CSS 像素 Y
   *
   * 算法：
   *   dx = screenX - panStartScreen.x（CSS 像素位移）
   *   dy = screenY - panStartScreen.y
   *   worldSize = 512 * 2^zoom
   *   mercDx = -dx / worldSize（屏幕右移 → 地图左移 → 中心向右偏移）
   *   mercDy = +dy / worldSize（屏幕下移 → 地图上移 → 中心向下偏移，注意 Y 轴方向）
   *   newMercX = startMerc.x + mercDx
   *   newMercY = startMerc.y + mercDy
   *   newCenter = mercToLngLat(newMercX, newMercY)
   *
   * 副作用：
   *   - 更新 _center
   *   - 记录惯性采样点 { dx: screenX - prevScreenX, dy: screenY - prevScreenY, time: now }
   *   - 应用 maxBounds 约束
   */
  handlePanMove(screenX: number, screenY: number): void;

  /**
   * Pan 结束（用户松开鼠标/手指抬起）。
   * 计算惯性初始速度，启动惯性滑动。
   *
   * 惯性速度计算算法：
   *   1. 取最近 inertiaSampleFrames 个采样点
   *   2. 计算总位移 totalDx, totalDy 和总时间 totalTime
   *   3. 如果 totalTime < 10ms（太快可能是误操作），不启动惯性
   *   4. velocityX = totalDx / totalTime * 1000（像素/秒）
   *   5. velocityY = totalDy / totalTime * 1000
   *   6. speed = sqrt(vx² + vy²)
   *   7. 如果 speed > maxInertiaVelocity，等比缩放到 maxInertiaVelocity
   *   8. 如果 speed < 50（像素/秒），不启动惯性（速度太低）
   *   9. 设置 inertiaVelocity = [vx, vy]，isInertiaActive = true
   *
   * 副作用：
   *   - isPanning = false
   *   - 可能启动惯性（isInertiaActive = true）
   */
  handlePanEnd(): void;

  /**
   * 缩放（鼠标滚轮/双指缩放）。
   * 以屏幕某点为锚点缩放。
   *
   * @param delta - 缩放增量（正值 zoom in，负值 zoom out），通常 ±1
   * @param screenX - 锚点 CSS 像素 X
   * @param screenY - 锚点 CSS 像素 Y
   *
   * 算法（锚点缩放——缩放后锚点下的地理位置不变）：
   *   1. anchorLngLat = screenToLngLat(screenX, screenY)  // 锚点的当前地理坐标
   *   2. newZoom = clamp(zoom + delta * 0.5, minZoom, maxZoom)
   *   3. 临时 center = anchorLngLat
   *   4. 根据 newZoom 计算新的 viewport 覆盖范围
   *   5. 调整 center 使 anchorLngLat 仍然在 (screenX, screenY) 位置：
   *      offsetX = (screenX - viewport.width/2) / (worldSize(newZoom))
   *      offsetY = (viewport.height/2 - screenY) / (worldSize(newZoom))
   *      newCenter = [anchorLng - offsetX * 360, anchorLat - offsetY * 180]（简化）
   *   6. 应用 maxBounds 约束
   *   7. 更新 zoom 和 center
   *
   * 副作用：
   *   - 取消动画
   *   - 停止惯性
   *   - 更新 _zoom 和 _center
   */
  handleZoom(delta: number, screenX: number, screenY: number): void;

  /**
   * 旋转（2D 模式下空操作）。
   */
  handleRotate(bearingDelta: number, pitchDelta: number): void;

  // ═══════════════════════════════════════
  // 2D 特有方法
  // ═══════════════════════════════════════

  /**
   * 获取当前可视的地理范围。
   * 基于 viewport 和 zoom 计算。
   *
   * @returns 当前可视的 BBox2D
   *
   * 算法：
   *   worldSize = 512 * 2^zoom
   *   halfWMerc = viewport.width / 2 / worldSize   // 视口半宽的墨卡托单位
   *   halfHMerc = viewport.height / 2 / worldSize
   *   centerMerc = lngLatToMerc(center)
   *   west  = mercToLng(centerMerc.x - halfWMerc)
   *   east  = mercToLng(centerMerc.x + halfWMerc)
   *   south = mercToLat(centerMerc.y + halfHMerc)  // 注意 Y 轴方向
   *   north = mercToLat(centerMerc.y - halfHMerc)
   */
  getVisibleBounds(): BBox2D;

  /**
   * 屏幕坐标 → 地理坐标。
   *
   * @param screenX - CSS 像素 X
   * @param screenY - CSS 像素 Y
   * @returns [lon, lat] 或 null（如果 viewport 未初始化）
   *
   * 算法：
   *   ndcX = (screenX / viewport.width) * 2 - 1
   *   ndcY = 1 - (screenY / viewport.height) * 2
   *   worldPos = inverseVPMatrix × [ndcX, ndcY, 0, 1]
   *   lngLat = mercToLngLat(worldPos.x / worldSize, worldPos.y / worldSize)
   */
  screenToLngLat(screenX: number, screenY: number): [number, number] | null;

  /**
   * 地理坐标 → 屏幕坐标。
   *
   * @param lon - 经度（度）
   * @param lat - 纬度（度）
   * @returns [screenX, screenY] CSS 像素
   *
   * 算法：
   *   merc = lngLatToMerc(lon, lat)
   *   worldPos = [merc.x * worldSize, merc.y * worldSize, 0, 1]
   *   clipPos = vpMatrix × worldPos
   *   ndcX = clipPos.x / clipPos.w
   *   ndcY = clipPos.y / clipPos.w
   *   screenX = (ndcX + 1) / 2 * viewport.width
   *   screenY = (1 - ndcY) / 2 * viewport.height
   */
  lngLatToScreen(lon: number, lat: number): [number, number];

  // ═══════════════════════════════════════
  // 事件
  // ═══════════════════════════════════════

  /**
   * 地图开始移动时触发（从静止到运动的边界）。
   * 触发条件：panStart / flyTo 开始 / easeTo 开始 / 惯性开始 / zoom
   *
   * @returns 取消订阅函数
   */
  onMoveStart(callback: () => void): () => void;

  /**
   * 地图移动中每帧触发。
   * 回调参数是当前 CameraState（复用对象）。
   */
  onMove(callback: (state: CameraState) => void): () => void;

  /**
   * 地图停止移动时触发（从运动到静止的边界）。
   * 触发条件：panEnd 无惯性 / 惯性停止 / 动画完成或取消 / stop()
   */
  onMoveEnd(callback: () => void): () => void;

  /**
   * 销毁相机。
   * 清除所有事件监听、取消动画、释放内部资源。
   * 销毁后不应再调用任何方法。
   */
  destroy(): void;
}
```

### 1.6 惯性动画详细算法

```
update() 中惯性处理（每帧）：
  if (!isInertiaActive) return;

  // 1. 衰减速度
  inertiaVelocity.x *= inertiaDecay;
  inertiaVelocity.y *= inertiaDecay;

  // 2. 计算本帧位移（像素）
  dx = inertiaVelocity.x * deltaTime;
  dy = inertiaVelocity.y * deltaTime;

  // 3. 转换为墨卡托位移
  worldSize = 512 * 2^zoom;
  mercDx = -dx / worldSize;  // 屏幕像素 → 墨卡托归一化坐标
  mercDy = +dy / worldSize;

  // 4. 更新 center
  currentMerc = lngLatToMerc(center);
  newMerc = [currentMerc.x + mercDx, currentMerc.y + mercDy];
  center = mercToLngLat(newMerc);

  // 5. 应用 maxBounds 约束
  applyBoundsConstraint();

  // 6. 检查速度是否低于阈值
  speed = sqrt(inertiaVelocity.x² + inertiaVelocity.y²);
  if (speed < INERTIA_VELOCITY_THRESHOLD) {
    isInertiaActive = false;
    inertiaVelocity = [0, 0];
    // 触发 moveEnd（如果无其他运动源）
  }
```

### 1.7 maxBounds 约束算法

```
applyBoundsConstraint():
  if (!maxBounds) return;

  worldSize = 512 * 2^zoom;

  // 计算当前 viewport 在墨卡托空间中覆盖的半宽半高
  halfWMerc = viewport.width / 2 / worldSize;
  halfHMerc = viewport.height / 2 / worldSize;

  // 将 maxBounds 转为墨卡托坐标
  boundsMinMerc = lngLatToMerc(maxBounds.west, maxBounds.south);
  boundsMaxMerc = lngLatToMerc(maxBounds.east, maxBounds.north);

  // 约束 center 使 viewport 不超出 bounds
  centerMerc = lngLatToMerc(center);

  // 如果 viewport 比 bounds 小，限制 center 使 viewport 在 bounds 内
  if (halfWMerc * 2 < boundsMaxMerc.x - boundsMinMerc.x) {
    centerMerc.x = clamp(centerMerc.x, boundsMinMerc.x + halfWMerc, boundsMaxMerc.x - halfWMerc);
  } else {
    // viewport 比 bounds 大，居中显示
    centerMerc.x = (boundsMinMerc.x + boundsMaxMerc.x) / 2;
  }
  // Y 轴同理

  center = mercToLngLat(centerMerc);
```

### 1.8 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| ← 输入 | L5/InteractionManager | handlePan*/handleZoom/handleRotate 方法调用 | InteractionManager 将 DOM 事件转换后调用相机方法 |
| ← 输入 | L4/AnimationManager | flyTo/easeTo 方法调用 | AnimationManager 委托给 CameraController |
| → 输出 | L3/FrameScheduler | update() 返回 CameraState | FrameScheduler 在 UPDATE 阶段调用 |
| → 输出 | L3/TileScheduler | CameraState（center/zoom/vpMatrix） | TileScheduler.update() 消费 CameraState 决定加载哪些瓦片 |
| → 输出 | L4/LabelManager | CameraState（vpMatrix/viewport） | 标注碰撞检测依赖相机视口 |
| → 输出 | L2/FrameGraphBuilder | CameraState（vpMatrix/projectionMatrix） | 每帧渲染使用 |
| → 事件 | L0/InternalBus | emit('camera:changed', state) / emit('camera:idle', state) | 内部模块松耦合监听 |

### 1.9 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| center 含 NaN/Infinity | CONFIG_INVALID_PARAM | throw GeoForgeError，附带具体值 |
| zoom 为 NaN | CONFIG_INVALID_PARAM | throw GeoForgeError |
| viewport 宽高为 0 | — | update() 跳过矩阵计算，返回上一帧的 state |
| inverseVP 矩阵不可逆 | — | 回退到 identity，log.warn |
| flyTo duration ≤ 0 | — | 等效 jumpTo（立即到位） |
| 销毁后调用方法 | — | log.warn + 空操作 |

### 1.10 常量

```typescript
const DEFAULT_MIN_ZOOM = 0;
const DEFAULT_MAX_ZOOM = 22;
const DEFAULT_INERTIA_DECAY = 0.85;
const DEFAULT_INERTIA_SAMPLE_FRAMES = 5;
const DEFAULT_MAX_INERTIA_VELOCITY = 4000;
const INERTIA_VELOCITY_THRESHOLD = 1.0;   // 像素/秒
const INERTIA_MIN_DURATION = 10;           // 最小采样时间（ms），低于此不启动惯性
const INERTIA_MIN_SPEED = 50;              // 最小启动速度（像素/秒）
const DEFAULT_FLY_DURATION = 1500;         // ms
const DEFAULT_EASE_DURATION = 500;         // ms
const EPSILON = 1e-10;
const WORLD_TILE_SIZE = 512;               // 墨卡托世界瓦片基础尺寸
const EARTH_CIRCUMFERENCE = 40075016.686;  // 米，用于 altitude 计算
```

### 1.11 对象池化（ObjectPool）使用点

```
camera-2d 中需要池化的对象：

1. InertiaSample 队列：
   不使用动态数组 push/pop，使用固定长度环形缓冲：
   samples: InertiaSample[] = new Array(inertiaSampleFrames)  // 构造时预分配
   sampleIndex: number = 0                                     // 写入位置
   sampleCount: number = 0                                     // 有效数量
   写入：samples[sampleIndex % capacity] = { dx, dy, time }; sampleIndex++; sampleCount = min(sampleCount+1, capacity)
   读取：从 (sampleIndex - sampleCount) 到 (sampleIndex - 1) 遍历

2. AnimationState 对象：
   使用 ObjectPool<AnimationState>：
   flyTo/easeTo 启动时：animation = animationPool.acquire()
   动画完成/取消时：animationPool.release(animation)
   池容量：2（同时最多 1 个动画 + 1 个备用）

3. 每帧 update() 中的临时向量：
   已通过模块级预分配 _eye/_target/_up 解决 → 不需要 ObjectPool
   但如果 screenToLngLat/lngLatToScreen 等方法在帧内被多次调用，
   需要额外预分配 _tempVec4: Vec4f 和 _tempVec3: Vec3f

4. 事件回调中的参数对象：
   onMove(state) 的 state 参数已经是复用对象 → 不需要
   但如果有额外的事件数据包装，应从 ObjectPool 获取
```

### 1.12 __DEV__ 条件编译标注

```
以下代码必须用 if (__DEV__) { ... } 包裹，生产构建 tree-shake 移除：

1. 参数验证（setCenter/setZoom/jumpTo）：
   if (__DEV__) {
     if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
       throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_PARAM,
         `center 包含非法值: [${center[0]}, ${center[1]}]`,
         { layerId: undefined, moduleId: 'camera-2d' });
     }
   }
   // 生产环境直接跳过验证（信任调用方），提升性能

2. 销毁后调用检测：
   if (__DEV__) {
     if (this._destroyed) {
       logger.warn('[camera-2d] 相机已销毁，忽略方法调用');
       return;
     }
   }

3. 性能日志：
   if (__DEV__) {
     const updateStart = performance.now();
     // ... update logic ...
     const updateMs = performance.now() - updateStart;
     if (updateMs > 2) {
       logger.debug(`[camera-2d] update() 耗时 ${updateMs.toFixed(2)}ms 超过 2ms 预算`);
     }
   }

4. GeoForgeError.context 中的额外诊断信息（见 1.9 错误处理）：
   if (__DEV__) {
     error.context.currentZoom = this._zoom;
     error.context.viewport = { width: viewport.width, height: viewport.height };
   }
```

### 1.13 @stability 标注

```
@stability stable（遵循 semver，不会 breaking change）：
  - state / isAnimating / isMoving / inertiaEnabled / constraints
  - setCenter / setZoom / setBearing / setPitch / jumpTo
  - flyTo / easeTo / stop
  - update
  - handlePanStart / handlePanMove / handlePanEnd / handleZoom / handleRotate
  - onMoveStart / onMove / onMoveEnd
  - destroy

@stability experimental（minor 版本可能变更）：
  - screenToLngLat / lngLatToScreen
  - getVisibleBounds
  - isInertiaActive / isPanning

@stability internal（仅引擎内部，随时可变）：
  - InertiaSample / AnimationState 全部内部结构
  - 预分配缓冲（_viewMatrix / _projMatrix / ...）
  - 所有 private 方法
```

### 1.14 CameraState → GPU PerFrameUniforms 对接

```
camera.update() 输出 CameraState 后，FrameScheduler 在同一帧将矩阵上传 GPU。

PerFrameUniforms WGSL struct（@group(0) @binding(0)）：

struct PerFrameUniforms {
  viewMatrix:       mat4x4<f32>,   // offset 0,   64 bytes  ← state.viewMatrix
  projectionMatrix: mat4x4<f32>,   // offset 64,  64 bytes  ← state.projectionMatrix
  vpMatrix:         mat4x4<f32>,   // offset 128, 64 bytes  ← state.vpMatrix
  cameraPosition:   vec3<f32>,     // offset 192, 12 bytes  ← state.position
  _pad0:            f32,           // offset 204, 4 bytes   ← padding（vec3 对齐到 16）
  viewport:         vec2<f32>,     // offset 208, 8 bytes   ← [viewport.width, viewport.height]
  time:             f32,           // offset 216, 4 bytes   ← 引擎运行时间（秒）
  zoom:             f32,           // offset 220, 4 bytes   ← state.zoom
};
// 总大小: 224 bytes → 对齐到 256 bytes（WGSL 要求 struct 大小是最大对齐值 16 的倍数）

上传路径（FrameScheduler.updatePhase 内）：
  const writer = uniformLayoutBuilder.createWriter(perFrameLayout);
  writer.setMat4('viewMatrix', camera.state.viewMatrix);       // 直接拷贝 Float32Array[16]
  writer.setMat4('projectionMatrix', camera.state.projectionMatrix);
  writer.setMat4('vpMatrix', camera.state.vpMatrix);
  writer.setVec3('cameraPosition', camera.state.position[0], camera.state.position[1], camera.state.position[2]);
  writer.setVec2('viewport', viewport.physicalWidth, viewport.physicalHeight);  // 注意：物理像素
  writer.setFloat('time', elapsedTime);
  writer.setFloat('zoom', camera.state.zoom);
  gpuUploader.writeUniform(perFrameBuffer, writer.getData());  // via L1
```

### 1.15 out 参数约束

```
camera-2d/25d/3d 的 update() 中所有矩阵计算必须使用 out 参数模式，
写入预分配的模块级 Float32Array，禁止每帧创建新 TypedArray。

✅ 正确：
  mat4.ortho(_projMatrix, -halfW, halfW, -halfH, halfH, -1, 1);
  mat4.lookAt(_viewMatrix, _eye, _target, _up);
  mat4.multiply(_vpMatrix, _projMatrix, _viewMatrix);
  mat4.invert(_inverseVP, _vpMatrix);
  vec3.set(_eye, px, py, 1);
  vec3.set(_target, px, py, 0);

❌ 禁止：
  const proj = mat4.create();           // 每帧 new Float32Array(16) → 64 字节 GC 压力
  const vp = mat4.multiply(mat4.create(), proj, view);  // 链式创建临时对象
  return { viewMatrix: new Float32Array(view) };         // 拷贝创建新对象

camera-25d 额外：
  mat4.perspectiveReversedZ(_projMatrix, fov, aspect, near, far);  // ✅ 复用 _projMatrix

camera-3d 额外：
  mat4.perspectiveReversedZInfinite(_projMatrix, fov, aspect, near);  // ✅
  quat.fromEuler(_tempQuat, bearing, pitch, roll);                    // ✅ 需要预分配 _tempQuat
  mat4.fromRotationTranslation(_viewMatrix, _tempQuat, _ecefPos);     // ✅
```

### 1.16 列主序约束

```
camera-2d/25d/3d 的 state 中所有矩阵字段均为 Float32Array[16]，列主序（Column-Major）。

内存布局（与 WGSL mat4x4<f32> 完全一致，上传 GPU 无需转置）：

  | m[0]  m[4]  m[8]   m[12] |     列 0   列 1   列 2   列 3
  | m[1]  m[5]  m[9]   m[13] |
  | m[2]  m[6]  m[10]  m[14] |
  | m[3]  m[7]  m[11]  m[15] |

等价于：
  m[0..3]   = 第 0 列（通常是 right 向量 + 0）
  m[4..7]   = 第 1 列（通常是 up 向量 + 0）
  m[8..11]  = 第 2 列（通常是 forward 向量 + 0）
  m[12..15] = 第 3 列（通常是 translation + 1）

camera-3d 的 vpMatrix 包含 ECEF 坐标（数值很大），
Split-Double 处理后以 RTC 偏移形式上传：
  perFrameUniforms 中使用 mat4x4<f32> 存储 RTC 后的矩阵
  RTC center 单独上传为 vec3<f32> high + vec3<f32> low
```

### 1.17 Tree-Shaking 导出规范

```typescript
// camera-2d/src/index.ts — 包入口
export { createCamera2D } from './Camera2D';              // 命名 export（工厂函数）
export type { Camera2D, Camera2DOptions } from './Camera2D';  // 类型 export

// ❌ 禁止
export default Camera2D;                                  // 禁止 default export
const _init = someSetup();                                // 禁止顶层副作用

// camera-25d/src/index.ts
export { createCamera25D } from './Camera25D';
export type { Camera25D, Camera25DOptions } from './Camera25D';

// camera-3d/src/index.ts
export { createCamera3D } from './Camera3D';
export type { Camera3D, Camera3DOptions } from './Camera3D';

// 效果：
// import { createCamera2D } from '@geoforge/camera-2d';  // 只打包 camera-2d
// 如果用户不 import camera-3d，整个包被 tree-shake 移除
```

---

## 2. @geoforge/camera-25d

### 2.1 与 Camera2D 的关系

Camera25D **不是**继承 Camera2D。它是独立实现 CameraController 接口，但在概念上扩展了 2D 的能力：
- 新增 bearing（旋转）和 pitch（俯仰）
- 投影矩阵从 ortho 变为 perspectiveReversedZ
- 视图矩阵需要考虑 pitch 导致的相机位置偏移
- 惯性变为三通道（pan + bearing + pitch 独立衰减）

### 2.2 Camera25DOptions

```typescript
export interface Camera25DOptions {
  /**
   * 初始中心 [lon, lat]（度）。
   * @default [0, 0]
   */
  readonly center?: [number, number];

  /** @default 1 */
  readonly zoom?: number;

  /** @default 0 */
  readonly minZoom?: number;

  /** @default 22 */
  readonly maxZoom?: number;

  /** 可视范围约束 */
  readonly maxBounds?: BBox2D;

  /**
   * 初始方位角（弧度），0 = 正北，正值 = 顺时针。
   * @unit 弧度
   * @range [0, 2π)
   * @default 0
   */
  readonly bearing?: number;

  /**
   * 初始俯仰角（弧度），0 = 正俯视，正值 = 向地平线倾斜。
   * @unit 弧度
   * @range [0, maxPitch]
   * @default 0
   */
  readonly pitch?: number;

  /**
   * 最大俯仰角（弧度）。
   * 85° ≈ 1.4835 rad 是常用上限（再大会看到地平线以外的空白）。
   * @unit 弧度
   * @range (0, π/2)
   * @default 1.4835（≈85°）
   */
  readonly maxPitch?: number;

  /**
   * 透视 FOV（弧度）。
   * @unit 弧度
   * @default 0.6435（≈36.87°，MapLibre 默认值）
   */
  readonly fov?: number;

  /** 惯性开关，默认 true */
  readonly inertia?: boolean;

  /** 惯性衰减系数 */
  readonly inertiaDecay?: number;

  /** Pan 惯性衰减（与旋转/俯仰分离），默认 0.85 */
  readonly panInertiaDecay?: number;

  /** Bearing 旋转惯性衰减（旋转衰减更快），默认 0.75 */
  readonly bearingInertiaDecay?: number;

  /** Pitch 惯性衰减（俯仰衰减最快），默认 0.7 */
  readonly pitchInertiaDecay?: number;
}
```

### 2.3 Camera25D 公共接口（仅列出与 Camera2D 不同的部分）

```typescript
export interface Camera25D extends CameraController {
  readonly type: '25d';

  // ─── 继承自 CameraController 的方法全部有效（setCenter/setZoom/setBearing/setPitch/jumpTo/flyTo/easeTo/stop/update/handlePan*/handleZoom/handleRotate） ───

  // ─── 2.5D 特有方法 ───

  /**
   * setBearing 在 2.5D 下有效（不再是空操作）。
   * @param bearing - 方位角（弧度），0 = 正北
   */
  setBearing(bearing: number): void;

  /**
   * setPitch 在 2.5D 下有效。
   * @param pitch - 俯仰角（弧度），会被 clamp 到 [0, maxPitch]
   */
  setPitch(pitch: number): void;

  /**
   * 重置 bearing 到 0（正北），带动画。
   * @param options.duration - 动画时长（ms），默认 500
   * @returns CameraAnimation
   */
  resetNorth(options?: { duration?: number }): CameraAnimation;

  /**
   * 重置 bearing 和 pitch 都到 0，带动画。
   */
  resetNorthPitch(options?: { duration?: number }): CameraAnimation;

  /**
   * bearing 接近 0 时自动吸附到正北。
   * @param options.threshold - 吸附阈值（弧度），默认 0.12（≈7°）
   * @param options.duration - 吸附动画时长（ms），默认 300
   */
  snapToNorth(options?: { threshold?: number; duration?: number }): CameraAnimation;

  /**
   * 获取当前 pitch 角度下的地平线屏幕 Y 坐标。
   * 高于此 Y 坐标的区域不需要渲染瓦片。
   * @returns 地平线 Y（CSS 像素），如果 pitch=0 则返回 0（整个屏幕都是地图）
   */
  getHorizonY(): number;

  /**
   * 获取可视地理范围（考虑 pitch 和 bearing）。
   * pitch > 0 时可视范围不再是矩形，而是梯形。
   * 返回包含此梯形的最小 BBox。
   */
  getVisibleBounds(): BBox2D;

  // ─── update() 矩阵计算差异 ───
  //
  // 投影矩阵：mat4.perspectiveReversedZ(fov, aspect, near, far)
  //   near = altitude * 0.1（altitude 由 zoom 和 pitch 决定）
  //   far  = altitude * (1 + 1/cos(pitch)) * 2（高 pitch 时自动扩大 far）
  //
  // 视图矩阵：
  //   地图中心的墨卡托坐标 [mercX * worldSize, mercY * worldSize, 0]
  //   相机位置 = 中心 + 偏移：
  //     offsetBack = sin(pitch) * altitude（向后偏移，因为 pitch 向地平线倾斜）
  //     offsetUp   = cos(pitch) * altitude（向上偏移）
  //     偏移方向由 bearing 旋转
  //   eye = [
  //     centerPixelX - sin(bearing) * offsetBack,
  //     centerPixelY + cos(bearing) * offsetBack,
  //     offsetUp
  //   ]
  //   target = [centerPixelX, centerPixelY, 0]
  //   up = rotate([0, 1, 0], bearing) 绕 Z 轴
  //   mat4.lookAt(eye, target, up)

  // ─── handleRotate 差异 ───
  //
  // handleRotate(bearingDelta, pitchDelta):
  //   bearing += bearingDelta（弧度增量）
  //   pitch = clamp(pitch + pitchDelta, 0, maxPitch)
  //   记录旋转惯性采样
  //
  // 惯性三通道：
  //   update() 中：
  //     panVelocity    *= panInertiaDecay
  //     bearingVelocity *= bearingInertiaDecay（旋转衰减更快）
  //     pitchVelocity   *= pitchInertiaDecay（俯仰衰减最快）

  // ─── 高 pitch 自动调整 ───
  //
  // pitch > 60° 时：
  //   TileScheduler SSE 阈值自动翻倍（减少远处瓦片加载）
  //   通过 InternalBus emit 'camera:high-pitch' 通知 TileScheduler
  //
  // pitch > 75° 时：
  //   启用雾化（PerformanceManager 降级），遮挡远处空白区域
}

export function createCamera25D(options?: Camera25DOptions): Camera25D;
```

### 2.4 与其他模块的对接

同 Camera2D（1.8 节），加上：

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| → 事件 | InternalBus | 'camera:high-pitch' | pitch > 60° 时通知 TileScheduler 调整 SSE |
| ← 输入 | InteractionManager | handleRotate(bearingDelta, pitchDelta) | 右键拖动 / 双指旋转 |
| → 输出 | L2/DepthManager | near/far 动态调整 | pitch 变化时 updateClipPlanes |

---

## 3. @geoforge/camera-3d

### 3.1 Camera3DOptions

```typescript
export interface Camera3DOptions {
  /**
   * 初始地理位置。
   * @default { lon: 0, lat: 0, alt: 20_000_000 }（太空视角）
   */
  readonly position?: { lon: number; lat: number; alt: number };

  /**
   * 初始方位角（弧度），0 = 正北。
   * @default 0
   */
  readonly bearing?: number;

  /**
   * 初始俯仰角（弧度），0 = 正俯视地球中心，-π/2 = 平视地平线。
   * 注意与 2.5D 不同：3D 的 pitch 范围更广。
   * @range [-π/2, π/2]
   * @default -π/4（45° 俯视）
   */
  readonly pitch?: number;

  /**
   * 初始翻滚角（弧度），通常为 0。
   * @default 0
   */
  readonly roll?: number;

  /**
   * 最小缩放距离（相机到地表的最小距离，米）。
   * @unit 米
   * @default 1
   */
  readonly minimumZoomDistance?: number;

  /**
   * 最大缩放距离（相机到地表的最大距离，米）。
   * @unit 米
   * @default Infinity
   */
  readonly maximumZoomDistance?: number;

  /**
   * 地形碰撞检测开关。
   * 启用后，相机高度不会低于地形表面 + minAltitudeAboveTerrain。
   * @default true
   */
  readonly enableCollision?: boolean;

  /**
   * 地形碰撞最小离地高度（米）。
   * @unit 米
   * @default 10
   */
  readonly minAltitudeAboveTerrain?: number;

  /** 惯性开关 */
  readonly inertia?: boolean;

  /**
   * 轨道旋转惯性衰减。使用四元数 slerp 衰减，此值控制每帧 slerp 的 t 参数。
   * @range (0, 1)，越小衰减越快
   * @default 0.85
   */
  readonly orbitInertiaDecay?: number;

  /**
   * 缩放惯性衰减。
   * @default 0.9
   */
  readonly zoomInertiaDecay?: number;
}
```

### 3.2 Camera3D 公共接口

```typescript
export interface Camera3D extends CameraController {
  readonly type: '3d';

  // ─── CameraController 接口全部有效 ───
  // setCenter, setZoom, setBearing, setPitch, jumpTo, flyTo, easeTo, stop, update, handlePan*, handleZoom, handleRotate

  // ─── 3D 位置控制 ───

  /**
   * 设置相机地理位置（经纬度 + 高程）。
   *
   * @param lon - 经度（度）
   * @param lat - 纬度（度）
   * @param alt - 高程/海拔（米），相对于 WGS84 椭球面
   *
   * 内部：调用 ellipsoid.geodeticToECEF(lon, lat, alt) 转为 ECEF 坐标
   */
  setPosition(lon: number, lat: number, alt: number): void;

  /**
   * 获取相机地理位置。
   * 内部：ECEF → geodetic via ellipsoid.ecefToGeodetic
   */
  getPosition(): { lon: number; lat: number; alt: number };

  /**
   * 设置相机朝向（bearing/pitch/roll 三个欧拉角）。
   * 内部转为四元数存储。
   *
   * @param bearing - 方位角（弧度），0 = 正北
   * @param pitch - 俯仰角（弧度）
   * @param roll - 翻滚角（弧度），默认 0
   */
  setOrientation(bearing: number, pitch: number, roll?: number): void;

  /**
   * 获取相机朝向。
   * 内部从四元数反算欧拉角。
   */
  getOrientation(): { bearing: number; pitch: number; roll: number };

  /**
   * 看向地球上的某个点。
   *
   * @param target - 目标位置 [lon, lat, alt]
   * @param offset - 观察偏移
   *   @param offset.bearing - 围绕目标的方位角（弧度）
   *   @param offset.pitch - 观察俯仰角（弧度，负值从上方看）
   *   @param offset.range - 到目标的距离（米）
   *
   * 算法：
   *   1. targetECEF = geodeticToECEF(target)
   *   2. 在目标点建立本地 ENU 坐标系
   *   3. 在 ENU 中根据 bearing/pitch/range 计算相机位置：
   *      localPos = spherical(range, bearing, pitch) → ENU → ECEF
   *   4. 相机朝向指向 targetECEF
   */
  lookAt(
    target: [number, number, number],
    offset?: { bearing?: number; pitch?: number; range?: number },
  ): void;

  /**
   * 3D 飞行。
   * 沿大圆弧路径飞行，高度呈抛物线。
   *
   * @param options.lon - 目标经度
   * @param options.lat - 目标纬度
   * @param options.alt - 目标高程（米）
   * @param options.bearing - 到达时的方位角
   * @param options.pitch - 到达时的俯仰角
   * @param options.duration - 时长（ms），默认 2000
   * @param options.easing - 缓动函数
   *
   * 大圆弧飞行算法：
   *   1. startECEF = geodeticToECEF(currentPos)
   *   2. endECEF = geodeticToECEF(targetPos)
   *   3. 计算大圆弧角度 θ = acos(dot(normalize(startECEF), normalize(endECEF)))
   *   4. 弧长 arcLength = θ * R_earth
   *   5. 飞行高度抛物线：
   *      maxAlt = max(startAlt, endAlt) + arcLength * 0.3
   *      alt(t) = lerp(startAlt, endAlt, t) + sin(π*t) * (maxAlt - max(startAlt, endAlt))
   *   6. 位置沿大圆弧插值：
   *      ecef(t) = slerp(normalize(startECEF), normalize(endECEF), t) * (R_earth + alt(t))
   *   7. 朝向从 startOrientation slerp 到 endOrientation
   */
  flyToPosition(options: {
    lon: number; lat: number; alt: number;
    bearing?: number; pitch?: number;
    duration?: number; easing?: (t: number) => number;
  }): CameraAnimation;

  // ─── 地形碰撞（#7.1）───

  /** 地形碰撞开关状态 */
  readonly terrainCollisionEnabled: boolean;

  /** 启用/禁用地形碰撞 */
  setTerrainCollisionEnabled(enabled: boolean): void;

  /**
   * 设置最小离地高度。
   * @param meters - 相机到地形表面的最小距离（米）
   */
  setMinAltitudeAboveTerrain(meters: number): void;

  /**
   * 查询指定经纬度的地形高度。
   * 内部委托给 TerrainLayer（通过 terrainProvider）。
   * 如果无地形图层或该位置未加载，返回 0。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @returns 地形高度（米，相对椭球面）
   */
  queryTerrainHeight(lon: number, lat: number): Promise<number>;

  /**
   * 注册地形高度查询器。
   * TerrainLayer 初始化后调用此方法注册自己的 getElevation。
   * Camera3D 在每帧 update() 中通过此 provider 查询当前位置下方的地形高度。
   *
   * @param provider - 高度查询函数（异步）
   */
  setTerrainProvider(provider: (lon: number, lat: number) => Promise<number>): void;

  // ─── 缩放距离 ───

  /**
   * 获取相机到地球表面的距离（米）。
   * 计算：|cameraECEF| - ellipsoidRadius(lat)
   */
  getDistanceToSurface(): number;

  /** 设置缩放距离范围 */
  setZoomDistanceRange(min: number, max: number): void;

  // ─── update() 矩阵计算 ───
  //
  // 坐标系：ECEF
  //   cameraECEF = geodeticToECEF(lon, lat, alt)
  //
  // 投影矩阵：mat4.perspectiveReversedZInfinite(fov, aspect, near)
  //   near = max(1.0, distanceToSurface * 0.001)
  //   far = Infinity
  //
  // 视图矩阵：
  //   1. 构建本地 ENU 坐标系（以相机位置为原点）
  //      east  = normalize(cross([0,0,1], normalize(cameraECEF)))
  //      north = normalize(cross(normalize(cameraECEF), east))
  //      up    = normalize(cameraECEF)
  //   2. 构建朝向四元数（bearing/pitch/roll → quat）
  //      q = quat.fromEuler(bearing, pitch, roll)（相对于本地 ENU）
  //   3. 视图矩阵 = inverse(mat4.fromRotationTranslation(q_enu_to_world, cameraECEF))
  //
  // CameraState 填充：
  //   center: ecefToGeodetic(lookAtPointOnEllipsoid) → [lon, lat]
  //   zoom: log2(EARTH_CIRCUMFERENCE / (distanceToSurface * fov * 2))（近似）
  //   bearing, pitch, roll: 从四元数反算
  //   altitude: distanceToSurface

  // ─── 地形碰撞算法 ───
  //
  // update() 中（每帧）：
  //   if (!terrainCollisionEnabled || !terrainProvider) return;
  //
  //   1. 获取当前相机正下方的地形高度
  //      terrainHeight = terrainProvider(currentLon, currentLat)
  //      注意：这是异步操作。使用上一帧的缓存值，同时发起新查询。
  //      缓存策略：距离上次查询位置超过 100m 时才重新查询。
  //
  //   2. 计算最小安全高度
  //      minSafeAlt = terrainHeight + minAltitudeAboveTerrain
  //
  //   3. 如果当前高度低于安全高度，平滑推高
  //      if (currentAlt < minSafeAlt) {
  //        currentAlt = lerp(currentAlt, minSafeAlt, 0.3);  // 0.3 = 平滑系数
  //        // 不瞬移，每帧接近 30% 的差距，防止突跳
  //      }

  // ─── handlePan 差异（轨道旋转）───
  //
  // 3D 模式下 pan 是绕地球旋转（轨道旋转），不是平移：
  //   handlePanMove(screenX, screenY):
  //     dx = screenX - prevScreenX
  //     dy = screenY - prevScreenY
  //     // 水平拖动 → 改变经度（绕地球 Z 轴旋转）
  //     lonDelta = -dx / viewport.width * 360 / (distanceToSurface / R_earth)
  //     // 垂直拖动 → 改变纬度（绕东向轴旋转）
  //     latDelta = dy / viewport.height * 180 / (distanceToSurface / R_earth)
  //     lon += lonDelta
  //     lat = clamp(lat + latDelta, -89.99, 89.99)
}

export function createCamera3D(options?: Camera3DOptions): Camera3D;
```

### 3.3 与其他模块的对接

| 方向 | 对接模块 | 对接方式 | 说明 |
|------|---------|---------|------|
| ← 输入 | TerrainLayer | setTerrainProvider(fn) | TerrainLayer 注册高度查询函数 |
| → 输出 | L0/ellipsoid | geodeticToECEF / ecefToGeodetic | 坐标转换 |
| → 输出 | L0/quat | fromEuler / slerp / toEuler | 朝向旋转 |
| → 输出 | L2/DepthManager | updateClipPlanes(near, far) | near 随 distanceToSurface 动态变化 |
| → 输出 | InternalBus | 'camera:changed' / 'camera:idle' | 通知其他模块 |

### 3.4 错误处理

| 场景 | 处理 |
|------|------|
| 经纬度超范围 | clamp 到 [-180,180] / [-90,90]，log.warn |
| 高度为负数 | clamp 到 minimumZoomDistance |
| terrainProvider 返回 NaN | 使用 0 作为默认高度，log.warn |
| terrainProvider 超时（>5s） | 使用缓存值，不阻塞渲染 |
| ECEF 坐标溢出（极端高度）| clamp 到地球半径 × 100 |
| 四元数退化（gimbal lock）| 检测 pitch 接近 ±π/2 时限制 roll |

---

## 3 个相机包统计

| 包 | 公共方法 | 内部状态字段 | 预分配缓冲 | 常量 | ObjectPool 使用点 | __DEV__ 点 |
|---|---------|-------------|-----------|------|-----------------|-----------|
| camera-2d | 20 | 15 | 7 个 TypedArray | 12 | 2（InertiaSample 环形缓冲 + AnimationState 池） | 4（参数验证/销毁检测/性能日志/诊断上下文） |
| camera-25d | +5 = 25 | +6 = 21 | 共享 camera-2d | +4 = 16 | 同上 | 同上 |
| camera-3d | +10 = 30 | +8 = 23 | +3 ECEF + 1 Quat | +5 = 17 | +1（terrainHeight 缓存） | +1（地形查询超时日志） |

## Context / safeExecute 适用性说明

```
camera-2d/25d/3d 是引擎内部包（@geoforge/camera-*），不是 EP1~EP6 扩展。
它们通过 FrameScheduler 直接实例化，不经过 ExtensionRegistry。

因此：
  ✅ 不需要 CustomLayerContext（相机不是图层）
  ✅ 不需要 safeExecute（引擎内部代码，错误直接传播到 FrameScheduler）
  ✅ 不需要 SourceContext（相机不加载数据）

但是：如果用户通过 EP1 注册的自定义图层内部创建自己的相机控制器，
则该自定义图层的代码整体受 safeExecute 保护（连续 5 次错误禁用图层）。
相机本身不额外包 safeExecute。
```

完整接口 + 内部结构 + 算法 + 对接点 + 错误处理 + 非功能性覆盖全部展开。
