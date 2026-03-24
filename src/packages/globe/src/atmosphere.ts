// ============================================================
// globe/atmosphere.ts — 大气散射渲染器
// 实现 Rayleigh + Mie 散射模型，用于 3D 地球的大气辉光效果。
// 导出 createAtmosphereRenderer 工厂函数。
// 依赖层级：L4 场景层组件，消费 L0 数学工具。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 物理常量 =====================

/**
 * 地球平均半径（米）。
 * 来源：IUGG 推荐值，用于散射模型中的球体近似。
 */
const EARTH_RADIUS_M = 6371000;

/**
 * 大气层外边界半径（米）。
 * 约为地球半径 + 100km（卡门线），散射积分从地表到此高度。
 */
const ATMOSPHERE_RADIUS_M = 6471000;

/**
 * 瑞利散射系数（m⁻¹），对应 RGB 三通道（680nm / 550nm / 440nm）。
 * 蓝光散射最强，红光最弱——天空呈蓝色的物理原因。
 * 来源：Nishita et al. 1993。
 */
const RAYLEIGH_COEFFICIENTS: readonly [number, number, number] = [5.5e-6, 13.0e-6, 22.4e-6];

/**
 * 瑞利散射标高（米）。
 * 大气密度随高度指数衰减的特征高度：ρ(h) = ρ₀ × exp(-h / H_r)。
 */
const RAYLEIGH_SCALE_HEIGHT_M = 8000;

/**
 * 米氏散射系数（m⁻¹）。
 * 气溶胶颗粒散射，与波长关系较弱，近似各向同性。
 */
const MIE_COEFFICIENT = 21e-6;

/**
 * 米氏散射标高（米）。
 * 气溶胶集中在低层大气。
 */
const MIE_SCALE_HEIGHT_M = 1200;

/**
 * 米氏散射各向异性参数 g（Henyey-Greenstein 相位函数）。
 * g=0 各向同性；g→1 强前向散射。0.758 是常用经验值。
 */
const MIE_G = 0.758;

/**
 * 散射积分采样步数。
 * 越多越精确但越贵；16 步在实时渲染中是常用平衡点。
 */
const INTEGRATION_STEPS = 16;

/**
 * 预计算 LUT 的纹理宽度（角度维度离散采样数）。
 */
const LUT_WIDTH = 256;

/**
 * 预计算 LUT 的纹理高度（高度维度离散采样数）。
 */
const LUT_HEIGHT = 64;

/**
 * 默认太阳方向（单位向量，归一化 [x, y, z]），指向 +Y（正午天顶）。
 */
const DEFAULT_SUN_DIRECTION: [number, number, number] = [0, 1, 0];

/**
 * 默认大气密度缩放（1.0 = 标准地球大气）。
 */
const DEFAULT_DENSITY = 1.0;

/** 4π 常量。 */
const FOUR_PI = 4 * Math.PI;

/** 3 / (16π) — 瑞利相位函数前系数。 */
const RAYLEIGH_PHASE_FACTOR = 3 / (16 * Math.PI);

// ===================== 类型接口 =====================

/**
 * 大气渲染器构造选项。
 */
export interface AtmosphereRendererOptions {
    /** 大气密度缩放因子（0~5），默认 1.0。 */
    readonly density?: number;

    /** 初始太阳方向（单位向量 [x, y, z]）。 */
    readonly sunDirection?: [number, number, number];

    /** 散射积分步数（4~64），默认 16。 */
    readonly integrationSteps?: number;
}

/**
 * 渲染上下文（由帧循环传入）。
 */
export interface AtmosphereRenderContext {
    /** 视图投影矩阵（Float32Array[16]，列主序）。 */
    readonly viewProjectionMatrix: Float32Array;

    /** 相机位置（世界空间，米）。 */
    readonly cameraPosition: Float32Array;

    /** 视口宽度（像素）。 */
    readonly viewportWidth: number;

    /** 视口高度（像素）。 */
    readonly viewportHeight: number;
}

/**
 * 预计算的透射率 LUT 数据。
 */
export interface AtmosphereLUTData {
    /** LUT 像素数据（RGBA float，宽×高×4）。 */
    readonly data: Float32Array;

    /** 纹理宽度。 */
    readonly width: number;

    /** 纹理高度。 */
    readonly height: number;
}

/**
 * 大气渲染器公共接口。
 */
