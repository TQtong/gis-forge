// ============================================================
// globe/GlobeRenderer.ts — 地球渲染器：椭球体网格、大气散射、星空、阴影
// GIS-Forge L4 场景层组件，负责 3D Globe 模式下的地球表面渲染、
// 大气散射效果、星空天穹和级联阴影贴图。
//
// 依赖关系：L0(math/geo) — 禁止反向或跨层依赖
// ============================================================

declare const __DEV__: boolean;

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';
import * as mat4 from '../../core/src/math/mat4.ts';
import * as vec3 from '../../core/src/math/vec3.ts';
import { WGS84_A, geodeticToECEF } from '../../core/src/geo/ellipsoid.ts';

// ============================================================
// 物理与渲染常量
// ============================================================

/**
 * 地球平均半径（米）。
 * 来源：IUGG 推荐值。用于大气散射模型中的地球球体近似。
 * 与 WGS84_A（赤道半径 6378137m）不同，此处取平均值简化散射计算。
 */
const EARTH_RADIUS: number = 6371000;

/**
 * 大气层外边界半径（米）。
 * 约为地球半径 + 100km（卡门线）。
 * 散射积分从地表到此半径，超出此范围视为真空。
 */
const ATMOSPHERE_RADIUS: number = 6471000;

/**
 * 瑞利散射系数（Rayleigh Scattering Coefficients），单位 m⁻¹。
 * 分别对应 RGB 三通道（680nm / 550nm / 440nm 波长）。
 * 蓝光散射最强（22.4e-6），红光最弱（5.5e-6），这是天空呈蓝色的物理原因。
 * 来源：Nishita et al. 1993 / Bruneton & Neyret 2008。
 */
const RAYLEIGH_COEFF: readonly [number, number, number] = [5.5e-6, 13.0e-6, 22.4e-6];

/**
 * 瑞利散射标高（Scale Height），单位米。
 * 大气密度随高度指数衰减的特征高度：ρ(h) = ρ₀ × exp(-h / H)。
 * 8000m 表示每上升 8km 大气密度降为 1/e ≈ 37%。
 */
const RAYLEIGH_HEIGHT: number = 8000;

/**
 * 米氏散射系数（Mie Scattering Coefficient），单位 m⁻¹。
 * 气溶胶粒子引起的散射，波长无关（各通道相同值）。
 * 米氏散射导致太阳周围的光晕和日落时地平线的白色/橙色光芒。
 */
const MIE_COEFF: number = 21e-6;

/**
 * 米氏散射标高（Mie Scale Height），单位米。
 * 气溶胶主要集中在低层大气，标高远低于瑞利散射的 8000m。
 * 1200m 表示每上升 1.2km 气溶胶浓度降为 1/e。
 */
const MIE_HEIGHT: number = 1200;

/**
 * 米氏散射非对称因子（Asymmetry Factor / Phase Function g）。
 * Henyey-Greenstein 相函数参数。
 * g=0 表示各向同性，g→1 表示强前向散射。
 * 0.76 表示明显的前向散射，太阳方向散射最强。
 */
const MIE_G: number = 0.76;

/**
 * 透射率 LUT（Look-Up Table）纹理宽度。
 * 水平轴：太阳天顶角 cos(θ) ∈ [-1, 1]。
 * 256 采样点足够平滑插值。
 */
const TRANSMITTANCE_LUT_WIDTH: number = 256;

/**
 * 透射率 LUT 纹理高度。
 * 垂直轴：视点高度 h ∈ [0, atmosphereHeight]。
 * 64 采样点足够覆盖从海平面到大气顶部的密度变化。
 */
const TRANSMITTANCE_LUT_HEIGHT: number = 64;

/**
 * 默认级联阴影贴图层级数。
 * 3 级级联是质量与性能的最佳平衡点：
 *   级联 0：近处高精度（~10m 范围）
 *   级联 1：中距离（~100m 范围）
 *   级联 2：远处低精度（~1000m 范围）
 */
const DEFAULT_SHADOW_CASCADES: number = 3;

/**
 * 默认阴影贴图尺寸（像素）。
 * 2048×2048 在大部分 GPU 上提供足够的阴影精度。
 * 每个级联共享此分辨率。
 */
const DEFAULT_SHADOW_MAP_SIZE: number = 2048;

/**
 * 默认 PCF（Percentage Closer Filtering）采样半径。
 * 3 表示 3×3 采样核，提供柔和的阴影边缘过渡。
 */
const DEFAULT_PCF_SIZE: number = 3;

/**
 * 级联阴影分割混合因子 λ。
 * λ=0 为均匀分割，λ=1 为纯对数分割。
 * 0.5 是两种方案的折中——近处级联更密（提升精度），远处级联更宽。
 * 来源：PSSM (Parallel-Split Shadow Maps) 论文建议 0.5~0.75。
 */
const CASCADE_SPLIT_LAMBDA: number = 0.5;

/**
 * 阴影偏移量（深度偏移），用于消除阴影痤疮（Shadow Acne）。
 * 0.005 是归一化深度空间中的小偏移，足以消除自阴影伪影。
 * 过大会导致 "Peter Panning"（阴影与物体分离）。
 */
const SHADOW_BIAS: number = 0.005;

/**
 * 天文单位（Astronomical Unit）的米数。
 * 1 AU = 地球到太阳的平均距离。
 * 用于将太阳位置转换为 ECEF 坐标。
 */
const AU_METERS: number = 1.496e11;

/**
 * 默认椭球体网格细分段数。
 * 64 段（经度 64 × 纬度 32）生成 ~4K 个三角形。
 * 对于全球视图已足够光滑，更近的视角由瓦片系统接管。
 */
const DEFAULT_GLOBE_SEGMENTS: number = 64;

/**
 * 默认星空点数量。
 * 10000 颗星在全天球均匀分布，肉眼可见星约 6000 颗。
 * GPU 渲染 10K 点几乎无性能开销。
 */
const DEFAULT_STAR_COUNT: number = 10000;

/** 角度到弧度的转换因子：π / 180 */
const DEG_TO_RAD: number = Math.PI / 180;

/** J2000.0 历元的儒略日数（2000年1月1日 12:00 TT） */
const J2000_JD: number = 2451545.0;

/** Unix 纪元（1970-01-01T00:00:00Z）对应的儒略日数 */
const UNIX_EPOCH_JD: number = 2440587.5;

/** 一天的毫秒数，用于 Date.getTime() → 儒略日转换 */
const MS_PER_DAY: number = 86400000;

/** 大气层厚度（米），从地表到大气外边界 */
const ATMOSPHERE_HEIGHT: number = ATMOSPHERE_RADIUS - EARTH_RADIUS;

// ============================================================
// 类型定义
// ============================================================

/**
 * 大气散射物理常量集合。
 * 封装 Rayleigh + Mie 散射模型所需的全部物理参数。
 * 用于 CPU 端预计算透射率 LUT 和 GPU Shader 中的实时散射积分。
 *
 * @example
 * const constants: AtmosphereConstants = {
 *   earthRadius: 6371000,
 *   atmosphereRadius: 6471000,
 *   rayleighCoeff: new Float32Array([5.5e-6, 13.0e-6, 22.4e-6]),
 *   rayleighHeight: 8000,
 *   mieCoeff: 21e-6,
 *   mieHeight: 1200,
 *   mieG: 0.76,
 * };
 */
export interface AtmosphereConstants {
    /** 地球平均半径（米），大气散射模型中的球体近似半径 */
    readonly earthRadius: number;

    /** 大气层外边界半径（米），散射积分上限 */
    readonly atmosphereRadius: number;

    /**
     * 瑞利散射系数 [R, G, B]，单位 m⁻¹。
     * Float32Array 长度 3，对应 680nm / 550nm / 440nm 波长的散射强度。
     */
    readonly rayleighCoeff: Float32Array;

    /** 瑞利散射标高（米），大气密度指数衰减特征高度 */
    readonly rayleighHeight: number;

    /** 米氏散射系数，单位 m⁻¹，波长无关的气溶胶散射 */
    readonly mieCoeff: number;

    /** 米氏散射标高（米），气溶胶集中在低层大气 */
    readonly mieHeight: number;

