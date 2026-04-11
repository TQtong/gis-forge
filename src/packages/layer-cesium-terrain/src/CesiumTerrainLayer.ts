// ============================================================
// CesiumTerrainLayer.ts — Cesium quantized-mesh 地形图层（L4）
// 职责：
//   • 拉取 layer.json + Geographic TMS 四叉树调度
//   • 解码 quantized-mesh + CPU 法线 + 裙边
//   • 重投影到 Web Mercator 像素空间（z=0 基准 → shader 按 worldScale 放缩）
//   • WebGPU 渲染（OSM 栅格贴图 drape + Lambert 光照）
//   • 与 Map25D 透视 vpMatrix + 相机相对坐标对齐
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

import {
  DEFAULT_MAX_SCREEN_SPACE_ERROR,
  FLOATS_PER_VERTEX,
  QM_COORD_RANGE,
  TILE_PIXEL_SIZE,
  VERTEX_STRIDE_BYTES,
  type CesiumTerrainLayerOptions,
  type DecodedTerrainTile,
  type TerrainCacheEntry,
} from './types.ts';
import {
  cesiumTileToGeographic,
  lngLatToMercatorPixel,
  pixelsPerMeter,
  pickCoveringOsmTile,
  lngLatToOsmTileUv,
  buildOsmTileUrl,
} from './mercator.ts';
import { CesiumTerrainProvider } from './cesium-terrain-provider.ts';
import { TerrainLRUCache } from './terrain-lru-cache.ts';
import { octDecodeNormal, type QuantizedMeshRaw } from './quantized-mesh-decoder.ts';
import {
  computeGeographicCoveringTiles,
  type GeographicScheduledTile,
} from './geographic-tile-scheduler.ts';

const SKIRT_METERS = 2000;

// ---------------------------------------------------------------------------
// WGSL 着色器
// ---------------------------------------------------------------------------
//
// 顶点坐标策略（zoom-independent）：
//   CPU 以 z=0 墨卡托像素储存 posXY（相对瓦片中心）。每帧 shader 先把
//     mercPxZ0 = posXY + tileCenterZ0 - cameraCenterZ0
//   再乘 worldScale(= 2^camera.zoom) 得到当前 zoom 下的相机相对像素，
//   然后 vpMatrix 做透视投影。
// 高度 z：以米储存，shader 端乘 ppmCurrent 得到像素尺度。
// 这样一份顶点缓冲在任何 zoom 下都能正确渲染，消除 builtWorldZoom 漂移。
//
// Drape 贴图：每瓦片单独 fetch 一张 OSM 栅格瓦片（尽量深、完整包含地形 bbox），
// CPU 端按经纬度算出每顶点 UV，shader 直接 textureSample。

const TERRAIN_WGSL = /* wgsl */ `
struct CameraUniforms {
  vpMatrix: mat4x4<f32>,
  // x,y = camera center in z=0 mercator pixel; z = worldScale = 2^zoom; w = ppmCurrent
  params: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct StyleUniforms {
  // xyz = light direction (world space); w = ambient
  lightAndAmbient: vec4<f32>,
  // x = opacity; y/z/w unused
  misc: vec4<f32>,
};
@group(1) @binding(0) var<uniform> style: StyleUniforms;

struct TileUniforms {
  // x,y = tile center in z=0 mercator pixel; z,w unused
  centerZ0: vec4<f32>,
  // xy = UV scale, zw = UV offset — 允许瓦片采样祖先纹理的子区域
  // 自有 drape: scale=(1,1), offset=(0,0)
  // 借用祖先: scale=(1/2^dz, 1/2^dz), offset=(relative position in ancestor)
  uvTransform: vec4<f32>,
};
@group(2) @binding(0) var<uniform> tile: TileUniforms;
@group(2) @binding(1) var drapeSampler: sampler;
@group(2) @binding(2) var drapeTex: texture_2d<f32>;

struct VsIn {
  @location(0) posXY:  vec2<f32>,
  @location(1) height: f32,
  @location(2) normal: vec3<f32>,
  @location(3) uv:     vec2<f32>,
};
struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv:     vec2<f32>,
};

@vertex fn vs_main(in: VsIn) -> VsOut {
  let cameraCenter = camera.params.xy;
  let worldScale = camera.params.z;
  let ppm = camera.params.w;

  let tileCenter = tile.centerZ0.xy;
  let mercRelZ0 = (in.posXY + tileCenter) - cameraCenter;
  let mercRelCur = mercRelZ0 * worldScale;
  let heightPx = in.height * ppm;

  let world = vec3<f32>(mercRelCur.x, mercRelCur.y, heightPx);

  var out: VsOut;
  out.clipPos = camera.vpMatrix * vec4<f32>(world, 1.0);
  out.normal = in.normal;
  out.uv = in.uv * tile.uvTransform.xy + tile.uvTransform.zw;
  return out;
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let uvClamped = clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let base = textureSample(drapeTex, drapeSampler, uvClamped).rgb;

  // Hillshade：以「平坦地形」作为零偏移基准。对于 normal=(0,0,1) 的平坦
  // 区域，shadeFactor 恒等于 1（贴图完全不变色），只有真正有坡度的地方
  // 才会相对变暗/变亮。这保证地形瓦片与平面底图的 OSM 像素颜色一致，
  // 不会出现"整片变亮/变暗"的失真。
  let n = normalize(in.normal);
  let L = normalize(style.lightAndAmbient.xyz);
  let ndl = dot(n, L);                       // [-1, 1]
  let ndlFlat = L.z;                         // dot((0,0,1), L) = Lz
  let strength = clamp(style.lightAndAmbient.w, 0.0, 1.0);
  let shadeFactor = 1.0 + (ndl - ndlFlat) * strength;
  let shaded = clamp(base * shadeFactor, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(shaded, style.misc.x);
}
`;

