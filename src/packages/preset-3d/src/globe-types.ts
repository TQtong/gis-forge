/**
 * @module preset-3d/globe-types
 * @description
 * Globe3D **对外选项**、**运行时状态**与 **GPU 资源聚合类型**。
 * 与 `globe-3d.ts` 中的 {@link Globe3D} 字段一一对应，子模块（`globe-gpu`、`globe-tiles` 等）仅依赖本文件与 L0 类型，不反向依赖主类。
 *
 * @stability experimental
 */

import type { GlobeTileMesh } from '../../globe/src/globe-tile-mesh.ts';

/**
 * 构造 {@link import('./globe-3d.ts').Globe3D} 时的选项。
 * 所有字段均为可选侧写默认值；`container` 为唯一必填。
 */
export interface Globe3DOptions {
    /**
     * 挂载目标：CSS 选择器字符串或已有 `HTMLElement`。
     * 引擎在容器内创建铺满的 `HTMLCanvasElement`。
     */
    readonly container: string | HTMLElement;

    /**
     * 地形数据源（DEM）。未实现完整管线时仅保留字段供后续 TerrainLayer 使用。
     */
    readonly terrain?: {
        /** DEM 或 TileJSON 根 URL */
        readonly url: string;
        /** 高程缩放，默认 1（真实米制） */
        readonly exaggeration?: number;
    };

    /**
     * 影像底图（XYZ/WMTS 类瓦片）。
     */
    readonly imagery?: {
        /** `{z}/{x}/{y}` 模板 URL */
        readonly url?: string;
        /** 方案标识，如 `xyz` / `wmts`（调度器扩展用） */
        readonly type?: string;
        /** 最大 zoom，防止请求不存在级别 */
        readonly maximumLevel?: number;
    };

    /** `false` 关闭大气 pass；默认 `true` */
    readonly atmosphere?: boolean;
    /** 阴影（预留）；默认 `false` */
    readonly shadows?: boolean;
    /** `false` 不渲染天穹全屏背景；默认 `true` */
    readonly skybox?: boolean;
    /** 雾效（预留）；默认 `true` */
    readonly fog?: boolean;
    /** 无影像时的地球底色 RGBA，默认深蓝 */
    readonly baseColor?: [number, number, number, number];
    /** 目标帧率提示（预留）；当前帧循环未严格限频 */
    readonly targetFrameRate?: number;
    /** MSAA 等（预留） */
    readonly antialias?: boolean;
    /** 画布 `devicePixelRatio` 上限，减轻 4K/5K 下像素填充压力 */
    readonly maxPixelRatio?: number;
    /** 左键拖拽旋转；默认 `true` */
    readonly enableRotate?: boolean;
    /** 滚轮缩放；默认 `true` */
    readonly enableZoom?: boolean;
    /** 中键调节 bearing/pitch；默认 `true` */
    readonly enableTilt?: boolean;
    /** 相机可到达的最近离地距离（米） */
    readonly minimumZoomDistance?: number;
    /** 相机可到达的最远离地距离（米） */
    readonly maximumZoomDistance?: number;
    /** 初始注视点 [经度°, 纬度°] */
    readonly center?: [number, number];
    /** 初始相机海拔（米） */
    readonly altitude?: number;
    /** 初始方位角（度），正北为 0 */
    readonly bearing?: number;
    /** 初始俯仰（度），俯视常为负 */
    readonly pitch?: number;
    /** 读屏软件用的 `canvas` `aria-label` */
    readonly accessibleTitle?: string;
}

/**
 * 场景中一个可渲染实体（模型 / 广告牌 / 标签）的描述。
 * 当前 {@link import('./globe-3d.ts').Globe3D} 仅存储元数据，渲染管线可后续接入。
 */
export interface EntitySpec {
    /** 业务唯一 id；省略时由引擎生成 */
    readonly id?: string;
    /** [经度°, 纬度°, 海拔米] */
    readonly position: [number, number, number];
    /** 外部 glTF 模型 */
    readonly model?: { readonly url: string; readonly scale?: number };
    /** 始终朝向相机的纹理牌 */
    readonly billboard?: { readonly image: string; readonly scale?: number };
    /** 屏幕空间文字 */
    readonly label?: { readonly text: string; readonly font?: string };
}