    /** 米氏散射非对称因子 g ∈ (-1, 1)，0.76 表示强前向散射 */
    readonly mieG: number;
}

/**
 * 星空数据，包含顶点缓冲区数据和星数量。
 * 每颗星用 4 个 float 表示：[x, y, z, brightness]。
 * x/y/z 是单位球面上的位置，brightness ∈ [0, 1]。
 *
 * @example
 * const starfield: StarfieldData = {
 *   buffer: new Float32Array(40000), // 10000 stars × 4 floats
 *   count: 10000,
 * };
 */
export interface StarfieldData {
    /**
     * 星空顶点数据缓冲区。
     * Float32Array，每 4 个元素描述一颗星：[x, y, z, brightness]。
     * 总长度 = count × 4。
     * x/y/z 为单位球面方向向量，brightness ∈ [0, 1]（视星等映射后的亮度）。
     */
    readonly buffer: Float32Array;

    /** 星的总数量，等于 buffer.length / 4 */
    readonly count: number;
}

/**
 * 椭球体网格数据，包含顶点位置、法线、纹理坐标和索引。
 * 用于 GPU 渲染地球表面。
 *
 * @example
 * const mesh = generateEllipsoidMesh(64);
 * // mesh.positions: Float32Array — 交错 [x,y,z] ECEF 坐标
 * // mesh.normals: Float32Array — 交错 [nx,ny,nz] 法线
 * // mesh.uvs: Float32Array — 交错 [u,v] 经纬度映射纹理坐标
 * // mesh.indices: Uint32Array — 三角形索引列表
 */
export interface EllipsoidMeshData {
    /**
     * 顶点位置数组，ECEF 坐标（米）。
     * Float32Array，交错 [x, y, z]，总长度 = vertexCount × 3。
     */
    readonly positions: Float32Array;

    /**
     * 顶点法线数组，归一化方向向量。
     * Float32Array，交错 [nx, ny, nz]，总长度 = vertexCount × 3。
     * 法线近似为球面法线（从球心指向地表点）。
     */
    readonly normals: Float32Array;

    /**
     * 纹理坐标数组。
     * Float32Array，交错 [u, v]，总长度 = vertexCount × 2。
     * u = longitude 映射到 [0, 1]（0°→0, 360°→1）。
     * v = latitude 映射到 [0, 1]（-90°→0, +90°→1）。
     */
    readonly uvs: Float32Array;

    /**
     * 三角形索引数组。
     * Uint32Array，每 3 个连续值描述一个三角形。
     * 使用 Uint32 以支持超过 65535 个顶点。
     */
    readonly indices: Uint32Array;

    /** 顶点总数 */
    readonly vertexCount: number;

    /** 三角形索引总数（三角形数 × 3） */
    readonly indexCount: number;
}

/**
 * GlobeRenderer 配置选项。
 * 控制大气散射、星空、阴影和椭球体网格的渲染参数。
 * 所有字段可选，未指定时使用默认值。
 *
 * @example
 * const options: GlobeOptions = {
 *   atmosphere: true,
 *   atmosphereIntensity: 1.2,
 *   skybox: true,
 *   starCount: 20000,
 *   shadows: false,
 *   globeSegments: 128,
 * };
 */
export interface GlobeOptions {
    /**
     * 是否启用大气散射效果。
     * 启用后在地球边缘绘制散射光晕，模拟真实大气层。
     * 默认值：true
     */
    readonly atmosphere?: boolean;

    /**
     * 大气散射强度乘数。
     * 1.0 为物理准确值，>1.0 增强视觉效果，<1.0 减弱。
     * 范围 [0, 2]，默认值：1.0
     */
    readonly atmosphereIntensity?: number;

    /**
     * 大气散射基础色调 [R, G, B]。
     * 叠加在物理散射结果之上，用于艺术风格调整。
     * 各通道范围 [0, 1]，默认值：[0.3, 0.5, 1.0]（偏蓝色调）
     */
    readonly atmosphereColor?: readonly [number, number, number];

    /**
     * 大气散射计算方式。
     * - 'lut'：预计算查找表，性能更好，适合大多数场景
     * - 'realtime'：逐像素实时积分，品质更高但性能开销大
     * 默认值：'lut'
     */
    readonly atmosphereMethod?: 'lut' | 'realtime';

    /**
     * 大气散射光线步进采样数（仅 'realtime' 模式有效）。
     * 每条射线沿视线方向的积分采样点数。
     * 数值越大品质越高、性能越低。
     * 范围 [4, 32]，默认值：16
     */
    readonly atmosphereSamples?: number;

    /**
     * 是否启用星空天穹渲染。
     * 启用后在地球背面绘制星空背景。
     * 默认值：true
     */
    readonly skybox?: boolean;

    /**
     * 星空中渲染的星数量。
     * 均匀分布在单位球面上，亮度按幂律分布。
     * 范围 [1000, 100000]，默认值：10000
     */
    readonly starCount?: number;

    /**
     * 星空整体亮度乘数。
     * 1.0 为默认亮度，0.0 为完全不可见，2.0 为双倍亮度。
     * 范围 [0, 2]，默认值：1.0
     */
    readonly starBrightness?: number;

    /**
     * 地球表面基础颜色 [R, G, B, A]。
     * 在无瓦片数据覆盖区域显示的底色（深空蓝黑色）。
     * 各通道范围 [0, 1]，默认值：[0.05, 0.05, 0.1, 1.0]
     */
    readonly baseColor?: readonly [number, number, number, number];

    /**
     * 是否启用级联阴影贴图（CSM）。
     * 启用后太阳光照产生地表阴影（建筑/地形）。
     * 默认值：false（性能开销较大，按需启用）
     */
    readonly shadows?: boolean;

    /**
     * CSM 级联层级数。
     * 更多级联 → 更好的近远距离阴影质量，但更多 GPU 开销。
     * 范围 [2, 4]，默认值：3
     */
    readonly shadowCascades?: number;

    /**
     * 阴影贴图分辨率（像素）。
     * 每个级联的阴影贴图尺寸（正方形）。
     * 范围 [512, 4096]，默认值：2048
     */
    readonly shadowMapSize?: number;

    /**
     * PCF 柔化采样半径。
     * 1 = 无柔化（硬阴影），3 = 3×3 采样，5 = 5×5 采样。
     * 范围 [1, 5]，默认值：3
     */
    readonly shadowPCFSize?: number;

    /**
     * 太阳位置（ECEF 坐标，米）。
     * Float32Array 长度 3，[x, y, z]。
     * 若未指定，使用 setSunFromDateTime(new Date()) 自动计算。
     */
    readonly sunPosition?: Float32Array;

    /**
     * 椭球体网格经度方向的分段数。
     * 纬度方向取 segments / 2。
     * 总三角形数 ≈ segments × (segments/2) × 2。
     * 范围 [16, 256]，默认值：64
     */
    readonly globeSegments?: number;
}

/**
 * 地球渲染器公共接口。
 * 封装 Globe 模式下的所有渲染功能：椭球体网格、大气散射、星空、阴影。
 * GPU 编码方法为 MVP 阶段的存根实现，非 GPU 逻辑全部完整实现。
 *
 * @stability experimental
 *
 * @example
 * const renderer = createGlobeRenderer({ atmosphere: true, skybox: true });
 * renderer.initialize(layerContext);
 * renderer.setSunFromDateTime(new Date());
 * // 在帧循环中：
 * renderer.encodeGlobe(encoder, camera);
 * renderer.encodeAtmosphere(encoder, camera);
 * renderer.encodeSkybox(encoder, camera);
 */
export interface GlobeRenderer {
    /**
     * 初始化渲染器资源（网格、星空、LUT 等）。
     * 必须在首次 encode 前调用。
     *
     * @param context - 图层上下文，包含 GPU 设备和服务引用
     *
     * @example
     * renderer.initialize(layerContext);
     */
    initialize(context: LayerContext): void;

    /**
     * 销毁所有 GPU 和 CPU 资源。
     * 调用后渲染器不可再使用。
     *
     * @example
     * renderer.destroy();
     */
    destroy(): void;

