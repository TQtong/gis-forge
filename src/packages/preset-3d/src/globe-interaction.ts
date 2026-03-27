/**
 * @module preset-3d/globe-interaction
 * @description
 * 指针设备与滚轮到 {@link import('../../camera-3d/src/Camera3D.ts').Camera3D} 的映射，以及 **2D↔3D morph** 状态机（当前仅事件与计时，渲染路径仍以 3D globe 为主）。
 *
 * 中键拖拽采用 **Pivot Orbit** 模式：
 * 1. mouseDown 时射线求交球面得到 pivot ECEF，并缓存 ENU 基向量；
 * 2. mouseMove 时帧间增量累积 bearing/pitch，重算相机在 pivot 球壳上的位置；
 * 3. 若 mouseDown 未命中球面（鼠标指向太空），回退为屏幕空间 bearing/pitch 增量。
 *
 * @stability experimental
 */

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import {
    geodeticToECEF,
    WGS84_A,
    WGS84_E2,
} from '../../core/src/geo/ellipsoid.ts';
import type { Vec3d } from '../../core/src/geo/ellipsoid.ts';
import { _orbitCamECEF, _orbitENUBuf } from './globe-buffers.ts';
import {
    DEG2RAD,
    ORBIT_FACTOR,
    ORBIT_PITCH_MAX,
    ORBIT_PITCH_MIN,
    PI,
    RAD2DEG,
    ROTATE_SENSITIVITY,
    ZOOM_SENSITIVITY,
} from './globe-constants.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';

// ════════════════════════════════════════════════════════════════
// applyCameraOrbit — 核心轨道更新
// ════════════════════════════════════════════════════════════════