/**
 * `addImageryLayer` 写入的运行时记录，用于切回 URL 与透明度。
 */
export interface ImageryLayerRecord {
    /** 图层 id */
    readonly id: string;
    /** 瓦片模板 URL */
    readonly url: string;
    /** 协议类型字符串 */
    readonly type: string;
    /** 不透明度 [0,1] */
    alpha: number;
}

/**
 * `add3DTileset` 占位记录；3D Tiles 渲染未接引擎前仅存配置。
 */
export interface TilesetRecord {
    readonly id: string;
    readonly url: string;
    /** 屏幕空间误差阈值（像素） */
    maximumScreenSpaceError: number;
    show: boolean;
}

/**
 * `addGeoJSON` 占位记录。
 */
export interface GeoJsonRecord {
    readonly id: string;
    data: unknown;
    options: unknown;
}

/**
 * 单个瓦片在 CPU/GPU 侧的缓存项：纹理、bind group、加载状态。
 *
 * **地形占位**：`demReady` / `demData` 为后续 DEM 接入预留；当前平面瓦片 `demReady === false`。
 */
export interface CachedTile {
    /** GPU 纹理；加载中或失败时为 `null` */
    texture: GPUTexture | null;
    /** group(1) 采样器+纹理；与 `fallbackBindGroup` 布局一致 */
    bindGroup: GPUBindGroup | null;
    /** 是否已发起异步请求且尚未结束 */
    loading: boolean;
    /** 影像是否已上传 GPU 可供采样 */
    textureReady: boolean;
    /** DEM 是否已解析；未就绪时按 z=0 平面渲染 */
    demReady: boolean;
    /** 高程栅格；`null` 表示平面 */
    demData: Float32Array | null;
}

/**
 * 某一 zoom/x/y 瓦片对应的曲面网格及常驻索引缓冲。
 */
export interface CachedMesh {
    /** CPU 侧拓扑与 Float64 顶点，供每帧 `meshToRTE` */
    mesh: GlobeTileMesh;
    /** 上传后的 `GPUBuffer`，`INDEX` 用途 */
    indexBuffer: GPUBuffer;
}

/**
 * {@link import('./globe-3d.ts').Globe3D.renderer}  getter 返回的快照。
 */
export interface GlobeRendererStats {
    /** 上一 pass 绘制过的瓦片 draw 次数（每瓦片 1） */
    readonly tilesRendered: number;
    /** `tileCache` `Map` 当前 size */
    readonly tilesCached: number;
    /** 天穹 + 瓦片 + 大气等 draw/dispatch 合计 */
    readonly drawCalls: number;
    /** 上一帧 `_renderFrame`  wall time（毫秒） */
    readonly frameTimeMs: number;
}

/**
 * 单例聚合 Globe3D 在 **L1** 持有的 WebGPU 句柄，便于 `create*` / `destroy*` 成对传递。
 * 生命周期：`_bootstrapAsync` 填充 → `remove` / `destroyGlobeGPUResources` 清空。
 */