    /**
     * 启用或禁用大气散射效果。
     *
     * @param enabled - 是否启用
     *
     * @example
     * renderer.setAtmosphereEnabled(true);
     */
    setAtmosphereEnabled(enabled: boolean): void;

    /**
     * 查询大气散射是否启用。
     *
     * @returns 当前是否启用大气散射
     *
     * @example
     * if (renderer.isAtmosphereEnabled()) { ... }
     */
    isAtmosphereEnabled(): boolean;

    /**
     * 设置大气散射强度。
     *
     * @param intensity - 强度乘数，范围 [0, 2]
     *
     * @example
     * renderer.setAtmosphereIntensity(1.5);
     */
    setAtmosphereIntensity(intensity: number): void;

    /**
     * 获取当前大气散射强度。
     *
     * @returns 当前强度值
     *
     * @example
     * const intensity = renderer.getAtmosphereIntensity();
     */
    getAtmosphereIntensity(): number;

    /**
     * 设置大气散射色调。
     *
     * @param color - RGB 颜色 [r, g, b]，各通道 [0, 1]
     *
     * @example
     * renderer.setAtmosphereColor([0.4, 0.6, 1.0]);
     */
    setAtmosphereColor(color: readonly [number, number, number]): void;

    /**
     * 启用或禁用星空天穹。
     *
     * @param enabled - 是否启用
     *
     * @example
     * renderer.setSkyboxEnabled(true);
     */
    setSkyboxEnabled(enabled: boolean): void;

    /**
     * 查询星空天穹是否启用。
     *
     * @returns 当前是否启用星空
     *
     * @example
     * if (renderer.isSkyboxEnabled()) { ... }
     */
    isSkyboxEnabled(): boolean;

    /**
     * 设置自定义天穹纹理（立方体贴图）。
     * MVP 阶段为存根实现，仅记录调用。
     *
     * @param _texture - 预留参数，未来接收 GPUTexture 或纹理 URL
     *
     * @example
     * renderer.setSkyboxTexture(null); // 存根
     */
    setSkyboxTexture(_texture: unknown): void;

    /**
     * 启用或禁用级联阴影贴图。
     *
     * @param enabled - 是否启用
     *
     * @example
     * renderer.setShadowsEnabled(true);
     */
    setShadowsEnabled(enabled: boolean): void;

    /**
     * 查询阴影是否启用。
     *
     * @returns 当前是否启用阴影
     *
     * @example
     * if (renderer.isShadowsEnabled()) { ... }
     */
    isShadowsEnabled(): boolean;

    /**
     * 设置级联阴影层级数。
     *
     * @param cascades - 级联数，范围 [2, 4]
     *
     * @example
     * renderer.setShadowCascades(4);
     */
    setShadowCascades(cascades: number): void;

    /**
     * 设置阴影贴图分辨率。
     *
     * @param size - 纹理尺寸（像素），范围 [512, 4096]
     *
     * @example
     * renderer.setShadowMapSize(4096);
     */
    setShadowMapSize(size: number): void;

    /**
     * 直接设置太阳位置（ECEF 坐标）。
     *
     * @param ecef - Float32Array 长度 3，[x, y, z] 单位米
     *
     * @example
     * renderer.setSunPosition(new Float32Array([1.496e11, 0, 0]));
     */
    setSunPosition(ecef: Float32Array): void;

    /**
     * 获取当前太阳位置（ECEF 坐标）。
     *
     * @returns Float32Array 长度 3 的 ECEF 坐标
     *
     * @example
     * const sun = renderer.getSunPosition(); // [x, y, z]
     */
    getSunPosition(): Float32Array;

    /**
     * 根据日期时间自动计算太阳位置。
     * 使用简化的太阳位置算法（SPA 简化版）：
     *   Julian Date → 太阳黄经 → 赤经/赤纬 → ECEF 坐标。
     *
     * @param date - JavaScript Date 对象
     *
     * @example
     * renderer.setSunFromDateTime(new Date('2024-06-21T12:00:00Z'));
     */
    setSunFromDateTime(date: Date): void;

    /**
     * 获取归一化太阳方向向量（从地心指向太阳）。
     *
     * @returns Float32Array 长度 3 的单位方向向量
     *
     * @example
     * const dir = renderer.getSunDirection(); // 归一化 [dx, dy, dz]
     */
    getSunDirection(): Float32Array;

    /**
     * 编码地球椭球体网格的 GPU 渲染命令。
     * MVP 阶段：日志输出存根。
     *
     * @param encoder - GPURenderPassEncoder（MVP 阶段类型为 unknown）
     * @param camera - 当前帧相机状态
     *
     * @example
     * renderer.encodeGlobe(renderPassEncoder, cameraState);
     */
    encodeGlobe(encoder: unknown, camera: CameraState): void;

    /**
     * 编码大气散射效果的 GPU 渲染命令。
     * MVP 阶段：日志输出存根。
     *
     * @param encoder - GPURenderPassEncoder
     * @param camera - 当前帧相机状态
     *
     * @example
     * renderer.encodeAtmosphere(renderPassEncoder, cameraState);
     */
    encodeAtmosphere(encoder: unknown, camera: CameraState): void;

    /**
     * 编码星空天穹的 GPU 渲染命令。
     * MVP 阶段：日志输出存根。
     *
     * @param encoder - GPURenderPassEncoder
     * @param camera - 当前帧相机状态
     *
     * @example
     * renderer.encodeSkybox(renderPassEncoder, cameraState);
     */
    encodeSkybox(encoder: unknown, camera: CameraState): void;

    /**
     * 编码阴影深度预渲染 Pass。
     * MVP 阶段：日志输出存根。
     *
     * @param encoder - GPURenderPassEncoder
     * @param camera - 当前帧相机状态
     *
     * @example
     * renderer.encodeShadowPass(shadowPassEncoder, cameraState);
     */
    encodeShadowPass(encoder: unknown, camera: CameraState): void;

    /**
     * 获取阴影贴图纹理（用于其他图层采样阴影）。
     * MVP 阶段返回 null。
     *
     * @returns GPUTexture 或 null
     *
     * @example
     * const shadowMap = renderer.getShadowMapTexture();
     */
    getShadowMapTexture(): null;

    /**
     * 获取各级联的阴影视图投影矩阵。
     * MVP 阶段返回空数组。
     *
     * @returns Float32Array[] 阴影 VP 矩阵数组
     *
     * @example
     * const vpMatrices = renderer.getShadowVPMatrices();
     */
    getShadowVPMatrices(): Float32Array[];

    /**
     * 获取级联分割距离数组。
     * MVP 阶段返回空数组。
     *
     * @returns number[] 各级联的远平面距离
     *
     * @example
     * const splits = renderer.getCascadeSplits();
     */
    getCascadeSplits(): number[];
}

// ============================================================
// 独立算法函数（非类方法，便于 Tree-Shake）
// ============================================================

/**
 * 生成 WGS84 椭球体网格（顶点位置 ECEF、法线、纹理坐标、三角形索引）。
 *
 * 网格拓扑：经度方向 `segments` 个分段，纬度方向 `segments / 2` 个分段。
 * 顶点数 = (lonSegments + 1) × (latSegments + 1)。
 * 三角形数 = lonSegments × latSegments × 2。
 *
 * 使用 WGS84 椭球体参数（长半轴 a = 6378137m），
 * 通过 geodeticToECEF 将每个经纬度格点转换为 ECEF 坐标。
 *
 * @param segments - 经度方向分段数，范围 [16, 256]，默认 64
 * @returns 完整的椭球体网格数据
 *
 * @example
 * const mesh = generateEllipsoidMesh(64);
 * console.log(mesh.vertexCount);  // (64+1) × (32+1) = 2145
 * console.log(mesh.indexCount);   // 64 × 32 × 6 = 12288
 */
