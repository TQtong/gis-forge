# 中键旋转修复 — Pivot Orbit（优化版）

> **问题**：中键拖拽是屏幕空间 bearing/pitch 直接映射，旋转中心与鼠标位置无关
> **目标**：中键按下锁定球面 pivot 点，拖拽时相机围绕 pivot 做轨道旋转
> **改动文件**：globe-types.ts / globe-interaction.ts / globe-3d.ts / globe-buffers.ts / globe-constants.ts

---

## 1. 问题

### 1.1 当前行为

```
中键按下 → isDragging = true
拖拽     → movementX × 0.003 → bearing 增量
           movementY × 0.003 → pitch 增量
           旋转中心 = camera.center（固定）
```

旋转中心与鼠标位置无关，灵敏度固定不随高度适配。

### 1.2 目标行为

```
中键按下 → screenToGlobe 射线求交 → pivot 点 P（ECEF）
           缓存 ENU 基向量（拖拽期间不变）
拖拽     → movementX/Y 帧间增量 → 累积 bearing/pitch
           重算相机在 pivot 球壳上的位置
           单次 setPosition + setOrientation 原子更新
```

---

## 2. 数据结构

### 2.1 GlobeInteractionState 扩展

```typescript
// globe-types.ts

export interface GlobeInteractionState {
    isDragging: boolean;
    dragButton: number;

    // ═══ 中键 Orbit 状态 ═══

    /** pivot ECEF [x,y,z]（米）。null = 未命中球面，走屏幕空间回退 */
    orbitPivot: Float64Array | null;

    /** 相机到 pivot 的距离（米），mouseDown 时锁定 */
    orbitDistance: number;

    /** 累积方位角（弧度），帧间 movementX 增量叠加 */
    orbitBearing: number;

    /** 累积仰角（弧度，负值=俯视），帧间 movementY 增量叠加 */
    orbitPitch: number;

    /**
     * pivot 点的 ENU 基向量（ECEF 表达），mouseDown 时算一次。
     * 9 个 float：[E.x, E.y, E.z, N.x, N.y, N.z, U.x, U.y, U.z]
     * 拖拽期间 pivot 不变 → ENU 不变 → 不重算
     */
    orbitENU: Float64Array | null;

    /** pivot 点的经纬度（弧度），mouseDown 时算一次，lookAt 用 */
    orbitPivotLngRad: number;
    orbitPivotLatRad: number;
}
```

### 2.2 预分配缓冲

```typescript
// globe-buffers.ts 新增

/** orbit 计算用临时 ECEF 缓冲（mouseDown 相机位置） */
export const _orbitCamECEF = new Float64Array(3);

/** orbit ENU 缓冲（9 float：E/N/U 各 3 分量） */
export const _orbitENUBuf = new Float64Array(9);
```

### 2.3 初始化

```typescript
// globe-3d.ts 构造函数
private readonly _interactionState: GlobeInteractionState = {
    isDragging: false,
    dragButton: -1,
    orbitPivot: null,
    orbitDistance: 0,
    orbitBearing: 0,
    orbitPitch: 0,
    orbitENU: null,
    orbitPivotLngRad: 0,
    orbitPivotLatRad: 0,
};
```

---

## 3. 常量

```typescript
// globe-constants.ts 新增

/**
 * 中键 orbit 灵敏度。
 * 单位：弧度 / 像素 / 米。
 * 实际灵敏度 = ORBIT_SENSITIVITY / distance（距离自适应）。
 *
 * 经验值：拖拽 500px 在 distance=1000km 时旋转约 90°。
 * 0.3 / 1e6 * 500 ≈ 0.00015 rad ... 太小。
 *
 * 用 viewport 归一化：delta_angle = (deltaPixels / viewportHeight) × π × factor
 * factor=1 时拖满屏幕 = 180° 旋转。factor=0.5 → 拖满屏幕 = 90°。
 */
export const ORBIT_FACTOR = 0.8;

/** 最大俯仰（弧度），-89°，避免万向锁 */
export const ORBIT_PITCH_MAX = -0.0175;  // ≈ -1°（几乎平视地面）

/** 最小俯仰（弧度），接近垂直俯视 */
export const ORBIT_PITCH_MIN = -Math.PI * 0.49;  // ≈ -88.2°
```