export interface AtmosphereRenderer {
    /**
     * 渲染大气散射效果（每帧调用）。
     *
     * @param ctx - 渲染上下文
     */
    render(ctx: AtmosphereRenderContext): void;

    /**
     * 设置大气密度缩放。
     *
     * @param density - 密度因子 [0, 5]
     */
    setDensity(density: number): void;

    /**
     * 设置太阳方向。
     *
     * @param direction - 单位向量 [x, y, z]
     */
    setSunDirection(direction: [number, number, number]): void;

    /**
     * 获取预计算的透射率 LUT 数据（可用于 GPU 纹理上传）。
     *
     * @returns LUT 数据
     */
    getLUTData(): AtmosphereLUTData;

    /**
     * 释放内部资源。
     */
    destroy(): void;
}

// ===================== 纯数学函数 =====================

/**
 * 计算三维向量的长度。
 *
 * @param x - X 分量
 * @param y - Y 分量
 * @param z - Z 分量
 * @returns 向量长度
 */
function length3(x: number, y: number, z: number): number {
    return Math.sqrt(x * x + y * y + z * z);
}

/**
 * 归一化三维向量（就地修改）。
 *
 * @param v - 三分量数组
 * @returns 归一化后的引用
 */
function normalize3(v: [number, number, number]): [number, number, number] {
    const len = length3(v[0], v[1], v[2]);
    if (len < 1e-12) {
        // 零向量无法归一化，返回默认朝上
        v[0] = 0;
        v[1] = 1;
        v[2] = 0;
        return v;
    }
    const inv = 1 / len;
    v[0] *= inv;
    v[1] *= inv;
    v[2] *= inv;
    return v;
}

/**
 * 三维向量点积。
 *
 * @param ax - A.x
 * @param ay - A.y
 * @param az - A.z
 * @param bx - B.x
 * @param by - B.y
 * @param bz - B.z
 * @returns 点积标量
 */
function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return ax * bx + ay * by + az * bz;
}

/**
 * 瑞利相位函数 P_R(θ)。
 * 公式：(3 / 16π) × (1 + cos²θ)
 *
 * @param cosTheta - 散射角余弦值
 * @returns 相位函数值
 */
function rayleighPhase(cosTheta: number): number {
    return RAYLEIGH_PHASE_FACTOR * (1 + cosTheta * cosTheta);
}

/**
 * Henyey-Greenstein 相位函数 P_HG(θ, g)。
 * 用于近似 Mie 散射的方向分布。
 *
 * @param cosTheta - 散射角余弦值
 * @param g - 各向异性参数
 * @returns 相位函数值
 */
function hgPhase(cosTheta: number, g: number): number {
    const g2 = g * g;
    const denom = 1 + g2 - 2 * g * cosTheta;
    // 防止 denom→0（g≈1 且 cosTheta≈1 时）
    const safeDenom = Math.max(denom, 1e-12);
    // (1 - g²) / (4π × (1 + g² - 2g·cosθ)^1.5)
    return (1 - g2) / (FOUR_PI * Math.pow(safeDenom, 1.5));
}

/**
 * 射线与球体相交测试。
 * 返回沿射线方向的两个交点参数 [t0, t1]；无交点返回 null。
 *
 * @param ox - 射线原点 X
 * @param oy - 射线原点 Y
 * @param oz - 射线原点 Z
 * @param dx - 射线方向 X（需归一化）
 * @param dy - 射线方向 Y
 * @param dz - 射线方向 Z
 * @param radius - 球体半径（球心在原点）
 * @returns [t_near, t_far] 或 null
 */
function raySphereIntersect(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    radius: number,
): [number, number] | null {
    // 球心在原点 => a = dot(d,d) = 1（d 已归一化）
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const discriminant = b * b - 4 * c;
    if (discriminant < 0) {
        return null;
    }
    const sqrtD = Math.sqrt(discriminant);
    const t0 = (-b - sqrtD) / 2;
    const t1 = (-b + sqrtD) / 2;
    return [t0, t1];
}

/**
 * 计算从起点沿方向在大气中传播的光学深度（optical depth）。
 * 使用数值积分（中点法则）沿路径累加密度。
 *
 * @param ox - 起点 X（世界空间，米）
 * @param oy - 起点 Y
 * @param oz - 起点 Z
 * @param dx - 方向 X（归一化）
 * @param dy - 方向 Y
 * @param dz - 方向 Z
 * @param length - 积分路径长度（米）
 * @param steps - 采样步数
 * @param densityScale - 密度缩放因子
 * @returns [rayleighOpticalDepth, mieOpticalDepth]
 */