export function generateEllipsoidMesh(segments: number = DEFAULT_GLOBE_SEGMENTS): EllipsoidMeshData {
    // 将 segments 限制在合法范围内，防止极端值导致内存爆炸或退化网格
    const clampedSegments = Math.max(16, Math.min(256, Math.round(segments)));

    // 经度分段数 = 传入值，纬度分段数 = 经度的一半（因为纬度范围是 180° vs 经度 360°）
    const lonSegments = clampedSegments;
    const latSegments = (clampedSegments / 2) | 0;

    // 顶点网格尺寸：每个方向多一个顶点以闭合接缝
    const vertRows = latSegments + 1;
    const vertCols = lonSegments + 1;
    const vertexCount = vertRows * vertCols;

    // 每个网格单元 2 个三角形，每个三角形 3 个索引
    const indexCount = lonSegments * latSegments * 6;

    // 预分配所有缓冲区（一次性分配，避免扩容）
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(indexCount);

    // 临时 Float64Array 用于 geodeticToECEF 高精度计算
    const ecef64 = new Float64Array(3);

    // 遍历纬度行（从南极 -π/2 到北极 +π/2）
    let vertexIndex = 0;
    for (let lat = 0; lat <= latSegments; lat++) {
        // v 映射 [0, 1]：0 = 南极，1 = 北极
        const v = lat / latSegments;
        // 纬度从 -π/2（南极）到 +π/2（北极）
        const latRad = -Math.PI * 0.5 + v * Math.PI;

        // 遍历经度列（从 -π 到 +π，即 -180° 到 +180°）
        for (let lon = 0; lon <= lonSegments; lon++) {
            // u 映射 [0, 1]：0 = -180°，1 = +180°
            const u = lon / lonSegments;
            // 经度从 -π 到 +π
            const lonRad = -Math.PI + u * 2.0 * Math.PI;

            // 使用 Float64 精度的 geodeticToECEF 计算 ECEF 坐标（高程为 0 = 椭球面上）
            geodeticToECEF(ecef64, lonRad, latRad, 0);

            // 计算缓冲区写入偏移
            const posOffset = vertexIndex * 3;
            const uvOffset = vertexIndex * 2;

            // 将 Float64 结果降精度写入 Float32 位置缓冲区
            positions[posOffset] = ecef64[0];
            positions[posOffset + 1] = ecef64[1];
            positions[posOffset + 2] = ecef64[2];

            // 计算球面近似法线：从球心指向地表点的单位方向向量
            // 对于 WGS84 椭球（扁率 ~1/298），球面近似误差 < 0.2°，渲染足够
            const cosLat = Math.cos(latRad);
            const nx = cosLat * Math.cos(lonRad);
            const ny = cosLat * Math.sin(lonRad);
            const nz = Math.sin(latRad);

            // 归一化法线（球面坐标计算的方向已是单位长度，但 cos/sin 组合可能有微小误差）
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            // 防止零向量除法（极端情况下 nLen 可能接近零，但球面坐标不会）
            const invNLen = nLen > 1e-10 ? 1.0 / nLen : 0.0;

            normals[posOffset] = nx * invNLen;
            normals[posOffset + 1] = ny * invNLen;
            normals[posOffset + 2] = nz * invNLen;

            // UV 坐标：u = 经度归一化 [0,1]，v = 纬度归一化 [0,1]
            uvs[uvOffset] = u;
            uvs[uvOffset + 1] = v;

            vertexIndex++;
        }
    }

    // 生成三角形索引：每个矩形网格单元分为两个三角形
    let indexOffset = 0;
    for (let lat = 0; lat < latSegments; lat++) {
        for (let lon = 0; lon < lonSegments; lon++) {
            // 当前矩形四个顶点的索引
            const topLeft = lat * vertCols + lon;
            const topRight = topLeft + 1;
            const bottomLeft = (lat + 1) * vertCols + lon;
            const bottomRight = bottomLeft + 1;

            // 三角形 1（左上三角）：逆时针绕序（正面朝外）
            indices[indexOffset] = topLeft;
            indices[indexOffset + 1] = bottomLeft;
            indices[indexOffset + 2] = topRight;

            // 三角形 2（右下三角）：逆时针绕序
            indices[indexOffset + 3] = topRight;
            indices[indexOffset + 4] = bottomLeft;
            indices[indexOffset + 5] = bottomRight;

            indexOffset += 6;
        }
    }

    return {
        positions,
        normals,
        uvs,
        indices,
        vertexCount,
        indexCount,
    };
}

/**
 * 生成星空数据：在单位球面上均匀分布随机星星，亮度按幂律分布。
 *
 * 使用 Marsaglia (1972) 球面均匀采样方法：
 *   1. 在 [-1, 1]² 中均匀采样 (u, v)，丢弃 u²+v² ≥ 1 的样本
 *   2. 将接受的样本投影到球面
 * 此方法比经纬度随机更均匀（无极点聚集问题）。
 *
 * 亮度分布：brightness = random^2.5，幂律分布使大多数星较暗，
 * 少量星非常亮，模拟真实星空的视星等分布。
 *
 * @param count - 星数量，范围 [1000, 100000]
 * @param seed - 伪随机种子（可选），用于可重复生成。传入 0 使用 Math.random()
 * @returns 星空数据（缓冲区 + 数量）
 *
 * @example
 * const stars = generateStarfield(10000);
 * console.log(stars.count); // 10000
 * console.log(stars.buffer.length); // 40000 (10000 × 4)
 */
export function generateStarfield(count: number = DEFAULT_STAR_COUNT, seed: number = 0): StarfieldData {
    // 限制星数量到合法范围
    const clampedCount = Math.max(1000, Math.min(100000, Math.round(count)));

    // 每颗星 4 个 float：x, y, z（单位球面方向）, brightness
    const buffer = new Float32Array(clampedCount * 4);

    // 简易 xorshift32 PRNG，用于可重复的伪随机序列
    // 当 seed=0 时回退到 Math.random()
    let prngState = seed !== 0 ? (seed >>> 0) | 1 : 0;

    /**
     * 获取 [0, 1) 范围的伪随机数。
     * seed≠0 时使用 xorshift32（周期 2^32-1，速度快），
     * seed=0 时使用 Math.random()。
     */
    const nextRandom = (): number => {
        if (prngState === 0) {
            return Math.random();
        }
        // xorshift32 算法：3 次移位异或操作
        prngState ^= prngState << 13;
        prngState ^= prngState >>> 17;
        prngState ^= prngState << 5;
        // 将 int32 转为 [0, 1) 的 float
        return (prngState >>> 0) / 4294967296;
    };

    let generated = 0;
    // Marsaglia 方法可能需要多次采样才能得到球面上的一个有效点
    // 接受率 = π/4 ≈ 78.5%，平均每个有效点需要 ~1.27 次采样
    while (generated < clampedCount) {
        // 在 [-1, 1]² 正方形中均匀采样
        const u = nextRandom() * 2.0 - 1.0;
        const v = nextRandom() * 2.0 - 1.0;
        const s = u * u + v * v;

        // 丢弃落在单位圆外的样本（Marsaglia 拒绝条件）
        if (s >= 1.0 || s < 1e-10) {
            continue;
        }

        // 投影到球面：将 2D 圆内点映射到 3D 球面
        // sqrt(1 - s) 是 z 坐标的辅助量
        const sqrtTerm = Math.sqrt(1.0 - s);
        const x = 2.0 * u * sqrtTerm;
        const y = 2.0 * v * sqrtTerm;
        // z = 1 - 2s，使 (x, y, z) 在单位球面上均匀分布
        const z = 1.0 - 2.0 * s;

        // 幂律亮度分布：大部分星暗（brightness 接近 0），少量亮星
        // 指数 2.5 近似视星等分布（星数随亮度指数增长）
        const brightness = Math.pow(nextRandom(), 2.5);

        // 写入缓冲区
        const offset = generated * 4;
        buffer[offset] = x;
        buffer[offset + 1] = y;
        buffer[offset + 2] = z;
        buffer[offset + 3] = brightness;

        generated++;
    }

    return {
        buffer,
        count: clampedCount,
    };
}