---

## 4. globe-interaction.ts 完整改造

### 4.1 工厂函数签名

```typescript
/**
 * @param pickGlobeECEF - 同步球面拾取，返回 ECEF [x,y,z] 或 null。
 *   由 Globe3D._pickGlobeSync 提供。
 * @param getViewportHeight - 返回视口 CSS 像素高度，灵敏度归一化用。
 */
export function createGlobeMouseHandlers(
    camera3D: Camera3D,
    options: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
    state: GlobeInteractionState,
    lifecycle: { isDestroyed: () => boolean },
    pickGlobeECEF: (screenX: number, screenY: number) => Float64Array | null,
    getViewportHeight: () => number,
): {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
} {
```

### 4.2 ENU 基向量计算（mouseDown 时调用一次）

```typescript
    /**
     * 计算 pivot 点的 ENU 基向量并写入 state.orbitENU。
     * ENU 定义（ECEF 列向量）：
     *   East  = [-sinλ,        cosλ,        0     ]
     *   North = [-sinφ·cosλ,  -sinφ·sinλ,   cosφ  ]
     *   Up    = [ cosφ·cosλ,   cosφ·sinλ,   sinφ  ]
     *
     * 其中 φ=纬度 λ=经度（弧度）。
     */
    function computeENUBasis(pivotECEF: Float64Array): void {
        // ECEF → 球面经纬度（atan2 精度对 ENU 基向量足够，不需要 Bowring）
        const lng = Math.atan2(pivotECEF[1], pivotECEF[0]);
        const p = Math.sqrt(pivotECEF[0] * pivotECEF[0] + pivotECEF[1] * pivotECEF[1]);
        const lat = Math.atan2(pivotECEF[2], p);

        state.orbitPivotLngRad = lng;
        state.orbitPivotLatRad = lat;

        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        const sinLng = Math.sin(lng);
        const cosLng = Math.cos(lng);

        const enu = _orbitENUBuf;
        // East
        enu[0] = -sinLng;
        enu[1] = cosLng;
        enu[2] = 0;
        // North
        enu[3] = -sinLat * cosLng;
        enu[4] = -sinLat * sinLng;
        enu[5] = cosLat;
        // Up
        enu[6] = cosLat * cosLng;
        enu[7] = cosLat * sinLng;
        enu[8] = sinLat;

        state.orbitENU = enu;
    }
```

### 4.3 mouseDown

```typescript
    const onMouseDown = (e: MouseEvent) => {
        if (lifecycle.isDestroyed()) return;

        if (e.button === 0 && options.enableRotate) {
            state.isDragging = true;
            state.dragButton = 0;
            camera3D.handlePanStart(e.clientX, e.clientY);

        } else if (e.button === 1 && options.enableTilt) {
            e.preventDefault();
            state.isDragging = true;
            state.dragButton = 1;

            // 射线求交（同步，基于上一帧 GlobeCamera）
            const pivotECEF = pickGlobeECEF(e.clientX, e.clientY);

            if (pivotECEF) {
                // 复用预分配缓冲——不 new
                if (!state.orbitPivot) {
                    state.orbitPivot = new Float64Array(3); // 仅首次，后续复用
                }
                state.orbitPivot[0] = pivotECEF[0];
                state.orbitPivot[1] = pivotECEF[1];
                state.orbitPivot[2] = pivotECEF[2];

                // ENU 基向量（整个拖拽期间不变）
                computeENUBasis(pivotECEF);

                // 相机 ECEF（复用 _orbitCamECEF 缓冲）
                const camPos = camera3D.getPosition();
                geodeticToECEF(
                    _orbitCamECEF,
                    camPos.lon * DEG2RAD,
                    camPos.lat * DEG2RAD,
                    camPos.alt,
                );

                // 相机到 pivot 的距离
                const dx = _orbitCamECEF[0] - pivotECEF[0];
                const dy = _orbitCamECEF[1] - pivotECEF[1];
                const dz = _orbitCamECEF[2] - pivotECEF[2];
                state.orbitDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                // 初始 bearing/pitch 从相机-pivot 向量在 ENU 中的投影求得
                // 而非从 camera3D.getOrientation()（那是相机自身姿态，不是相对 pivot 的角度）
                const enu = state.orbitENU!;
                // 在 ENU 基下投影 cam-pivot 向量
                const eastProj  = dx * enu[0] + dy * enu[1] + dz * enu[2];
                const northProj = dx * enu[3] + dy * enu[4] + dz * enu[5];
                const upProj    = dx * enu[6] + dy * enu[7] + dz * enu[8];

                state.orbitBearing = Math.atan2(eastProj, northProj);
                const horizDist = Math.sqrt(eastProj * eastProj + northProj * northProj);
                state.orbitPitch = -Math.atan2(upProj, horizDist); // 负值=俯视

            } else {
                // 未命中球面 → 标记为屏幕空间回退
                state.orbitPivot = null;
                state.orbitENU = null;
            }
        }
    };
```

