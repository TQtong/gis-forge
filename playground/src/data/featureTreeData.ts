/**
 * @file featureTreeData.ts
 * @description GeoForge DevPlayground 功能树完整数据。
 * 按架构层级（L0~L6）+ 功能包（P0~P3）+ 集成场景组织，共 ~80 个叶子节点。
 * 每个叶子节点的 sceneId 对应 scenes/ 目录中的场景配置文件。
 *
 * @stability experimental
 */

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

/**
 * 功能树节点数据结构。
 * 支持文件夹（有 children）和叶子（有 sceneId）两种形态。
 */
export interface TreeNode {
  /** 唯一 ID，用于 URL hash 路由和 React key，格式如 'l0-math-vec3' */
  id: string;

  /** 显示名称，支持中英文混合（如 "vec2/vec3/vec4 运算验证"） */
  label: string;

  /** Lucide 图标名称（可选），用于叶子节点前的图标 */
  icon?: string;

  /** 子节点数组（文件夹节点），与 sceneId 互斥 */
  children?: TreeNode[];

  /**
   * 场景配置 ID（叶子节点），指向 scenes/ 目录中的场景。
   * 点击时写入 sceneStore.activeSceneId 并同步到 URL hash。
   */
  sceneId?: string;
}

// ═══════════════════════════════════════════════════════════
// 功能树完整数据
// ═══════════════════════════════════════════════════════════

/**
 * 功能树完整数据，按 GeoForge 七层架构 + 功能包 + 集成场景组织。
 *
 * 结构总览：
 * - L0 基础层：math / geo / algorithm / index / precision（~23 叶子）
 * - L1 GPU 层：6 个模块
 * - L2 渲染层：11 个模块
 * - L3 调度层：7 个模块
 * - L4 场景层：9 个模块
 * - L5 扩展层：6 个扩展点
 * - L6 预设层：4 个预设
 * - P0 相机：3 个相机 + P0 图层：3 个基础图层
 * - P1 3D：4 个 3D 模块
 * - P2 增强：10 个增强功能
 * - P3 生态：7 个生态包
 * - 集成场景：8 个端到端测试场景
 */
