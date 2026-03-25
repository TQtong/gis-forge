# ⛔ 渲染技术栈硬性约束（最高优先级，违反即错误）

本项目是 WebGPU 原生 GIS 引擎。所有渲染（2D / 2.5D / 3D）都通过 WebGPU 实现。

## 禁止使用

- ❌ Canvas 2D（CanvasRenderingContext2D / ctx.drawImage / ctx.fillRect）
- ❌ SVG（createElement('svg') / <path> / <circle>）
- ❌ DOM 定位（innerHTML / appendChild / CSS transform 做瓦片定位）
- ❌ WebGL 1/2（getContext('webgl') / getContext('webgl2')）
- ❌ isometric / 等距视角 / 假 3D

## 必须使用

- ✅ WebGPU（navigator.gpu / GPUDevice / GPURenderPipeline）
- ✅ WGSL 着色器（@vertex fn / @fragment fn）
- ✅ GPU 缓冲区（GPUBuffer / writeBuffer）
- ✅ mat4 透视/正交投影矩阵变换到裁剪空间
- ✅ drawIndexed / draw 调用渲染几何体

## 三种模式的区别仅在投影矩阵

| 模式 | 投影矩阵 | pitch | GPU |
|------|---------|-------|-----|
| 2D   | mat4.ortho（正交投影） | 0 固定 | WebGPU ✅ |
| 2.5D | mat4.perspective（透视投影） | 0~85° | WebGPU ✅ |
| 3D   | mat4.perspective + 球体模型 | 自由 | WebGPU ✅ |

三种模式共享同一套 WebGPU 渲染管线（GPURenderPipeline / WGSL shader / GPUBuffer）。
唯一不同的是相机的投影矩阵和视图矩阵的计算方式。
瓦片始终通过 GPU 光栅化绘制，永远不使用 Canvas 2D。

## 瓦片渲染流程（所有模式通用）

```
瓦片纹理(GPUTexture) → 顶点缓冲(GPUBuffer) → WGSL顶点着色器(vpMatrix变换) → GPU光栅化 → WGSL片元着色器(纹理采样) → 屏幕像素
```

如果你正在写的代码中出现了 `getContext('2d')` 或 `CanvasRenderingContext2D`，停下来——你走错路了。