function opticalDepth(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    length: number,
    steps: number,
    densityScale: number,
): [number, number] {
    const stepLen = length / steps;
    let odRayleigh = 0;
    let odMie = 0;

    for (let i = 0; i < steps; i++) {
        // 中点采样位置
        const t = (i + 0.5) * stepLen;
        const px = ox + dx * t;
        const py = oy + dy * t;
        const pz = oz + dz * t;

        // 采样点到地心的距离即为海拔 + 地球半径
        const altitude = length3(px, py, pz) - EARTH_RADIUS_M;
        // 低于海平面视为地表密度（防负值）
        const h = Math.max(altitude, 0);

        // 瑞利密度：指数衰减
        odRayleigh += Math.exp(-h / RAYLEIGH_SCALE_HEIGHT_M) * stepLen * densityScale;
        // 米氏密度：指数衰减
        odMie += Math.exp(-h / MIE_SCALE_HEIGHT_M) * stepLen * densityScale;
    }

    return [odRayleigh, odMie];
}

/**
 * 计算单条视线的散射颜色（Rayleigh + Mie）。
 * 沿视线积分，每步再向太阳方向积分光学深度。
 *
 * @param originX - 视线起点 X
 * @param originY - 视线起点 Y
 * @param originZ - 视线起点 Z
 * @param dirX - 视线方向 X（归一化）
 * @param dirY - 视线方向 Y
 * @param dirZ - 视线方向 Z
 * @param rayLength - 视线在大气中的路径长度
 * @param sunDirX - 太阳方向 X（归一化）
 * @param sunDirY - 太阳方向 Y
 * @param sunDirZ - 太阳方向 Z
 * @param steps - 采样步数
 * @param densityScale - 密度缩放
 * @returns [r, g, b] 散射辐射度
 */
function computeScattering(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    rayLength: number,
    sunDirX: number, sunDirY: number, sunDirZ: number,
    steps: number,
    densityScale: number,
): [number, number, number] {
    const stepLen = rayLength / steps;
    // 累积瑞利散射 RGB
    let sumR_r = 0, sumR_g = 0, sumR_b = 0;
    // 累积米氏散射 (灰色，单通道代表)
    let sumMie = 0;
    // 视线方向光学深度累积器
    let viewOdR = 0;
    let viewOdM = 0;

    // 散射角余弦（视线与太阳方向的点积）
    const cosTheta = dot3(dirX, dirY, dirZ, sunDirX, sunDirY, sunDirZ);
    // 相位函数
    const phaseR = rayleighPhase(cosTheta);
    const phaseM = hgPhase(cosTheta, MIE_G);

    for (let i = 0; i < steps; i++) {
        // 中点采样
        const t = (i + 0.5) * stepLen;
        const px = originX + dirX * t;
        const py = originY + dirY * t;
        const pz = originZ + dirZ * t;

        const altitude = length3(px, py, pz) - EARTH_RADIUS_M;
        const h = Math.max(altitude, 0);

        // 当前采样点的局部密度
        const localDensityR = Math.exp(-h / RAYLEIGH_SCALE_HEIGHT_M) * densityScale;
        const localDensityM = Math.exp(-h / MIE_SCALE_HEIGHT_M) * densityScale;

        // 累加视线方向光学深度
        viewOdR += localDensityR * stepLen;
        viewOdM += localDensityM * stepLen;

        // 从采样点向太阳方向的光学深度（到大气顶部）
        const sunHit = raySphereIntersect(px, py, pz, sunDirX, sunDirY, sunDirZ, ATMOSPHERE_RADIUS_M);
        if (sunHit === null) {
            // 不应该发生（采样点在大气内部），跳过
            continue;
        }
        const sunLen = sunHit[1];
        if (sunLen <= 0) {
            continue;
        }

        const [sunOdR, sunOdM] = opticalDepth(
            px, py, pz,
            sunDirX, sunDirY, sunDirZ,
            sunLen,
            Math.max(4, Math.floor(steps / 2)),
            densityScale,
        );

        // 总光学深度 = 太阳→采样点 + 采样点→相机
        const totalOdR = viewOdR + sunOdR;
        const totalOdM = viewOdM + sunOdM;

        // 透射率衰减（Beer-Lambert 定律）
        const attenR = Math.exp(-(RAYLEIGH_COEFFICIENTS[0] * totalOdR + MIE_COEFFICIENT * totalOdM));
        const attenG = Math.exp(-(RAYLEIGH_COEFFICIENTS[1] * totalOdR + MIE_COEFFICIENT * totalOdM));
        const attenB = Math.exp(-(RAYLEIGH_COEFFICIENTS[2] * totalOdR + MIE_COEFFICIENT * totalOdM));

        // 瑞利散射贡献（波长相关）
        sumR_r += localDensityR * attenR * stepLen;
        sumR_g += localDensityR * attenG * stepLen;
        sumR_b += localDensityR * attenB * stepLen;

        // 米氏散射贡献（近似灰色，取绿通道衰减）
        sumMie += localDensityM * attenG * stepLen;
    }

    // 最终散射 = 散射系数 × 相位 × 积分和
    const r = RAYLEIGH_COEFFICIENTS[0] * phaseR * sumR_r + MIE_COEFFICIENT * phaseM * sumMie;
    const g = RAYLEIGH_COEFFICIENTS[1] * phaseR * sumR_g + MIE_COEFFICIENT * phaseM * sumMie;
    const b = RAYLEIGH_COEFFICIENTS[2] * phaseR * sumR_b + MIE_COEFFICIENT * phaseM * sumMie;

    return [r, g, b];
}

