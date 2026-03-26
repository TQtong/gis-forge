# GIS-Forge 可选功能包完整接口设计 — P2 增强包（下）

> postprocess-bloom / postprocess-ssao / postprocess-shadow

---

## 8. @gis-forge/postprocess-bloom

### 8.1 BloomPassOptions

```typescript
export interface BloomPassOptions {
  /**
   * 亮度提取阈值。
   * 超过此亮度值的像素参与泛光，低于的被忽略。
   * 值越低越多像素产生泛光（整体更亮），值越高只有最亮的点发光。
   * @range [0, 2]（HDR 场景可超 1）
   * @default 0.8
   */
  readonly threshold?: number;

  /**
   * 泛光强度（叠加回原始图像的乘数）。
   * @range [0, 5]
   * @default 1.0
   */
  readonly intensity?: number;

  /**
   * 泛光半径（高斯模糊范围）。
   * 值越大泛光扩散范围越广。
   * @range [0, 2]
   * @default 0.5
   */
  readonly radius?: number;

  /**
   * 高斯模糊迭代次数。
   * 每次迭代 = 水平模糊 + 垂直模糊（Ping-Pong）。
   * 越多次越柔和，但性能开销线性增长。
   * @range [1, 10]
   * @default 5
   */
  readonly blurIterations?: number;
}
```

### 8.2 BloomPass 接口

```typescript
export interface BloomPass extends PostProcessPass {
  /** @stability stable */
  setThreshold(value: number): void;
  /** @stability stable */
  setIntensity(value: number): void;
  /** @stability stable */
  setRadius(value: number): void;
  /** @stability experimental */
  setBlurIterations(count: number): void;

  /**
   * setup 步骤：
   *   1. 创建中间纹理（半分辨率，节省性能）：
   *      brightTex: RGBA16F, width/2 × height/2（亮度提取结果）
   *      blurTexA:  RGBA16F, width/2 × height/2（Ping）
   *      blurTexB:  RGBA16F, width/2 × height/2（Pong）
   *   2. 编译 3 个 Pipeline：
   *      extractPipeline: 亮度提取（全屏 quad）
   *      blurPipeline:    高斯模糊（全屏 quad，方向通过 Uniform 切换）
   *      compositePipeline: 叠加合成（全屏 quad）
   *
   * @stability stable
   */
  setup(context: PostProcessContext): void;

  /**
   * execute 三阶段渲染：
   *
   * Sub-Pass 1: Brightness Extraction
   *   input: inputColor（原始场景纹理）
   *   output: brightTex
   *   Shader:
   *     let luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
   *     if (luminance <= threshold) { output = vec4(0); }
   *     else { output = color × (luminance - threshold) / luminance; }
   *     // 软阈值：不是硬切，而是按超出比例衰减（避免泛光边缘锯齿）
   *
   * Sub-Pass 2: Gaussian Blur（迭代 N 次）
   *   for (i = 0; i < blurIterations; i++):
   *     // 水平模糊
   *     input: (i === 0) ? brightTex : blurTexB
   *     output: blurTexA
   *     Shader: 9-tap 高斯核，采样方向 = vec2(1/width, 0) × (radius × (i+1))
   *       weights = [0.227, 0.194, 0.194, 0.121, 0.121, 0.054, 0.054, 0.016, 0.016]
   *       offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4]
   *       result = Σ weights[j] × textureSample(input, uv + offsets[j] × texelSize × direction)
   *
   *     // 垂直模糊
   *     input: blurTexA
   *     output: blurTexB
   *     Shader: 同上，方向 = vec2(0, 1/height) × (radius × (i+1))
   *
   * Sub-Pass 3: Composite
   *   input: inputColor（原始场景）+ blurTexB（模糊后的泛光）
   *   output: outputColor
   *   Shader:
   *     let scene = textureSample(sceneTexture, uv);
   *     let bloom = textureSample(bloomTexture, uv);
   *     output = scene + bloom × intensity;  // additive blend
   *     // 可选 tone mapping: output.rgb = output.rgb / (output.rgb + 1.0); // Reinhard
   *
   * @stability stable
   */
  execute(encoder: GPUCommandEncoder, inputColor: GPUTextureView, inputDepth: GPUTextureView, outputColor: GPUTextureView): void;

  /**
   * onResize: 重新创建半分辨率中间纹理。
   * @stability stable
   */
  onResize(width: number, height: number): void;

  /** @stability stable */
  destroy(): void;
}

export function createBloomPass(options?: BloomPassOptions): BloomPass;
```