### 4.4 mouseMove

```typescript
    const onMouseMove = (e: MouseEvent) => {
        if (!state.isDragging || lifecycle.isDestroyed()) return;

        if (state.dragButton === 0) {
            camera3D.handlePanMove(e.clientX, e.clientY);

        } else if (state.dragButton === 1) {
            if (state.orbitPivot && state.orbitENU) {
                // ════ Pivot Orbit 模式 ════

                // 帧间增量（movementX/Y 由浏览器提供，比自己算 delta 更准确）
                const mx = e.movementX;
                const my = e.movementY;
                if (mx === 0 && my === 0) return;

                // 灵敏度：viewport 归一化
                // 拖满屏幕 ≈ ORBIT_FACTOR × π 弧度旋转
                // 不依赖 distance——distance 已通过 orbit 几何天然适配
                const vpH = getViewportHeight();
                const angularPerPx = (ORBIT_FACTOR * PI) / Math.max(vpH, 1);

                // 累积 bearing / pitch
                state.orbitBearing += mx * angularPerPx;
                state.orbitPitch = Math.max(
                    ORBIT_PITCH_MIN,
                    Math.min(ORBIT_PITCH_MAX, state.orbitPitch - my * angularPerPx),
                );

                // 从 bearing + pitch + distance + pivot 重算相机位置
                applyCameraOrbit(camera3D, state);

            } else {
                // ════ 屏幕空间回退（指向太空时） ════
                const bearingDelta = e.movementX * ROTATE_SENSITIVITY;
                const pitchDelta = e.movementY * ROTATE_SENSITIVITY;
                camera3D.handleRotate(bearingDelta, pitchDelta);
            }
        }
    };
```

### 4.5 mouseUp

```typescript
    const onMouseUp = (_e: MouseEvent) => {
        if (!state.isDragging) return;

        if (state.dragButton === 0) {
            camera3D.handlePanEnd();
        }

        // orbit 状态保留（orbitPivot/orbitENU 不置 null）
        // 下次 mouseDown 会覆盖，避免不必要的 GC 触发

        state.isDragging = false;
        state.dragButton = -1;
    };
```

### 4.6 applyCameraOrbit 核心函数

