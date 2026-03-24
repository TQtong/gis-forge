// ============================================================
// math/interpolate.ts — 插值与缓动函数
// 用于动画系统、相机过渡、样式渐变等场景
// 所有函数均为纯函数，零依赖，零分配
// ============================================================

/**
 * 线性插值（Lerp）：a + t * (b - a)。
 * 最基础的插值函数，恒速过渡。
 *
 * @param a - 起始值（t=0）
 * @param b - 终止值（t=1）
 * @param t - 插值因子，通常在 [0, 1]
 * @returns 插值结果
 *
 * @example
 * linear(0, 100, 0.5); // 50
 * linear(10, 20, 0.25); // 12.5
 */
export function linear(a: number, b: number, t: number): number {
    // a + t*(b-a) 保证 t=0→a, t=1→b 精确无浮点误差
    return a + t * (b - a);
}

/**
 * Smoothstep：三阶 Hermite 插值，输出在 [0, 1] 范围内平滑过渡。
 * 在边缘处一阶导数为零（起止速度为零），比线性更自然。
 * 公式：3t² - 2t³
 *
 * @param edge0 - 下边界（输出 0 的位置）
 * @param edge1 - 上边界（输出 1 的位置）
 * @param x - 输入值
 * @returns 平滑插值结果 [0, 1]
 *
 * @example
 * smoothstep(0, 1, 0.5); // 0.5
 * smoothstep(0, 10, 5); // 0.5
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
    // 先将 x 映射到 [0, 1] 范围并钳位
    let t = (x - edge0) / (edge1 - edge0);
    // 钳位到 [0, 1]，防止超出范围
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // 三阶多项式 3t² - 2t³ = t²(3 - 2t)
    return t * t * (3 - 2 * t);
}

/**
 * Smootherstep（Ken Perlin 改进版）：五阶多项式，一阶和二阶导数在边缘均为零。
 * 公式：6t⁵ - 15t⁴ + 10t³
 * 比 smoothstep 更平滑，适合高质量动画。
 *
 * @param edge0 - 下边界
 * @param edge1 - 上边界
 * @param x - 输入值
 * @returns 更平滑的插值结果 [0, 1]
 *
 * @example
 * smootherstep(0, 1, 0.5); // 0.5
 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
    let t = (x - edge0) / (edge1 - edge0);
    // 钳位到 [0, 1]
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // 五阶多项式 6t⁵ - 15t⁴ + 10t³ = t³(t(6t - 15) + 10)
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 三次 Hermite 插值：给定两个端点的值和切线，计算中间值。
 * 用于样条曲线的逐段求值。
 *
 * @param p0 - 起点值
 * @param m0 - 起点切线（导数）
 * @param p1 - 终点值
 * @param m1 - 终点切线（导数）
 * @param t - 插值因子 [0, 1]
 * @returns 插值结果
 *
 * @example
 * hermite(0, 1, 1, 0, 0.5); // 中间值
 */
export function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
    // 预计算 t 的幂次
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite 基函数：
    // h00 = 2t³ - 3t² + 1
    // h10 = t³ - 2t² + t
    // h01 = -2t³ + 3t²
    // h11 = t³ - t²
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    // 加权组合
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

/**
 * 三次贝塞尔曲线求值（4 个控制点）。
 * 使用 De Casteljau 算法的展开式。
 *
 * @param p0 - 控制点 0（起点）
 * @param p1 - 控制点 1
 * @param p2 - 控制点 2
 * @param p3 - 控制点 3（终点）
 * @param t - 参数 [0, 1]
 * @returns 曲线上 t 处的值
 *
 * @example
 * bezierCubic(0, 0.25, 0.75, 1, 0.5); // ≈ 0.5
 */
export function bezierCubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
    // 1 - t 的幂次
    const u = 1 - t;
    const u2 = u * u;
    const u3 = u2 * u;
    // t 的幂次
    const t2 = t * t;
    const t3 = t2 * t;
    // 伯恩斯坦多项式展开
    return u3 * p0 + 3 * u2 * t * p1 + 3 * u * t2 * p2 + t3 * p3;
}