### 8.3 WGSL

```wgsl
// === postprocess/bloom_extract.wgsl ===
struct BloomExtractParams {
  threshold: f32,
  _pad: vec3<f32>,
};
@group(0) @binding(0) var<uniform> params: BloomExtractParams;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;

@fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let color = textureSample(sceneTexture, sceneSampler, uv);
  let luminance = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));

  // 软阈值提取
  let contribution = max(0.0, luminance - params.threshold);
  let factor = contribution / max(luminance, 0.001);  // 避免除零
  return vec4<f32>(color.rgb * factor, 1.0);
}
```

```wgsl
// === postprocess/bloom_blur.wgsl ===
struct BlurParams {
  direction: vec2<f32>,      // (1/w, 0) 或 (0, 1/h)
  radius: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // 9-tap 高斯核
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var result = textureSample(inputTexture, inputSampler, uv) * weights[0];

  for (var i: i32 = 1; i < 5; i++) {
    let offset = params.direction * f32(i) * params.radius;
    result += textureSample(inputTexture, inputSampler, uv + offset) * weights[i];
    result += textureSample(inputTexture, inputSampler, uv - offset) * weights[i];
  }
  return result;
}
```

```wgsl
// === postprocess/bloom_composite.wgsl ===
struct CompositeParams {
  intensity: f32,
  _pad: vec3<f32>,
};
@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTexture: texture_2d<f32>;
@group(0) @binding(3) var bloomSampler: sampler;
@group(0) @binding(4) var bloomTexture: texture_2d<f32>;

@fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, sceneSampler, uv);
  let bloom = textureSample(bloomTexture, bloomSampler, uv);
  return vec4<f32>(scene.rgb + bloom.rgb * params.intensity, scene.a);
}
```

### 8.4 对接 / 错误 / 常量

```
对接：
  L2/FrameGraphBuilder.addPostProcessPass({ id:'bloom', factory:bloomPass, inputPassId:'scene' })
  L1/TextureManager.create() — 中间纹理（禁止 device.createTexture）
  L2/PipelineCache — 3 个 Pipeline
  PerformanceManager 降级链：减少 blurIterations(5→3→1) → 降低中间纹理分辨率(1/2→1/4) → 禁用 bloom

错误：
  | 中间纹理创建 OOM | GPU_BUFFER_OOM | 降低分辨率重试 |
  | threshold 超范围 | — | clamp [0, 2] + if(__DEV__) warn |
  | blurIterations 超范围 | — | clamp [1, 10] + if(__DEV__) warn |

常量：
  DEFAULT_THRESHOLD = 0.8
  DEFAULT_INTENSITY = 1.0
  DEFAULT_RADIUS = 0.5
  DEFAULT_BLUR_ITERATIONS = 5
  BLOOM_TEXTURE_SCALE = 0.5          // 半分辨率
  GAUSSIAN_WEIGHTS = [0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216]
```

---

## 9. @gis-forge/postprocess-ssao

### 9.1 SSAOPassOptions

```typescript
export interface SSAOPassOptions {
  /**
   * 采样半径（世界空间单位）。
   * 在此半径范围内随机采样点检测遮蔽。
   * @range [0.01, 5]
   * @default 0.5
   */
  readonly radius?: number;

  /**
   * 遮蔽强度。
   * @range [0, 5]
   * @default 1.0
   */
  readonly intensity?: number;

  /**
   * 偏置。
   * 避免自遮蔽（平面上的点不应该遮蔽自己）。
   * @range [0, 0.1]
   * @default 0.025
   */
  readonly bias?: number;

  /**
   * 采样核数量。
   * 每个像素随机采样此数量的点来检测遮蔽。
   * 越多越准确但越慢。
   * @range 16 | 32 | 64
   * @default 32
   */
  readonly kernelSize?: 16 | 32 | 64;

  /**
   * 模糊 Pass 开关。
   * 启用后对 SSAO 结果做双边模糊（保边平滑，减少噪声）。
   * @default true
   */
  readonly blur?: boolean;
}
```

### 9.2 SSAOPass 接口