```typescript
/**
 * 将相机放置在 pivot 的轨道上。
 * 从缓存的 ENU 基向量 + bearing/pitch/distance 直接算出 ECEF 位置，
 * 再 ECEF → 经纬高 → 单次 setPosition + setOrientation 原子更新。
 *
 * 每帧调用，零分配——全部使用预分配缓冲和 state 字段。
 *
 * 坐标系约定：
 *   bearing=0 → 相机在 pivot 正北方
 *   bearing=π/2 → 相机在 pivot 正东方
 *   pitch=0 → 相机在地平线高度（水平看 pivot）
 *   pitch=-π/4 → 相机在 45° 仰角俯视 pivot
 */
function applyCameraOrbit(camera3D: Camera3D, state: GlobeInteractionState): void {
    const pivot = state.orbitPivot!;
    const enu = state.orbitENU!;
    const dist = state.orbitDistance;
    const bearing = state.orbitBearing;
    const pitch = state.orbitPitch;

    // pitch 是负值（俯视），转为仰角（正值 = 上方）
    const elevation = -pitch;
    const cosEl = Math.cos(elevation);
    const sinEl = Math.sin(elevation);

    // 在 pivot 的 ENU 空间中的相机偏移
    const horizDist = dist * cosEl;
    const vertDist = dist * sinEl;

    const eastOff  = horizDist * Math.sin(bearing);
    const northOff = horizDist * Math.cos(bearing);
    const upOff    = vertDist;

    // ENU → ECEF（矩阵乘法，ENU 基向量已缓存）
    // camECEF = pivot + east*E + north*N + up*U
    const cx = pivot[0] + eastOff * enu[0] + northOff * enu[3] + upOff * enu[6];
    const cy = pivot[1] + eastOff * enu[1] + northOff * enu[4] + upOff * enu[7];
    const cz = pivot[2] + eastOff * enu[2] + northOff * enu[5] + upOff * enu[8];

    // ECEF → 经纬高（Bowring 2 次迭代，精度 < 1m）
    const camLngRad = Math.atan2(cy, cx);
    const p = Math.sqrt(cx * cx + cy * cy);
    let camLatRad = Math.atan2(cz, p * (1 - WGS84_E2));
    for (let i = 0; i < 2; i++) {
        const sinLat = Math.sin(camLatRad);
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
        camLatRad = Math.atan2(cz + WGS84_E2 * N * sinLat, p);
    }
    const sinFinal = Math.sin(camLatRad);
    const Nf = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinFinal * sinFinal);
    const camAlt = p / Math.cos(camLatRad) - Nf;

    // 相机看向 pivot → 计算 bearing 和 pitch
    // 相机到 pivot 的方位角（在相机位置的 ENU 中）
    // 简化：直接用轨道参数反推
    // lookBearing = orbit bearing + π（相机在 pivot 北方，看向 pivot = 看向南 = bearing+π）
    const lookBearing = state.orbitBearing + PI;
    // lookPitch = -elevation（相机在上方，看向下方）
    const lookPitch = pitch; // 已经是负值

    // 单次原子更新（不拆成 setPosition + lookAt 两步）
    camera3D.setPosition(
        camLngRad * RAD2DEG,
        camLatRad * RAD2DEG,
        Math.max(camAlt, 100),
    );
    camera3D.setOrientation(lookBearing, lookPitch, 0);
}
```

---

## 5. globe-3d.ts 桥接

### 5.1 同步拾取（返回预分配缓冲引用）

```typescript
// globe-3d.ts

/** 拾取输出缓冲——复用，不分配 */
private readonly _pickECEFBuf = new Float64Array(3);

/**
 * 同步球面拾取——返回 ECEF 坐标的预分配缓冲引用。
 * 调用方必须在同一同步回调中消费值（下次调用会覆盖）。
 *
 * @returns Float64Array(3) 引用或 null
 */
private _pickGlobeSync(screenX: number, screenY: number): Float64Array | null {
    if (!this._lastGlobeCam) return null;

    const gc = this._lastGlobeCam;
    const hit = screenToGlobe(
        screenX, screenY,
        gc.inverseVP_ECEF,
        gc.viewportWidth, gc.viewportHeight,
    );
    if (!hit) return null;

    const lonRad = hit[0] * DEG2RAD;
    const latRad = hit[1] * DEG2RAD;
    geodeticToECEF(this._pickECEFBuf as any, lonRad, latRad, 0);
    return this._pickECEFBuf;
}
```

### 5.2 构造函数传参