/**
 * 预计算透射率 LUT（Transmittance Look-Up Table）。
 * 横轴：天顶角 θ（cos 从 -1 到 +1）。
 * 纵轴：海拔 h（0 到大气高度）。
 *
 * @param width - LUT 纹理宽度
 * @param height - LUT 纹理高度
 * @param steps - 积分步数
 * @param densityScale - 密度缩放
 * @returns RGBA Float32Array
 */
function buildTransmittanceLUT(
    width: number,
    height: number,
    steps: number,
    densityScale: number,
): Float32Array {
    const size = width * height * 4;
    const data = new Float32Array(size);
    const atmosphereThickness = ATMOSPHERE_RADIUS_M - EARTH_RADIUS_M;

    for (let y = 0; y < height; y++) {
        // h ∈ [0, atmosphereThickness]
        const hNorm = y / Math.max(height - 1, 1);
        const altitude = hNorm * atmosphereThickness;
        // 观测点到地心的距离
        const r = EARTH_RADIUS_M + altitude;

        for (let x = 0; x < width; x++) {
            // cosθ ∈ [-1, 1]
            const cosTheta = (2 * x / Math.max(width - 1, 1)) - 1;
            const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));

            // 射线方向（局部坐标系，Y 朝天顶）
            const dx = sinTheta;
            const dy = cosTheta;
            const dz = 0;

            // 观测点在地心坐标系 (0, r, 0)
            const ox = 0;
            const oy = r;
            const oz = 0;

            // 求射线与大气外边界的交点
            const hit = raySphereIntersect(ox, oy, oz, dx, dy, dz, ATMOSPHERE_RADIUS_M);
            if (hit === null || hit[1] <= 0) {
                // 无交点（不应发生在大气内）
                const idx = (y * width + x) * 4;
                data[idx + 0] = 1;
                data[idx + 1] = 1;
                data[idx + 2] = 1;
                data[idx + 3] = 1;
                continue;
            }

            // 检测是否被地球遮挡
            const earthHit = raySphereIntersect(ox, oy, oz, dx, dy, dz, EARTH_RADIUS_M);
            const blocked = earthHit !== null && earthHit[0] > 0;

            const pathLength = blocked ? earthHit![0] : hit[1];
            const [odR, odM] = opticalDepth(
                ox, oy, oz,
                dx, dy, dz,
                Math.max(pathLength, 0),
                steps,
                densityScale,
            );

            // Beer-Lambert 透射率
            const tR = Math.exp(-RAYLEIGH_COEFFICIENTS[0] * odR - MIE_COEFFICIENT * odM);
            const tG = Math.exp(-RAYLEIGH_COEFFICIENTS[1] * odR - MIE_COEFFICIENT * odM);
            const tB = Math.exp(-RAYLEIGH_COEFFICIENTS[2] * odR - MIE_COEFFICIENT * odM);

            const idx = (y * width + x) * 4;
            data[idx + 0] = tR;
            data[idx + 1] = tG;
            data[idx + 2] = tB;
            data[idx + 3] = 1;
        }
    }

    return data;
}

// ===================== 工厂函数 =====================