```typescript
export interface SSAOPass extends PostProcessPass {
  /** @stability stable */
  setRadius(value: number): void;
  /** @stability stable */
  setIntensity(value: number): void;
  /** @stability experimental */
  setKernelSize(size: 16 | 32 | 64): void;
  /** @stability experimental */
  setBias(value: number): void;

  /**
   * setup 步骤：
   *   1. 生成采样核：在单位半球内随机分布的 N 个采样向量
   *      for (i = 0; i < kernelSize; i++):
   *        sample = [random(-1,1), random(-1,1), random(0,1)]（半球）
   *        normalize(sample)
   *        sample *= random(0,1)（距离随机化）
   *        // 加权：靠近中心的样本更多（减少远处采样的噪声）
   *        scale = i / kernelSize
   *        scale = lerp(0.1, 1.0, scale * scale)  // 二次加权
   *        sample *= scale
   *      上传为 Uniform Buffer（vec4<f32>[kernelSize]）
   *
   *   2. 生成噪声纹理：4×4 随机旋转向量
   *      for (i = 0; i < 16; i++):
   *        noise[i] = [random(-1,1), random(-1,1), 0]  // 绕 Z 轴随机旋转
   *      上传为 4×4 RGBA16F 纹理，平铺到屏幕（repeat addressMode）
   *
   *   3. 创建中间纹理：
   *      ssaoTex: R8, viewport 尺寸（遮蔽值）
   *      blurTex: R8, viewport 尺寸（模糊后）
   *
   *   4. 编译 Pipeline：
   *      ssaoPipeline: SSAO 计算（需要深度 + 法线输入）
   *      blurPipeline: 双边模糊
   *      compositePipeline: 叠加到场景
   *
   * @stability stable
   */
  setup(context: PostProcessContext): void;

  /**
   * execute 三阶段：
   *
   * Sub-Pass 1: SSAO 计算
   *   input: 深度纹理 + 法线纹理（或从深度重建法线）
   *   output: ssaoTex (R8)
   *   Shader（逐像素）：
   *     1. 从深度纹理重建世界位置：
   *        ndc = (uv * 2 - 1, depth, 1)
   *        worldPos = inverseVP × ndc / ndc.w
   *
   *     2. 获取法线（优先从法线纹理，否则从深度差分重建）：
   *        if (hasNormalTexture)
   *          normal = textureSample(normalTex, uv) * 2 - 1
   *        else
   *          // 从深度梯度重建法线
   *          dFdx = dpdx(worldPos), dFdy = dpdy(worldPos)
   *          normal = normalize(cross(dFdx, dFdy))
   *
   *     3. 构建 TBN 矩阵（将采样核从切线空间转到世界空间）：
   *        randomVec = textureSample(noiseTex, uv * viewport / 4) // 平铺 4×4 噪声
   *        tangent = normalize(randomVec - normal * dot(randomVec, normal))
   *        bitangent = cross(normal, tangent)
   *        TBN = mat3(tangent, bitangent, normal)
   *
   *     4. 遍历采样核：
   *        occlusion = 0
   *        for (i = 0; i < kernelSize; i++):
   *          samplePos = worldPos + TBN × kernel[i] × radius
   *          // 投影回屏幕
   *          sampleClip = vpMatrix × vec4(samplePos, 1)
   *          sampleUV = sampleClip.xy / sampleClip.w * 0.5 + 0.5
   *          // 采样深度
   *          sampleDepth = textureSample(depthTex, sampleUV).r
   *          // 重建采样点的世界 Z
   *          actualDepth = linearizeDepth(sampleDepth)
   *          projectedDepth = linearizeDepth(sampleClip.z / sampleClip.w)
   *          // 范围检查 + 遮蔽判断
   *          rangeCheck = smoothstep(0, 1, radius / abs(actualDepth - projectedDepth + bias))
   *          occlusion += select(0, 1, projectedDepth > actualDepth + bias) × rangeCheck
   *
   *        ao = 1.0 - occlusion / kernelSize
   *        output.r = pow(ao, intensity)
   *
   * Sub-Pass 2: 双边模糊（如果 blur=true）
   *   input: ssaoTex
   *   output: blurTex
   *   Shader: 4×4 kernel，权重同时考虑空间距离和法线/深度差异
   *     for (dx = -2; dx <= 2; dx++):
   *       for (dy = -2; dy <= 2; dy++):
   *         sampleAO = textureSample(ssaoTex, uv + [dx,dy] × texelSize).r
   *         sampleDepth = textureSample(depthTex, uv + [dx,dy] × texelSize).r
   *         depthDiff = abs(centerDepth - sampleDepth)
   *         weight = exp(-depthDiff × 1000)  // 深度差异大的权重低（保边）
   *         result += sampleAO × weight
   *         totalWeight += weight
   *     output.r = result / totalWeight
   *
   * Sub-Pass 3: 叠加
   *   input: sceneColor + blurTex（或 ssaoTex）
   *   output: outputColor
   *   Shader:
   *     ao = textureSample(blurTex, uv).r
   *     output = vec4(sceneColor.rgb × ao, sceneColor.a)
   *
   * @stability stable
   */
  execute(encoder: GPUCommandEncoder, inputColor: GPUTextureView, inputDepth: GPUTextureView, outputColor: GPUTextureView): void;

  /** @stability stable */
  onResize(width: number, height: number): void;
  /** @stability stable */
  destroy(): void;
}

export function createSSAOPass(options?: SSAOPassOptions): SSAOPass;
```