```typescript
const _handlers = createGlobeMouseHandlers(
    this._camera3D,
    { enableRotate: this._enableRotate, enableZoom: this._enableZoom, enableTilt: this._enableTilt },
    this._interactionState,
    { isDestroyed: () => this._destroyed },
    (sx, sy) => this._pickGlobeSync(sx, sy),
    () => this._viewport.height,
);
```

---

## 6. 灵敏度设计

### 6.1 为什么不用 distance 除法

上一版用 `atan2(1, distance)` 做灵敏度——distance=1000km 时 sensitivity ≈ 10⁻⁶ rad/px，拖满 1000px 屏幕只转 0.001 弧度 ≈ 0.06°。基本不动。

### 6.2 viewport 归一化（本版方案）

```typescript
const angularPerPx = (ORBIT_FACTOR * PI) / viewportHeight;
```

与距离无关。拖满整个视口高度 = 旋转 `ORBIT_FACTOR × 180°`。

`ORBIT_FACTOR=0.8` → 拖满屏幕 ≈ 144° 旋转。近处远处手感一致。

距离适配由 orbit 几何天然提供——近处（distance 小）同样的角度变化对应更小的地面位移，远处对应更大位移。不需要额外缩放。

### 6.3 与 CesiumJS 对比

CesiumJS 的 `_tilt3D` 实际上也是 viewport 归一化：
```javascript
// CesiumJS ScreenSpaceCameraController.js
var startPosition = ...; // NDC [-1,1]
var movement = ...; // NDC delta
var angle = ... * movement; // 角度与 NDC delta 成正比
```

NDC delta = pixel delta / viewport size，本质与 `pixelDelta / viewportHeight` 相同。

---

## 7. 初始 bearing/pitch 的正确计算

### 7.1 上一版的错误

```typescript
// 错误：使用相机自身姿态
const orient = camera3D.getOrientation();
state.orbitBearing = orient.bearing;
state.orbitPitch = orient.pitch;
```

相机的 bearing/pitch 是相对自身注视方向的，不是相对 pivot 的轨道角度。当相机不是正对 pivot 时（比如 pivot 在视口角落），两者差异很大。

### 7.2 本版修正

从相机-pivot 向量在 ENU 基下的投影求得真实轨道角度：

```typescript
const dx = camECEF[0] - pivot[0];
const dy = camECEF[1] - pivot[1];
const dz = camECEF[2] - pivot[2];

// 在 pivot 的 ENU 基下投影
const eastProj  = dx * enu[0] + dy * enu[1] + dz * enu[2];
const northProj = dx * enu[3] + dy * enu[4] + dz * enu[5];
const upProj    = dx * enu[6] + dy * enu[7] + dz * enu[8];

state.orbitBearing = Math.atan2(eastProj, northProj);  // 方位角
const horizDist = Math.sqrt(eastProj * eastProj + northProj * northProj);
state.orbitPitch = -Math.atan2(upProj, horizDist);      // 仰角（取负=俯视）
```

这保证拖拽开始瞬间相机不跳变——初始轨道角度精确匹配当前视图。

---

## 8. ECEF → 经纬高精度

### 8.1 上一版的错误

```typescript
const camAlt = camR - WGS84_A; // 球面近似，最大误差 21km
```

### 8.2 本版修正：Bowring 2 次迭代

```typescript
const p = Math.sqrt(cx * cx + cy * cy);
let camLatRad = Math.atan2(cz, p * (1 - WGS84_E2));
for (let i = 0; i < 2; i++) {
    const sinLat = Math.sin(camLatRad);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    camLatRad = Math.atan2(cz + WGS84_E2 * N * sinLat, p);
}
const sinFinal = Math.sin(camLatRad);
const Nf = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinFinal * sinFinal);
const camAlt = p / Math.cos(camLatRad) - Nf;
```

精度 < 1m，与 `screenToGlobe` 中已有的 Bowring 迭代一致。

---

## 9. 边界保护

