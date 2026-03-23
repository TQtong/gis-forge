// ============================================================
// math/trigonometry.ts — 三角函数工具
// GIS 引擎中度/弧度转换、角度归一化等高频操作
// 所有常量和函数零依赖，纯函数，可 tree-shake
// ============================================================

// ===== 常量 =====

/** 度到弧度的转换因子：π/180 ≈ 0.017453292519943295 */
export const DEG_TO_RAD: number = Math.PI / 180;

/** 弧度到度的转换因子：180/π ≈ 57.29577951308232 */
export const RAD_TO_DEG: number = 180 / Math.PI;

/** 2π（一个完整圆周），≈ 6.283185307179586 */
export const TWO_PI: number = Math.PI * 2;

/** π/2（四分之一圆周，直角），≈ 1.5707963267948966 */
export const HALF_PI: number = Math.PI * 0.5;

/** 浮点比较容差，用于判断两个角度是否"足够接近" */
export const EPSILON: number = 1e-6;

/**
 * 将角度从度转换为弧度。
 * GIS 中经纬度常以度为单位，GPU/数学计算需要弧度。
 *
 * @param deg - 角度（度）
 * @returns 对应的弧度值
 *
 * @example
 * degToRad(180); // Math.PI ≈ 3.14159
 * degToRad(90);  // Math.PI / 2 ≈ 1.5708
 */
export function degToRad(deg: number): number {
    // 乘以常量比每次算 Math.PI/180 更快
    return deg * DEG_TO_RAD;
}

/**
 * 将角度从弧度转换为度。
 *
 * @param rad - 角度（弧度）
 * @returns 对应的度数值
 *
 * @example
 * radToDeg(Math.PI); // 180
 * radToDeg(1);       // ≈ 57.296
 */
export function radToDeg(rad: number): number {
    return rad * RAD_TO_DEG;
}

/**
 * 将角度归一化到 [-π, π] 范围。
 * 处理旋转累积导致的角度溢出，保证比较和插值的一致性。
 *
 * @param rad - 输入角度（弧度），可以是任意值
 * @returns 归一化后的角度，范围 [-π, π]
 *
 * @example
 * normalizeAngle(3 * Math.PI);  // ≈ Math.PI（即 π）
 * normalizeAngle(-3 * Math.PI); // ≈ -Math.PI
 * normalizeAngle(0);            // 0
 */
export function normalizeAngle(rad: number): number {
    // 先将角度移到 [0, 2π) 范围
    let normalized = rad % TWO_PI;
    // 处理负数取模（JS 的 % 保留符号）
    if (normalized < 0) {
        normalized += TWO_PI;
    }
    // 如果大于 π，减去 2π 使其落入 [-π, π]
    if (normalized > Math.PI) {
        normalized -= TWO_PI;
    }
    return normalized;
}

/**
 * 计算两个角度之间的最短差值。
 * 结果在 [-π, π] 范围内，正值表示从 a 到 b 逆时针转动。
 * 用于旋转动画插值时选择最短路径。
 *
 * @param a - 起始角度（弧度）
 * @param b - 目标角度（弧度）
 * @returns 最短角度差（弧度），范围 [-π, π]
 *
 * @example
 * angleDiff(0, Math.PI / 2);      // π/2（逆时针 90°）
 * angleDiff(0, Math.PI * 1.5);    // -π/2（顺时针 90°，不是逆时针 270°）
 */
export function angleDiff(a: number, b: number): number {
    // 先求差值，再归一化到 [-π, π] 确保走最短弧
    return normalizeAngle(b - a);
}

/**
 * 将经度归一化到 [-180, 180] 范围。
 * 处理跨越日期变更线（±180°）的情况。
 *
 * @param lng - 输入经度（度），可以是任意值
 * @returns 归一化后的经度，范围 [-180, 180]
 *
 * @example
 * wrapLongitude(190);  // -170（跨越日期变更线）
 * wrapLongitude(-200); // 160
 * wrapLongitude(90);   // 90（不变）
 */
export function wrapLongitude(lng: number): number {
    // 将经度移到 [-180, 180] 范围
    let wrapped = lng % 360;
    // 处理 JS 负数取模
    if (wrapped < -180) {
        wrapped += 360;
    } else if (wrapped > 180) {
        wrapped -= 360;
    }
    return wrapped;
}

/**
 * 将纬度钳位到 [-90, 90] 范围。
 * 纬度不能"环绕"（到了极点就停止），只能钳位。
 *
 * @param lat - 输入纬度（度）
 * @returns 钳位后的纬度，范围 [-90, 90]
 *
 * @example
 * wrapLatitude(95);  // 90（钳位到北极）
 * wrapLatitude(-100); // -90（钳位到南极）
 */
export function wrapLatitude(lat: number): number {
    // 纬度无法环绕，直接钳位到有效范围
    return lat < -90 ? -90 : lat > 90 ? 90 : lat;
}

/**
 * 计算 atan2 并返回结果为度数。
 * 方便 GIS 场景中直接用度数表示方位角。
 *
 * @param y - Y 分量（对边）
 * @param x - X 分量（邻边）
 * @returns 角度（度），范围 [-180, 180]
 *
 * @example
 * atan2Deg(1, 0);  // 90（正北）
 * atan2Deg(0, 1);  // 0（正东）
 * atan2Deg(-1, 0); // -90（正南）
 */
export function atan2Deg(y: number, x: number): number {
    // Math.atan2 返回 [-π, π]，乘以 RAD_TO_DEG 转为度
    return Math.atan2(y, x) * RAD_TO_DEG;
}