/**
 * Catmull-Rom 样条插值。
 * 经过所有控制点的光滑曲线（与贝塞尔不同，CatmullRom 过控制点）。
 * 给定 4 个点 p0~p3，在 p1 和 p2 之间插值。
 *
 * @param p0 - 前一个控制点（用于计算切线）
 * @param p1 - 起始控制点
 * @param p2 - 终止控制点
 * @param p3 - 后一个控制点（用于计算切线）
 * @param t - 参数 [0, 1]，在 p1 和 p2 之间
 * @returns 曲线上 t 处的值
 *
 * @example
 * catmullRom(0, 1, 3, 4, 0.5); // ≈ 2（p1 和 p2 的中点附近）
 */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    // 预计算 t 的幂次
    const t2 = t * t;
    const t3 = t2 * t;
    // Catmull-Rom 矩阵公式（均匀参数化，tau = 0.5）
    // f(t) = 0.5 * [(2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t² + (-p0+3*p1-3*p2+p3)*t³]
    return 0.5 * (
        (2 * p1)
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

/**
 * 弹簧阻尼模型：模拟物理弹簧的衰减振荡。
 * 用于弹性动画效果（如惯性滚动回弹）。
 *
 * @param current - 当前值
 * @param target - 目标值
 * @param velocity - 当前速度（会被修改，传入可变引用）
 * @param stiffness - 弹簧刚度（推荐 100~500）
 * @param damping - 阻尼系数（推荐 10~30，2*sqrt(stiffness) 为临界阻尼）
 * @param dt - 时间步长（秒）
 * @returns 包含新位置和新速度的元组 [newPosition, newVelocity]
 *
 * @example
 * let pos = 0, vel = 0;
 * [pos, vel] = springDamper(pos, 100, vel, 200, 20, 1/60);
 */
export function springDamper(
    current: number,
    target: number,
    velocity: number,
    stiffness: number,
    damping: number,
    dt: number,
): [number, number] {
    // 弹簧力 = -stiffness * displacement
    // 阻尼力 = -damping * velocity
    // 加速度 = 弹簧力 + 阻尼力
    const displacement = current - target;
    const springForce = -stiffness * displacement;
    const dampingForce = -damping * velocity;
    const acceleration = springForce + dampingForce;

    // 半隐式欧拉积分（比显式欧拉更稳定）
    const newVelocity = velocity + acceleration * dt;
    const newPosition = current + newVelocity * dt;

    return [newPosition, newVelocity];
}

/**
 * 将值钳位到 [min, max] 范围内。
 *
 * @param value - 输入值
 * @param min - 最小值
 * @param max - 最大值
 * @returns 钳位后的值
 *
 * @example
 * clamp(1.5, 0, 1); // 1
 * clamp(-0.5, 0, 1); // 0
 * clamp(0.5, 0, 1); // 0.5
 */
export function clamp(value: number, min: number, max: number): number {
    // 使用条件表达式比 Math.min/max 更快（V8 可内联条件）
    return value < min ? min : value > max ? max : value;
}

/**
 * 重新映射值从一个范围到另一个范围。
 * 先做 inverseLerp 再做 lerp。
 *
 * @param value - 输入值
 * @param inMin - 输入范围最小值
 * @param inMax - 输入范围最大值
 * @param outMin - 输出范围最小值
 * @param outMax - 输出范围最大值
 * @returns 映射后的值（不钳位，可能超出 outMin~outMax）
 *
 * @example
 * remap(5, 0, 10, 0, 100); // 50
 * remap(0.5, 0, 1, -1, 1); // 0
 */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
    // 先归一化到 [0, 1]，再映射到 [outMin, outMax]
    const t = (value - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
}

/**
 * 逆线性插值：给定值在 [a, b] 中的位置，返回 t 因子。
 * 即 linear(a, b, t) = value 时求 t。
 *
 * @param a - 范围起始值
 * @param b - 范围终止值
 * @param value - 输入值
 * @returns t 因子（value=a→0, value=b→1）
 *
 * @example
 * inverseLerp(0, 10, 5); // 0.5
 * inverseLerp(10, 20, 15); // 0.5
 */
export function inverseLerp(a: number, b: number, value: number): number {
    // 避免除零（a === b 时返回 0）
    const range = b - a;
    if (Math.abs(range) < 1e-10) {
        return 0;
    }
    return (value - a) / range;
}

/**
 * 二次缓入（加速）：t²
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeInQuad(0.5); // 0.25
 */
export function easeInQuad(t: number): number {
    return t * t;
}

/**
 * 二次缓出（减速）：1 - (1-t)²
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeOutQuad(0.5); // 0.75
 */
export function easeOutQuad(t: number): number {
    // 展开：1 - (1-t)² = t(2-t)
    return t * (2 - t);
}

/**
 * 二次缓入缓出：前半段加速，后半段减速。
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeInOutQuad(0.25); // 0.125
 * easeInOutQuad(0.75); // 0.875
 */
export function easeInOutQuad(t: number): number {
    // 前半段：2t²，后半段：1 - 2(1-t)²
    return t < 0.5
        ? 2 * t * t
        : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * 三次缓入（加速）：t³
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeInCubic(0.5); // 0.125
 */
export function easeInCubic(t: number): number {
    return t * t * t;
}

/**
 * 三次缓出（减速）：1 - (1-t)³
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeOutCubic(0.5); // 0.875
 */
export function easeOutCubic(t: number): number {
    const u = 1 - t;
    return 1 - u * u * u;
}

/**
 * 三次缓入缓出：前半段加速，后半段减速，比二次更明显。
 *
 * @param t - 归一化时间 [0, 1]
 * @returns 缓动后的值 [0, 1]
 *
 * @example
 * easeInOutCubic(0.25); // ≈ 0.0625
 * easeInOutCubic(0.75); // ≈ 0.9375
 */
export function easeInOutCubic(t: number): number {
    if (t < 0.5) {
        // 前半段：4t³（映射 [0, 0.5] → [0, 0.5]）
        return 4 * t * t * t;
    }
    // 后半段：1 - (-2t+2)³ / 2（映射 [0.5, 1] → [0.5, 1]）
    const u = -2 * t + 2;
    return 1 - (u * u * u) / 2;
}