// ---------------------------------------------------------------------------
// 主工厂
// ---------------------------------------------------------------------------

const DEFAULT_DRAPE_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_DRAPE_MAX_ZOOM = 18;

export function createCesiumTerrainLayer(
  opts: CesiumTerrainLayerOptions,
): Layer & {
  readonly provider: CesiumTerrainProvider;
  queryTerrainElevation(lng: number, lat: number): number | null;
} {
  const exaggeration = opts.exaggeration ?? 1.5;
  const opacity = opts.opacity ?? 1;
  const maxSSE = opts.maxScreenSpaceError ?? DEFAULT_MAX_SCREEN_SPACE_ERROR;
  const lightDir = opts.lightDirection ?? [-0.5, -0.7, 1.0];
  // 在新 shader 中此值被当作 hillshade 强度（±比例）：
  //   0   = 无阴影（贴图保持原色）
  //   0.1 = 坡面 ±10% 微弱明暗（推荐，与 2D 底图无缝）
  //   1.0 = 坡面 100% 黑/200% 亮（几乎不用）
  const ambient = opts.ambient ?? 0.1;
  const drapeTemplate = opts.drapeUrlTemplate ?? DEFAULT_DRAPE_TEMPLATE;
  const drapeMaxZoom = opts.drapeMaxZoom ?? DEFAULT_DRAPE_MAX_ZOOM;

  const provider = new CesiumTerrainProvider(opts.url);

  // GPU 资源
  let device: GPUDevice | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let cameraLayout: GPUBindGroupLayout | null = null;
  let styleLayout: GPUBindGroupLayout | null = null;
  let tileLayout: GPUBindGroupLayout | null = null;
  let cameraUB: GPUBuffer | null = null;
  let styleUB: GPUBuffer | null = null;
  let sampler: GPUSampler | null = null;
  // 每个瓦片一个 TileUniform buffer（小且固定）
  let cameraBG: GPUBindGroup | null = null;
  let styleBG: GPUBindGroup | null = null;
  /** 1×1 白色占位纹理：drape 未加载时让瓦片仍可渲染（纯白底） */
  let placeholderTex: GPUTexture | null = null;

  // 缓存
  const cache = new TerrainLRUCache((e) => {
    e.vertexBuffer?.destroy();
    e.indexBuffer?.destroy();
    e.drapeTexture?.destroy();
    // bindgroup 无需手动释放
  });

  // 每瓦片的 uniform buffer（随缓存条目销毁）
  const tileUBByKey = new Map<string, GPUBuffer>();

  // 本帧调度
  let scheduledThisFrame: GeographicScheduledTile[] = [];
  let layerContext: LayerContext | null = null;
  let mounted = false;
  let canvasSize: readonly [number, number] = [1024, 768];
  let rootPreloadStarted = false;

  // 正在进行的贴图 fetch（避免重复）
  const drapeFetchInflight = new Set<string>();

  // layer.json 初始化
  let providerReady = false;
  void provider.initialize().then(() => {
    providerReady = true;
  }).catch((e) => {
    console.error('[CesiumTerrainLayer] provider init failed', e);
  });

  // ---------------------------------------------------------------------
  // GPU 资源初始化
  // ---------------------------------------------------------------------

  function initGPU(dev: GPUDevice): void {
    device = dev;
    const mod = dev.createShaderModule({ code: TERRAIN_WGSL });

    cameraLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    styleLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' },
      }],
    });
    tileLayout = dev.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ],
    });

    const plLayout = dev.createPipelineLayout({
      bindGroupLayouts: [cameraLayout, styleLayout, tileLayout],
    });

    const format = navigator.gpu.getPreferredCanvasFormat();
    pipeline = dev.createRenderPipeline({
      layout: plLayout,
      vertex: {
        module: mod, entryPoint: 'vs_main',
        buffers: [{
          arrayStride: VERTEX_STRIDE_BYTES,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x2' }, // posXY
            { shaderLocation: 1, offset: 8,  format: 'float32'   }, // height
            { shaderLocation: 2, offset: 12, format: 'float32x3' }, // normal
            { shaderLocation: 3, offset: 24, format: 'float32x2' }, // uv
          ],
        }],
      },
      fragment: {
        module: mod, entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: 'none',
      },
      // 地形场景：使用画家算法，不参与深度缓冲。
      //   • 相邻同 LOD 瓦片不物理重叠，不需要 depth 解决遮挡
      //   • 父/子 LOD 瓦片会重叠（祖先兜底），此时按 LOD 粗到细顺序绘制，
      //     细瓦片视觉覆盖粗瓦片，靠绘制顺序正确显示
      //   • 消除同深度 fragment 的 z-fighting / 交叉渲染
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    cameraUB = dev.createBuffer({
      size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    styleUB = dev.createBuffer({
      size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cameraBG = dev.createBindGroup({
      layout: cameraLayout,
      entries: [{ binding: 0, resource: { buffer: cameraUB } }],
    });
    styleBG = dev.createBindGroup({
      layout: styleLayout,
      entries: [{ binding: 0, resource: { buffer: styleUB } }],
    });

    sampler = dev.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // 初始 style uniform
    const sd = new Float32Array(8);
    sd[0] = lightDir[0]; sd[1] = lightDir[1]; sd[2] = lightDir[2]; sd[3] = ambient;
    sd[4] = opacity; sd[5] = 0; sd[6] = 0; sd[7] = 0;
    dev.queue.writeBuffer(styleUB, 0, sd);

    // 1×1 白色占位纹理
    placeholderTex = dev.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture(
      { texture: placeholderTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  // ---------------------------------------------------------------------
  // 为 entry 构建 tile bind group（复用 / 更新）
  // ---------------------------------------------------------------------

  function ensureTileBindGroup(
    entry: TerrainCacheEntry,
    texture: GPUTexture,
    uvScaleX: number = 1,
    uvScaleY: number = 1,
    uvOffsetX: number = 0,
    uvOffsetY: number = 0,
  ): void {
    if (device === null || tileLayout === null || sampler === null) { return; }
    const dec = entry.decoded;
    if (dec === null) { return; }

    let ub = tileUBByKey.get(entry.key);
    if (ub === undefined) {
      ub = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      tileUBByKey.set(entry.key, ub);
    }
    // 每次 ensureTileBindGroup 调用都重写 uniform，确保 UV transform 是最新的
    const td = new Float32Array(8);
    td[0] = dec.tileCenterMercatorPxZ0[0];
    td[1] = dec.tileCenterMercatorPxZ0[1];
    td[2] = 0;
    td[3] = 0;
    td[4] = uvScaleX;
    td[5] = uvScaleY;
    td[6] = uvOffsetX;
    td[7] = uvOffsetY;
    device.queue.writeBuffer(ub, 0, td);

    entry.tileBindGroup = device.createBindGroup({
      layout: tileLayout,
      entries: [
        { binding: 0, resource: { buffer: ub } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: texture.createView() },
      ],
    });
  }

  // ---------------------------------------------------------------------
  // Drape 贴图加载（占位符渲染 + 异步替换 + 指数退避重试）
  //
  // 注意：地形层完全自有 drape 纹理，不借用外部 rasterTileCache。
  // 跨层共享 GPUTexture 会引入生命周期耦合——宿主层驱逐时销毁纹理，
  // 但本层 bindGroup 仍引用它，会触发
  // "Destroyed texture used in a submit" WebGPU 校验错误。
  // ---------------------------------------------------------------------

  async function loadDrapeTexture(
    entry: TerrainCacheEntry, attempt: number = 0,
  ): Promise<void> {
    if (device === null) { return; }
    const dec = entry.decoded;
    if (dec === null) { return; }
    const { z, x, y } = dec.drapeOsm;
    if (drapeFetchInflight.has(entry.key)) { return; }
    drapeFetchInflight.add(entry.key);

    try {
      const url = buildOsmTileUrl(drapeTemplate, z, x, y);
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      if (!mounted || device === null) { bitmap.close(); return; }
      // entry 已被 LRU 驱逐：放弃
      if (!cache.has(entry.key)) { bitmap.close(); return; }

      const tex = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: tex },
        [bitmap.width, bitmap.height, 1],
      );
      const texW = bitmap.width;
      const texH = bitmap.height;
      bitmap.close();

      // 释放之前的真实纹理（占位符不销毁，供其它瓦片继续使用）
      if (entry.drapeTexture !== null && entry.drapeTexture !== placeholderTex) {
        entry.drapeTexture.destroy();
      }
      entry.drapeTexture = tex;
      entry.drapeLoaded = true;
      ensureTileBindGroup(entry, tex);
      cache.updateBytes(entry.key, entry.byteSize + texW * texH * 4);
    } catch {
      // 指数退避重试：1s → 2s → 4s，最多 3 次
      if (attempt < 3 && mounted) {
        const delay = 1000 * Math.pow(2, attempt);
        setTimeout(() => {
          drapeFetchInflight.delete(entry.key);
          // entry 可能已被 LRU 驱逐：重试前检查
          if (cache.has(entry.key)) {
            void loadDrapeTexture(entry, attempt + 1);
          }
        }, delay);
        return;
      }
      // 放弃：保留占位符渲染
    } finally {
      drapeFetchInflight.delete(entry.key);
    }
  }

  // ---------------------------------------------------------------------
  // 瓦片加载：直接使用 quantized-mesh 原生三角网，不经过 heightfield 中间层
  // ---------------------------------------------------------------------

  /**
   * 把 QM 原始数据直接转换为顶点缓冲。
   * 每个 QM 顶点对应一个 mesh 顶点，三角索引直接复用。
   */
  function buildTileMeshFromQM(
    raw: QuantizedMeshRaw,
    z: number, x: number, y: number,
  ): DecodedTerrainTile {
    const geo = cesiumTileToGeographic(z, x, y);
    const centerLng = (geo.west + geo.east) * 0.5;
    const centerLat = (geo.south + geo.north) * 0.5;
    const worldSizeZ0 = TILE_PIXEL_SIZE;
    const [centerPxZ0X, centerPxZ0Y] = lngLatToMercatorPixel(
      centerLng, centerLat, worldSizeZ0,
    );

    // 选一张覆盖 bbox 的 OSM 瓦片作为 drape 纹理源
    const osm = pickCoveringOsmTile(
      geo.west, geo.south, geo.east, geo.north,
      Math.min(drapeMaxZoom, z + 1),
    );

    const vc = raw.vertexCount;
    const hMin = raw.header.minimumHeight;
    const hMax = raw.header.maximumHeight;
    const hRange = Math.max(1e-3, hMax - hMin);

    // 临时数组：位置(z=0 px)、真实高度(米)、UV
    const tmpPosXY = new Float32Array(vc * 2);
    const tmpHeight = new Float32Array(vc);
    const tmpUV = new Float32Array(vc * 2);
    // 用于法线计算的 3D 位置（high 以 z=0 px 为单位，保证比例正确）
    const ppmZ0 = 1 / (
      (2 * Math.PI * 6378137 / worldSizeZ0) * Math.cos(centerLat * Math.PI / 180)
    );
    const normalPos = new Float32Array(vc * 3);

    for (let i = 0; i < vc; i++) {
      const uNorm = raw.uArray[i] / QM_COORD_RANGE;
      const vNorm = raw.vArray[i] / QM_COORD_RANGE;
      const hNorm = raw.hArray[i] / QM_COORD_RANGE;
      const lng = geo.west + (geo.east - geo.west) * uNorm;
      // Cesium QM: v=0 南, v=1 北
      const lat = geo.south + (geo.north - geo.south) * vNorm;
      const [mx, my] = lngLatToMercatorPixel(lng, lat, worldSizeZ0);
      tmpPosXY[i * 2 + 0] = mx - centerPxZ0X;
      tmpPosXY[i * 2 + 1] = my - centerPxZ0Y;
      const heightM = hMin + hNorm * hRange;
      tmpHeight[i] = heightM;

      // UV: (lng,lat) → OSM 瓦片局部 [0,1]
      const [uu, vv] = lngLatToOsmTileUv(lng, lat, osm.z, osm.x, osm.y);
      tmpUV[i * 2 + 0] = uu;
      tmpUV[i * 2 + 1] = vv;

      normalPos[i * 3 + 0] = tmpPosXY[i * 2 + 0];
      normalPos[i * 3 + 1] = tmpPosXY[i * 2 + 1];
      normalPos[i * 3 + 2] = heightM * ppmZ0 * exaggeration;
    }

    // 法线：优先 oct-encoded，否则 CPU 面积加权
    const normals = new Float32Array(vc * 3);
    if (raw.octNormals !== null && raw.octNormals.length >= vc * 2) {
      for (let i = 0; i < vc; i++) {
        octDecodeNormal(raw.octNormals[i * 2], raw.octNormals[i * 2 + 1], normals, i * 3);
      }
    } else {
      computeVertexNormals(normalPos, raw.triangleIndices, normals);
    }

    // 裙边：沿西/南/东/北 4 条边下沉 SKIRT_METERS
    const edgeArrays = [raw.westIndices, raw.southIndices, raw.eastIndices, raw.northIndices];
    let skirtVertCount = 0;
    for (const a of edgeArrays) { skirtVertCount += a.length; }

    const totalVerts = vc + skirtVertCount;
    const vertData = new Float32Array(totalVerts * FLOATS_PER_VERTEX);

    // 主顶点交错写入
    for (let i = 0; i < vc; i++) {
      const dst = i * FLOATS_PER_VERTEX;
      vertData[dst + 0] = tmpPosXY[i * 2 + 0];
      vertData[dst + 1] = tmpPosXY[i * 2 + 1];
      vertData[dst + 2] = tmpHeight[i];
      vertData[dst + 3] = normals[i * 3 + 0];
      vertData[dst + 4] = normals[i * 3 + 1];
      vertData[dst + 5] = normals[i * 3 + 2];
      vertData[dst + 6] = tmpUV[i * 2 + 0];
      vertData[dst + 7] = tmpUV[i * 2 + 1];
    }

    // 裙边顶点
    const edgeSkirtStart: number[] = [];
    let skirtVi = vc;
    for (const arr of edgeArrays) {
      edgeSkirtStart.push(skirtVi);
      for (let i = 0; i < arr.length; i++) {
        const src = arr[i];
        const dst = skirtVi * FLOATS_PER_VERTEX;
        vertData[dst + 0] = tmpPosXY[src * 2 + 0];
        vertData[dst + 1] = tmpPosXY[src * 2 + 1];
        vertData[dst + 2] = tmpHeight[src] - SKIRT_METERS;
        vertData[dst + 3] = 0;
        vertData[dst + 4] = 0;
        vertData[dst + 5] = -1;
        vertData[dst + 6] = tmpUV[src * 2 + 0];
        vertData[dst + 7] = tmpUV[src * 2 + 1];
        skirtVi++;
      }
    }

    // 索引：主三角 + 裙边条带三角
    const mainIdxCount = raw.triangleIndices.length;
    let skirtIdxCount = 0;
    for (const arr of edgeArrays) {
      if (arr.length >= 2) { skirtIdxCount += (arr.length - 1) * 6; }
    }
    const totalIdx = mainIdxCount + skirtIdxCount;
    const useUint32 = totalVerts > 65535;
    const idxArr: Uint16Array | Uint32Array = useUint32
      ? new Uint32Array(totalIdx)
      : new Uint16Array(totalIdx);

    for (let i = 0; i < mainIdxCount; i++) {
      idxArr[i] = raw.triangleIndices[i];
    }
    let w = mainIdxCount;
    for (let e = 0; e < edgeArrays.length; e++) {
      const arr = edgeArrays[e];
      const sStart = edgeSkirtStart[e];
      for (let i = 0; i < arr.length - 1; i++) {
        const v0 = arr[i];
        const v1 = arr[i + 1];
        const s0 = sStart + i;
        const s1 = sStart + i + 1;
        idxArr[w++] = v0; idxArr[w++] = v1; idxArr[w++] = s0;
        idxArr[w++] = v1; idxArr[w++] = s1; idxArr[w++] = s0;
      }
    }

    const byteSize = vertData.byteLength + idxArr.byteLength;
    return {
      coord: { z, x, y },
      vertices: vertData,
      indices: idxArr,
      vertexCount: totalVerts,
      indexCount: w,
      mainIndexCount: mainIdxCount,
      bbox: [geo.west, geo.south, geo.east, geo.north],
      heightRange: [hMin, hMax],
      tileCenterMercatorPxZ0: [centerPxZ0X, centerPxZ0Y],
      tileCenterLngLat: [centerLng, centerLat],
      drapeOsm: osm,
      byteSize,
    };
  }

  /** 面积加权法线（以 z=0 px 尺度的位置） */
  function computeVertexNormals(
    positions: Float32Array,
    indices: Uint16Array | Uint32Array,
    out: Float32Array,
  ): void {
    out.fill(0);
    const triCount = indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = indices[t * 3 + 0];
      const ib = indices[t * 3 + 1];
      const ic = indices[t * 3 + 2];
      const ax = positions[ia * 3 + 0], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
      const bx = positions[ib * 3 + 0], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
      const cx = positions[ic * 3 + 0], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      out[ia * 3 + 0] += nx; out[ia * 3 + 1] += ny; out[ia * 3 + 2] += nz;
      out[ib * 3 + 0] += nx; out[ib * 3 + 1] += ny; out[ib * 3 + 2] += nz;
      out[ic * 3 + 0] += nx; out[ic * 3 + 1] += ny; out[ic * 3 + 2] += nz;
    }
    const vc = out.length / 3;
    for (let i = 0; i < vc; i++) {
      const nx = out[i * 3 + 0];
      const ny = out[i * 3 + 1];
      const nz = out[i * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-10) {
        out[i * 3 + 0] = nx / len;
        out[i * 3 + 1] = ny / len;
        out[i * 3 + 2] = nz / len;
      } else {
        out[i * 3 + 2] = 1;
      }
    }
  }

  async function loadTile(z: number, x: number, y: number): Promise<void> {
    if (device === null) { return; }
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) { return; }
    const entry: TerrainCacheEntry = {
      key,
      coord: { z, x, y },
      state: 'loading',
      decoded: null,
      vertexBuffer: null,
      indexBuffer: null,
      indexFormat: 'uint16',
      drapeTexture: null,
      drapeLoaded: false,
      tileBindGroup: null,
      drapeOsm: null,
      byteSize: 1024,
      errorCount: 0,
      prev: null,
      next: null,
    };
    cache.set(key, entry);

    // 异步获取 QM 二进制并解码
    let raw: QuantizedMeshRaw;
    try {
      raw = await provider.loadTile(z, x, y);
    } catch {
      entry.state = 'error';
      entry.errorCount++;
      return;
    }
    if (!mounted || device === null) { return; }
    // 再次检查是否被 LRU 驱逐
    if (!cache.has(key)) { return; }

    const decoded = buildTileMeshFromQM(raw, z, x, y);
    entry.decoded = decoded;
    entry.drapeOsm = decoded.drapeOsm;
    entry.byteSize = decoded.byteSize;
    entry.indexFormat = decoded.indices instanceof Uint32Array ? 'uint32' : 'uint16';

    // 顶点 buffer
    entry.vertexBuffer = device.createBuffer({
      size: decoded.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      entry.vertexBuffer, 0,
      decoded.vertices.buffer as ArrayBuffer,
      decoded.vertices.byteOffset, decoded.vertices.byteLength,
    );

    // 索引 buffer：size 和 writeBuffer 的 size 都必须是 4 的倍数。
    // 对于 Uint16 数组，byteLength 可能是奇数 × 2，需要 pad 一个元素再上传。
    const indexBytes = decoded.indices.byteLength;
    const paddedIndexBytes = Math.ceil(indexBytes / 4) * 4;
    entry.indexBuffer = device.createBuffer({
      size: paddedIndexBytes,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    let indexSource: Uint16Array | Uint32Array = decoded.indices;
    if (indexBytes !== paddedIndexBytes) {
      if (decoded.indices instanceof Uint16Array) {
        const padded = new Uint16Array(paddedIndexBytes / 2);
        padded.set(decoded.indices);
        // 末尾填充顶点 0（不会被任何真实三角形引用）
        indexSource = padded;
      } else {
        const padded = new Uint32Array(paddedIndexBytes / 4);
        padded.set(decoded.indices);
        indexSource = padded;
      }
    }
    device.queue.writeBuffer(
      entry.indexBuffer, 0,
      indexSource.buffer as ArrayBuffer,
      indexSource.byteOffset, paddedIndexBytes,
    );

    // 立即找一个 drape-ready 的祖先瓦片，借用其纹理 + UV 子区域作为
    // 初始 bind group，这样瓦片加载瞬间就有真实 OSM 颜色，不会显示白色。
    // 真实 drape 到达后 ensureTileBindGroup 会用 identity transform 替换。
    let initialTex: GPUTexture = placeholderTex !== null
      ? placeholderTex : (null as unknown as GPUTexture);
    let uvScale = 1, uvOffsetX = 0, uvOffsetY = 0;
    {
      let az = z - 1, ax = x >>> 1, ay = y >>> 1;
      while (az >= 0) {
        const ak = `${az}/${ax}/${ay}`;
        const ae = cache.peek(ak);
        if (ae !== undefined && ae.drapeTexture !== null && ae.drapeLoaded) {
          initialTex = ae.drapeTexture;
          const dz = z - az;
          const shift = dz;
          const n2 = 1 << shift;
          // 本瓦片 (x,y) 在祖先内的局部坐标
          const ix = x - (ax << shift);
          const iy = y - (ay << shift);
          uvScale = 1 / n2;
          uvOffsetX = ix / n2;
          uvOffsetY = iy / n2;
          break;
        }
        if (az === 0) { break; }
        az--;
        ax >>>= 1;
        ay >>>= 1;
      }
    }
    if (initialTex !== null) {
      ensureTileBindGroup(entry, initialTex, uvScale, uvScale, uvOffsetX, uvOffsetY);
    }
    entry.state = 'ready';
    cache.updateBytes(key, decoded.byteSize);

    // 启动真实 drape 贴图加载
    void loadDrapeTexture(entry);
  }

  // ---------------------------------------------------------------------
  // Layer 接口
  // ---------------------------------------------------------------------

  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  const layer: Layer & {
    readonly provider: CesiumTerrainProvider;
    queryTerrainElevation(lng: number, lat: number): number | null;
  } = {
    id: opts.id,
    type: 'cesium-terrain',
    source: opts.source,
    projection: 'mercator',
    visible: true,
    opacity,
    zIndex: 0,
    isLoaded: false,
    isTransparent: false,
    renderOrder: 0,
    provider,

    onAdd(context: LayerContext): void {
      layerContext = context;
      mounted = true;
      if (context.canvasSize) { canvasSize = context.canvasSize; }
      if (context.gpuDevice != null && pipeline === null) {
        initGPU(context.gpuDevice);
      }
    },

    onRemove(): void {
      mounted = false;
      provider.abortAll();
      for (const e of cache.values()) {
        e.vertexBuffer?.destroy();
        e.indexBuffer?.destroy();
        e.drapeTexture?.destroy();
      }
      cache.clear();
      for (const b of tileUBByKey.values()) { b.destroy(); }
      tileUBByKey.clear();
      cameraUB?.destroy(); cameraUB = null;
      styleUB?.destroy(); styleUB = null;
      placeholderTex?.destroy(); placeholderTex = null;
      pipeline = null;
      device = null;
    },

    onUpdate(_dt: number, camera: CameraState): void {
      if (device === null) { return; }
      if (!providerReady) { return; }
      if (layerContext?.canvasSize) { canvasSize = layerContext.canvasSize; }
      void maxSSE;
      void rootPreloadStarted;

      // Cesium 地理 TMS 调度（只会返回 available 矩阵内的瓦片，所以在
      // 非 DEM 区域如美国/非洲，调度结果为空，由底图 RasterTileLayer 兜底）
      scheduledThisFrame = computeGeographicCoveringTiles(camera, provider, {
        viewportWidth: canvasSize[0],
        viewportHeight: canvasSize[1],
        minZoom: opts.minZoom ?? 0,
        maxZoom: opts.maxZoom ?? 14,
      });

      // Touch 已存在的 scheduled 到 LRU 尾部（最远→最近）
      for (let i = scheduledThisFrame.length - 1; i >= 0; i--) {
        const t = scheduledThisFrame[i];
        const key = `${t.z}/${t.x}/${t.y}`;
        if (cache.has(key)) { cache.get(key); }
      }

      // 为缺失的瓦片触发异步加载（budget 限流）
      let budget = 8;
      for (const t of scheduledThisFrame) {
        const key = `${t.z}/${t.x}/${t.y}`;
        if (!cache.has(key)) {
          if (budget > 0) {
            void loadTile(t.z, t.x, t.y);
            budget--;
          }
        }
      }
    },

    encode(encoder: GPURenderPassEncoder, camera: CameraState): void {
      if (
        device === null || pipeline === null ||
        cameraBG === null || styleBG === null || cameraUB === null ||
        !layer.visible
      ) {
        return;
      }

      // CameraUniforms：vpMatrix + (camCenterZ0 xy, worldScale, ppmCurrent)
      const worldSizeZ0 = TILE_PIXEL_SIZE;
      const [camCxZ0, camCyZ0] = lngLatToMercatorPixel(
        camera.center[0], camera.center[1], worldSizeZ0,
      );
      const worldScale = Math.pow(2, camera.zoom);
      // 将「米」投影到当前 zoom 下的像素。
      // 注意：顶点 shader 中 mercPx = mercRelZ0 * worldScale（XY），
      // 高度使用当前 zoom 下的 pixelsPerMeter 与顶点 XY 保持一致的像素尺度。
      const ppmCurrent = pixelsPerMeter(camera.center[1], camera.zoom) * exaggeration;

      const camData = new Float32Array(20);
      camData.set(camera.vpMatrix, 0);
      camData[16] = camCxZ0;
      camData[17] = camCyZ0;
      camData[18] = worldScale;
      camData[19] = ppmCurrent;
      device.queue.writeBuffer(cameraUB, 0, camData);

      encoder.setPipeline(pipeline);
      encoder.setBindGroup(0, cameraBG);
      encoder.setBindGroup(1, styleBG);

      // isReady：mesh 已构建 + 有 bind group（可能是自有 drape，也可能
      // 是借用祖先 drape 的子区域）。这样瓦片加载瞬间即可参与渲染，不会
      // 在缩放过渡期出现 "等待 drape 白板期"。
      const isReady = (e: TerrainCacheEntry | undefined): boolean =>
        e !== undefined &&
        e.state === 'ready' &&
        e.decoded !== null &&
        e.vertexBuffer !== null &&
        e.indexBuffer !== null &&
        e.tileBindGroup !== null;

      const drawEntry = (e: TerrainCacheEntry): void => {
        encoder.setBindGroup(2, e.tileBindGroup!);
        encoder.setVertexBuffer(0, e.vertexBuffer!);
        encoder.setIndexBuffer(e.indexBuffer!, e.indexFormat);
        encoder.drawIndexed(e.decoded!.indexCount);
      };

      // 直接 QM 渲染：不再自己构建网格，所以 mesh 质量由服务器原生三角网
      // 决定，没有 heightfield 光栅化噪声；调度器只返回 available 矩阵内的
      // Cesium 瓦片，非 DEM 区（美国/非洲）由底图 RasterTileLayer 兜底。
      //
      // 渲染：对每个 scheduled ready 的瓦片直接 draw；未 ready 的用 walkup
      // 到最近已 ready 祖先替代（加速缩放过渡，避免空洞）。

      const primary: TerrainCacheEntry[] = [];
      const substitutes = new Map<string, TerrainCacheEntry>();

      for (const st of scheduledThisFrame) {
        const k = `${st.z}/${st.x}/${st.y}`;
        const e = cache.get(k);
        if (isReady(e)) {
          primary.push(e!);
          continue;
        }
        // walkup 到最近 ready 祖先
        let cz = st.z - 1, cx = st.x >>> 1, cy = st.y >>> 1;
        while (cz >= 0) {
          const kk = `${cz}/${cx}/${cy}`;
          if (substitutes.has(kk)) { break; }
          const ae = cache.get(kk);
          if (isReady(ae)) { substitutes.set(kk, ae!); break; }
          if (cz === 0) { break; }
          cz--;
          cx >>>= 1;
          cy >>>= 1;
        }
      }

      // 粗祖先先画，细叶子后画
      const subSorted = Array.from(substitutes.values()).sort(
        (a, b) => a.coord.z - b.coord.z,
      );
      for (const e of subSorted) { drawEntry(e); }
      for (const e of primary) { drawEntry(e); }
    },

    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
      if (device !== null && styleUB !== null) {
        const sd = new Float32Array(8);
        sd[0] = lightDir[0]; sd[1] = lightDir[1]; sd[2] = lightDir[2]; sd[3] = ambient;
        sd[4] = opacity; sd[5] = 0; sd[6] = 0; sd[7] = 0;
        device.queue.writeBuffer(styleUB, 0, sd);
      }
    },
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);
      if (name === 'visibility') { layer.visible = value === 'visible'; }
    },
    getPaintProperty(name: string): unknown { return paintProps.get(name); },
    getLayoutProperty(name: string): unknown { return layoutProps.get(name); },
    setData(_data: unknown): void { /* provider 自管 */ },
    getData(): unknown {
      let ready = 0;
      for (const e of cache.values()) { if (e.state === 'ready') { ready++; } }
      return {
        cachedTiles: cache.size,
        readyTiles: ready,
        cacheBytes: cache.bytes,
        scheduledTiles: scheduledThisFrame.length,
        providerReady,
      };
    },
    setFeatureState(_id: string, _state: Record<string, unknown>): void { /* no-op */ },
    getFeatureState(_id: string): Record<string, unknown> | undefined { return undefined; },

    queryTerrainElevation(lng: number, lat: number): number | null {
      let best: TerrainCacheEntry | null = null;
      for (const e of cache.values()) {
        if (e.decoded === null) { continue; }
        const d = e.decoded;
        if (lng < d.bbox[0] || lng > d.bbox[2] || lat < d.bbox[1] || lat > d.bbox[3]) { continue; }
        if (best === null || e.coord.z > best.coord.z) { best = e; }
      }
      if (best === null || best.decoded === null) { return null; }
      const [mn, mx] = best.decoded.heightRange;
      return (mn + mx) * 0.5;
    },
  };

  return layer;
}