/**
 * 计算给定日期时间的太阳 ECEF 位置。
 * 使用简化的太阳位置算法（基于 VSOP87 低精度近似）：
 *   1. Date → 儒略日 (JD)
 *   2. JD → 世纪数 T（自 J2000.0）
 *   3. T → 太阳平黄经 L₀ → 太阳黄经 λ
 *   4. λ → 赤经 α / 赤纬 δ（含黄道倾角修正）
 *   5. (α, δ) + GMST → ECEF 方向 → × 1 AU = 最终位置
 *
 * 精度约 ±1°，对 GIS 可视化（日照方向、阴影角度）完全足够。
 * 不适用于天文导航或精确日食预报。
 *
 * @param date - JavaScript Date 对象（UTC 时间）
 * @param out - 预分配的 Float32Array(3) 输出 ECEF 坐标（米）
 * @returns out 引用
 *
 * @example
 * const sunECEF = new Float32Array(3);
 * computeSunPositionECEF(new Date('2024-06-21T12:00:00Z'), sunECEF);
 * // sunECEF ≈ 指向夏至正午太阳方向 × 1AU
 */
export function computeSunPositionECEF(date: Date, out: Float32Array): Float32Array {
    // ---- Step 1: Date → 儒略日 (Julian Date) ----
    // JD = Unix 时间戳（ms）/ 每天毫秒数 + Unix 纪元的 JD
    const jd = date.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;

    // ---- Step 2: 儒略日 → 儒略世纪数 T（自 J2000.0 起的世纪数）----
    // T 是各天文公式的核心自变量
    const T = (jd - J2000_JD) / 36525.0;

    // ---- Step 3: 太阳平黄经 L₀（Mean Longitude），单位度 ----
    // Meeus (1998) 简化公式，精度对可视化足够
    const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360.0;

    // ---- Step 4: 太阳平近点角 M（Mean Anomaly），单位度 ----
    // 描述地球绕太阳椭圆轨道上的角位置
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360.0;
    const Mrad = M * DEG_TO_RAD;

    // ---- Step 5: 太阳中心差方程 C（Equation of Center）----
    // 修正椭圆轨道偏离圆轨道导致的角度偏差
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad)
        + (0.019993 - 0.000101 * T) * Math.sin(2.0 * Mrad)
        + 0.000289 * Math.sin(3.0 * Mrad);

    // ---- Step 6: 太阳真黄经 λ（True Longitude），单位度 ----
    // 太阳在黄道坐标系中的经度
    const sunLongitude = (L0 + C) % 360.0;
    const sunLongRad = sunLongitude * DEG_TO_RAD;

    // ---- Step 7: 黄道倾角 ε（Obliquity of the Ecliptic），单位度 ----
    // 地球自转轴与黄道面法线的夹角，当前约 23.44°
    // 缓慢变化（每世纪约 -47 角秒），使用线性近似
    const epsilon = 23.439291 - 0.0130042 * T;
    const epsilonRad = epsilon * DEG_TO_RAD;

    // ---- Step 8: 赤经 α（Right Ascension）和赤纬 δ（Declination）----
    // 从黄道坐标（λ, β≈0）转换到赤道坐标（α, δ）
    // β = 太阳黄纬，近似为 0（太阳几乎在黄道面上）
    const sinLambda = Math.sin(sunLongRad);
    const cosLambda = Math.cos(sunLongRad);
    const cosEpsilon = Math.cos(epsilonRad);
    const sinEpsilon = Math.sin(epsilonRad);

    // α = atan2(cosε × sinλ, cosλ)
    const ra = Math.atan2(cosEpsilon * sinLambda, cosLambda);
    // δ = asin(sinε × sinλ)
    const dec = Math.asin(sinEpsilon * sinLambda);

    // ---- Step 9: 格林威治平恒星时 GMST（Greenwich Mean Sidereal Time），单位度 ----
    // GMST 描述春分点相对于格林威治子午线的时角
    // 公式来源：IAU 2006 简化版本
    const GMST = (280.46061837 + 360.98564736629 * (jd - J2000_JD)
        + 0.000387933 * T * T) % 360.0;
    const GMSTrad = GMST * DEG_TO_RAD;

    // ---- Step 10: 赤道坐标 → ECEF 方向 ----
    // 太阳的时角 H = GMST - α（地球自转使太阳位置随时间变化）
    const H = GMSTrad - ra;

    // 在 ECEF 坐标系中，太阳方向 =
    //   X = cos(δ) × cos(H)   → 指向格林威治子午线/赤道交点
    //   Y = cos(δ) × sin(H)   → 指向 90°E/赤道交点
    //   Z = sin(δ)             → 指向北极
    // 注意：H 取负号是因为 GMST 增加 = 地球向东自转 = 太阳向西移动
    const cosDec = Math.cos(dec);
    const dirX = cosDec * Math.cos(H);
    const dirY = -cosDec * Math.sin(H);
    const dirZ = Math.sin(dec);

    // ---- Step 11: 方向 × 距离 = ECEF 位置 ----
    // 太阳距地球约 1 AU（1.496 × 10¹¹ 米）
    out[0] = dirX * AU_METERS;
    out[1] = dirY * AU_METERS;
    out[2] = dirZ * AU_METERS;

    return out;
}

/**
 * 计算大气透射率查找表（Transmittance LUT）。
 *
 * 透射率 T(P→Q) = exp(-∫ (βR·ρR(h) + βM·ρM(h)) ds)
 * 即沿光线路径 P→Q 上，Rayleigh + Mie 消光系数的积分。
 *
 * LUT 参数化：
 *   - 水平轴 (width)：cos(天顶角 θ) ∈ [-1, 1]
 *   - 垂直轴 (height)：观测点高度 h ∈ [0, atmosphereHeight]
 * 每个像素存储 RGB 三通道的透射率值。
 *
 * 在 GPU Shader 中通过双线性插值采样此 LUT，避免实时积分开销。
 *
 * @param width - LUT 纹理宽度（水平采样数），默认 256
 * @param height - LUT 纹理高度（垂直采样数），默认 64
 * @param numSamples - 每条射线的光线步进采样数，默认 40
 * @returns Float32Array — RGBA 格式的 LUT 数据，长度 = width × height × 4
 *
 * @example
 * const lut = computeTransmittanceLUT(256, 64, 40);
 * // lut 可直接上传为 GPU 纹理 (RGBA32Float, 256×64)
 */