### 9.3 对接 / 错误 / 常量

```
对接：
  L2/FrameGraphBuilder.addPostProcessPass({ id:'ssao', ... })
  L2/DepthManager — 深度纹理
  L1/TextureManager — 中间纹理 + 噪声纹理
  TerrainLayer.getNormalTexture() / 从深度重建法线
  PerformanceManager 降级链：减少 kernelSize(64→32→16) → 降低 ssaoTex 分辨率(1/2) → 禁用 SSAO

错误：
  | 深度纹理不可用 | — | 跳过 SSAO（log.warn：需要 depth32float 格式） |
  | kernelSize 不在允许值 | — | snap 到最近的 16/32/64 |
  | 中间纹理 OOM | GPU_BUFFER_OOM | 降低分辨率重试 |

常量：
  DEFAULT_RADIUS = 0.5
  DEFAULT_INTENSITY = 1.0
  DEFAULT_BIAS = 0.025
  DEFAULT_KERNEL_SIZE = 32
  NOISE_TEXTURE_SIZE = 4             // 4×4 噪声纹理
  MAX_KERNEL_SIZE = 64
  SSAO_TEXTURE_FORMAT = 'r8unorm'
  DEPTH_LINEARIZE_NEAR = 0.1        // 深度线性化参数
```

---

## 10. @gis-forge/postprocess-shadow

### 10.1 ShadowPassOptions

```typescript
/**
 * 简化阴影后处理（2D/2.5D 模式）。
 * 注意：3D 地球模式使用 GlobeRenderer 的内置 CSM 阴影（见 P1 globe 包），
 * 此包用于 2D/2.5D 场景的简单投影阴影（如建筑阴影投到地面）。
 */
export interface ShadowPassOptions {
  /**
   * 光源方向（归一化向量）。
   * [x, y, z]，z 为负表示从上方照射。
   * @default [0.5, 0.5, -1]（左前上方 45°）
   */
  readonly lightDirection?: [number, number, number];

  /**
   * 阴影颜色。
   * @default 'rgba(0,0,0,0.3)'
   */
  readonly shadowColor?: string;

  /**
   * 阴影模糊半径（像素）。
   * @unit 像素
   * @range [0, 20]
   * @default 4
   */
  readonly blurRadius?: number;

  /**
   * 阴影偏移距离系数。
   * 阴影偏移 = 建筑高度 × lightDirection.xy × offsetFactor。
   * @range [0, 2]
   * @default 1.0
   */
  readonly offsetFactor?: number;
}
```

### 10.2 ShadowPass 接口

