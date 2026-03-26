/**
 * @packageDocumentation
 * @module @gis-forge/preset-3d
 * @description
 * **preset-3d**（L6）对外桶：导出 {@link Globe3D} 主类、构造选项、渲染统计类型，
 * 以及与球体渲染管线一致的 **对数深度** 工具（`computeLogDepthBufFC`）与 WGSL 片段（`LOG_DEPTH_WGSL`），
 * 供矢量/拉伸等图层着色器拼接时保持深度一致。
 *
 * 实现拆分为 `globe-*.ts` 子模块（常量、缓冲、GPU、相机、瓦片、交互等），主类见 {@link file://./globe-3d.ts}。
 *
 * @example
 * ```ts
 * import { Globe3D, computeLogDepthBufFC } from '@gis-forge/preset-3d';
 * ```
 */

// ============================================================
// @gis-forge/preset-3d — 包公共入口（桶导出）
// 聚合 Globe3D 核心类、对数深度辅助与相关类型。
// ============================================================

export {
    /** 3D 数字地球主类（WebGPU + Camera3D + 瓦片） */
    Globe3D,
    /** 与 globe 瓦片相同的 log-depth 常数，供其它图层 WGSL 使用 */
    computeLogDepthBufFC,
    /** 可嵌入 polyline/point shader 的 `applyLogDepth` 片段 */
    LOG_DEPTH_WGSL,
} from './globe-3d.ts';

export type {
    /** 构造 {@link Globe3D} 时的选项（容器、影像、交互、初始相机） */
    Globe3DOptions,
    /** 预留：模型 / 标牌 / 标签实体描述 */
    EntitySpec,
    /** 上一帧瓦片数、缓存量、draw call、帧时间 */
    GlobeRendererStats,
} from './globe-3d.ts';