/**
 * 将相机放置在 pivot 的轨道上。
 * 从缓存的 ENU 基向量 + bearing/pitch/distance 直接算出 ECEF 位置，
 * 再 ECEF → 经纬高 → 单次 `setPosition` + `setOrientation` 原子更新。
 *
 * 每帧调用，零分配——全部使用预分配缓冲和 state 字段。
 *
 * 坐标系约定：
 *   bearing=0 → 相机在 pivot 正北方
 *   bearing=π/2 → 相机在 pivot 正东方
 *   pitch=0 → 相机在地平线高度（水平看 pivot）
 *   pitch=-π/4 → 相机在 45° 仰角俯视 pivot
 *
 * @param camera3D - 接收 setPosition / setOrientation 的相机
 * @param state - 含 orbitPivot / orbitENU / orbitBearing / orbitPitch / orbitDistance
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
    // horizDist: 水平面内到 pivot 的距离
    // vertDist:  垂直于水平面的高度偏移
    const horizDist = dist * cosEl;
    const vertDist = dist * sinEl;

    // ENU 分量：东向 = horizDist × sin(bearing)，北向 = horizDist × cos(bearing)
    const eastOff  = horizDist * Math.sin(bearing);
    const northOff = horizDist * Math.cos(bearing);
    const upOff    = vertDist;

    // ENU → ECEF（矩阵乘法，ENU 基向量已在 mouseDown 缓存）
    // camECEF = pivot + east×E + north×N + up×U
    const cx = pivot[0] + eastOff * enu[0] + northOff * enu[3] + upOff * enu[6];
    const cy = pivot[1] + eastOff * enu[1] + northOff * enu[4] + upOff * enu[7];
    const cz = pivot[2] + eastOff * enu[2] + northOff * enu[5] + upOff * enu[8];

    // ── ECEF → 经纬高（Bowring 2 次迭代，精度 < 1m） ──
    const camLngRad = Math.atan2(cy, cx);
    const p = Math.sqrt(cx * cx + cy * cy);

    // 初始近似纬度
    let camLatRad = Math.atan2(cz, p * (1 - WGS84_E2));

    // Bowring 迭代：每次用当前 lat 计算 N，再更新 lat
    for (let i = 0; i < 2; i++) {
        const sinLat = Math.sin(camLatRad);
        // N = 卯酉圈曲率半径
        const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
        // 修正公式：lat = atan2(Z + e²·N·sinφ, p)
        camLatRad = Math.atan2(cz + WGS84_E2 * N * sinLat, p);
    }

    // 最终高程：p / cos(lat) - N
    const sinFinal = Math.sin(camLatRad);
    const Nf = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinFinal * sinFinal);

    // 使用 p / cos(lat) 计算高程；极点附近 cos→0 时退化到 |z|/|sin|-N*(1-e²)
    const cosLatFinal = Math.cos(camLatRad);
    let camAlt: number;
    if (Math.abs(cosLatFinal) > 1e-10) {
        camAlt = p / cosLatFinal - Nf;
    } else {
        // 极点附近用 Z 分量推算
        camAlt = Math.abs(cz) / Math.abs(sinFinal) - Nf * (1.0 - WGS84_E2);
    }

    // ── 相机看向 pivot → 计算 lookBearing 和 lookPitch ──
    // lookBearing = orbit bearing + π（相机在 pivot 北方，看向 pivot = 看向南 = bearing+π）
    const lookBearing = state.orbitBearing + PI;
    // lookPitch = pitch 本身已是负值（俯视方向）
    const lookPitch = pitch;

    // 单次原子更新（不拆成 setPosition + lookAt 两步，避免中间帧闪烁）
    // setPosition 接受度数，setOrientation 接受弧度
    camera3D.setPosition(
        camLngRad * RAD2DEG,
        camLatRad * RAD2DEG,
        Math.max(camAlt, 100), // 最低 100m，避免相机穿入地面
    );
    camera3D.setOrientation(lookBearing, lookPitch, 0);
}

// ════════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════════

/**
 * 工厂：返回一组可绑定到 DOM 的事件处理器；闭包捕获 `camera3D` 与可变 `state`。
 *
 * @param camera3D - 接收 pan / rotate / zoom
 * @param options - 功能开关：左键轨道、滚轮缩放、中键倾斜
 * @param state - 拖拽中与按钮 id；由本模块读写
 * @param lifecycle - `isDestroyed` 用于销毁后忽略回调
 * @param pickGlobeECEF - 同步球面拾取，返回 ECEF [x,y,z] 或 null。
 *   由 Globe3D._pickGlobeSync 提供。调用方必须在同一同步回调中消费值。
 * @param getViewportHeight - 返回视口 CSS 像素高度，灵敏度归一化用。
 * @returns `onMouseDown` / `onMouseMove` / `onMouseUp` / `onWheel` / `onContextMenu`
 *
 * @remarks
 * - 左键：`handlePanStart`/`Move`/`End`
 * - 中键：pivot orbit（射线求交 → ENU 缓存 → bearing/pitch 累积 → 轨道重算）
 *   或屏幕空间回退（指向太空时）
 * - 滚轮：`handleZoom`（`deltaY × ZOOM_SENSITIVITY`）
 *
 * @stability experimental
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

    // ────────────────────────────────────────────────────────────
    // ENU 基向量计算（mouseDown 中键时调用一次）
    // ────────────────────────────────────────────────────────────

    /**
     * 计算 pivot 点的 ENU 基向量并写入 `state.orbitENU`（引用 `_orbitENUBuf`）。
     *
     * ENU 定义（ECEF 列向量）：
     *   East  = [-sinλ,        cosλ,        0     ]
     *   North = [-sinφ·cosλ,  -sinφ·sinλ,   cosφ  ]
     *   Up    = [ cosφ·cosλ,   cosφ·sinλ,   sinφ  ]
     *
     * 其中 φ=纬度 λ=经度（弧度）。
     *
     * @param pivotECEF - pivot 点 ECEF 坐标 [x,y,z]
     */
    function computeENUBasis(pivotECEF: Float64Array): void {
        // ECEF → 球面经纬度（atan2 精度对 ENU 基向量足够，不需要 Bowring）
        const lng = Math.atan2(pivotECEF[1], pivotECEF[0]);
        const p = Math.sqrt(pivotECEF[0] * pivotECEF[0] + pivotECEF[1] * pivotECEF[1]);
        const lat = Math.atan2(pivotECEF[2], p);

        // 缓存 pivot 经纬度供 lookAt 使用
        state.orbitPivotLngRad = lng;
        state.orbitPivotLatRad = lat;

        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        const sinLng = Math.sin(lng);
        const cosLng = Math.cos(lng);

        const enu = _orbitENUBuf;

        // East：[-sinλ, cosλ, 0]
        enu[0] = -sinLng;
        enu[1] = cosLng;
        enu[2] = 0;

        // North：[-sinφ·cosλ, -sinφ·sinλ, cosφ]
        enu[3] = -sinLat * cosLng;
        enu[4] = -sinLat * sinLng;
        enu[5] = cosLat;

        // Up：[cosφ·cosλ, cosφ·sinλ, sinφ]
        enu[6] = cosLat * cosLng;
        enu[7] = cosLat * sinLng;
        enu[8] = sinLat;

        // state 持有此缓冲的引用——拖拽期间 pivot 不变则 ENU 不变
        state.orbitENU = enu;
    }

    // ────────────────────────────────────────────────────────────
    // 事件处理器
    // ────────────────────────────────────────────────────────────

    /**
     * mouseDown：
     * - 左键（button=0）→ `handlePanStart`
     * - 中键（button=1）→ 射线求交得 pivot → ENU 缓存 → 初始 orbit 角度
     */
    const onMouseDown = (e: MouseEvent) => {
        if (lifecycle.isDestroyed()) { return; }

        if (e.button === 0 && options.enableRotate) {
            // ════ 左键：轨道平移 ════
            state.isDragging = true;
            state.dragButton = 0;
            camera3D.handlePanStart(e.clientX, e.clientY);

        } else if (e.button === 1 && options.enableTilt) {
            // ════ 中键：pivot orbit ════
            e.preventDefault();
            state.isDragging = true;
            state.dragButton = 1;

            // 射线求交（同步，基于上一帧 GlobeCamera）
            const pivotECEF = pickGlobeECEF(e.clientX, e.clientY);

            if (pivotECEF) {
                // 复用预分配缓冲——仅首次 new，后续覆盖
                if (!state.orbitPivot) {
                    state.orbitPivot = new Float64Array(3);
                }
                state.orbitPivot[0] = pivotECEF[0];
                state.orbitPivot[1] = pivotECEF[1];
                state.orbitPivot[2] = pivotECEF[2];

                // ENU 基向量（整个拖拽期间不变）
                computeENUBasis(pivotECEF);

                // 相机 ECEF（复用 _orbitCamECEF 模块级缓冲）
                const camPos = camera3D.getPosition();
                geodeticToECEF(
                    _orbitCamECEF as unknown as Vec3d,
                    camPos.lon * DEG2RAD,
                    camPos.lat * DEG2RAD,
                    camPos.alt,
                );

                // 相机到 pivot 的距离（拖拽期间锁定）
                // 下限 100m 防止相机恰好在 pivot 点时方向向量长度为零 →
                // ENU 投影退化 → atan2(0,0) → 后续 sin/cos 产生 NaN → VP 矩阵污染 → 渲染崩溃
                // 参考：CesiumJS #6783 / #7094 / PR #3605（零向量归一化致命 bug）
                const dx = _orbitCamECEF[0] - pivotECEF[0];
                const dy = _orbitCamECEF[1] - pivotECEF[1];
                const dz = _orbitCamECEF[2] - pivotECEF[2];
                state.orbitDistance = Math.max(
                    Math.sqrt(dx * dx + dy * dy + dz * dz),
                    100, // 最小轨道半径 100m，远小于任何实际操作距离，用户无感知
                );

                // 初始 bearing/pitch 从相机-pivot 向量在 ENU 中的投影求得
                // 不能用 camera3D.getOrientation()——那是相机自身姿态，不是相对 pivot 的轨道角度
                const enu = state.orbitENU!;

                // 在 ENU 基下投影 cam-pivot 向量
                const eastProj  = dx * enu[0] + dy * enu[1] + dz * enu[2];
                const northProj = dx * enu[3] + dy * enu[4] + dz * enu[5];
                const upProj    = dx * enu[6] + dy * enu[7] + dz * enu[8];

                // 方位角：atan2(east, north)
                state.orbitBearing = Math.atan2(eastProj, northProj);

                // 仰角：-atan2(up, horizDist)，负值=俯视
                const horizDist = Math.sqrt(eastProj * eastProj + northProj * northProj);
                state.orbitPitch = -Math.atan2(upProj, horizDist);

            } else {
                // 未命中球面 → 标记为屏幕空间回退
                state.orbitPivot = null;
                state.orbitENU = null;
            }
        }
    };

    /**
     * mouseMove：
     * - 左键 → `handlePanMove`
     * - 中键 + pivot → orbit 累积 bearing/pitch + applyCameraOrbit
     * - 中键 + no pivot → 屏幕空间回退
     */
    const onMouseMove = (e: MouseEvent) => {
        if (!state.isDragging || lifecycle.isDestroyed()) { return; }

        if (state.dragButton === 0) {
            // ════ 左键平移 ════
            camera3D.handlePanMove(e.clientX, e.clientY);

        } else if (state.dragButton === 1) {
            if (state.orbitPivot && state.orbitENU) {
                // ════ Pivot Orbit 模式 ════

                // 帧间增量（movementX/Y 由浏览器提供，比自己算 delta 更准确）
                const mx = e.movementX;
                const my = e.movementY;

                // 无位移时跳过无效计算
                if (mx === 0 && my === 0) { return; }

                // 灵敏度：viewport 归一化
                // 拖满屏幕高度 ≈ ORBIT_FACTOR × π 弧度旋转
                // 不依赖 distance——distance 已通过 orbit 几何天然适配
                const vpH = getViewportHeight();
                const angularPerPx = (ORBIT_FACTOR * PI) / Math.max(vpH, 1);

                // 累积 bearing（水平方向）
                state.orbitBearing += mx * angularPerPx;

                // 累积 pitch（垂直方向），clamp 在 [ORBIT_PITCH_MIN, ORBIT_PITCH_MAX]
                // my > 0 → 鼠标下移 → pitch 更负（更俯视）→ 减去
                state.orbitPitch = Math.max(
                    ORBIT_PITCH_MIN,
                    Math.min(ORBIT_PITCH_MAX, state.orbitPitch - my * angularPerPx),
                );

                // 从 bearing + pitch + distance + pivot 重算相机 ECEF 位置
                applyCameraOrbit(camera3D, state);

            } else {
                // ════ 屏幕空间回退（指向太空时） ════
                const bearingDelta = e.movementX * ROTATE_SENSITIVITY;
                const pitchDelta = e.movementY * ROTATE_SENSITIVITY;
                camera3D.handleRotate(bearingDelta, pitchDelta);
            }
        }
    };

    /**
     * mouseUp：
     * - 左键 → `handlePanEnd`
     * - 中键 → 仅重置 isDragging/dragButton
     *
     * orbit 状态（orbitPivot/orbitENU）保留——下次 mouseDown 会覆盖。
     * 避免不必要的 GC 触发。
     */
    const onMouseUp = (_e: MouseEvent) => {
        if (!state.isDragging) { return; }

        if (state.dragButton === 0) {
            camera3D.handlePanEnd();
        }

        // orbit 状态保留（orbitPivot/orbitENU 不置 null）
        // 下次 mouseDown 会覆盖，避免不必要的 GC 触发

        state.isDragging = false;
        state.dragButton = -1;
    };

    /**
     * wheel：滚轮缩放。与 orbit 系统独立。
     */
    const onWheel = (e: WheelEvent) => {
        if (lifecycle.isDestroyed() || !options.enableZoom) { return; }

        e.preventDefault();

        // deltaY > 0 = 向下滚 = 拉远，取反使 handleZoom 正值=放大
        const delta = -e.deltaY * ZOOM_SENSITIVITY;
        camera3D.handleZoom(delta, e.clientX, e.clientY);
    };

    /**
     * contextmenu：阻止右键菜单。
     */
    const onContextMenu = (e: Event) => {
        e.preventDefault();
    };

    return { onMouseDown, onMouseMove, onMouseUp, onWheel, onContextMenu };
}