```typescript
export interface ShadowPass extends PostProcessPass {
  /** @stability stable */
  setLightDirection(dir: [number, number, number]): void;
  /** @stability stable */
  setShadowColor(color: string): void;
  /** @stability stable */
  setBlurRadius(radius: number): void;
  /** @stability experimental */
  setOffsetFactor(factor: number): void;

  /**
   * setup 步骤：
   *   1. 创建阴影纹理（R8，viewport 尺寸）
   *   2. 创建模糊纹理（R8）
   *   3. 编译 Pipeline：shadowGenPipeline + blurPipeline + compositePipeline
   *
   * @stability stable
   */
  setup(context: PostProcessContext): void;

  /**
   * execute 步骤：
   *
   * 此 Pass 专门为 2D/2.5D 的 fill-extrusion 建筑图层生成地面阴影。
   *
   * Sub-Pass 1: Shadow 生成
   *   input: 深度纹理（从 ExtrusionLayer 获取建筑高度信息）
   *   output: shadowTex (R8)
   *   Shader：
   *     1. 从深度纹理重建世界位置
   *     2. 如果该像素属于建筑（depth < backgroundDepth）：
   *        // 计算阴影投射位置
   *        shadowOffset = height × lightDirection.xy × offsetFactor
   *        shadowUV = uv + shadowOffset / viewport
   *        // 在阴影纹理上标记
   *        output.r = 1.0  // 有阴影
   *     3. 否则 output.r = 0.0
   *
   * Sub-Pass 2: 高斯模糊（柔化阴影边缘）
   *   同 Bloom 的模糊逻辑，但只需 1~2 次迭代
   *
   * Sub-Pass 3: 叠加
   *   input: sceneColor + blurredShadowTex
   *   output: outputColor
   *   Shader：
   *     let shadow = textureSample(shadowTex, uv).r;
   *     let shadowColorVec = parseShadowColor(shadowColor);
   *     output = mix(sceneColor, sceneColor × shadowColorVec, shadow);
   *
   * @stability stable
   */
  execute(encoder: GPUCommandEncoder, inputColor: GPUTextureView, inputDepth: GPUTextureView, outputColor: GPUTextureView): void;

  /** @stability stable */
  onResize(width: number, height: number): void;
  /** @stability stable */
  destroy(): void;
}

export function createShadowPass(options?: ShadowPassOptions): ShadowPass;
```

### 10.3 对接 / 错误 / 常量

```
对接：
  L2/FrameGraphBuilder.addPostProcessPass({ id:'shadow', ... })
  L2/DepthManager — 深度纹理
  ExtrusionLayer — 建筑高度数据（从深度纹理推断，或通过 height Uniform）
  PerformanceManager 降级：降低阴影纹理分辨率 → 减少模糊迭代 → 禁用阴影

错误：
  | 深度纹理不可用 | — | 跳过阴影生成 |
  | lightDirection 长度为 0 | — | 使用默认值 [0.5, 0.5, -1] |
  | shadowColor 解析失败 | — | 使用默认 'rgba(0,0,0,0.3)' |

常量：
  DEFAULT_LIGHT_DIR = [0.5, 0.5, -1]
  DEFAULT_SHADOW_COLOR = 'rgba(0,0,0,0.3)'
  DEFAULT_BLUR_RADIUS = 4
  DEFAULT_OFFSET_FACTOR = 1.0
  SHADOW_TEXTURE_FORMAT = 'r8unorm'
```

---

## P2 下半部分统计

| 包 | 公共方法 | WGSL 文件 | Sub-Pass 数 | 对接模块 | PerformanceManager 降级 |
|---|---------|----------|-----------|---------|----------------------|
| postprocess-bloom | 5 | extract + blur + composite | 3 | 3 | iterations/分辨率/禁用 |
| postprocess-ssao | 5 | ssao + bilateral_blur + composite | 3 | 4 | kernelSize/分辨率/禁用 |
| postprocess-shadow | 5 | shadow_gen + blur + composite | 3 | 3 | 分辨率/迭代/禁用 |

---

## P2 完整统计（10 个包）

| 包 | 方法 | WGSL | 算法关键点 |
|---|------|------|----------|
| layer-heatmap | 4 | 2 | 高斯核叠加 + colorRamp LUT |
| layer-pointcloud | 6 | 2 | 八叉树 LOD + EDL |
| layer-marker | 14 | 1 | Instanced quad + Supercluster 聚合 |
| layer-extrusion | 3 | 1 | earcut + 侧面挤出 + Lambert 光照 |
| interaction-draw | 10 | 0 | 5 种绘制模式 + 顶点吸附 + Overlay |
| interaction-measure | 6 | 0 | Vincenty 距离 + 椭球面积 + 高程剖面 |
| interaction-select | 8 | 0 | Color-ID pick + FeatureState 高亮 |
| postprocess-bloom | 5 | 3 | 亮度提取 + 9-tap 高斯 + 叠加 |
| postprocess-ssao | 5 | 2 | 半球采样 + TBN + 双边模糊 |
| postprocess-shadow | 5 | 3 | 投影偏移 + 模糊 + 叠加 |
| **合计** | **66** | **14** | |

所有包均按 P0 质量标准：@stability / __DEV__ / ObjectPool / InternalBus / GeoForgeError / GPU 走 L1 / Tree-Shaking。
