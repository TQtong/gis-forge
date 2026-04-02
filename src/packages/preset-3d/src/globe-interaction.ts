// ============================================================
// preset-3d/globe-interaction.ts — Globe 鼠标交互桥接
// 层级：L6
// 职责：创建 ScreenSpaceCameraController 并返回兼容的事件处理器接口。
//       ScreenSpaceCameraController 自行管理事件绑定，
//       返回的处理器为空壳（由 globe-3d.ts 的 _installInteractions 安装）。
// 依赖：screen-space-camera-controller.ts、Camera3D
// ============================================================

import type { Camera3D } from '../../camera-3d/src/Camera3D.ts';
import type { GlobeInteractionState, MorphState } from './globe-types.ts';
import { ScreenSpaceCameraController } from './screen-space-camera-controller.ts';

/** 存储当前活跃的 ScreenSpaceCameraController 实例，供 globe-3d 帧循环调用 update */
let _activeController: ScreenSpaceCameraController | null = null;

/**
 * 获取当前活跃的 ScreenSpaceCameraController。
 * globe-3d.ts 的帧循环调用此方法以驱动惯性更新。
 */
export function getActiveController(): ScreenSpaceCameraController | null {
    return _activeController;
}

/**
 * 创建 Globe 鼠标事件处理器。
 *
 * 内部创建 ScreenSpaceCameraController 实例（自行绑定 canvas 事件），
 * 返回的处理器为空壳以保持 globe-3d.ts 接口兼容。
 *
 * @param camera  - Camera3D 实例
 * @param flags   - 启用标志（rotate/zoom/tilt）
 * @param state   - 交互可变状态
 * @param guard   - 销毁守卫
 * @param pickFn  - 球面拾取函数（未使用，SSCC 内部调用 camera.pickEllipsoid）
 * @param vpFn    - 视口尺寸获取函数
 * @param canvas  - HTML Canvas 元素
 * @returns 空壳事件处理器集合
 */
export function createGlobeMouseHandlers(
    camera: Camera3D,
    flags: { enableRotate: boolean; enableZoom: boolean; enableTilt: boolean },
    _state: GlobeInteractionState,
    _guard: { isDestroyed: () => boolean },
    _pickFn: (sx: number, sy: number) => Float64Array | null,
    _vpFn: () => { width: number; height: number },
    canvas: HTMLCanvasElement,
): {
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onContextMenu: (e: Event) => void;
    controller: ScreenSpaceCameraController;
} {
    // 销毁旧控制器
    if (_activeController) {
        _activeController.destroy();
        _activeController = null;
    }

    // 创建新的 ScreenSpaceCameraController
    const sscc = new ScreenSpaceCameraController(camera, canvas);
    sscc.enableRotate = flags.enableRotate;
    sscc.enableZoom = flags.enableZoom;
    sscc.enableTilt = flags.enableTilt;
    _activeController = sscc;

    // 返回空壳处理器：SSCC 自行管理事件绑定，
    // 这些回调由 globe-3d 的 _installInteractions 安装但实际不做任何事
    const noop = () => {};
    const noopE = (e: Event) => { e.preventDefault(); };

    return {
        onMouseDown: noop as (e: MouseEvent) => void,
        onMouseMove: noop as (e: MouseEvent) => void,
        onMouseUp: noop as (e: MouseEvent) => void,
        onWheel: noop as (e: WheelEvent) => void,
        onContextMenu: noopE,
        controller: sscc,
    };
}

/**
 * 运行视图 morph 动画（2D ↔ 2.5D ↔ 3D）。
 * 当前为空占位。
 */
export function runMorph(
    _morphState: MorphState,
    _targetMode: string,
    _durationMs?: number,
    _emitFn?: (type: string, payload: unknown) => void,
    _destroyedFn?: () => boolean,
): boolean {
    return false;
}
