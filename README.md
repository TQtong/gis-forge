# GIS-Forge

**统一 2D / 2.5D / 3D 纯 WebGPU GIS 引擎。零 npm 依赖，所有算法自研。**

---

## 特性

- **纯 WebGPU** — 无 WebGL 回退，面向下一代浏览器 GPU API
- **零依赖** — 数学库、三角剖分、空间索引、投影变换全部自研
- **三种维度** — 同一引擎支持 2D 地图、2.5D 倾斜、3D 数字地球，运行时可切换
- **七层架构** — L0 基础 → L1 GPU → L2 渲染 → L3 调度 → L4 场景 → L5 扩展 → L6 预设
- **Tree-Shakable** — 2D ~120KB / 3D ~195KB / 全功能 ~350KB (gzip)
- **6 个扩展点** — 自定义图层、投影、数据源、Shader Hook、后处理、交互工具

## 快速开始

```typescript
import { Map2D } from '@gis-forge/preset-2d';

const map = new Map2D({
  container: 'map',
  center: [116.39, 39.91],
  zoom: 10,
});
```

3D 地球：

```typescript
import { Globe3D } from '@gis-forge/preset-3d';

const globe = new Globe3D({
  container: 'globe',
  atmosphere: true,
  skybox: true,
});

globe.flyTo({
  destination: [116.39, 39.91, 50000],
  duration: 3000,
});
```

全功能模式切换：

```typescript
import { MapFull } from '@gis-forge/preset-full';

const map = new MapFull({
  container: 'map',
  mode: '2d',
  center: [116.39, 39.91],
  zoom: 10,
});

// 运行时切换到 3D
map.setMode('3d', { duration: 2000 });
```

## 架构

```
L6 预设层    Map2D / Map25D / Globe3D / MapFull + Controls
L5 扩展层    ExtensionRegistry + Lifecycle + EP1~EP6
L4 场景层    SceneGraph / LayerManager / SourceManager / StyleEngine / LabelManager / ...
L3 调度层    FrameScheduler / TileScheduler / WorkerPool / CameraController / ...
L2 渲染层    ShaderAssembler / PipelineCache / RenderGraph / Compositor / PickingEngine / ...
L1 GPU层     DeviceManager / BufferPool / TextureManager / GPUUploader / ...
L0 基础层    math/ geo/ algorithm/ index/ precision/ types/ infra/
```

依赖方向：L6 → L5 → L4 → L3 → L2 → L1 → L0，禁止反向或跨层。

## 包清单

| 包 | 层 | 说明 |
|---|---|------|
| `@gis-forge/core` | L0 | 数学、地理、算法、空间索引、精度、类型、基础设施 |
| `@gis-forge/gpu` | L1+L2 | GPU 资源管理 + 渲染管线 |
| `@gis-forge/runtime` | L3 | 帧调度、瓦片调度、Worker 池、相机控制、内存预算 |
| `@gis-forge/scene` | L4 | 场景图、图层、数据源、样式引擎、标注、空间查询 |
| `@gis-forge/extensions` | L5 | 扩展注册中心 + 6 个扩展点接口 |
| `@gis-forge/preset-2d` | L6 | 2D 地图（MapLibre GL 兼容 API） |
| `@gis-forge/preset-25d` | L6 | 2.5D 倾斜地图 |
| `@gis-forge/preset-3d` | L6 | 3D 数字地球（CesiumJS 兼容 API） |
| `@gis-forge/preset-full` | L6 | 全功能 + 运行时模式切换 |

## 模块统计

| 层 | 模块数 | 公共方法数 |
|---|--------|----------|
| L0 基础层 | 29 | ~200 |
| L1 GPU层 | 8 | 58 |
| L2 渲染层 | 15 | ~96 |
| L3 调度层 | 11 | ~91 |
| L4 场景层 | 13 | ~90 |
| L5 扩展层 | 9 | ~32 |
| L6 预设层 | 6 | ~108 |
| NF 补充 | 6 | ~30 |
| **合计** | **97** | **~705** |

## 核心设计决策

| 决策 | 方案 |
|------|------|
| 深度缓冲 | Reversed-Z（`depthCompare: 'greater'`，clear `0.0`，`depth32float`） |
| 矩阵存储 | 列主序（Column-Major），对齐 WGSL `mat4x4<f32>` |
| 旋转角 | 统一 `bearing`（弧度），非 heading |
| 精度 | Split-Double + RTC（Float64 → Float32×2） |
| Shader | 模块化组合（投影/几何/样式）+ 9 个 Hook 点 |
| 瓦片调度 | SSE（Screen Space Error）驱动 LOD |
| 内存管理 | 引用计数 + LRU + 双轨预算（GPU+CPU） |
| 文字渲染 | MSDF（Multi-channel Signed Distance Field） |
| 半透明 | Weighted Blended OIT |
| 拾取 | Color-ID 异步 GPU readback |

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器（含 MVP 演示）
npm run dev

# TypeScript 类型检查
npx tsc --noEmit

# 构建
npm run build
```

## 6 个扩展点

| EP | 接口 | 用途 |
|----|------|------|
| EP1 | `CustomLayer` | 自定义图层（完全控制 WebGPU 渲染） |
| EP2 | `ProjectionModule` | 自定义投影（CPU project/unproject + GPU WGSL） |
| EP3 | `DataSource` | 自定义数据源（瓦片/要素/实时流） |
| EP4 | `ShaderHookDefinition` | Shader 钩子（9 个注入点） |
| EP5 | `PostProcessPass` | 自定义后处理（Bloom/SSAO/...） |
| EP6 | `InteractionTool` | 自定义交互工具（绘制/测量/选择） |

```typescript
// 示例：注册夜间模式 Shader Hook
registry.registerShaderHook('night-mode', {
  hookPoint: 'fragment_color_after_style',
  wgslCode: `color = vec4<f32>(color.rgb * 0.3, color.a);`,
  priority: -10,
});
```

## 逃生舱口

从预设 API 可随时访问底层模块：

```typescript
const map = new Map2D({ container: 'map' });

// 访问 GPU 层
const { deviceManager, shaderAssembler } = map.renderer;

// 访问场景层
const { sceneGraph, layerManager } = map.scene;

// 访问调度层
const { frameScheduler, tileScheduler } = map.scheduler;

// 访问扩展注册中心
const { registry } = map.extensions;

// 访问相机控制器
const camera = map.camera;
```

## 硬约束

1. 先查架构再写代码——确认模块在七层中的位置
2. 类型从 L0 import——Feature/CameraState/PickResult/Viewport 禁止重定义
3. 零依赖——禁止任何 npm 包
4. out 参数——数学函数 `fn(out, a, b)`
5. GPU 走 L1——L2~L6 禁止 `device.createBuffer/createTexture`
6. Shader 走 Assembler——禁止单体 WGSL
7. Worker 走 Pool——CPU 密集计算走 `WorkerPool.submit()`
8. 扩展走 Context——EP1~EP6 禁止 import 内部模块
9. 错误隔离——扩展 `safeExecute` 包裹
10. Reversed-Z——`depthCompare:'greater'`，clear `0.0`
11. 列主序——矩阵 Column-Major
12. bearing 非 heading——旋转角统一 `bearing`（弧度）
13. 异步 Picking——`queryRenderedFeatures` 返回 `Promise<Feature[]>`
14. Tree-Shaking——命名 export，无 default

## 许可证

MIT
