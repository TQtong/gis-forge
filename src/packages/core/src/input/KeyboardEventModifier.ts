// ============================================================
// input/KeyboardEventModifier.ts — 键盘修饰键枚举
//
// 移植自 Cesium KeyboardEventModifier.js
// 层级：L0（零外部依赖）
// 职责：标识与鼠标事件组合的键盘修饰键
// ============================================================

/**
 * 键盘修饰键枚举。
 * 用于与 {@link ScreenSpaceEventType} 组合，区分例如 Shift+左键拖拽 与 普通左键拖拽。
 */
const KeyboardEventModifier = {
    /** Shift 键 */
    SHIFT: 0,
    /** Ctrl 键 */
    CTRL: 1,
    /** Alt 键 */
    ALT: 2,
} as const;

export type KeyboardEventModifier = (typeof KeyboardEventModifier)[keyof typeof KeyboardEventModifier];
export { KeyboardEventModifier };
export default KeyboardEventModifier;
