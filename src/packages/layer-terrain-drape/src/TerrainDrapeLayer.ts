// ============================================================
// TerrainDrapeLayer.ts — 单层地形渲染（参照 Mapbox GL v3 / MapLibre）
//
// 所有瓦片共享 singleton 128×128 grid mesh。
// DEM 作为 GPU 纹理在 vertex shader 内采样高度。
// 无 DEM 时绑 1×1 零纹理 → 纯平面底图。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import type { Layer } from '../../scene/src/scene-graph.ts';
import type { LayerContext } from '../../scene/src/layer-manager.ts';

import {
  TILE_PIXEL_SIZE,
  EARTH_CIRCUMFERENCE,
  CAMERA_UB_SIZE,
  STYLE_UB_SIZE,
  TILE_UB_SIZE,
  LOAD_BUDGET_PER_FRAME,
  type TerrainDrapeLayerOptions,
  type TerrainDrapeTileEntry,
  type ElevationSource,
} from './types.ts';
import { TERRAIN_DRAPE_WGSL } from './terrain-drape-shader.wgsl.ts';
import { createSharedGridMesh, type SharedGridMesh } from './shared-grid-mesh.ts';
import { TerrainDrapeTileCache } from './terrain-drape-tile-cache.ts';
import {
  computeTerrainDrapeCoveringTiles,
  type ScheduledTile,
} from './terrain-drape-scheduler.ts';

// ---------------------------------------------------------------------------
// Mercator 工具（内联避免跨包依赖）
// ---------------------------------------------------------------------------

const MAX_LAT = 85.051128779806604;

function lngLatToMercatorPxZ0(lng: number, lat: number): [number, number] {
  const ws = TILE_PIXEL_SIZE;
  const px = ((lng + 180) / 360) * ws;
  const cLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const latRad = (cLat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * ws;
  return [px, py];
}

function pixelsPerMeter(lat: number, zoom: number): number {
  const ws = TILE_PIXEL_SIZE * Math.pow(2, zoom);
  const mPerPxEq = EARTH_CIRCUMFERENCE / ws;
  return 1 / (mPerPxEq * Math.cos(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180));
}

/** Mercator XYZ 瓦片 bbox → z=0 px */
function tileBboxZ0(z: number, x: number, y: number): [number, number, number, number] {
  const n = Math.pow(2, z);
  // OSM 瓦片 (x, y)：x 列（west→east），y 行（north→south）
  // 四角 lngLat → z=0 px
  const westLng = (x / n) * 360 - 180;
  const eastLng = ((x + 1) / n) * 360 - 180;
  const northLat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180) / Math.PI;
  const southLat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180) / Math.PI;
  // west/south = bboxMin, east/north = bboxMax
  const [wx, _ny] = lngLatToMercatorPxZ0(westLng, northLat);
  const [ex, sy] = lngLatToMercatorPxZ0(eastLng, southLat);
  // 注意：mercator y 向南增大。northLat 对应 py 小，southLat 对应 py 大。
  // mix(bboxMin, bboxMax, uv) 中 uv.y=0 对应 north(小 py), uv.y=1 对应 south(大 py)
  return [wx, _ny, ex, sy];
}