export const featureTreeData: TreeNode[] = [
  // ───────────────────────────────────────────────────────
  // L0 基础层
  // ───────────────────────────────────────────────────────
  {
    id: 'l0',
    label: 'L0 基础层',
    children: [
      {
        id: 'l0-math',
        label: 'math',
        children: [
          {
            id: 'l0-math-vec',
            label: 'vec2/vec3/vec4 运算验证',
            sceneId: 'l0-math-vec',
          },
          {
            id: 'l0-math-mat4',
            label: 'mat4 投影矩阵',
            sceneId: 'l0-math-mat4',
          },
          {
            id: 'l0-math-quat',
            label: 'quat 四元数旋转',
            sceneId: 'l0-math-quat',
          },
          {
            id: 'l0-math-bbox',
            label: 'bbox 包围盒运算',
            sceneId: 'l0-math-bbox',
          },
          {
            id: 'l0-math-frustum',
            label: 'frustum 视锥体裁剪',
            sceneId: 'l0-math-frustum',
          },
          {
            id: 'l0-math-interpolate',
            label: 'interpolate 插值函数曲线',
            sceneId: 'l0-math-interpolate',
          },
        ],
      },
      {
        id: 'l0-geo',
        label: 'geo',
        children: [
          {
            id: 'l0-geo-ellipsoid',
            label: 'ellipsoid WGS84 坐标转换',
            sceneId: 'l0-geo-ellipsoid',
          },
          {
            id: 'l0-geo-mercator',
            label: 'mercator 投影',
            sceneId: 'l0-geo-mercator',
          },
          {
            id: 'l0-geo-geodesic',
            label: 'geodesic Vincenty 距离/方位',
            sceneId: 'l0-geo-geodesic',
          },
          {
            id: 'l0-geo-measure',
            label: 'measure 面积/长度/质心',
            sceneId: 'l0-geo-measure',
          },
        ],
      },
      {
        id: 'l0-algorithm',
        label: 'algorithm',
        children: [
          {
            id: 'l0-algorithm-earcut',
            label: 'earcut 三角剖分可视化',
            sceneId: 'l0-algorithm-earcut',
          },
          {
            id: 'l0-algorithm-delaunay',
            label: 'delaunay 三角网',
            sceneId: 'l0-algorithm-delaunay',
          },
          {
            id: 'l0-algorithm-convex-hull',
            label: 'convex-hull 凸包',
            sceneId: 'l0-algorithm-convex-hull',
          },
          {
            id: 'l0-algorithm-clip',
            label: 'clip 裁剪',
            sceneId: 'l0-algorithm-clip',
          },
          {
            id: 'l0-algorithm-intersect',
            label: 'intersect 相交检测',
            sceneId: 'l0-algorithm-intersect',
          },
          {
            id: 'l0-algorithm-contain',
            label: 'contain 包含测试',
            sceneId: 'l0-algorithm-contain',
          },
          {
            id: 'l0-algorithm-simplify',
            label: 'simplify 线简化对比',
            sceneId: 'l0-algorithm-simplify',
          },
          {
            id: 'l0-algorithm-cluster',
            label: 'cluster 聚合效果',
            sceneId: 'l0-algorithm-cluster',
          },
        ],
      },
      {
        id: 'l0-index',
        label: 'index',
        children: [
          {
            id: 'l0-index-rtree',
            label: 'R-Tree 查询可视化',
            sceneId: 'l0-index-rtree',
          },
          {
            id: 'l0-index-quadtree',
            label: 'Quadtree 可视化',
            sceneId: 'l0-index-quadtree',
          },
          {
            id: 'l0-index-kdtree',
            label: 'KD-Tree 最近邻',
            sceneId: 'l0-index-kdtree',
          },
        ],
      },
      {
        id: 'l0-precision',
        label: 'precision',
        children: [
          {
            id: 'l0-precision-split-double',
            label: 'Split-Double 精度对比',
            sceneId: 'l0-precision-split-double',
          },
          {
            id: 'l0-precision-rtc',
            label: 'RTC 偏移演示',
            sceneId: 'l0-precision-rtc',
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L1 GPU 层
  // ───────────────────────────────────────────────────────
  {
    id: 'l1',
    label: 'L1 GPU 层',
    children: [
      {
        id: 'l1-device-manager',
        label: 'DeviceManager GPU 信息',
        sceneId: 'l1-device-manager',
      },
      {
        id: 'l1-surface-manager',
        label: 'SurfaceManager Canvas/DPR',
        sceneId: 'l1-surface-manager',
      },
      {
        id: 'l1-buffer-pool',
        label: 'BufferPool 内存分配统计',
        sceneId: 'l1-buffer-pool',
      },
      {
        id: 'l1-texture-manager',
        label: 'TextureManager Atlas 可视化',
        sceneId: 'l1-texture-manager',
      },
      {
        id: 'l1-gpu-memory-tracker',
        label: 'GPUMemoryTracker 内存监控',
        sceneId: 'l1-gpu-memory-tracker',
      },
      {
        id: 'l1-gpu-uploader',
        label: 'GPUUploader 上传吞吐量',
        sceneId: 'l1-gpu-uploader',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L2 渲染层
  // ───────────────────────────────────────────────────────
  {
    id: 'l2',
    label: 'L2 渲染层',
    children: [
      {
        id: 'l2-shader-assembler',
        label: 'ShaderAssembler 模块组合',
        sceneId: 'l2-shader-assembler',
      },
      {
        id: 'l2-pipeline-cache',
        label: 'PipelineCache 缓存命中率',
        sceneId: 'l2-pipeline-cache',
      },
      {
        id: 'l2-depth-manager',
        label: 'DepthManager Reversed-Z 验证',
        sceneId: 'l2-depth-manager',
      },
      {
        id: 'l2-render-graph',
        label: 'RenderGraph DAG 可视化',
        sceneId: 'l2-render-graph',
      },
      {
        id: 'l2-compositor',
        label: 'Compositor 多投影合成',
        sceneId: 'l2-compositor',
      },
      {
        id: 'l2-picking-engine',
        label: 'PickingEngine 拾取测试',
        sceneId: 'l2-picking-engine',
      },
      {
        id: 'l2-stencil-manager',
        label: 'StencilManager 模板缓冲',
        sceneId: 'l2-stencil-manager',
      },
      {
        id: 'l2-render-stats',
        label: 'RenderStats 性能面板',
        sceneId: 'l2-render-stats',
      },
      {
        id: 'l2-compute-pass-manager',
        label: 'ComputePassManager GPU 计算',
        sceneId: 'l2-compute-pass-manager',
      },
      {
        id: 'l2-blend-presets',
        label: 'BlendPresets 混合模式',
        sceneId: 'l2-blend-presets',
      },
      {
        id: 'l2-uniform-layout-builder',
        label: 'UniformLayoutBuilder 对齐验证',
        sceneId: 'l2-uniform-layout-builder',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L3 调度层
  // ───────────────────────────────────────────────────────
  {
    id: 'l3',
    label: 'L3 调度层',
    children: [
      {
        id: 'l3-frame-scheduler',
        label: 'FrameScheduler 帧循环监控',
        sceneId: 'l3-frame-scheduler',
      },
      {
        id: 'l3-tile-scheduler',
        label: 'TileScheduler 瓦片加载可视化',
        sceneId: 'l3-tile-scheduler',
      },
      {
        id: 'l3-worker-pool',
        label: 'WorkerPool 任务队列监控',
        sceneId: 'l3-worker-pool',
      },
      {
        id: 'l3-resource-manager',
        label: 'ResourceManager 资源生命周期',
        sceneId: 'l3-resource-manager',
      },
      {
        id: 'l3-memory-budget',
        label: 'MemoryBudget 内存预算',
        sceneId: 'l3-memory-budget',
      },
      {
        id: 'l3-request-scheduler',
        label: 'RequestScheduler 网络请求监控',
        sceneId: 'l3-request-scheduler',
      },
      {
        id: 'l3-error-recovery',
        label: 'ErrorRecovery 错误恢复测试',
        sceneId: 'l3-error-recovery',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L4 场景层
  // ───────────────────────────────────────────────────────
  {
    id: 'l4',
    label: 'L4 场景层',
    children: [
      {
        id: 'l4-scene-graph',
        label: 'SceneGraph 投影分组',
        sceneId: 'l4-scene-graph',
      },
      {
        id: 'l4-layer-manager',
        label: 'LayerManager 图层操作',
        sceneId: 'l4-layer-manager',
      },
      {
        id: 'l4-source-manager',
        label: 'SourceManager 数据源管理',
        sceneId: 'l4-source-manager',
      },
      {
        id: 'l4-style-engine',
        label: 'StyleEngine 样式编译',
        sceneId: 'l4-style-engine',
      },
      {
        id: 'l4-label-manager',
        label: 'LabelManager 标注碰撞',
        sceneId: 'l4-label-manager',
      },
      {
        id: 'l4-glyph-manager',
        label: 'GlyphManager MSDF 字形',
        sceneId: 'l4-glyph-manager',
      },
      {
        id: 'l4-feature-state-manager',
        label: 'FeatureStateManager 状态驱动',
        sceneId: 'l4-feature-state-manager',
      },
      {
        id: 'l4-antimeridian-handler',
        label: 'AntiMeridianHandler 日期线',
        sceneId: 'l4-antimeridian-handler',
      },
      {
        id: 'l4-animation-manager',
        label: 'AnimationManager 动画',
        sceneId: 'l4-animation-manager',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L5 扩展层
  // ───────────────────────────────────────────────────────
  {
    id: 'l5',
    label: 'L5 扩展层',
    children: [
      {
        id: 'l5-ep1-custom-layer',
        label: 'EP1 自定义图层',
        sceneId: 'l5-ep1-custom-layer',
      },
      {
        id: 'l5-ep2-custom-projection',
        label: 'EP2 自定义投影',
        sceneId: 'l5-ep2-custom-projection',
      },
      {
        id: 'l5-ep3-custom-source',
        label: 'EP3 自定义数据源',
        sceneId: 'l5-ep3-custom-source',
      },
      {
        id: 'l5-ep4-shader-hook',
        label: 'EP4 Shader Hook',
        sceneId: 'l5-ep4-shader-hook',
      },
      {
        id: 'l5-ep5-custom-postprocess',
        label: 'EP5 自定义后处理',
        sceneId: 'l5-ep5-custom-postprocess',
      },
      {
        id: 'l5-ep6-custom-interaction',
        label: 'EP6 自定义交互',
        sceneId: 'l5-ep6-custom-interaction',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // L6 预设层
  // ───────────────────────────────────────────────────────
  {
    id: 'l6',
    label: 'L6 预设层',
    children: [
      {
        id: 'l6-map2d',
        label: 'Map2D 完整测试',
        sceneId: 'l6-map2d',
      },
      {
        id: 'l6-map25d',
        label: 'Map25D 完整测试',
        sceneId: 'l6-map25d',
      },
      {
        id: 'l6-globe3d',
        label: 'Globe3D 完整测试',
        sceneId: 'l6-globe3d',
      },
      {
        id: 'l6-map-full',
        label: 'MapFull 模式切换',
        sceneId: 'l6-map-full',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // P0 相机
  // ───────────────────────────────────────────────────────
  {
    id: 'p0-camera',
    label: 'P0 相机',
    children: [
      {
        id: 'p0-camera-2d',
        label: 'Camera2D 正交 + 惯性 + flyTo',
        sceneId: 'p0-camera-2d',
      },
      {
        id: 'p0-camera-25d',
        label: 'Camera25D 透视 + pitch/bearing',
        sceneId: 'p0-camera-25d',
      },
      {
        id: 'p0-camera-3d',
        label: 'Camera3D 轨道 + 地形碰撞',
        sceneId: 'p0-camera-3d',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // P0 图层
  // ───────────────────────────────────────────────────────
  {
    id: 'p0-layer',
    label: 'P0 图层',
    children: [
      {
        id: 'p0-raster-tile-layer',
        label: 'RasterTileLayer 栅格瓦片',
        sceneId: 'p0-raster-tile-layer',
      },
      {
        id: 'p0-vector-tile-layer',
        label: 'VectorTileLayer 矢量瓦片',
        sceneId: 'p0-vector-tile-layer',
      },
      {
        id: 'p0-geojson-layer',
        label: 'GeoJSONLayer GeoJSON + 聚合',
        sceneId: 'p0-geojson-layer',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // P1 3D
  // ───────────────────────────────────────────────────────
  {
    id: 'p1',
    label: 'P1 3D',
    children: [
      {
        id: 'p1-terrain-layer',
        label: 'TerrainLayer 地形渲染',
        sceneId: 'p1-terrain-layer',
      },
      {
        id: 'p1-globe-renderer',
        label: 'GlobeRenderer 大气/星空/阴影',
        sceneId: 'p1-globe-renderer',
      },
      {
        id: 'p1-view-morph',
        label: 'ViewMorph 2D↔3D 过渡',
        sceneId: 'p1-view-morph',
      },
      {
        id: 'p1-tiles3d-layer',
        label: 'Tiles3DLayer 3D Tiles',
        sceneId: 'p1-tiles3d-layer',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // P2 增强
  // ───────────────────────────────────────────────────────
  {
    id: 'p2',
    label: 'P2 增强',
    children: [
      {
        id: 'p2-heatmap-layer',
        label: 'HeatmapLayer 热力图',
        sceneId: 'p2-heatmap-layer',
      },
      {
        id: 'p2-pointcloud-layer',
        label: 'PointCloudLayer 点云',
        sceneId: 'p2-pointcloud-layer',
      },
      {
        id: 'p2-marker-layer',
        label: 'MarkerLayer 标注',
        sceneId: 'p2-marker-layer',
      },
      {
        id: 'p2-extrusion-layer',
        label: 'ExtrusionLayer 3D 建筑',
        sceneId: 'p2-extrusion-layer',
      },
      {
        id: 'p2-draw-tool',
        label: 'DrawTool 绘制',
        sceneId: 'p2-draw-tool',
      },
      {
        id: 'p2-measure-tool',
        label: 'MeasureTool 测量',
        sceneId: 'p2-measure-tool',
      },
      {
        id: 'p2-select-tool',
        label: 'SelectTool 选择',
        sceneId: 'p2-select-tool',
      },
      {
        id: 'p2-bloom-pass',
        label: 'BloomPass 泛光',
        sceneId: 'p2-bloom-pass',
      },
      {
        id: 'p2-ssao-pass',
        label: 'SSAOPass 环境光遮蔽',
        sceneId: 'p2-ssao-pass',
      },
      {
        id: 'p2-shadow-pass',
        label: 'ShadowPass 阴影',
        sceneId: 'p2-shadow-pass',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // P3 生态
  // ───────────────────────────────────────────────────────
  {
    id: 'p3',
    label: 'P3 生态',
    children: [
      {
        id: 'p3-wmts-source',
        label: 'WMTSSource WMTS 服务',
        sceneId: 'p3-wmts-source',
      },
      {
        id: 'p3-wms-source',
        label: 'WMSSource WMS 服务',
        sceneId: 'p3-wms-source',
      },
      {
        id: 'p3-wfs-source',
        label: 'WFSSource WFS 服务',
        sceneId: 'p3-wfs-source',
      },
      {
        id: 'p3-pmtiles-source',
        label: 'PMTilesSource PMTiles',
        sceneId: 'p3-pmtiles-source',
      },
      {
        id: 'p3-mobile-optimizer',
        label: 'MobileOptimizer 移动端',
        sceneId: 'p3-mobile-optimizer',
      },
      {
        id: 'p3-hidpi-adapter',
        label: 'HiDPIAdapter 高 DPI',
        sceneId: 'p3-hidpi-adapter',
      },
      {
        id: 'p3-analysis',
        label: 'Analysis 空间分析',
        sceneId: 'p3-analysis',
      },
    ],
  },

  // ───────────────────────────────────────────────────────
  // 集成场景
  // ───────────────────────────────────────────────────────
  {
    id: 'integration',
    label: '集成场景',
    children: [
      {
        id: 'integration-city-2d',
        label: '2D 城市底图',
        sceneId: 'integration-city-2d',
      },
      {
        id: 'integration-city-25d',
        label: '2.5D 城市建筑',
        sceneId: 'integration-city-25d',
      },
      {
        id: 'integration-globe-3d',
        label: '3D 地球',
        sceneId: 'integration-globe-3d',
      },
      {
        id: 'integration-mixed-rendering',
        label: '混合渲染',
        sceneId: 'integration-mixed-rendering',
      },
      {
        id: 'integration-big-data',
        label: '大数据（100万点）',
        sceneId: 'integration-big-data',
      },
      {
        id: 'integration-realtime',
        label: '实时更新',
        sceneId: 'integration-realtime',
      },
      {
        id: 'integration-analysis',
        label: '空间分析',
        sceneId: 'integration-analysis',
      },
      {
        id: 'integration-stress-test',
        label: '性能压测',
        sceneId: 'integration-stress-test',
      },
    ],
  },
];
