// ============================================================
// preset-3d/screen-space-camera-controller.ts — Cesium 兼容交互控制器
// 层级：L6
// 职责：将鼠标/滚轮/触摸事件映射到 Camera3D 的旋转/缩放操作。
//       实现 Cesium ScreenSpaceCameraController 的核心算法：
//       spin3D（左键拖拽）、zoom3D（滚轮/右键）、tilt3D（中键/Ctrl+左键）。
// 依赖：Camera3D（ECEF 向量模型）
// 被消费：globe-3d.ts（通过 globe-interaction.ts 桥接）
// ============================================================

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import { WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import { computeENUBasis } from '../../core/src/geo/enu.ts';

// ============================================================
// 常量
// ============================================================

/** 旋转速率基准因子（1/半径） */
const ROTATE_FACTOR = 1.0 / WGS84_A;

/** 旋转速率范围调整（半径偏移） */
const ROTATE_RANGE_ADJ = WGS84_A;

/** 最小旋转速率 */
const MIN_ROTATE_RATE = 1.0 / 5000.0;

/** 最大旋转速率 */
const MAX_ROTATE_RATE = 1.77;

/** 缩放因子 */
const ZOOM_FACTOR = 5.0;

/** 最小 trackball 高度（米），高于此高度时未命中球面走 trackball */
const MIN_TRACKBALL_HEIGHT = 7_500_000;

/** 最小拾取地形高度（米），低于此高度时使用深度缓冲拾取 */
const MIN_PICKING_TERRAIN_HEIGHT = 150_000;

/** 惯性衰减指数基础 */
const INERTIA_DECAY = 0.9;

/** 惯性最小速度阈值 */
const INERTIA_EPS = 1e-7;

/** 惯性时间窗口（ms） */
const INERTIA_TIME_WINDOW = 50;

const TWO_PI = Math.PI * 2;
const PI = Math.PI;

// ============================================================
// 模块级预分配缓冲区
// ============================================================

const _enuE = new Float64Array(3);
const _enuN = new Float64Array(3);
const _enuU = new Float64Array(3);
const _tmpA = new Float64Array(3);
const _tmpB = new Float64Array(3);

// ============================================================
// 交互模式枚举
// ============================================================

const SpinMode = {
    NONE: 0,
    PAN: 1,        // 球面命中 → arcball pan
    ROTATE: 2,     // 未命中 + 高空 → trackball rotate
    LOOK: 3,       // 未命中 + 低空 → free look
    STRAFE: 4,     // 近切线 → 平移
} as const;
type SpinMode = typeof SpinMode[keyof typeof SpinMode];

// ============================================================
// ScreenSpaceCameraController
// ============================================================

/**
 * Cesium 兼容的屏幕空间相机控制器。
 *
 * 输入映射：
 *   左键拖拽 → spin3D（pan / rotate / look / strafe）
 *   右键拖拽 → zoom3D
 *   滚轮     → zoom3D
 *   中键拖拽 → tilt3D
 *   Ctrl+左键 → tilt3D
 */
export class ScreenSpaceCameraController {
    private _camera: Camera3D;
    private _canvas: HTMLCanvasElement;

    // ── 启用标志 ──
    enableRotate = true;
    enableZoom = true;
    enableTilt = true;
    enableLook = true;

    // ── spin3D 状态 ──
    private _spinMode: SpinMode = SpinMode.NONE;
    private _spinStartECEF: Float64Array | null = null;  // pan 模式下的初始球面命中点

    // ── 拖拽跟踪 ──
    private _dragging = false;
    private _dragButton = -1;
    private _ctrlKey = false;
    private _lastX = 0;
    private _lastY = 0;
    private _startX = 0;
    private _startY = 0;
    private _lastMoveTime = 0;

    // ── 惯性 ──
    private _inertiaH = 0;   // 水平惯性角速度 (rad/frame)
    private _inertiaV = 0;   // 垂直惯性角速度 (rad/frame)
    private _inertiaActive = false;

    // ── 事件绑定引用（用于清理） ──
    private _onMouseDown: (e: MouseEvent) => void;
    private _onMouseMove: (e: MouseEvent) => void;
    private _onMouseUp: (e: MouseEvent) => void;
    private _onWheel: (e: WheelEvent) => void;
    private _onContextMenu: (e: Event) => void;

    private _destroyed = false;

    constructor(camera: Camera3D, canvas: HTMLCanvasElement) {
        this._camera = camera;
        this._canvas = canvas;

        // 绑定事件
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onWheel = this._handleWheel.bind(this);
        this._onContextMenu = (e: Event) => e.preventDefault();

        canvas.addEventListener('mousedown', this._onMouseDown);
        canvas.addEventListener('mousemove', this._onMouseMove);
        canvas.addEventListener('mouseup', this._onMouseUp);
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        canvas.addEventListener('contextmenu', this._onContextMenu);
        // 全局 mouseup 以处理拖出 canvas 的情况
        window.addEventListener('mouseup', this._onMouseUp);
    }

    /**
     * 每帧更新：处理惯性动画。
     * 应在 Camera3D.update() 之前调用。
     *
     * @param dt - 帧间隔（秒）
     */
    update(dt: number): void {
        if (this._destroyed || this._dragging) return;

        if (this._inertiaActive) {
            const decay = Math.pow(INERTIA_DECAY, dt * 60);
            this._inertiaH *= decay;
            this._inertiaV *= decay;

            if (Math.abs(this._inertiaH) > INERTIA_EPS || Math.abs(this._inertiaV) > INERTIA_EPS) {
                this._camera.rotateRight(this._inertiaH);
                this._camera.rotateUp(this._inertiaV);
            } else {
                this._inertiaActive = false;
                this._inertiaH = 0;
                this._inertiaV = 0;
            }
        }
    }

    /**
     * 销毁控制器，移除所有事件监听。
     */
    destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        this._canvas.removeEventListener('mousemove', this._onMouseMove);
        this._canvas.removeEventListener('mouseup', this._onMouseUp);
        this._canvas.removeEventListener('wheel', this._onWheel);
        this._canvas.removeEventListener('contextmenu', this._onContextMenu);
        window.removeEventListener('mouseup', this._onMouseUp);
    }

    // ════════════════════════════════════════════════════════════
    // 事件处理器
    // ════════════════════════════════════════════════════════════

    private _handleMouseDown(e: MouseEvent): void {
        if (this._destroyed) return;
        e.preventDefault();

        this._dragging = true;
        this._dragButton = e.button;
        this._ctrlKey = e.ctrlKey;
        this._startX = e.clientX;
        this._startY = e.clientY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._lastMoveTime = performance.now();
        this._inertiaActive = false;

        // 确定 spin 模式（左键拖拽）
        if (e.button === 0 && !e.ctrlKey && this.enableRotate) {
            this._determineSpin3DMode(e.clientX, e.clientY);
        }
    }

    private _handleMouseMove(e: MouseEvent): void {
        if (this._destroyed || !this._dragging) return;

        const dx = e.clientX - this._lastX;
        const dy = e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;

        const now = performance.now();
        const dtMs = Math.max(1, now - this._lastMoveTime);
        this._lastMoveTime = now;

        if (dx === 0 && dy === 0) return;

        if (this._dragButton === 0 && !this._ctrlKey && this.enableRotate) {
            // ── 左键：spin3D ──
            this._spin3D(e.clientX, e.clientY, dx, dy, dtMs);
        } else if (this._dragButton === 2 && this.enableZoom) {
            // ── 右键：拖拽缩放 ──
            this._zoom3DDrag(dy);
        } else if ((this._dragButton === 1 || (this._dragButton === 0 && this._ctrlKey)) && this.enableTilt) {
            // ── 中键 / Ctrl+左键：tilt ──
            this._tilt3D(dx, dy);
        }
    }

    private _handleMouseUp(_e: MouseEvent): void {
        if (this._destroyed || !this._dragging) return;

        // 启动惯性（仅对 spin3D 左键 pan 模式）
        if (this._dragButton === 0 && !this._ctrlKey && this._spinMode === SpinMode.PAN) {
            if (Math.abs(this._inertiaH) > INERTIA_EPS || Math.abs(this._inertiaV) > INERTIA_EPS) {
                this._inertiaActive = true;
            }
        }

        this._dragging = false;
        this._dragButton = -1;
        this._spinMode = SpinMode.NONE;
        this._spinStartECEF = null;
    }

    private _handleWheel(e: WheelEvent): void {
        if (this._destroyed || !this.enableZoom) return;
        e.preventDefault();

        // 沿视线方向缩放
        const delta = e.deltaY;
        this._zoom3DWheel(delta, e.clientX, e.clientY);
    }

    // ════════════════════════════════════════════════════════════
    // spin3D — 左键拖拽旋转地球（核心交互）
    // ════════════════════════════════════════════════════════════

    /**
     * 确定 spin3D 交互模式：
     * 1. pickEllipsoid 命中 → PAN（arcball）
     * 2. 未命中 + 高空 → ROTATE（trackball）
     * 3. 未命中 + 低空 → LOOK（自由观看）
     */
    private _determineSpin3DMode(sx: number, sy: number): void {
        // 转换为 canvas 本地坐标
        const rect = this._canvas.getBoundingClientRect();
        const localX = sx - rect.left;
        const localY = sy - rect.top;

        const hit = this._camera.pickEllipsoid(localX, localY);

        if (hit) {
            this._spinMode = SpinMode.PAN;
            this._spinStartECEF = hit;
        } else {
            const alt = this._getAltitude();
            if (alt > MIN_TRACKBALL_HEIGHT) {
                this._spinMode = SpinMode.ROTATE;
            } else {
                this._spinMode = SpinMode.LOOK;
            }
        }
    }

    /**
     * spin3D 帧更新：根据模式执行对应操作。
     */
    private _spin3D(sx: number, sy: number, dx: number, dy: number, dtMs: number): void {
        switch (this._spinMode) {
            case SpinMode.PAN:
                this._pan3D(sx, sy, dx, dy, dtMs);
                break;
            case SpinMode.ROTATE:
                this._rotate3D(dx, dy);
                break;
            case SpinMode.LOOK:
                this._look3D(dx, dy);
                break;
        }
    }

    /**
     * pan3D — 地球跟随鼠标旋转（arcball）。
     *
     * Cesium 的核心算法：
     * 1. 用 pickEllipsoid 获取当前鼠标位置的球面点 p1
     * 2. 计算 p0（上一帧的球面点）和 p1 之间的旋转
     * 3. 如果有 constrainedAxis，分解为水平/垂直分量
     *
     * 简化版本：将屏幕位移转为角度，通过 rotateRight/rotateUp 应用。
     */
    private _pan3D(sx: number, sy: number, dx: number, dy: number, dtMs: number): void {
        const rect = this._canvas.getBoundingClientRect();
        const localX = sx - rect.left;
        const localY = sy - rect.top;
        const w = rect.width;
        const h = rect.height;

        // 当前鼠标位置拾取球面点
        const p1 = this._camera.pickEllipsoid(localX, localY);

        if (p1 && this._spinStartECEF) {
            // ── Arcball pan：计算两个球面点之间的旋转 ──
            const p0 = this._spinStartECEF;

            // 归一化两个点
            const p0Len = Math.sqrt(p0[0] * p0[0] + p0[1] * p0[1] + p0[2] * p0[2]);
            const p1Len = Math.sqrt(p1[0] * p1[0] + p1[1] * p1[1] + p1[2] * p1[2]);

            if (p0Len < 1e-10 || p1Len < 1e-10) return;

            // 归一化的球面点
            const n0x = p0[0] / p0Len, n0y = p0[1] / p0Len, n0z = p0[2] / p0Len;
            const n1x = p1[0] / p1Len, n1y = p1[1] / p1Len, n1z = p1[2] / p1Len;

            if (this._camera.constrainedAxis) {
                // ── 有约束轴：分解为水平和垂直旋转 ──
                const axis = this._camera.constrainedAxis;

                // 将 p0, p1 投影到球坐标（相对于约束轴）
                // theta = 极角（到轴的角度），phi = 方位角
                const dot0 = n0x * axis[0] + n0y * axis[1] + n0z * axis[2];
                const dot1 = n1x * axis[0] + n1y * axis[1] + n1z * axis[2];
                const theta0 = Math.acos(clamp(dot0, -1, 1));
                const theta1 = Math.acos(clamp(dot1, -1, 1));

                // 方位角：投影到垂直于轴的平面后计算
                // 先减去沿轴的分量
                const proj0x = n0x - dot0 * axis[0];
                const proj0y = n0y - dot0 * axis[1];
                const proj0z = n0z - dot0 * axis[2];
                const proj1x = n1x - dot1 * axis[0];
                const proj1y = n1y - dot1 * axis[1];
                const proj1z = n1z - dot1 * axis[2];

                const proj0Len = Math.sqrt(proj0x * proj0x + proj0y * proj0y + proj0z * proj0z);
                const proj1Len = Math.sqrt(proj1x * proj1x + proj1y * proj1y + proj1z * proj1z);

                if (proj0Len > 1e-10 && proj1Len > 1e-10) {
                    // 方位角差 = 两个投影向量的夹角（带符号）
                    const cosA = clamp(
                        (proj0x * proj1x + proj0y * proj1y + proj0z * proj1z) / (proj0Len * proj1Len),
                        -1, 1
                    );
                    // 叉积确定旋转方向
                    const cx = proj0y * proj1z - proj0z * proj1y;
                    const cy = proj0z * proj1x - proj0x * proj1z;
                    const cz = proj0x * proj1y - proj0y * proj1x;
                    const crossDot = cx * axis[0] + cy * axis[1] + cz * axis[2];
                    const deltaPhi = Math.acos(cosA) * (crossDot >= 0 ? 1 : -1);

                    // 极角差
                    const deltaTheta = theta1 - theta0;

                    // 应用旋转
                    if (Math.abs(deltaPhi) > 1e-12) {
                        this._camera.rotateRight(-deltaPhi);
                    }
                    if (Math.abs(deltaTheta) > 1e-12) {
                        this._camera.rotateUp(-deltaTheta);
                    }

                    // 记录惯性
                    this._inertiaH = -deltaPhi;
                    this._inertiaV = -deltaTheta;
                }
            } else {
                // ── 无约束轴：直接用叉积+点积旋转 ──
                // 旋转轴 = cross(p0, p1)
                const ax = n0y * n1z - n0z * n1y;
                const ay = n0z * n1x - n0x * n1z;
                const az = n0x * n1y - n0y * n1x;
                const axLen = Math.sqrt(ax * ax + ay * ay + az * az);

                if (axLen > 1e-12) {
                    const cosAngle = clamp(n0x * n1x + n0y * n1y + n0z * n1z, -1, 1);
                    const angle = Math.acos(cosAngle);

                    _tmpA[0] = ax / axLen;
                    _tmpA[1] = ay / axLen;
                    _tmpA[2] = az / axLen;
                    this._camera.rotate(_tmpA, angle);
                }
            }

            // 更新起始点为当前拾取点
            this._spinStartECEF = p1;
        } else {
            // 拾取失败时退化为简单角度映射
            this._rotate3D(dx, dy);
        }
    }

    /**
     * rotate3D — trackball 旋转（未命中球面时的高空模式）。
     *
     * 匹配 Cesium rotate3D：
     *   rotateRate = rotateFactor * (cameraDistance - earthRadius)
     *   deltaPhi = rotateRate * dx/width * 2π
     *   deltaTheta = rotateRate * dy/height * π
     */
    private _rotate3D(dx: number, dy: number): void {
        const rho = this._getCameraDistance();
        const rate = clamp(
            ROTATE_FACTOR * (rho - ROTATE_RANGE_ADJ),
            MIN_ROTATE_RATE,
            MAX_ROTATE_RATE,
        );

        const w = this._canvas.clientWidth || 1;
        const h = this._canvas.clientHeight || 1;

        const deltaPhi = rate * (dx / w) * TWO_PI;
        const deltaTheta = rate * (dy / h) * PI;

        this._camera.rotateRight(deltaPhi);
        this._camera.rotateUp(-deltaTheta);

        // 惯性
        this._inertiaH = deltaPhi;
        this._inertiaV = -deltaTheta;
    }

    /**
     * look3D — 自由观看模式（仅旋转方向，不移动）。
     * 用于低空未命中球面的情况。
     */
    private _look3D(dx: number, dy: number): void {
        if (!this.enableLook) return;

        const w = this._canvas.clientWidth || 1;
        const h = this._canvas.clientHeight || 1;

        // 较小的旋转速率
        const rate = 0.005;
        const hAngle = dx / w * PI * rate * 60;
        const vAngle = dy / h * PI * rate * 60;

        // 水平旋转围绕 constrainedAxis 或 up
        if (this._camera.constrainedAxis && Math.abs(hAngle) > 1e-12) {
            this._camera.look(this._camera.constrainedAxis, -hAngle);
        } else if (Math.abs(hAngle) > 1e-12) {
            this._camera.look(this._camera.upWC, -hAngle);
        }

        // 垂直旋转围绕 right
        if (Math.abs(vAngle) > 1e-12) {
            this._camera.look(this._camera.rightWC, vAngle);
        }
    }

    // ════════════════════════════════════════════════════════════
    // tilt3D — 中键拖拽倾斜
    // ════════════════════════════════════════════════════════════

    /**
     * tilt3D — 围绕注视点倾斜/旋转相机。
     *
     * 简化实现：
     *   水平移动 → rotateRight（heading 变化）
     *   垂直移动 → rotateUp（pitch 变化）
     * 使用较低的灵敏度，模拟 Cesium tilt3DOnEllipsoid 的手感。
     */
    private _tilt3D(dx: number, dy: number): void {
        const w = this._canvas.clientWidth || 1;
        const h = this._canvas.clientHeight || 1;
        const sensitivity = 0.005;

        // 水平：改变 heading（围绕约束轴或 ENU up）
        if (Math.abs(dx) > 0.5) {
            const hAngle = -dx / w * PI * sensitivity * 60;
            // tilt 水平旋转使用 look（不移动位置，仅改变朝向）
            if (this._camera.constrainedAxis) {
                this._camera.look(this._camera.constrainedAxis, hAngle);
            }
        }

        // 垂直：改变 pitch（围绕 right 轴）
        if (Math.abs(dy) > 0.5) {
            const vAngle = dy / h * PI * sensitivity * 60;
            this._camera.look(this._camera.rightWC, vAngle);
        }
    }

    // ════════════════════════════════════════════════════════════
    // zoom3D — 缩放
    // ════════════════════════════════════════════════════════════

    /**
     * 滚轮缩放：沿视线方向前进/后退。
     *
     * 缩放策略（匹配 Cesium zoom3D）：
     * - 使用距离比例因子，使近距离缩放慢、远距离缩放快
     * - deltaY 正值 = 向下滚动 = 缩小（远离）
     * - deltaY 负值 = 向上滚动 = 放大（靠近）
     */
    private _zoom3DWheel(delta: number, _sx: number, _sy: number): void {
        const pos = this._camera.positionWC;
        const posLen = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
        const alt = posLen - WGS84_A;

        // 缩放速率与海拔成正比：高空时一步移动多，低空时移动少
        // 浏览器约定：deltaY > 0 = 向下滚动 = 远离（zoom out），增加距离
        //             deltaY < 0 = 向上滚动 = 靠近（zoom in），减少距离
        const zoomRate = Math.max(alt * 0.05, 50);
        const moveAmount = (delta > 0 ? 1 : -1) * zoomRate;

        // 新长度 = 当前长度 + 移动量（负值=靠近）
        const newLen = clamp(posLen + moveAmount, WGS84_A + 100, WGS84_A + 5e7);
        const ratio = newLen / posLen;

        pos[0] *= ratio;
        pos[1] *= ratio;
        pos[2] *= ratio;
    }

    /**
     * 右键拖拽缩放。
     */
    private _zoom3DDrag(dy: number): void {
        // dy 正值 = 鼠标向下 = 远离（放大 deltaY）
        this._zoom3DWheel(dy * ZOOM_FACTOR, 0, 0);
    }

    // ════════════════════════════════════════════════════════════
    // 工具方法
    // ════════════════════════════════════════════════════════════

    /** 获取相机到地心距离 */
    private _getCameraDistance(): number {
        const p = this._camera.positionWC;
        return Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    }

    /** 获取近似海拔 */
    private _getAltitude(): number {
        return this._getCameraDistance() - WGS84_A;
    }
}

/** 钳制到 [lo, hi] */
function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}