function buildOsmUrl(tmpl: string, z: number, x: number, y: number): string {
  return tmpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createTerrainDrapeLayer(
  opts: TerrainDrapeLayerOptions,
): Layer {
  const exaggeration = opts.exaggeration ?? 1.5;
  const opacity = opts.opacity ?? 1;
  const hillshadeStrength = opts.hillshadeStrength ?? 0.15;
  const lightDir = opts.lightDirection ?? [-0.5, -0.7, 1.0];
  const rasterTemplate = opts.rasterUrlTemplate;
  const rasterMaxZoom = opts.rasterMaxZoom ?? 19;
  void rasterMaxZoom;

  // 可选 elevation source（Step 5 接入）
  let elevationSource: ElevationSource | null = null;
  void elevationSource;

  // GPU 资源
  let device: GPUDevice | null = null;
  let pipeline: GPURenderPipeline | null = null;
  let cameraLayout: GPUBindGroupLayout | null = null;
  let styleLayout: GPUBindGroupLayout | null = null;
  let tileLayout: GPUBindGroupLayout | null = null;
  let cameraUB: GPUBuffer | null = null;
  let styleUB: GPUBuffer | null = null;
  let cameraBG: GPUBindGroup | null = null;
  let styleBG: GPUBindGroup | null = null;
  let sampler: GPUSampler | null = null;
  let sharedMesh: SharedGridMesh | null = null;
  let zeroDemTex: GPUTexture | null = null;
  let placeholderDrapeTex: GPUTexture | null = null;

  // 缓存 & 调度
  const cache = new TerrainDrapeTileCache((e) => {
    e.drapeTex?.destroy();
    e.demTex?.destroy();
    e.tileUB?.destroy();
  });
  let scheduledThisFrame: ScheduledTile[] = [];
  let layerContext: LayerContext | null = null;
  let mounted = false;
  let canvasSize: readonly [number, number] = [1024, 768];
  const drapeFetchInflight = new Set<string>();

  // ---------------------------------------------------------------------
  // GPU 初始化
  // ---------------------------------------------------------------------

  function initGPU(dev: GPUDevice): void {
    device = dev;
    const mod = dev.createShaderModule({ code: TERRAIN_DRAPE_WGSL });

    cameraLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    styleLayout = dev.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });
    tileLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      ],
    });

    const format = navigator.gpu.getPreferredCanvasFormat();
    pipeline = dev.createRenderPipeline({
      layout: dev.createPipelineLayout({
        bindGroupLayouts: [cameraLayout, styleLayout, tileLayout],
      }),
      vertex: {
        module: mod,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 8, // float32x2 uv
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        }],
      },
      fragment: {
        module: mod,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    // Uniform buffers
    cameraUB = dev.createBuffer({ size: CAMERA_UB_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    styleUB = dev.createBuffer({ size: STYLE_UB_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    cameraBG = dev.createBindGroup({ layout: cameraLayout, entries: [{ binding: 0, resource: { buffer: cameraUB } }] });
    styleBG = dev.createBindGroup({ layout: styleLayout, entries: [{ binding: 0, resource: { buffer: styleUB } }] });

    // Style uniform（一次性写入，paint 变更时重写）
    const sd = new Float32Array(8);
    sd[0] = lightDir[0]; sd[1] = lightDir[1]; sd[2] = lightDir[2]; sd[3] = hillshadeStrength;
    sd[4] = opacity;
    dev.queue.writeBuffer(styleUB, 0, sd);

    // Sampler
    sampler = dev.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    // Shared mesh
    sharedMesh = createSharedGridMesh(dev);

    // 1×1 零 DEM（R8, value=0）
    zeroDemTex = dev.createTexture({
      size: [1, 1, 1], format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture(
      { texture: zeroDemTex },
      new Uint8Array([0]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );

    // 1×1 白 drape 占位
    placeholderDrapeTex = dev.createTexture({
      size: [1, 1, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture(
      { texture: placeholderDrapeTex },
      new Uint8Array([220, 220, 220, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
  }

  // ---------------------------------------------------------------------
  // 为 entry 构建 / 更新 tileBindGroup
  // ---------------------------------------------------------------------

  function ensureBindGroup(
    entry: TerrainDrapeTileEntry,
    drapeTex: GPUTexture,
    demTex: GPUTexture,
  ): void {
    if (device === null || tileLayout === null || sampler === null) { return; }

    if (entry.tileUB === null) {
      entry.tileUB = device.createBuffer({
        size: TILE_UB_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // bboxZ0 + heightInfo
    const bbox = tileBboxZ0(entry.z, entry.x, entry.y);
    const td = new Float32Array(8);
    td[0] = bbox[0]; td[1] = bbox[1]; td[2] = bbox[2]; td[3] = bbox[3];
    td[4] = entry.heightRange[0];                        // minH
    td[5] = entry.heightRange[1] - entry.heightRange[0]; // heightRange
    td[6] = exaggeration;
    td[7] = entry.hasElevation ? 1 : 0;
    device.queue.writeBuffer(entry.tileUB, 0, td);

    entry.tileBindGroup = device.createBindGroup({
      layout: tileLayout,
      entries: [
        { binding: 0, resource: { buffer: entry.tileUB } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: demTex.createView() },
        { binding: 3, resource: drapeTex.createView() },
      ],
    });
  }

  // ---------------------------------------------------------------------
  // 瓦片加载
  // ---------------------------------------------------------------------

  async function loadTile(z: number, x: number, y: number): Promise<void> {
    if (device === null) { return; }
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) { return; }
    if (drapeFetchInflight.has(key)) { return; }
    drapeFetchInflight.add(key);

    const entry: TerrainDrapeTileEntry = {
      key, z, x, y,
      state: 'loading',
      drapeTex: null,
      demTex: null,
      tileBindGroup: null,
      tileUB: null,
      hasElevation: false,
      heightRange: [0, 0],
      byteSize: 256,
      errorCount: 0,
      prev: null, next: null,
    };
    cache.set(key, entry);

    try {
      // OSM drape fetch
      const url = buildOsmUrl(rasterTemplate, z, x, y);
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      if (!mounted || device === null) { bitmap.close(); return; }
      if (!cache.has(key)) { bitmap.close(); return; }

      const tex = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: tex },
        [bitmap.width, bitmap.height, 1],
      );
      const texBytes = bitmap.width * bitmap.height * 4;
      bitmap.close();

      entry.drapeTex = tex;
      entry.byteSize = texBytes;
      ensureBindGroup(entry, tex, zeroDemTex!);
      entry.state = 'ready';
      cache.updateBytes(key, texBytes);
    } catch {
      entry.state = 'error';
      entry.errorCount++;
    } finally {
      drapeFetchInflight.delete(key);
    }
  }

  // ---------------------------------------------------------------------
  // Layer 接口
  // ---------------------------------------------------------------------

  const paintProps = new Map<string, unknown>();
  const layoutProps = new Map<string, unknown>();

  const layer: Layer = {
    id: opts.id,
    type: 'terrain-drape',
    source: opts.id,
    projection: 'mercator',
    visible: true,
    opacity,
    zIndex: 0,
    isLoaded: false,
    isTransparent: false,
    renderOrder: 0,

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
      for (const e of cache.values()) {
        e.drapeTex?.destroy();
        e.demTex?.destroy();
        e.tileUB?.destroy();
      }
      cache.clear();
      cameraUB?.destroy(); cameraUB = null;
      styleUB?.destroy(); styleUB = null;
      zeroDemTex?.destroy(); zeroDemTex = null;
      placeholderDrapeTex?.destroy(); placeholderDrapeTex = null;
      pipeline = null;
      device = null;
    },

    onUpdate(_dt: number, camera: CameraState): void {
      if (device === null) { return; }
      if (layerContext?.canvasSize) { canvasSize = layerContext.canvasSize; }

      scheduledThisFrame = computeTerrainDrapeCoveringTiles(camera, {
        viewportWidth: canvasSize[0],
        viewportHeight: canvasSize[1],
        minZoom: opts.minZoom ?? 0,
        maxZoom: opts.maxZoom ?? rasterMaxZoom,
      });

      // LRU touch（最远→最近）
      for (let i = scheduledThisFrame.length - 1; i >= 0; i--) {
        const t = scheduledThisFrame[i];
        const k = `${t.z}/${t.x}/${t.y}`;
        if (cache.has(k)) { cache.get(k); }
      }

      // 加载缺失瓦片
      let budget = LOAD_BUDGET_PER_FRAME;
      for (const t of scheduledThisFrame) {
        const k = `${t.z}/${t.x}/${t.y}`;
        if (!cache.has(k) && budget > 0) {
          void loadTile(t.z, t.x, t.y);
          budget--;
        }
      }
    },

    encode(encoder: GPURenderPassEncoder, camera: CameraState): void {
      if (
        device === null || pipeline === null ||
        cameraBG === null || styleBG === null || cameraUB === null ||
        sharedMesh === null || !layer.visible
      ) {
        return;
      }

      // Camera uniform
      const [camCxZ0, camCyZ0] = lngLatToMercatorPxZ0(camera.center[0], camera.center[1]);
      const worldScale = Math.pow(2, camera.zoom);
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
      encoder.setVertexBuffer(0, sharedMesh.vertexBuffer);
      encoder.setIndexBuffer(sharedMesh.indexBuffer, sharedMesh.indexFormat);

      // 绘制所有 ready 的 scheduled 瓦片
      for (const st of scheduledThisFrame) {
        const k = `${st.z}/${st.x}/${st.y}`;
        const e = cache.peek(k);
        if (e === undefined || e.state !== 'ready' || e.tileBindGroup === null) {
          continue;
        }
        encoder.setBindGroup(2, e.tileBindGroup);
        encoder.drawIndexed(sharedMesh.indexCount);
      }
    },

    setPaintProperty(name: string, value: unknown): void {
      paintProps.set(name, value);
    },
    setLayoutProperty(name: string, value: unknown): void {
      layoutProps.set(name, value);
      if (name === 'visibility') { layer.visible = value === 'visible'; }
    },
    getPaintProperty(name: string): unknown { return paintProps.get(name); },
    getLayoutProperty(name: string): unknown { return layoutProps.get(name); },
    setData(): void { /* no-op */ },
    getData(): unknown {
      let ready = 0;
      for (const e of cache.values()) { if (e.state === 'ready') { ready++; } }
      return { cachedTiles: cache.size, readyTiles: ready, scheduledTiles: scheduledThisFrame.length };
    },
    setFeatureState(): void { /* no-op */ },
    getFeatureState(): undefined { return undefined; },
  };

  return layer;
}