| 场景 | 行为 |
|------|------|
| 鼠标指向太空（未命中球面） | `orbitPivot = null` → 回退屏幕空间旋转 |
| 首帧（`_lastGlobeCam` 为 null） | `_pickGlobeSync` 返回 null → 回退 |
| pitch 到达垂直俯视 | clamp 到 `-0.49π`（≈88.2°），避免万向锁 |
| pitch 接近地平线 | clamp 到 `-1°`，避免相机穿入地面 |
| altitude < 100m | setPosition 中 `Math.max(camAlt, 100)` |
| movementX/Y = 0 | 提前 return，跳过无效计算 |
| 极地 pivot（lat ≈ ±90°） | ENU 中 North 退化但 Up 仍有效，orbit 数学正确 |

---

## 10. 性能

### 10.1 每帧开销（mouseMove 期间）

| 操作 | 调用次数 | 类型 |
|------|---------|------|
| `Math.cos` / `Math.sin` | 4 | trig（bearing/elevation） |
| 3×3 矩阵-向量乘（ENU→ECEF） | 1 | 9 乘法 + 6 加法 |
| Bowring 迭代 | 2 次 | 2×(sin+sqrt+atan2) |
| `setPosition` + `setOrientation` | 1+1 | API 调用 |
| **总计** | | ~20 个浮点运算 |

### 10.2 不做的事

- ENU 基向量不重算（mouseDown 缓存）
- 不调 `screenToGlobe`（只在 mouseDown 调一次）
- 不调 `lookAt`（直接算 orientation）
- 不分配对象（预分配缓冲 + state 字段）

---

## 11. 与上一版对比

| 项目 | 上一版 | 优化版 |
|------|--------|--------|
| ENU 基向量 | 每次 move 算 | mouseDown 算一次，缓存 |
| Delta 来源 | 绝对 delta（从 startScreen） | 帧间增量 `movementX/Y` |
| 灵敏度 | `atan2(1, distance)`（远距离退化为零） | viewport 归一化（距离无关） |
| 初始 bearing/pitch | 取 camera orientation（语义错误） | ENU 投影（精确轨道角） |
| ECEF→经纬高 | `camR - WGS84_A`（球面，误差 21km） | Bowring 2 次迭代（< 1m） |
| 相机更新 | setPosition + lookAt（两步，可能闪烁） | setPosition + setOrientation（原子） |
| 分配 | mouseDown 时 `new Float64Array(3)` | 首次分配后复用 |
| mouseUp 清理 | 置 null（触发 GC） | 保留缓冲，下次覆盖 |

---

## 12. 文件改动清单

| 文件 | 改动 | 行数 |
|------|------|------|
| `globe-types.ts` | `GlobeInteractionState` 新增 7 个字段 | +14 |
| `globe-buffers.ts` | `_orbitCamECEF` + `_orbitENUBuf` | +4 |
| `globe-constants.ts` | `ORBIT_FACTOR` + `ORBIT_PITCH_MIN/MAX` | +6 |
| `globe-interaction.ts` | 签名 +2 参数 | +2 |
| `globe-interaction.ts` | `computeENUBasis` 函数 | +25 |
| `globe-interaction.ts` | mouseDown 中键重写 | +35 / -4 |
| `globe-interaction.ts` | mouseMove 中键重写 | +20 / -3 |
| `globe-interaction.ts` | mouseUp 简化 | +1 / -4 |
| `globe-interaction.ts` | `applyCameraOrbit` 函数 | +45 |
| `globe-3d.ts` | `_pickECEFBuf` + `_pickGlobeSync` | +16 |
| `globe-3d.ts` | 构造函数传参 | +2 / -1 |
| **总计** | | **+170 / -12** |

### 不受影响

| 文件 | 原因 |
|------|------|
| 左键拖拽 | `handlePanStart/Move/End` 路径独立 |
| 滚轮缩放 | `handleZoom` 路径独立 |
| globe-render.ts | 渲染循环无交互逻辑 |
| globe-shaders.ts | shader 无交互逻辑 |
| globe-tile-mesh.ts | 瓦片网格无交互逻辑 |
| globe-camera.ts | 相机矩阵计算由 Camera3D.update 驱动，不受 interaction 影响 |
