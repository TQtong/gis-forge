// ============================================================
// camera-3d/CameraEventType.ts — 相机事件类型枚举
//
// 移植自 Cesium CameraEventType.js
// 层级：L3（camera-3d 包）
// 职责：枚举用于驱动相机操作的输入类型（拖拽、滚轮、双指缩放）
// ============================================================

/**
 * 相机事件类型枚举。
 * 定义了可用于驱动相机的输入方式：左键拖拽、右键拖拽、中键拖拽、滚轮滚动和双指缩放。
 *
 * 与 {@link KeyboardEventModifier} 组合使用，可以区分例如 Ctrl+左键拖拽 vs. 普通左键拖拽。
 * 数值与 Cesium CameraEventType 完全一致。
 */
const CameraEventType = {
    /** 左键按下 + 移动 + 释放 */
    LEFT_DRAG: 0,
    /** 右键按下 + 移动 + 释放 */
    RIGHT_DRAG: 1,
    /** 中键按下 + 移动 + 释放 */
    MIDDLE_DRAG: 2,
    /** 鼠标滚轮滚动 */
    WHEEL: 3,
    /** 双指触摸缩放 */
    PINCH: 4,
} as const;

export type CameraEventType = (typeof CameraEventType)[keyof typeof CameraEventType];
export { CameraEventType };
export default CameraEventType;