export function computeTransmittanceLUT(
    width: number = TRANSMITTANCE_LUT_WIDTH,
    height: number = TRANSMITTANCE_LUT_HEIGHT,
    numSamples: number = 40,
): Float32Array {
    // 每个像素 4 通道（RGB 透射率 + Alpha=1.0）
    const lutData = new Float32Array(width * height * 4);

    // 大气顶部半径的平方（预计算，用于射线与大气外球面求交）
    const atmosphereRadiusSq = ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS;

    // 遍历 LUT 的每个像素
    for (let y = 0; y < height; y++) {
        // 垂直轴映射到观测点高度 h ∈ [0, atmosphereHeight]
        // 使用线性映射：h = (y + 0.5) / height × atmosphereHeight
        // +0.5 是像素中心偏移，避免采样在边界上
        const h = ((y + 0.5) / height) * ATMOSPHERE_HEIGHT;
        // 观测点到地心的距离 r = earthRadius + h
        const r = EARTH_RADIUS + h;

        for (let x = 0; x < width; x++) {
            // 水平轴映射到 cos(天顶角) ∈ [-1, 1]
            // -1 = 朝地面，+1 = 朝天顶
            const cosTheta = ((x + 0.5) / width) * 2.0 - 1.0;

            // ---- 射线-球面求交：从高度 r 出发，方向为天顶角 θ ----
            // 射线参数方程：P(t) = [0, r] + t × [sinθ, cosθ]
            // 与大气外球面 |P|² = R_atm² 求交
            // 展开得二次方程：t² + 2·r·cosθ·t + (r² - R_atm²) = 0
            const b = 2.0 * r * cosTheta;
            const c = r * r - atmosphereRadiusSq;
            const discriminant = b * b - 4.0 * c;

            // 若判别式 < 0，射线不与大气球面相交（观测点在大气外且朝外看）
            if (discriminant < 0.0) {
                const pixelOffset = (y * width + x) * 4;
                // 无交点 → 透射率 = 1.0（无介质衰减）
                lutData[pixelOffset] = 1.0;
                lutData[pixelOffset + 1] = 1.0;
                lutData[pixelOffset + 2] = 1.0;
                lutData[pixelOffset + 3] = 1.0;
                continue;
            }

            // 取较大的正根：射线穿过大气层到外边界的距离
            const sqrtDisc = Math.sqrt(discriminant);
            const t0 = (-b - sqrtDisc) * 0.5;
            const t1 = (-b + sqrtDisc) * 0.5;
            // 路径长度 = max(t1, 0)（确保非负，观测点可能在大气层内）
            const pathLength = Math.max(t1, 0.0) - Math.max(t0, 0.0);

            // 若路径长度几乎为零，透射率为 1
            if (pathLength < 1.0) {
                const pixelOffset = (y * width + x) * 4;
                lutData[pixelOffset] = 1.0;
                lutData[pixelOffset + 1] = 1.0;
                lutData[pixelOffset + 2] = 1.0;
                lutData[pixelOffset + 3] = 1.0;
                continue;
            }

            // ---- 沿射线步进积分光学厚度 (Optical Depth) ----
            // 积分 τ = ∫ (βR·ρR(h) + βM·ρM(h)) ds
            // 使用梯形法则（Trapezoidal Rule），numSamples 个采样点
            const stepSize = pathLength / numSamples;
            // 三通道光学厚度累积器（R/G/B 各自累积因为 Rayleigh 系数不同）
            let opticalDepthR = 0.0;
            let opticalDepthG = 0.0;
            let opticalDepthB = 0.0;

            // 射线起点（取 max(t0, 0) 以确保从大气内部开始）
            const tStart = Math.max(t0, 0.0);

            for (let i = 0; i <= numSamples; i++) {
                // 当前采样点沿射线的参数 t
                const t = tStart + i * stepSize;

                // 采样点在 2D 极坐标中的位置（射线方向 = [sinθ, cosθ]）
                // sinθ = sqrt(1 - cosθ²)
                const sinTheta = Math.sqrt(Math.max(0.0, 1.0 - cosTheta * cosTheta));
                const sampleX = t * sinTheta;
                const sampleY = r + t * cosTheta;

                // 采样点到地心的距离
                const sampleR = Math.sqrt(sampleX * sampleX + sampleY * sampleY);
                // 采样点的海拔高度
                const sampleH = sampleR - EARTH_RADIUS;

                // 若采样点低于地面（被地球挡住），跳过
                if (sampleH < 0.0) {
                    continue;
                }

                // Rayleigh 密度：ρR(h) = exp(-h / H_R)
                const rayleighDensity = Math.exp(-sampleH / RAYLEIGH_HEIGHT);
                // Mie 密度：ρM(h) = exp(-h / H_M)
                const mieDensity = Math.exp(-sampleH / MIE_HEIGHT);

                // 梯形法则权重：首尾点权重为 0.5，中间点为 1.0
                const weight = (i === 0 || i === numSamples) ? 0.5 : 1.0;

                // 累加各通道光学厚度
                // τ_R = ∫ βR × ρR(h) ds，βR 各通道不同
                // τ_M = ∫ βM × ρM(h) ds，βM 各通道相同
                opticalDepthR += (RAYLEIGH_COEFF[0] * rayleighDensity + MIE_COEFF * mieDensity) * weight;
                opticalDepthG += (RAYLEIGH_COEFF[1] * rayleighDensity + MIE_COEFF * mieDensity) * weight;
                opticalDepthB += (RAYLEIGH_COEFF[2] * rayleighDensity + MIE_COEFF * mieDensity) * weight;
            }

            // 乘以步长完成积分
            opticalDepthR *= stepSize;
            opticalDepthG *= stepSize;
            opticalDepthB *= stepSize;

            // ---- 透射率 = exp(-光学厚度) ----
            // Beer-Lambert 定律：光强衰减为 I = I₀ × exp(-τ)
            const pixelOffset = (y * width + x) * 4;
            lutData[pixelOffset] = Math.exp(-opticalDepthR);
            lutData[pixelOffset + 1] = Math.exp(-opticalDepthG);
            lutData[pixelOffset + 2] = Math.exp(-opticalDepthB);
            // Alpha 通道始终为 1.0（完全不透明）
            lutData[pixelOffset + 3] = 1.0;
        }
    }

    return lutData;
}

/**
 * 计算级联阴影贴图（CSM）的级联分割距离。
 * 使用对数-均匀混合方案（Practical Split Scheme）：
 *   split_i = λ × log_split + (1 - λ) × uniform_split
 * 其中：
 *   log_split = near × (far / near)^(i / N)
 *   uniform_split = near + (far - near) × i / N
 *
 * λ = 0 → 纯均匀分割（近处阴影精度不足）
 * λ = 1 → 纯对数分割（远处阴影精度浪费）
 * λ = 0.5 → 折中方案（推荐值）
 *
 * @param cascadeCount - 级联数量，范围 [2, 4]
 * @param nearPlane - 相机近裁剪面距离（米）
 * @param farPlane - 相机远裁剪面距离（米）
 * @param lambda - 混合因子，范围 [0, 1]，默认 CASCADE_SPLIT_LAMBDA
 * @returns number[] — 长度为 cascadeCount+1 的分割距离数组（含 near 和 far）
 *
 * @example
 * const splits = computeCascadeSplits(3, 0.1, 1000, 0.5);
 * // splits ≈ [0.1, 3.24, 31.8, 1000]
 * // 级联 0: [0.1, 3.24] 近处高精度
 * // 级联 1: [3.24, 31.8] 中距离
 * // 级联 2: [31.8, 1000] 远处低精度
 */
export function computeCascadeSplits(
    cascadeCount: number,
    nearPlane: number,
    farPlane: number,
    lambda: number = CASCADE_SPLIT_LAMBDA,
): number[] {
    // 限制级联数在合法范围
    const clampedCascades = Math.max(2, Math.min(4, Math.round(cascadeCount)));

    // 限制 lambda 到 [0, 1]
    const clampedLambda = Math.max(0.0, Math.min(1.0, lambda));

    // 确保 near > 0 和 far > near，防止对数计算出错
    const safeNear = Math.max(nearPlane, 1e-4);
    const safeFar = Math.max(farPlane, safeNear + 1.0);

    // 结果数组：长度 = cascadeCount + 1（包含 near 和 far 端点）
    const splits: number[] = new Array(clampedCascades + 1);

    // 第一个分割点 = 近裁剪面
    splits[0] = safeNear;

    // 对数分割的底数：(far / near) 的 1/N 次方
    const ratio = safeFar / safeNear;

    for (let i = 1; i < clampedCascades; i++) {
        // 归一化位置 p = i / N，p ∈ (0, 1)
        const p = i / clampedCascades;

        // 对数分割：近处密集，远处稀疏（适合深度精度指数分布）
        const logSplit = safeNear * Math.pow(ratio, p);

        // 均匀分割：等间距（直觉简单，但浪费近处精度）
        const uniformSplit = safeNear + (safeFar - safeNear) * p;

        // 混合：λ × log + (1 - λ) × uniform
        splits[i] = clampedLambda * logSplit + (1.0 - clampedLambda) * uniformSplit;
    }

    // 最后一个分割点 = 远裁剪面
    splits[clampedCascades] = safeFar;

    return splits;
}

/**
 * 构建大气散射物理常量对象。
 * 将模块级常量封装为结构化对象，便于传递给 Shader Uniform。
 *
 * @returns 不可变的大气常量集合
 *
 * @example
 * const atm = buildAtmosphereConstants();
 * console.log(atm.earthRadius); // 6371000
 * console.log(atm.rayleighCoeff); // Float32Array [5.5e-6, 13e-6, 22.4e-6]
 */
export function buildAtmosphereConstants(): AtmosphereConstants {
    return {
        earthRadius: EARTH_RADIUS,
        atmosphereRadius: ATMOSPHERE_RADIUS,
        rayleighCoeff: new Float32Array(RAYLEIGH_COEFF),
        rayleighHeight: RAYLEIGH_HEIGHT,
        mieCoeff: MIE_COEFF,
        mieHeight: MIE_HEIGHT,
        mieG: MIE_G,
    };
}

// ============================================================
// GlobeRenderer 内部实现
// ============================================================

/**
 * GlobeRenderer 内部可变状态。
 * 将所有可变字段集中管理，与公共接口分离。
 */
interface GlobeRendererState {
    /** 是否已初始化 */
    initialized: boolean;
    /** 是否已销毁 */
    destroyed: boolean;