export interface GlobeGPURefs {
    /** 当前逻辑设备；未初始化或销毁后为 `null` */
    device: GPUDevice | null;
    /** `canvas.getContext('webgpu')`；与 `device` 同时置空 */
    gpuContext: GPUCanvasContext | null;
    /** `getCurrentTexture()` 的像素格式，如 `bgra8unorm` */
    surfaceFormat: GPUTextureFormat;
    /** 与 swapchain 同尺寸的 depth attachment */
    depthTexture: GPUTexture | null;
    /** 当前 `depthTexture.width` 缓存，用于判断是否需要重建 */
    depthW: number;
    /** 当前 `depthTexture.height` */
    depthH: number;
    /** 地球瓦片 raster pipeline */
    globePipeline: GPURenderPipeline | null;
    /** 天穹全屏三角形 pipeline */
    skyPipeline: GPURenderPipeline | null;
    /** 大气加性混合 pipeline */
    atmoPipeline: GPURenderPipeline | null;
    /** 96B camera uniform */
    cameraUniformBuffer: GPUBuffer | null;
    /** 16B tile UV uniform */
    tileParamsBuffer: GPUBuffer | null;
    /** 96B sky uniform */
    skyUniformBuffer: GPUBuffer | null;
    /** 大气壳 CPU 网格（R×1.025） */
    atmoMesh: GlobeTileMesh | null;
    /** 大气索引缓冲（静态） */
    atmoIndexBuffer: GPUBuffer | null;
    /** 大气交错顶点缓冲（每帧 RTE 更新） */
    atmoVertexBuffer: GPUBuffer | null;
    /** 瓦片与占位纹理共用的线性采样器 */
    sampler: GPUSampler | null;
    /** 1×1 深蓝占位纹理 */
    fallbackTexture: GPUTexture | null;
    /** 占位 bind group（group1） */
    fallbackBindGroup: GPUBindGroup | null;
    /** group0：相机 */
    cameraBindGroupLayout: GPUBindGroupLayout | null;
    /** group1：sampler + texture2d */
    tileBindGroupLayout: GPUBindGroupLayout | null;
    /** group2：tile params */
    tileParamsBindGroupLayout: GPUBindGroupLayout | null;
    /** 预绑 `cameraUniformBuffer` */
    cameraBindGroup: GPUBindGroup | null;
    /** 预绑 `tileParamsBuffer` */
    tileParamsBindGroup: GPUBindGroup | null;
}

/**
 * 返回全 `null` / 零尺寸的 {@link GlobeGPURefs}，供 `Globe3D` 字段初始化。
 *
 * @returns 可就地被 `createGlobeGPUResources` 变异的初始快照
 */
export function createEmptyGlobeGPURefs(): GlobeGPURefs {
    return {
        device: null,
        gpuContext: null,
        surfaceFormat: 'bgra8unorm',
        depthTexture: null,
        depthW: 0,
        depthH: 0,
        globePipeline: null,
        skyPipeline: null,
        atmoPipeline: null,
        cameraUniformBuffer: null,
        tileParamsBuffer: null,
        skyUniformBuffer: null,
        atmoMesh: null,
        atmoIndexBuffer: null,
        atmoVertexBuffer: null,
        sampler: null,
        fallbackTexture: null,
        fallbackBindGroup: null,
        cameraBindGroupLayout: null,
        tileBindGroupLayout: null,
        tileParamsBindGroupLayout: null,
        cameraBindGroup: null,
        tileParamsBindGroup: null,
    };
}

/**
 * 瓦片 URL、纹理 LRU、曲面网格缓存的可变聚合（纯数据结构，无方法）。
 */
export interface TileManagerState {
    /** 键 `"z/x/y"` → {@link CachedTile} */
    tileCache: Map<string, CachedTile>;
    /** 与 `tileCache` 同步的 LRU 键序；头部最久未用 */
    tileLRU: string[];
    /** 键 `"z/x/y"` → {@link CachedMesh}（索引缓冲常驻 GPU） */
    meshCache: Map<string, CachedMesh>;
    /** 当前影像图层使用的 `{z}/{x}/{y}` 模板 */
    tileUrlTemplate: string;
}

/**
 * 2D / 2.5D / 3D 视图 morph 的进度状态；由 {@link import('./globe-interaction.ts').runMorph} 写入。
 */
export interface MorphState {
    /** 是否处于插值区间（当前实现仅打标，渲染仍走 3D globe） */
    morphing: boolean;
    /** `performance.now()` 起始时间戳 */
    morphStartTime: number;
    /** 总时长（毫秒），至少 16ms */
    morphDuration: number;
    /** 目标模式 */
    morphTarget: '2d' | '25d' | '3d';
    /** 当前已生效模式；动画结束后与 `morphTarget` 一致 */
    viewMode: '2d' | '25d' | '3d';
}

/**
 * 鼠标拖拽/按键的可变状态；由 {@link import('./globe-interaction.ts').createGlobeMouseHandlers} 闭包读写。
 */
export interface GlobeInteractionState {
    /** 是否正在拖拽（左或中键） */
    isDragging: boolean;
    /**
     * 激活的键：`0` 左键平移轨道，`1` 中键旋转，` -1` 无。
     */
    dragButton: number;
}
