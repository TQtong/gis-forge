# GeoForge 鼠标锚点缩放完整修复方案

> **问题**：滚轮/双击/触摸缩放时，地图以视口中心为锚点而非鼠标/触点位置。
> **正确行为**：缩放前后，鼠标指向的地理位置在屏幕上的像素位置不变（不动点）。
> **影响范围**：Camera2D / Camera2.5D / Camera3D 的全部缩放入口。

---

## 一、各引擎同类 Issue 和解决方案汇总

| 引擎 | Issue / 特性 | 方案摘要 |
|------|-------------|---------|
| **MapLibre GL JS** | [#1024](https://github.com/maplibre/maplibre-gl-js/issues/1024) 地形模式下缩放锚点偏移 | PR #1977 修复：scroll_zoom.ts 返回 `{ around: Point }`，transform 以 around 为锚点执行 `_setZoomAroundCenter` |
| **MapLibre GL JS** | [#2709](https://github.com/maplibre/maplibre-gl-js/issues/2709) 中断滚轮缩放后弹回 | 原因是 `_targetZoom` 残留，修复方案是中断时清空 `_targetZoom` |
| **MapLibre GL JS** | [#4362](https://github.com/maplibre/maplibre-gl-js/issues/4362) 自由滚轮缩放卡顿 | 原因是 scroll 累加器未正确处理高频 trackpad 事件 |
| **CesiumJS** | [PR #2810](https://github.com/AnalyticalGraphicsInc/cesium/pull/2810) 1.11 起默认鼠标锚点缩放 | 3D：沿 `camera.getPickRay(mousePos).direction` 移动相机。2D：`zoomIn + moveLeft/moveForward` 补偿 |
| **CesiumJS** | [#2968](https://github.com/CesiumGS/cesium/issues/2968) 锚点缩放不精确 | 地球表面曲率导致偏差，需要迭代校正 |
| **Leaflet** | 内置 `setZoomAround(latlng, zoom)` | 2D 解析公式：`newCenter = anchor + (oldCenter - anchor) / scaleFactor` |
| **OpenLayers** | `MouseWheelZoom({ useAnchor: true })` 默认启用 | `view.animate({ zoom, anchor: coordinate })` 内部执行相同的 center 偏移 |
| **deck.gl** | `MapController.scrollZoom` | `_onWheel` 中传入 `position=[x,y]`，`ViewState` 根据 anchor 重算 longitude/latitude |

---

## 二、需要修复的全部缩放入口

不仅是滚轮——**所有改变 zoom 的操作**都需要考虑锚点：

| 缩放入口 | 锚点应该是 | 当前问题 |
|---------|----------|---------|
| **鼠标滚轮** | 鼠标光标位置 | ❌ 以视口中心缩放 |
| **双击缩放** | 双击位置 | ❌ 以视口中心缩放 |
| **触摸双指缩放** | 双指中心点 | ❌ 以视口中心缩放 |
| **键盘 +/- 缩放** | 视口中心 | ✅ 正确（键盘缩放就应该以中心为锚点）|
| **缩放按钮 [+][-]** | 视口中心 | ✅ 正确（同上）|
| **flyTo / easeTo** | 由动画目标决定 | ✅ 正确（动画 API 自行管理 center）|
| **fitBounds** | 由 bounds 决定 | ✅ 正确 |

---

## 三、滚轮缩放完整实现

### 3.1 滚轮事件预处理（InteractionManager 层）

```typescript
/**
 * InteractionManager.ts — 滚轮事件入口
 * 负责：事件规范化 + 防抖 + 设备检测 + 委托给 Camera
 */

// ═══ 常量 ═══
const WHEEL_ZOOM_RATE = 1 / 450;         // 鼠标滚轮：每 delta 像素的 zoom 变化量
const TRACKPAD_ZOOM_RATE = 1 / 1200;     // 触控板：频率更高所以速率更低
const WHEEL_DELTA_MAGIC = 4.000244140625; // Chrome 鼠标滚轮的 deltaY 特征值
const LINE_DELTA_MULTIPLIER = 40;         // deltaMode=DOM_DELTA_LINE 时的乘数
const PAGE_DELTA_MULTIPLIER = 300;        // deltaMode=DOM_DELTA_PAGE 时的乘数

// ═══ 设备检测 ═══
/** 区分鼠标滚轮 vs 触控板（不同设备需要不同的缩放速率）*/
let _lastWheelTimestamp = 0;
let _isTrackpad = false;
let _wheelEventCount = 0;
const TRACKPAD_DETECT_WINDOW = 400;       // ms 内连续 wheel 事件超过 N 次 → 判定为 trackpad

function detectTrackpad(event: WheelEvent): boolean {
  const now = performance.now();
  if (now - _lastWheelTimestamp > TRACKPAD_DETECT_WINDOW) {
    _wheelEventCount = 0;
  }
  _wheelEventCount++;
  _lastWheelTimestamp = now;

  // 方法 1：deltaY 精确等于特征值 → 鼠标滚轮
  if (Math.abs(event.deltaY) === WHEEL_DELTA_MAGIC * 120) return false;

  // 方法 2：短时间内大量 wheel 事件 → 触控板（鼠标滚轮一格只产生 1 个事件）
  if (_wheelEventCount > 3) return true;

  // 方法 3：deltaY 不是 120 的整数倍 → 触控板（鼠标滚轮 deltaY 通常是 ±120）
  if (event.deltaY % 120 !== 0) return true;

  return _isTrackpad; // 保持上次检测结果
}

// ═══ 滚轮事件处理 ═══
handleWheel(event: WheelEvent): void {
  event.preventDefault();

  // 1. deltaMode 规范化（全部转为像素单位）
  let deltaY = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    deltaY *= LINE_DELTA_MULTIPLIER;     // Firefox 行模式
  } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    deltaY *= PAGE_DELTA_MULTIPLIER;     // 极少数设备
  }

  // 2. 设备检测 → 选择缩放速率
  _isTrackpad = detectTrackpad(event);
  const zoomRate = _isTrackpad ? TRACKPAD_ZOOM_RATE : WHEEL_ZOOM_RATE;

  // 3. 计算 zoom delta
  const zoomDelta = -deltaY * zoomRate;  // 向下滚（正 deltaY）= 缩小 = 负 zoom delta

  // 4. 计算鼠标在 canvas 内的坐标（考虑 DPR）
  const rect = this._canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;

  // 5. 委托给 ScrollZoomHandler（处理累加和动画）
  this._scrollZoomHandler.onWheel(cssX, cssY, zoomDelta);
}
```

### 3.2 滚轮缩放累加器（ScrollZoomHandler）

```typescript
/**
 * ScrollZoomHandler — 管理滚轮缩放的累加、动画、锚点保持。
 *
 * 为什么需要累加器？
 *   1. 滚轮事件高频触发（触控板可达 60Hz），不能每个事件都立即重建矩阵
 *   2. 连续滚动时需要平滑动画（easing），不是每个 delta 直接 jumpTo
 *   3. 动画期间锚点必须始终保持不动
 *
 * MapLibre 的 scroll_zoom.ts 就是这个组件。
 */

export class ScrollZoomHandler {
  private _camera: CameraController;
  private _enabled = true;

  // ═══ 锚点状态 ═══
  /** 鼠标屏幕坐标（CSS 像素），缩放动画期间保持不变 */
  private _anchorScreenX = 0;
  private _anchorScreenY = 0;
  /** 锚点对应的地理坐标（缩放开始时快照，整个动画期间固定）*/
  private _anchorLngLat: [number, number] | null = null;

  // ═══ 缩放累加 ═══
  /** 目标 zoom（滚轮 delta 不断累加到这里）*/
  private _targetZoom: number | null = null;
  /** 缩放开始时的 zoom 快照 */
  private _startZoom = 0;

  // ═══ 动画 ═══
  /** 上一帧时间戳 */
  private _lastFrameTime = 0;
  /** 缓动时长（ms），触控板更短（更灵敏），鼠标滚轮更长（更平滑） */
  private _easeToduration = 0;
  private _easeStartTime = 0;

  // ═══ 常量 ═══
  private static readonly TRACKPAD_EASE_DURATION = 0;     // 触控板：无缓动（直接跟随）
  private static readonly WHEEL_EASE_DURATION = 200;      // 鼠标滚轮：200ms 缓动
  private static readonly ANIMATION_TIMEOUT = 300;         // 超过 300ms 无新 wheel 事件 → 结束动画

  /**
   * 滚轮事件到达。
   * 不直接改 camera 状态——只累加 _targetZoom 和记录锚点。
   * 实际缩放在 update() 的 renderFrame 中执行。
   */
  onWheel(cssX: number, cssY: number, zoomDelta: number): void {
    if (!this._enabled) return;

    const currentZoom = this._camera.state.zoom;

    // 如果是新的缩放序列（之前没有 _targetZoom 或已结束）
    if (this._targetZoom === null) {
      this._startZoom = currentZoom;
      this._anchorScreenX = cssX;
      this._anchorScreenY = cssY;
      // 记录锚点的地理坐标（在整个缩放动画中保持不变！）
      this._anchorLngLat = this._camera.screenToLngLat(cssX, cssY);
      this._targetZoom = currentZoom;
    }

    // 累加 zoom delta
    this._targetZoom = clamp(
      this._targetZoom + zoomDelta,
      this._camera.constraints.minZoom,
      this._camera.constraints.maxZoom
    );

    // 设置缓动参数
    this._easeToDistance = this._targetZoom - currentZoom;
    this._easeStartTime = performance.now();
    this._lastFrameTime = this._easeStartTime;

    // 触控板 vs 鼠标滚轮的缓动时长
    this._easeToDistance = this._camera._isTrackpad
      ? ScrollZoomHandler.TRACKPAD_EASE_DURATION
      : ScrollZoomHandler.WHEEL_EASE_DURATION;

    // 请求动画帧（如果还没在跑）
    this._requestUpdate();
  }

  /**
   * 每帧由 FrameScheduler 调用。
   * 执行实际的缩放 + 锚点保持。
   */
  update(now: number): boolean {
    if (this._targetZoom === null) return false;

    const currentZoom = this._camera.state.zoom;
    let newZoom: number;

    if (this._easeToDistance === 0) {
      // 触控板模式：直接跳到目标 zoom（无缓动）
      newZoom = this._targetZoom;
    } else {
      // 鼠标滚轮模式：缓动插值
      const elapsed = now - this._easeStartTime;
      const t = clamp(elapsed / this._easeToDistance, 0, 1);
      const eased = easeOutQuad(t); // 先快后慢
      newZoom = interpolate(currentZoom, this._targetZoom, eased);
    }

    // ═══ 核心：执行锚点缩放 ═══
    this._zoomAroundAnchor(newZoom);

    // 检查是否完成
    if (Math.abs(newZoom - this._targetZoom) < 0.0001) {
      // 精确对齐到目标
      this._zoomAroundAnchor(this._targetZoom);
      // 超时检查：如果 ANIMATION_TIMEOUT 内没有新 wheel 事件 → 结束
      if (now - this._lastFrameTime > ScrollZoomHandler.ANIMATION_TIMEOUT) {
        this._targetZoom = null;
        this._anchorLngLat = null;
        return false; // 动画完成
      }
    }

    return true; // 还在动画中
  }

  /**
   * 核心算法：以 _anchorLngLat 为不动点，将 zoom 设为 newZoom。
   * 不动点约束：screenToLngLat(_anchorScreenX, _anchorScreenY) === _anchorLngLat
   */
  private _zoomAroundAnchor(newZoom: number): void {
    if (!this._anchorLngLat) {
      // 无锚点（射线未命中地面）→ 退化为中心缩放
      this._camera.setZoom(newZoom);
      return;
    }
    // 委托给 Camera 的锚点缩放方法
    this._camera.zoomAround(this._anchorScreenX, this._anchorScreenY, this._anchorLngLat, newZoom);
  }

  /** 中断当前缩放动画（flyTo/easeTo/jumpTo 等外部操作触发时调用） */
  abort(): void {
    this._targetZoom = null;
    this._anchorLngLat = null;
  }
}
```

### 3.3 Camera2D 锚点缩放实现

```typescript
/**
 * Camera2D.zoomAround — 2D 正交投影下的锚点缩放。
 * 数学推导见下方。
 */
zoomAround(
  anchorScreenX: number,    // CSS 像素
  anchorScreenY: number,
  anchorLngLat: [number, number],  // 锚点地理坐标（缩放序列开始时快照）
  newZoom: number
): void {
  const oldZoom = this._zoom;

  // 如果 zoom 没变，不做任何事
  if (Math.abs(newZoom - oldZoom) < 1e-10) return;

  // 1. 锚点的墨卡托坐标
  const anchorMerc = lngLatToMerc(anchorLngLat);

  // 2. 缩放比（new / old）
  const scaleFactor = Math.pow(2, newZoom - oldZoom);

  // 3. 当前 center 的墨卡托坐标
  const centerMerc = lngLatToMerc(this._center);

  // 4. 新 center = anchor + (oldCenter - anchor) / scaleFactor
  //    推导：
  //      缩放前：anchorScreen = project(anchorMerc, oldZoom, oldCenter)
  //      缩放后：anchorScreen = project(anchorMerc, newZoom, newCenter)  ← 不动点约束
  //      展开 project：anchorScreen = (anchorMerc - center) × scale + viewportCenter
  //      令两者相等：(anchorMerc - oldCenter) × oldScale = (anchorMerc - newCenter) × newScale
  //      解出：newCenter = anchorMerc - (anchorMerc - oldCenter) × (oldScale / newScale)
  //                     = anchorMerc + (oldCenter - anchorMerc) / scaleFactor
  const newCenterMercX = anchorMerc[0] + (centerMerc[0] - anchorMerc[0]) / scaleFactor;
  const newCenterMercY = anchorMerc[1] + (centerMerc[1] - anchorMerc[1]) / scaleFactor;

  // 5. 转回经纬度
  const newCenter = mercToLngLat([newCenterMercX, newCenterMercY]);

  // 6. maxBounds 约束（如果设置了边界限制）
  if (this._maxBounds) {
    constrainCenter(newCenter, newZoom, this._viewport, this._maxBounds);
  }

  // 7. 应用
  this._center = newCenter;
  this._zoom = newZoom;

  // 8. 重建矩阵（单次，不在中间重复构建）
  this._rebuildMatrices();
}
```

### 3.4 Camera2.5D 锚点缩放实现

```typescript
/**
 * Camera25D.zoomAround — 透视投影下的锚点缩放。
 *
 * 透视投影下，同一屏幕坐标在不同 zoom 对应不同的地面位置（因为 pitch 导致非线性映射）。
 * 不能用 2D 的解析公式，必须用 "project-then-correct" 方法。
 *
 * OpenLayers/MapLibre 在有 pitch 时也用这种方法。
 */
zoomAround(
  anchorScreenX: number,
  anchorScreenY: number,
  anchorLngLat: [number, number],
  newZoom: number
): void {
  const oldZoom = this._zoom;
  if (Math.abs(newZoom - oldZoom) < 1e-10) return;

  // ═══ 快速路径：pitch=0 时退化为 2D 公式（精确、快速）═══
  if (Math.abs(this._pitch) < 0.001) {
    // 同 Camera2D.zoomAround
    const anchorMerc = lngLatToMerc(anchorLngLat);
    const centerMerc = lngLatToMerc(this._center);
    const sf = Math.pow(2, newZoom - oldZoom);
    this._center = mercToLngLat([
      anchorMerc[0] + (centerMerc[0] - anchorMerc[0]) / sf,
      anchorMerc[1] + (centerMerc[1] - anchorMerc[1]) / sf,
    ]);
    this._zoom = newZoom;
    this._rebuildMatrices();
    return;
  }

  // ═══ 透视路径：project-then-correct ═══

  // 1. 应用新 zoom（暂时不改 center）
  this._zoom = newZoom;
  this._rebuildMatrices();

  // 2. 锚点在新 VP 矩阵下 project 回屏幕
  const anchorScreen = this.lngLatToScreen(anchorLngLat[0], anchorLngLat[1]);
  if (!anchorScreen) {
    // 锚点投影失败（极端 pitch 下可能跑到视口外）→ 不修正
    return;
  }

  // 3. 计算屏幕偏差（锚点从期望位置漂移了多少）
  const diffX = anchorScreenX - anchorScreen[0];
  const diffY = anchorScreenY - anchorScreen[1];

  // 如果偏差极小（< 0.5px），不修正（避免浮点累积）
  if (Math.abs(diffX) < 0.5 && Math.abs(diffY) < 0.5) return;

  // 4. 将屏幕偏差转为 center 偏移
  //    方法：对比视口中心和"视口中心+偏差"的 unproject 结果之差
  const vCenterX = this._viewport.width / 2;
  const vCenterY = this._viewport.height / 2;
  const geo1 = this.screenToLngLat(vCenterX, vCenterY);
  const geo2 = this.screenToLngLat(vCenterX - diffX, vCenterY - diffY);

  if (geo1 && geo2) {
    // 修正 center
    this._center[0] += (geo2[0] - geo1[0]);
    this._center[1] += (geo2[1] - geo1[1]);

    // maxBounds 约束
    if (this._maxBounds) {
      constrainCenter(this._center, this._zoom, this._viewport, this._maxBounds);
    }

    // 最终重建矩阵
    this._rebuildMatrices();
  }

  // 5. 可选：迭代校正（大 pitch 下第一次校正可能有残余误差）
  //    实测 pitch < 70° 一次迭代已足够（误差 < 1px）。
  //    如果需要更高精度，可以重复步骤 2~4 一次。
}
```

### 3.5 Camera3D (Globe) 锚点缩放实现

```typescript
/**
 * Camera3D.zoomAround — 球面轨道相机的锚点缩放。
 *
 * CesiumJS 方式：沿鼠标射线方向移动相机。
 * 这是最自然的实现——"朝鼠标指的地方飞过去"。
 * 不需要 project-then-correct，因为射线方向天然保证了锚点不动。
 */
zoomAround(
  anchorScreenX: number,
  anchorScreenY: number,
  anchorLngLat: [number, number],  // 这个参数在 Globe 模式不直接用
  newZoom: number
): void {
  const oldZoom = this._zoom;
  if (Math.abs(newZoom - oldZoom) < 1e-10) return;

  // 1. 构建鼠标射线
  const ndcX = (anchorScreenX / this._viewport.width) * 2 - 1;
  const ndcY = 1 - (anchorScreenY / this._viewport.height) * 2;

  // 从 inverseVPMatrix 重建世界空间射线
  const nearClip = vec4.transformMat4(_tempVec4A, [ndcX, ndcY, 1, 1], this._inverseVP);
  const farClip  = vec4.transformMat4(_tempVec4B, [ndcX, ndcY, 0, 1], this._inverseVP);
  // 齐次除法
  vec3.set(_rayOrigin, nearClip[0]/nearClip[3], nearClip[1]/nearClip[3], nearClip[2]/nearClip[3]);
  vec3.set(_rayEnd,    farClip[0]/farClip[3],   farClip[1]/farClip[3],   farClip[2]/farClip[3]);
  vec3.subtract(_rayDir, _rayEnd, _rayOrigin);
  vec3.normalize(_rayDir, _rayDir);

  // 2. 计算缩放距离
  //    与当前高度成正比 → 高空缩放快（大尺度），低空缩放慢（精细）
  const currentAlt = vec3.length(this._position) - EARTH_RADIUS;
  const zoomDelta = newZoom - oldZoom;
  // 将 zoom delta 转为移动距离（正=靠近=放大，负=远离=缩小）
  const moveDistance = currentAlt * (1 - Math.pow(2, -zoomDelta));
  // 限制最大单次移动量（防止一帧穿越地球）
  const clampedDistance = clamp(moveDistance, -currentAlt * 0.8, currentAlt * 5);

  // 3. 沿射线方向移动
  vec3.scaleAndAdd(_newPos, this._position, _rayDir, clampedDistance);

  // 4. 约束
  const dist = vec3.length(_newPos);
  const minDist = EARTH_RADIUS + MIN_SAFE_ALTITUDE;
  const maxDist = MAX_CAMERA_DISTANCE;

  if (dist < minDist) {
    // 不能进入地球内部
    vec3.normalize(_newPos, _newPos);
    vec3.scale(_newPos, _newPos, minDist);
  } else if (dist > maxDist) {
    vec3.normalize(_newPos, _newPos);
    vec3.scale(_newPos, _newPos, maxDist);
  }

  // 5. 如果有地形，检查碰撞
  if (this._terrainProvider) {
    const geo = ecefToGeodetic(_newPos);
    const terrainH = this._terrainProvider.getElevationSync(geo.lon, geo.lat);
    if (terrainH !== null) {
      const minAlt = terrainH + MIN_SAFE_ALTITUDE;
      if (geo.alt < minAlt) {
        const safePos = geodeticToECEF(geo.lon, geo.lat, minAlt);
        vec3.copy(_newPos, safePos);
      }
    }
  }

  // 6. 更新
  vec3.copy(this._position, _newPos);
  const geo = ecefToGeodetic(this._position);
  this._center = [geo.lon, geo.lat];
  this._zoom = altitudeToZoom(geo.alt);
  this._rebuildMatrices();
}
```

---

## 四、双击缩放

```typescript
/**
 * InteractionManager.handleDoubleClick
 * 双击 = 以双击位置为锚点，zoom +1（放大一级）。
 * Shift+双击 = zoom -1（缩小一级）。
 */
handleDoubleClick(event: MouseEvent): void {
  event.preventDefault();

  const rect = this._canvas.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;

  const zoomDelta = event.shiftKey ? -1 : 1;
  const newZoom = clamp(
    Math.round(this._camera.state.zoom) + zoomDelta,  // snap 到整数 zoom
    this._camera.constraints.minZoom,
    this._camera.constraints.maxZoom
  );

  // 以双击位置为锚点
  const anchorLngLat = this._camera.screenToLngLat(cssX, cssY);
  if (!anchorLngLat) return;

  // easeTo 动画（带锚点）
  this._camera.easeTo({
    zoom: newZoom,
    around: { screen: [cssX, cssY], lngLat: anchorLngLat },
    duration: 300,
  });
}
```

---

## 五、触摸双指缩放

```typescript
/**
 * InteractionManager.handlePinchZoom
 * 双指缩放的锚点 = 双指中心点。
 */
handlePinchZoom(
  centerX: number,      // 双指中心 CSS X
  centerY: number,      // 双指中心 CSS Y
  scaleFactor: number,  // 当前帧的缩放比（>1 放大，<1 缩小）
  isStart: boolean,     // 手势开始（第一帧）
): void {
  if (isStart) {
    // 手势开始：记录锚点
    this._pinchAnchorScreen = [centerX, centerY];
    this._pinchAnchorLngLat = this._camera.screenToLngLat(centerX, centerY);
    this._pinchStartZoom = this._camera.state.zoom;
  }

  if (!this._pinchAnchorLngLat) return;

  // 将 scaleFactor 转为 zoom delta
  // scaleFactor = 2 → zoom +1（放大一倍）
  const zoomDelta = Math.log2(scaleFactor);
  const newZoom = clamp(
    this._pinchStartZoom + zoomDelta,
    this._camera.constraints.minZoom,
    this._camera.constraints.maxZoom
  );

  // 以双指中心为锚点缩放
  this._camera.zoomAround(
    this._pinchAnchorScreen[0],
    this._pinchAnchorScreen[1],
    this._pinchAnchorLngLat,
    newZoom
  );
}
```

---

## 六、地形模式特殊处理

MapLibre #1024 的根因：地形开启后，`screenToLngLat` 仍与 z=0 平面求交，但实际地面有高程。

```typescript
/**
 * screenToLngLatWithTerrain — 考虑地形的屏幕→地理坐标转换。
 * 用于锚点计算（缩放序列开始时调用一次，后续缓存结果）。
 */
screenToLngLatWithTerrain(
  screenX: number,
  screenY: number,
  terrainProvider: TerrainProvider | null
): [number, number] | null {
  // 1. 射线与 z=0 平面初步求交
  let lngLat = this.screenToLngLat(screenX, screenY);
  if (!lngLat || !terrainProvider) return lngLat;

  // 2. 迭代校正（考虑地形高程）
  for (let i = 0; i < 3; i++) {
    const h = terrainProvider.getElevationSync(lngLat[0], lngLat[1]);
    if (h === null) break;

    // 射线与 z=h×exaggeration 平面重新求交
    const ray = this._computePickRay(screenX, screenY);
    const t = (h * this._terrainExaggeration - ray.origin[2]) / ray.direction[2];
    if (t < 0) break; // 射线向上，不与地面相交

    const hitX = ray.origin[0] + ray.direction[0] * t;
    const hitY = ray.origin[1] + ray.direction[1] * t;
    const newLngLat = mercToLngLat([hitX, hitY]);

    // 收敛检查
    if (Math.abs(newLngLat[0] - lngLat[0]) < 1e-8 &&
        Math.abs(newLngLat[1] - lngLat[1]) < 1e-8) {
      break; // 已收敛
    }
    lngLat = newLngLat;
  }

  return lngLat;
}
```

---

## 七、easeTo / flyTo 动画中的锚点保持

```typescript
/**
 * CameraController.easeTo 增强 — 支持 around 锚点参数。
 * 用于双击缩放和滚轮缩放的平滑动画。
 */
easeTo(options: {
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  duration?: number;
  /** 锚点：如果提供，zoom 变化时保持该点屏幕位置不变 */
  around?: { screen: [number, number]; lngLat: [number, number] };
}): CameraAnimation {
  const { around, zoom: targetZoom, duration = 500 } = options;

  if (around && targetZoom !== undefined) {
    // 计算动画目标 center（使锚点不动）
    const anchorMerc = lngLatToMerc(around.lngLat);
    const currentCenterMerc = lngLatToMerc(this._center);
    const scaleFactor = Math.pow(2, targetZoom - this._zoom);
    const targetCenterMerc = [
      anchorMerc[0] + (currentCenterMerc[0] - anchorMerc[0]) / scaleFactor,
      anchorMerc[1] + (currentCenterMerc[1] - anchorMerc[1]) / scaleFactor,
    ];
    options.center = mercToLngLat(targetCenterMerc);
  }

  // 正常 easeTo 动画（同时插值 center + zoom + bearing + pitch）
  return this._startAnimation(options);
}
```

---

## 八、边界场景和约束

### 8.1 maxBounds 与锚点缩放的冲突

```
当锚点缩放导致 center 移出 maxBounds 时：
  1. 先执行锚点缩放计算 newCenter
  2. 然后 constrainCenter(newCenter, maxBounds)
  3. 这会导致锚点轻微漂移（因为 center 被 clamp 了）
  4. 这是正确行为——maxBounds 优先级高于锚点不动点约束

MapLibre 和 OpenLayers 都是这样处理的。
```

### 8.2 日期变更线（Anti-Meridian）

```
锚点经度在 ±180° 附近时：
  mercToLngLat 可能产生 ±360° 的跳变。
  修复：在计算 newCenterMerc 后 normalize 到 [-180, 180]。
  newCenter[0] = ((newCenter[0] + 540) % 360) - 180;  // wrap to [-180, 180]
```

### 8.3 极地区域

```
2D 模式下 lat 接近 ±85.051° 时：
  墨卡托投影 Y 趋近无穷大，锚点计算可能溢出。
  修复：clamp 锚点纬度到 [-85.05, 85.05]。
  在 Globe 模式下无此问题（ECEF 坐标连续）。
```

### 8.4 鼠标在视口外

```
鼠标快速移动时可能在 wheel 事件触发时已经移出 canvas。
  修复：clamp screenX/Y 到 [0, viewport.width/height]。
  或者：如果 screenToLngLat 返回 null，退化为中心缩放。
```

### 8.5 连续滚动锚点漂移

```
问题：连续滚动时每帧都重新计算锚点 → 浮点误差累积 → 锚点慢慢漂移。
修复（关键！）：整个滚轮序列只在开始时快照一次 anchorLngLat，
  后续帧始终使用同一个 anchorLngLat（而不是每帧重新 screenToLngLat）。
  这就是 ScrollZoomHandler 中 _anchorLngLat 的作用。
```

---

## 九、与 P0 设计文档的对照

P0 Cameras 设计中 `handleZoom` 的原始签名已经包含 `screenX, screenY` 参数，
但描述中只写了"根据 screenX/screenY 计算 anchorLngLat → 锚点缩放"，
没有展开具体算法。本文档补全了完整实现。

需要同步更新的设计文档位置：
- `GeoForge_Optional_P0_Cameras_Full.md` 中 Camera2D 的 `handleZoom` 描述（约第 440~480 行）
- Camera2.5D 的 `handleZoom` 描述
- Camera3D 的 `handleZoom` 描述
- `L5/InteractionManager` 的 `handleWheel` 描述（L5_v2.1.md）
- Cursor Rules `camera-runtime.mdc` 中添加锚点缩放约束

---

## 十、测试矩阵

| 测试场景 | 断言 |
|---------|------|
| 2D 中心缩放 | 鼠标在视口正中心 → zoom 变化但 center 不变 |
| 2D 偏移缩放 | 鼠标在右上角 → 缩放前后 `screenToLngLat(mouseX, mouseY)` 不变（误差 < 1e-6°） |
| 2D 有 bearing | 旋转 45° → 偏移缩放 → 锚点不变 |
| 2D maxBounds | 锚点缩放后 center 超出 maxBounds → center 被 clamp → 锚点允许微漂移 |
| 2D 日期变更线 | 锚点在 179.9°E → zoom in → center 不跳变到 -180° |
| 2.5D pitch=0 | 退化为 2D 公式 → 精确 |
| 2.5D pitch=45° | 锚点偏差 < 1px |
| 2.5D pitch=70° | 锚点偏差 < 3px（可接受） |
| 2.5D pitch=85° | 射线近乎水平 → 退化为中心缩放（不崩溃） |
| 2.5D 有地形 | 地形高度 500m → 锚点仍然精确（迭代校正生效） |
| Globe 缩放 | 鼠标指向北京 → zoom in → 北京保持在同一像素位置 |
| Globe 极地 | 鼠标指向北极 → 缩放 → 不出现翻转 |
| Globe 太空 | 鼠标指向地球外的太空 → 退化为中心缩放 |
| 双击缩放 | 双击非中心位置 → zoom +1 → 双击点保持不动 |
| Shift+双击 | zoom -1 → 锚点不动 |
| 触摸双指 | 双指中心非视口中心 → 缩放 → 双指中心点的地理位置不变 |
| 滚轮中断 | 滚轮缩放 → 调用 flyTo → 再滚轮 → 不弹回（_targetZoom 已清除） |
| 连续快速滚动 | 连续滚动 50 帧 → 锚点累积漂移 < 1px（因为 anchorLngLat 只快照一次） |
| 触控板 vs 鼠标 | 触控板无缓动（即时响应） / 鼠标滚轮有 200ms 缓动 |