    /** 大气效果开关 */
    atmosphereEnabled: boolean;
    /** 大气散射强度乘数 */
    atmosphereIntensity: number;
    /** 大气散射色调 [R, G, B] */
    atmosphereColor: Float32Array;
    /** 大气计算方式 */
    atmosphereMethod: 'lut' | 'realtime';
    /** 大气射线步进采样数 */
    atmosphereSamples: number;

    /** 星空开关 */
    skyboxEnabled: boolean;
    /** 星空亮度乘数 */
    starBrightness: number;

    /** 阴影开关 */
    shadowsEnabled: boolean;
    /** 阴影级联数 */
    shadowCascades: number;
    /** 阴影贴图尺寸 */
    shadowMapSize: number;
    /** PCF 采样半径 */
    shadowPCFSize: number;

    /** 太阳 ECEF 位置（米） */
    sunPosition: Float32Array;
    /** 归一化太阳方向 */
    sunDirection: Float32Array;

    /** 地球表面基础颜色 */
    baseColor: Float32Array;

    /** 椭球体网格数据 */
    meshData: EllipsoidMeshData | null;
    /** 星空数据 */
    starfieldData: StarfieldData | null;
    /** 大气透射率 LUT 数据（CPU 端） */
    transmittanceLUT: Float32Array | null;
    /** 大气物理常量 */
    atmosphereConstants: AtmosphereConstants | null;

    /** 层上下文引用（弱引用，不阻碍 GC） */
    context: LayerContext | null;
}

/**
 * 辅助函数：将 Float32Array 方向向量归一化并写入 out。
 * 若输入长度接近零（< 1e-10），输出设为 [0, 0, 1]（默认朝向 Z+）。
 *
 * @param out - 输出归一化方向（预分配 Float32Array(3)）
 * @param src - 源方向向量（Float32Array(3)）
 * @returns out 引用
 *
 * @example
 * const dir = new Float32Array(3);
 * normalizeSunDirection(dir, sunPositionECEF);
 */
function normalizeSunDirection(out: Float32Array, src: Float32Array): Float32Array {
    const x = src[0], y = src[1], z = src[2];
    const len = Math.sqrt(x * x + y * y + z * z);

    if (len < 1e-10) {
        // 零向量保护：默认太阳方向指向 Z+（北极上方）
        out[0] = 0.0;
        out[1] = 0.0;
        out[2] = 1.0;
        return out;
    }

    const invLen = 1.0 / len;
    out[0] = x * invLen;
    out[1] = y * invLen;
    out[2] = z * invLen;

    return out;
}

/**
 * 辅助函数：将数值 clamp 到 [min, max] 范围。
 *
 * @param value - 输入值
 * @param lo - 下界
 * @param hi - 上界
 * @returns clamp 后的值
 *
 * @example
 * clampValue(1.5, 0, 2); // 1.5
 * clampValue(-1, 0, 2);  // 0
 */