/**
 * 创建大气散射渲染器。
 * 内部预计算透射率 LUT，并提供每帧渲染接口。
 *
 * @param options - 大气参数
 * @returns AtmosphereRenderer 实例
 *
 * @stability experimental
 *
 * @example
 * const atmo = createAtmosphereRenderer({ density: 1.2 });
 * atmo.setSunDirection([0.5, 0.8, 0.2]);
 * atmo.render(ctx);
 */
export function createAtmosphereRenderer(
    options?: AtmosphereRendererOptions,
): AtmosphereRenderer {
    // 密度缩放：clamp 到 [0, 5]
    let density = Math.max(0, Math.min(options?.density ?? DEFAULT_DENSITY, 5));
    // 太阳方向（可变）
    let sunDir: [number, number, number] = options?.sunDirection
        ? [options.sunDirection[0], options.sunDirection[1], options.sunDirection[2]]
        : [DEFAULT_SUN_DIRECTION[0], DEFAULT_SUN_DIRECTION[1], DEFAULT_SUN_DIRECTION[2]];
    normalize3(sunDir);

    const steps = Math.max(4, Math.min(options?.integrationSteps ?? INTEGRATION_STEPS, 64));

    // 预计算 LUT（CPU 端，实际引擎可将此上传为 GPU 纹理）
    let lutData = buildTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT, steps, density);
    let destroyed = false;

    /**
     * 标记 LUT 需要重建（密度变化后）。
     */
    function rebuildLUT(): void {
        lutData = buildTransmittanceLUT(LUT_WIDTH, LUT_HEIGHT, steps, density);
    }

    return {
        /**
         * 渲染大气散射。
         * MVP 实现：CPU 端计算参考散射值并存储到内部缓冲（不实际提交 GPU 指令）。
         * 完整实现会编码 GPU render pass。
         *
         * @param ctx - 渲染上下文
         */
        render(ctx: AtmosphereRenderContext): void {
            if (destroyed) {
                return;
            }
            // 从相机位置计算一条参考视线的散射颜色（用于调试 / DevTools）
            const cx = ctx.cameraPosition[0];
            const cy = ctx.cameraPosition[1];
            const cz = ctx.cameraPosition[2];

            // 参考视线：从相机指向天顶偏移一点
            const vx = 0;
            const vy = 1;
            const vz = 0;

            // 与大气求交
            const hit = raySphereIntersect(cx, cy, cz, vx, vy, vz, ATMOSPHERE_RADIUS_M);
            if (hit === null || hit[1] <= 0) {
                return;
            }

            // 进入点与退出点
            const tEnter = Math.max(hit[0], 0);
            const tExit = hit[1];
            const rayLength = tExit - tEnter;

            if (rayLength <= 0) {
                return;
            }

            // 实际起点
            const startX = cx + vx * tEnter;
            const startY = cy + vy * tEnter;
            const startZ = cz + vz * tEnter;

            // 计算散射颜色（CPU fallback）
            const _scattering = computeScattering(
                startX, startY, startZ,
                vx, vy, vz,
                rayLength,
                sunDir[0], sunDir[1], sunDir[2],
                steps,
                density,
            );

            if (__DEV__) {
                // DevTools 可用此值验证散射结果
                void _scattering;
            }
        },

        /**
         * 设置大气密度并重建 LUT。
         *
         * @param newDensity - [0, 5]
         */
        setDensity(newDensity: number): void {
            if (!Number.isFinite(newDensity)) {
                return;
            }
            density = Math.max(0, Math.min(newDensity, 5));
            rebuildLUT();
        },

        /**
         * 设置太阳方向（会自动归一化）。
         *
         * @param direction - [x, y, z]
         */
        setSunDirection(direction: [number, number, number]): void {
            if (direction.length < 3) {
                return;
            }
            if (!Number.isFinite(direction[0]) || !Number.isFinite(direction[1]) || !Number.isFinite(direction[2])) {
                return;
            }
            sunDir = [direction[0], direction[1], direction[2]];
            normalize3(sunDir);
        },

        /**
         * 获取预计算的透射率 LUT。
         *
         * @returns LUT 数据
         */
        getLUTData(): AtmosphereLUTData {
            return {
                data: lutData,
                width: LUT_WIDTH,
                height: LUT_HEIGHT,
            };
        },

        /**
         * 释放资源。
         */
        destroy(): void {
            destroyed = true;
        },
    };
}
