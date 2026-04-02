// ============================================================
// input/ScreenSpaceEventType.ts — 屏幕空间事件类型枚举
//
// 移植自 Cesium ScreenSpaceEventType.js
// 层级：L0（零外部依赖）
// 职责：分类鼠标/触摸 DOM 事件类型
// ============================================================

/**
 * 屏幕空间事件类型枚举。
 * 对应 DOM 鼠标/触摸事件的分类，包括按下、抬起、点击、双击、移动、滚轮和触摸手势。
 *
 * 数值与 Cesium ScreenSpaceEventType 完全一致，便于对照和调试。
 */
const ScreenSpaceEventType = {
    /** 鼠标左键按下 */
    LEFT_DOWN: 0,
    /** 鼠标左键抬起 */
    LEFT_UP: 1,
    /** 鼠标左键单击（按下+抬起，未超过像素容差） */
    LEFT_CLICK: 2,
    /** 鼠标左键双击 */
    LEFT_DOUBLE_CLICK: 3,

    /** 鼠标右键按下 */
    RIGHT_DOWN: 5,
    /** 鼠标右键抬起 */
    RIGHT_UP: 6,
    /** 鼠标右键单击 */
    RIGHT_CLICK: 7,

    /** 鼠标中键按下 */
    MIDDLE_DOWN: 10,
    /** 鼠标中键抬起 */
    MIDDLE_UP: 11,
    /** 鼠标中键单击 */
    MIDDLE_CLICK: 12,

    /** 鼠标移动 */
    MOUSE_MOVE: 15,
    /** 鼠标滚轮 */
    WHEEL: 16,

    /** 双指触摸开始 */
    PINCH_START: 17,
    /** 双指触摸结束 */
    PINCH_END: 18,
    /** 双指触摸移动 */
    PINCH_MOVE: 19,
} as const;

export type ScreenSpaceEventType = (typeof ScreenSpaceEventType)[keyof typeof ScreenSpaceEventType];
export { ScreenSpaceEventType };
export default ScreenSpaceEventType;