function clampValue(value: number, lo: number, hi: number): number {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

/**
 * 创建 GlobeRenderer 实例。
 * 工厂函数模式——返回接口而非 class，便于 Tree-Shake 移除未使用方法。
 *
 * @param options - 渲染器配置选项，所有字段可选
 * @returns GlobeRenderer 接口实例
 *
 * @stability experimental
 *
 * @example
 * const renderer = createGlobeRenderer({
 *   atmosphere: true,
 *   atmosphereIntensity: 1.2,
 *   skybox: true,
 *   starCount: 20000,
 *   shadows: false,
 *   globeSegments: 128,
 * });
 * renderer.initialize(layerContext);
 * renderer.setSunFromDateTime(new Date());
 */
export function createGlobeRenderer(options: GlobeOptions = {}): GlobeRenderer {
    // ---- 从 options 提取配置，应用默认值 ----
    const globeSegments = clampValue(options.globeSegments ?? DEFAULT_GLOBE_SEGMENTS, 16, 256);
    const starCount = clampValue(options.starCount ?? DEFAULT_STAR_COUNT, 1000, 100000);

    // 初始太阳位置：若用户未提供，稍后在 initialize 中通过 setSunFromDateTime 计算
    const initialSunPosition = new Float32Array(3);
    if (options.sunPosition != null && options.sunPosition.length >= 3) {
        initialSunPosition[0] = options.sunPosition[0];
        initialSunPosition[1] = options.sunPosition[1];
        initialSunPosition[2] = options.sunPosition[2];
    }

    // ---- 构建内部可变状态 ----
    const state: GlobeRendererState = {
        initialized: false,
        destroyed: false,

        atmosphereEnabled: options.atmosphere !== false,
        atmosphereIntensity: clampValue(options.atmosphereIntensity ?? 1.0, 0.0, 2.0),
        atmosphereColor: new Float32Array(options.atmosphereColor ?? [0.3, 0.5, 1.0]),
        atmosphereMethod: options.atmosphereMethod ?? 'lut',
        atmosphereSamples: clampValue(options.atmosphereSamples ?? 16, 4, 32),

        skyboxEnabled: options.skybox !== false,
        starBrightness: clampValue(options.starBrightness ?? 1.0, 0.0, 2.0),

        shadowsEnabled: options.shadows === true,
        shadowCascades: clampValue(options.shadowCascades ?? DEFAULT_SHADOW_CASCADES, 2, 4),
        shadowMapSize: clampValue(options.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE, 512, 4096),
        shadowPCFSize: clampValue(options.shadowPCFSize ?? DEFAULT_PCF_SIZE, 1, 5),

        sunPosition: initialSunPosition,
        sunDirection: new Float32Array(3),

        baseColor: new Float32Array(options.baseColor ?? [0.05, 0.05, 0.1, 1.0]),

        meshData: null,
        starfieldData: null,
        transmittanceLUT: null,
        atmosphereConstants: null,

        context: null,
    };

    // 初始化太阳方向（从位置归一化）
    normalizeSunDirection(state.sunDirection, state.sunPosition);

    // ---- 公共接口实现 ----

    const renderer: GlobeRenderer = {
        /**
         * 初始化渲染器：生成网格、星空、LUT、大气常量。
         * 若用户未提供 sunPosition，自动使用当前时间计算。
         *
         * @param context - 图层上下文
         *
         * @example
         * renderer.initialize(layerContext);
         */
        initialize(context: LayerContext): void {
            // 防止重复初始化或在销毁后初始化
            if (state.initialized) {
                if (__DEV__) {
                    console.warn('[GlobeRenderer] Already initialized, skipping.');
                }
                return;
            }
            if (state.destroyed) {
                if (__DEV__) {
                    console.error('[GlobeRenderer] Cannot initialize after destroy.');
                }
                return;
            }

            state.context = context;

            // 生成 WGS84 椭球体网格
            state.meshData = generateEllipsoidMesh(globeSegments);

            // 生成星空数据
            state.starfieldData = generateStarfield(starCount);

            // 预计算大气透射率 LUT（CPU 端，后续上传为 GPU 纹理）
            state.transmittanceLUT = computeTransmittanceLUT(
                TRANSMITTANCE_LUT_WIDTH,
                TRANSMITTANCE_LUT_HEIGHT,
            );

            // 构建大气物理常量
            state.atmosphereConstants = buildAtmosphereConstants();

            // 若太阳位置未被用户显式设置（全零），则使用当前时间计算
            const sunLen = Math.sqrt(
                state.sunPosition[0] * state.sunPosition[0]
                + state.sunPosition[1] * state.sunPosition[1]
                + state.sunPosition[2] * state.sunPosition[2],
            );
            if (sunLen < 1.0) {
                computeSunPositionECEF(new Date(), state.sunPosition);
                normalizeSunDirection(state.sunDirection, state.sunPosition);
            }

            state.initialized = true;

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] Initialized: mesh=${state.meshData.vertexCount} verts, `
                    + `stars=${state.starfieldData.count}, `
                    + `LUT=${TRANSMITTANCE_LUT_WIDTH}×${TRANSMITTANCE_LUT_HEIGHT}`,
                );
            }
        },

        /**
         * 销毁所有资源，将状态标记为已销毁。
         *
         * @example
         * renderer.destroy();
         */
        destroy(): void {
            if (state.destroyed) {
                return;
            }

            // 清空所有 CPU 数据引用，便于 GC 回收
            state.meshData = null;
            state.starfieldData = null;
            state.transmittanceLUT = null;
            state.atmosphereConstants = null;
            state.context = null;

            state.destroyed = true;
            state.initialized = false;

            if (__DEV__) {
                console.log('[GlobeRenderer] Destroyed.');
            }
        },

        /**
         * 启用/禁用大气散射。
         *
         * @param enabled - 开关
         */
        setAtmosphereEnabled(enabled: boolean): void {
            state.atmosphereEnabled = enabled;
        },

        /**
         * 查询大气散射开关。
         *
         * @returns 是否启用
         */
        isAtmosphereEnabled(): boolean {
            return state.atmosphereEnabled;
        },

        /**
         * 设置大气散射强度。
         *
         * @param intensity - 强度值，clamp 到 [0, 2]
         */
        setAtmosphereIntensity(intensity: number): void {
            state.atmosphereIntensity = clampValue(intensity, 0.0, 2.0);
        },

        /**
         * 获取当前大气强度。
         *
         * @returns 强度值
         */
        getAtmosphereIntensity(): number {
            return state.atmosphereIntensity;
        },

        /**
         * 设置大气散射色调。
         *
         * @param color - [R, G, B] 各通道 [0, 1]
         */
        setAtmosphereColor(color: readonly [number, number, number]): void {
            state.atmosphereColor[0] = clampValue(color[0], 0.0, 1.0);
            state.atmosphereColor[1] = clampValue(color[1], 0.0, 1.0);
            state.atmosphereColor[2] = clampValue(color[2], 0.0, 1.0);
        },

        /**
         * 启用/禁用星空天穹。
         *
         * @param enabled - 开关
         */
        setSkyboxEnabled(enabled: boolean): void {
            state.skyboxEnabled = enabled;
        },

        /**
         * 查询星空天穹开关。
         *
         * @returns 是否启用
         */
        isSkyboxEnabled(): boolean {
            return state.skyboxEnabled;
        },

        /**
         * 设置自定义天穹纹理。
         * MVP 阶段为存根实现。
         *
         * @param _texture - 预留参数
         */
        setSkyboxTexture(_texture: unknown): void {
            if (__DEV__) {
                console.log('[GlobeRenderer] setSkyboxTexture: stub — custom cubemap not yet implemented.');
            }
        },

        /**
         * 启用/禁用阴影。
         *
         * @param enabled - 开关
         */
        setShadowsEnabled(enabled: boolean): void {
            state.shadowsEnabled = enabled;
        },

        /**
         * 查询阴影开关。
         *
         * @returns 是否启用
         */
        isShadowsEnabled(): boolean {
            return state.shadowsEnabled;
        },

        /**
         * 设置阴影级联数。
         *
         * @param cascades - 级联数量，clamp 到 [2, 4]
         */
        setShadowCascades(cascades: number): void {
            state.shadowCascades = clampValue(Math.round(cascades), 2, 4);
        },

        /**
         * 设置阴影贴图尺寸。
         *
         * @param size - 像素尺寸，clamp 到 [512, 4096]
         */
        setShadowMapSize(size: number): void {
            state.shadowMapSize = clampValue(Math.round(size), 512, 4096);
        },

        /**
         * 直接设置太阳 ECEF 位置。
         *
         * @param ecef - Float32Array(3) [x, y, z] 米
         */
        setSunPosition(ecef: Float32Array): void {
            // 验证输入长度
            if (ecef == null || ecef.length < 3) {
                if (__DEV__) {
                    console.warn('[GlobeRenderer] setSunPosition: invalid input, expected Float32Array(3).');
                }
                return;
            }

            state.sunPosition[0] = ecef[0];
            state.sunPosition[1] = ecef[1];
            state.sunPosition[2] = ecef[2];

            // 同步更新归一化方向
            normalizeSunDirection(state.sunDirection, state.sunPosition);
        },

        /**
         * 获取太阳 ECEF 位置。
         *
         * @returns Float32Array(3) 的只读副本
         */
        getSunPosition(): Float32Array {
            // 返回副本以防止外部修改内部状态
            const result = new Float32Array(3);
            result[0] = state.sunPosition[0];
            result[1] = state.sunPosition[1];
            result[2] = state.sunPosition[2];
            return result;
        },

        /**
         * 根据日期时间计算太阳位置。
         *
         * @param date - UTC 日期时间
         */
        setSunFromDateTime(date: Date): void {
            // 验证输入
            if (!(date instanceof Date) || isNaN(date.getTime())) {
                if (__DEV__) {
                    console.warn('[GlobeRenderer] setSunFromDateTime: invalid Date object.');
                }
                return;
            }

            // 计算太阳 ECEF 位置
            computeSunPositionECEF(date, state.sunPosition);

            // 同步更新归一化方向
            normalizeSunDirection(state.sunDirection, state.sunPosition);

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] Sun position updated for ${date.toISOString()}: `
                    + `[${state.sunPosition[0].toExponential(3)}, `
                    + `${state.sunPosition[1].toExponential(3)}, `
                    + `${state.sunPosition[2].toExponential(3)}]`,
                );
            }
        },

        /**
         * 获取归一化太阳方向向量。
         *
         * @returns Float32Array(3) 的只读副本
         */
        getSunDirection(): Float32Array {
            const result = new Float32Array(3);
            result[0] = state.sunDirection[0];
            result[1] = state.sunDirection[1];
            result[2] = state.sunDirection[2];
            return result;
        },

        /**
         * GPU 编码：地球椭球体。MVP 阶段存根。
         *
         * @param encoder - GPU render pass encoder
         * @param camera - 当前帧相机状态
         */
        encodeGlobe(encoder: unknown, camera: CameraState): void {
            if (!state.initialized || state.destroyed) {
                return;
            }

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] encodeGlobe stub — mesh has `
                    + `${state.meshData?.vertexCount ?? 0} vertices, `
                    + `camera altitude=${camera.altitude.toFixed(0)}m`,
                );
            }
        },

        /**
         * GPU 编码：大气散射。MVP 阶段存根。
         *
         * @param encoder - GPU render pass encoder
         * @param camera - 当前帧相机状态
         */
        encodeAtmosphere(encoder: unknown, camera: CameraState): void {
            if (!state.initialized || state.destroyed || !state.atmosphereEnabled) {
                return;
            }

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] encodeAtmosphere stub — `
                    + `method=${state.atmosphereMethod}, intensity=${state.atmosphereIntensity}`,
                );
            }
        },

        /**
         * GPU 编码：星空天穹。MVP 阶段存根。
         *
         * @param encoder - GPU render pass encoder
         * @param camera - 当前帧相机状态
         */
        encodeSkybox(encoder: unknown, camera: CameraState): void {
            if (!state.initialized || state.destroyed || !state.skyboxEnabled) {
                return;
            }

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] encodeSkybox stub — `
                    + `stars=${state.starfieldData?.count ?? 0}, brightness=${state.starBrightness}`,
                );
            }
        },

        /**
         * GPU 编码：阴影深度 Pass。MVP 阶段存根。
         *
         * @param encoder - GPU render pass encoder
         * @param camera - 当前帧相机状态
         */
        encodeShadowPass(encoder: unknown, camera: CameraState): void {
            if (!state.initialized || state.destroyed || !state.shadowsEnabled) {
                return;
            }

            if (__DEV__) {
                console.log(
                    `[GlobeRenderer] encodeShadowPass stub — `
                    + `cascades=${state.shadowCascades}, mapSize=${state.shadowMapSize}`,
                );
            }
        },

        /**
         * 获取阴影贴图纹理。MVP 阶段返回 null。
         *
         * @returns null
         */
        getShadowMapTexture(): null {
            return null;
        },

        /**
         * 获取阴影 VP 矩阵。MVP 阶段返回空数组。
         *
         * @returns 空 Float32Array[]
         */
        getShadowVPMatrices(): Float32Array[] {
            return [];
        },

        /**
         * 获取级联分割距离。MVP 阶段返回空数组。
         *
         * @returns 空 number[]
         */
        getCascadeSplits(): number[] {
            return [];
        },
    };

    return renderer;
}