/**
 * 启动视图 morph：设置 `morphState` 时间戳并用 `requestAnimationFrame` 轮询直到 `t≥1`。
 *
 * @param morphState - 读写 `morphing` / 时间 / `viewMode` / `morphTarget`
 * @param target - 目标视图模式
 * @param durationMs - 动画时长（毫秒），下限 16ms
 * @param emit - 与 `Globe3D._emit` 兼容的 `(type, payload)`
 * @param isDestroyed - 为 true 时停止轮询
 *
 * @remarks
 * 若 `viewMode === target` 则立即返回；完成时 `viewMode = morphTarget` 并 `emit('morph:complete')`。
 */
export function runMorph(
    morphState: MorphState,
    target: '2d' | '25d' | '3d',
    durationMs: number,
    emit: (type: string, payload: unknown) => void,
    isDestroyed: () => boolean,
): void {
    // 已在目标模式则无需动画
    if (morphState.viewMode === target) { return; }

    morphState.morphing = true;
    morphState.morphStartTime = performance.now();
    morphState.morphDuration = Math.max(durationMs, 16);
    morphState.morphTarget = target;

    emit('morph:start', { from: morphState.viewMode, to: target });

    /**
     * 每帧检查 morph 进度。
     * t ∈ [0,1]，t≥1 时结束动画并 emit 'morph:complete'。
     */
    const checkMorph = (): void => {
        if (isDestroyed() || !morphState.morphing) { return; }

        const elapsed = performance.now() - morphState.morphStartTime;
        const t = Math.min(elapsed / morphState.morphDuration, 1.0);

        if (t >= 1.0) {
            // 动画完成
            morphState.morphing = false;
            morphState.viewMode = morphState.morphTarget;
            emit('morph:complete', { mode: morphState.viewMode });
        } else {
            // 继续轮询
            requestAnimationFrame(checkMorph);
        }
    };

    requestAnimationFrame(checkMorph);
}
