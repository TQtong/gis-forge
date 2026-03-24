// ============================================================
// l2/picking-engine.ts — Color-ID 拾取 + 异步 GPU 回读
// 层级：L2（渲染层）
// 职责：维护 rgba32uint 拾取目标、按层解析 colorId、深度回读与屏幕反投影。
// 约束：零 npm；类型从 L0 import；GPU 回读经 L1 GPUUploader。
// ============================================================

import type { PickResult } from '../../../core/src/types/viewport.ts';
import type { Vec3f, Mat4f } from '../../../core/src/types/math-types.ts';
import type { GPUUploader } from '../l1/uploader.ts';
import type { TextureHandle } from '../l1/texture-manager.ts';

// ===================== 常量 =====================

/** 拾取颜色附件格式：每像素一个 u32 颜色 ID。 */
const PICKING_COLOR_FORMAT: GPUTextureFormat = 'rgba32uint';

/** 深度拾取附件格式。 */
const PICKING_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** 默认初始拾取纹理尺寸（像素）；调用 `resizePickingTarget` 或首次渲染前会扩展。 */
const DEFAULT_PICKING_SIZE = 1 as const;

/** WGS84 平均球半径（米），用于简化射线-球求交。 */
const WGS84_MEAN_RADIUS_M = 6371007.0;

/** 反投影 / 射线计算的数值容差。 */
const EPSILON = 1.0e-7;

/** 每像素 rgba32uint 字节数。 */
const BYTES_RGBA32UINT = 16 as const;

/** depth32float 每像素字节数。 */
const BYTES_DEPTH32 = 4 as const;

/** WebGPU copy 行对齐（字节）。 */
const BYTES_PER_ROW_ALIGN = 256 as const;

const PICKING_LABEL = 'geoforge-picking';

// ===================== 前向类型 =====================

/**
 * 渲染图（前向声明）。
 * 正式实现将位于 `render-graph.ts`；此处仅保留拾取编码所需的最小形状。
 */
export interface RenderGraph {
  /** Pass 名称 → 任意 Pass 描述；若对象含 `encodePicking` 则会被调用。 */
  readonly passes: ReadonlyMap<string, unknown>;
}

// ===================== 类型 =====================

/**
 * Color-ID 拾取引擎：渲染拾取帧、异步读回像素、地理/世界反投影。
 */
export interface PickingEngine {
  /**
   * 将拾取 Pass 编码进给定 `encoder`（颜色 ID + 深度）。
   * `RenderGraph` 中各 Pass 若实现 `encodePicking(encoder, colorView, depthView)` 则会被调用。
   *
   * @param graph - 渲染图（最小接口）
   * @param encoder - 外部命令编码器
   */
  renderPickingFrame(graph: RenderGraph, encoder: GPUCommandEncoder): void;

  /**
   * 读取单像素颜色 ID 并经由已注册解析器解析为 `PickResult`。
   * 须在包含 `renderPickingFrame` 的提交执行完成后再调用（通常下一帧）。
   *
   * @param x - 屏幕 X（CSS 像素，左上原点）
   * @param y - 屏幕 Y（CSS 像素，左上原点）
   * @returns 命中结果或 null
   */
  pickAt(x: number, y: number): Promise<PickResult | null>;

  /**
   * 在轴对齐矩形内扫描拾取结果（去重后返回非空 `PickResult` 列表）。
   *
   * @param x1 - 矩形左（含）
   * @param y1 - 矩形上（含）
   * @param x2 - 矩形右（含）
   * @param y2 - 矩形下（含）
   */
  pickInRect(x1: number, y1: number, x2: number, y2: number): Promise<PickResult[]>;

  /**
   * 世界空间射线检测（占位实现：无场景 BVH 时返回空数组）。
   *
   * @param origin - 射线起点（世界坐标，米）
   * @param direction - 射线方向（未归一化时内部会归一化）
   * @param maxDistance - 最大距离（米）
   */
  raycast(origin: Vec3f, direction: Vec3f, maxDistance: number): Promise<PickResult[]>;

  /**
   * 异步读取深度纹理单像素（`depth32float` 原始采样值 [0,1]）。
   *
   * @param x - 屏幕 X（CSS 像素）
   * @param y - 屏幕 Y（CSS 像素）
   */
  readDepthAt(x: number, y: number): Promise<number>;

  /**
   * 屏幕坐标 + 深度反投影到世界坐标（列主序 `inverseVPMatrix`）。
   *
   * @param screenX - 屏幕 X（CSS 像素）
   * @param screenY - 屏幕 Y（CSS 像素）
   * @param depth - 归一化深度（Reversed-Z：1 近 0 远）
   * @param inverseVPMatrix - 视图投影逆矩阵（列主序 Mat4f）
   */
  unprojectScreenToWorld(screenX: number, screenY: number, depth: number, inverseVPMatrix: Mat4f): Vec3f;

  /**
   * 屏幕点转大地坐标：先构造视射线，再与 z=0 世界平面求交；失败时与 WGS84 平均球求交。
   *
   * @param screenX - 屏幕 X（CSS 像素）
   * @param screenY - 屏幕 Y（CSS 像素）
   * @param vpMatrix - 视图投影矩阵（列主序）
   * @param inverseVPMatrix - 视图投影逆矩阵（列主序）
   * @returns `[lon, lat, alt]` 度/米，或 null
   */
  screenToGeodetic(
    screenX: number,
    screenY: number,
    vpMatrix: Mat4f,
    inverseVPMatrix: Mat4f
  ): [number, number, number] | null;

  /**
   * 读取矩形区域内每个像素的原始颜色 ID（`rgba32uint` 的 R 通道 u32，小端）。
   *
   * @param x - 左上角 X（像素，相对拾取纹理）
   * @param y - 左上角 Y
   * @param width - 宽度（像素）
   * @param height - 高度（像素）
   */
  pickRegion(x: number, y: number, width: number, height: number): Promise<Uint32Array>;

  /**
   * 注册图层解析器：`colorId` 为 GPU 写入的完整 u32（可含层槽位打包）。
   *
   * @param layerId - 图层 ID
   * @param resolver - `colorId → PickResult | null`
   */
  registerLayer(layerId: string, resolver: (colorId: number) => PickResult | null): void;

  /**
   * 注销图层解析器。
   *
   * @param layerId - 图层 ID
   */
  unregisterLayer(layerId: string): void;

}

// ===================== 数学辅助 =====================

/**
 * 列主序 4×4 与 vec4 相乘：out = M * v。
 *
 * @param out - 输出 Vec4（长度 4 Float32）
 * @param m - 列主序 Mat4f
 * @param v - 齐次向量
 */
function mulMat4Vec4(out: Float32Array, m: Mat4f, v: Readonly<Float32Array>): void {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  const w = v[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
}

/**
 * 分配 Vec3f 输出。
 *
 * @param x - X
 * @param y - Y
 * @param z - Z
 * @returns Vec3f
 */
function vec3(x: number, y: number, z: number): Vec3f {
  return new Float32Array([x, y, z]);
}

/**
 * 向量长度。
 *
 * @param v - 3D 向量
 */
function len3(v: Vec3f): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * 归一化 3D 向量（原地若 out 与 v 相同需拷贝）。
 *
 * @param v - 输入
 * @returns 新 Vec3f
 */
function normalize3(v: Vec3f): Vec3f {
  const l = len3(v);
  if (l < EPSILON) {
    return new Float32Array([0, 0, 1]);
  }
  return new Float32Array([v[0] / l, v[1] / l, v[2] / l]);
}

/**
 * 射线与以原点为中心、半径 R 的球求交（最近正根）。
 *
 * @param origin - 射线起点
 * @param dir - 单位方向
 * @param radius - 球半径
 * @returns 最近 t 或 null
 */
function raySphereNearestT(origin: Vec3f, dir: Vec3f, radius: number): number | null {
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) {
    return null;
  }
  const s = Math.sqrt(disc);
  const t0 = (-b - s) * 0.5;
  const t1 = (-b + s) * 0.5;
  const candidates = [t0, t1].filter((t) => t > EPSILON);
  if (candidates.length === 0) {
    return null;
  }
  return Math.min(...candidates);
}

/**
 * ECEF 笛卡尔坐标转近似经纬高（度、度、米）。
 *
 * @param x - ECEF X（米）
 * @param y - ECEF Y（米）
 * @param z - ECEF Z（米）
 */
function ecefToLonLatHeight(x: number, y: number, z: number): [number, number, number] {
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const p = Math.hypot(x, y);
  const lat = (Math.atan2(z, p) * 180) / Math.PI;
  const h = Math.hypot(p, z) - WGS84_MEAN_RADIUS_M;
  return [lon, lat, h];
}

// ===================== TextureHandle 包装 =====================

/**
 * 将裸 `GPUTexture` 包装为 `TextureHandle` 供 GPUUploader 使用。
 *
 * @param tex - GPU 纹理
 * @param format - 格式
 * @param id - 调试 id
 */
function toTextureHandle(tex: GPUTexture, format: GPUTextureFormat, id: string): TextureHandle {
  const view = tex.createView({ label: `${id}-view` });
  return Object.freeze({
    id,
    texture: tex,
    view,
    width: tex.width,
    height: tex.height,
    format,
  });
}

// ===================== rgba32uint 回读 =====================

/**
 * 将纹理子区域拷贝到 staging 并读取为紧凑 RGBA32UINT 像素（每像素 16 字节无行填充）。
 *
 * @param device - GPU 设备
 * @param texture - 源纹理
 * @param x - 原点 X
 * @param y - 原点 Y
 * @param width - 宽度
 * @param height - 高度
 * @param bytesPerPixel - 每像素字节
 */
async function readTextureRegionRaw(
  device: GPUDevice,
  texture: GPUTexture,
  x: number,
  y: number,
  width: number,
  height: number,
  bytesPerPixel: number
): Promise<ArrayBuffer> {
  if (width <= 0 || height <= 0) {
    throw new Error('[PickingEngine] readTextureRegionRaw: invalid dimensions');
  }
  const rawBytesPerRow = width * bytesPerPixel;
  const alignedBytesPerRow =
    Math.ceil(rawBytesPerRow / BYTES_PER_ROW_ALIGN) * BYTES_PER_ROW_ALIGN;
  const totalSize = alignedBytesPerRow * height;

  const stagingBuffer = device.createBuffer({
    label: `${PICKING_LABEL}-readback-staging`,
    size: totalSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder({ label: `${PICKING_LABEL}-readback-enc` });
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y } },
    { buffer: stagingBuffer, bytesPerRow: alignedBytesPerRow, rowsPerImage: height },
    { width, height }
  );
  device.queue.submit([encoder.finish()]);

  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const mapped = stagingBuffer.getMappedRange();
  let result: ArrayBuffer;
  if (alignedBytesPerRow === rawBytesPerRow) {
    result = mapped.slice(0);
  } else {
    const compact = new Uint8Array(rawBytesPerRow * height);
    const src = new Uint8Array(mapped);
    for (let row = 0; row < height; row++) {
      compact.set(
        src.subarray(row * alignedBytesPerRow, row * alignedBytesPerRow + rawBytesPerRow),
        row * rawBytesPerRow
      );
    }
    result = compact.buffer;
  }
  stagingBuffer.unmap();
  stagingBuffer.destroy();
  return result;
}

/**
 * 带 `resizePickingTarget` 的拾取引擎实例（须与画布物理分辨率对齐）。
 */
export type PickingEngineInstance = PickingEngine & {
  /**
   * 调整拾取渲染目标尺寸（物理像素）。
   *
   * @param width - 宽度
   * @param height - 高度
   */
  resizePickingTarget(width: number, height: number): void;
};

/**
 * 创建 PickingEngine（返回实例含 `resizePickingTarget`，须与表面物理分辨率对齐）。
 *
 * @param device - WebGPU 设备
 * @param uploader - L1 上传器（深度回读）
 * @returns 拾取引擎实例
 */
export function createPickingEngine(device: GPUDevice, uploader: GPUUploader): PickingEngineInstance {
  if (!device) {
    throw new Error('[PickingEngine] device is required');
  }
  if (!uploader) {
    throw new Error('[PickingEngine] uploader is required');
  }

  /** 图层解析器表。 */
  const resolvers = new Map<string, (colorId: number) => PickResult | null>();

  /** 注册顺序，用于解析时优先匹配。 */
  const registrationOrder: string[] = [];

  let pickW: number = DEFAULT_PICKING_SIZE;
  let pickH: number = DEFAULT_PICKING_SIZE;

  let colorTex: GPUTexture | null = null;
  let depthTex: GPUTexture | null = null;
  let colorHandle: TextureHandle | null = null;
  let depthHandle: TextureHandle | null = null;

  /**
   * 销毁当前拾取纹理句柄。
   */
  function destroyPickingSurfaces(): void {
    if (colorTex) {
      colorTex.destroy();
      colorTex = null;
    }
    if (depthTex) {
      depthTex.destroy();
      depthTex = null;
    }
    colorHandle = null;
    depthHandle = null;
  }

  /**
   * 分配或重建拾取纹理。
   */
  function ensureSurfaces(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('[PickingEngine] ensureSurfaces: dimensions must be finite');
    }
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (colorTex && pickW === w && pickH === h) {
      return;
    }
    destroyPickingSurfaces();
    pickW = w;
    pickH = h;

    colorTex = device.createTexture({
      label: `${PICKING_LABEL}-color`,
      size: { width: w, height: h },
      format: PICKING_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
    depthTex = device.createTexture({
      label: `${PICKING_LABEL}-depth`,
      size: { width: w, height: h },
      format: PICKING_DEPTH_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    colorHandle = toTextureHandle(colorTex, PICKING_COLOR_FORMAT, `${PICKING_LABEL}-color-handle`);
    depthHandle = toTextureHandle(depthTex, PICKING_DEPTH_FORMAT, `${PICKING_LABEL}-depth-handle`);
  }

  ensureSurfaces(DEFAULT_PICKING_SIZE, DEFAULT_PICKING_SIZE);

  /**
   * 将 CSS 像素坐标映射到拾取纹理整数坐标。
   *
   * @param screenX - CSS X
   * @param screenY - CSS Y
   */
  function mapScreenToTexel(screenX: number, screenY: number): { tx: number; ty: number } {
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
      throw new Error('[PickingEngine] mapScreenToTexel: coordinates must be finite');
    }
    const tx = Math.min(pickW - 1, Math.max(0, Math.floor(screenX)));
    const ty = Math.min(pickH - 1, Math.max(0, Math.floor(screenY)));
    return { tx, ty };
  }

  /**
   * 从 `rgba32uint` 缓冲区读取第一个像素的 u32 ID（小端，取 R 通道）。
   *
   * @param buf - 像素缓冲区
   */
  function readColorIdFromRgba32UintPixel(buf: ArrayBuffer): number {
    const u32 = new Uint32Array(buf, 0, Math.min(4, buf.byteLength / 4));
    return u32[0] >>> 0;
  }

  /**
   * 使用已注册解析器解析颜色 ID。
   *
   * @param colorId - GPU 颜色 ID
   */
  function resolveColorId(colorId: number): PickResult | null {
    if (colorId === 0) {
      return null;
    }
    for (let i = 0; i < registrationOrder.length; i++) {
      const lid = registrationOrder[i];
      const fn = resolvers.get(lid);
      if (!fn) {
        continue;
      }
      try {
        const r = fn(colorId);
        if (r) {
          return r;
        }
      } catch (err) {
        console.error(`[PickingEngine] resolver error layer=${lid}`, err);
      }
    }
    return null;
  }

  const engine: PickingEngineInstance = {
    renderPickingFrame(graph: RenderGraph, encoder: GPUCommandEncoder): void {
      if (!graph || !graph.passes) {
        throw new Error('[PickingEngine] renderPickingFrame: invalid graph');
      }
      if (!encoder) {
        throw new Error('[PickingEngine] renderPickingFrame: encoder required');
      }
      if (!colorTex || !depthTex) {
        throw new Error('[PickingEngine] renderPickingFrame: internal surfaces missing');
      }

      const colorView = colorTex.createView({ label: `${PICKING_LABEL}-rtv` });
      const depthView = depthTex.createView({ label: `${PICKING_LABEL}-dsv` });

      const pass = encoder.beginRenderPass({
        label: `${PICKING_LABEL}-pass`,
        colorAttachments: [
          {
            view: colorView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });

      for (const [_id, p] of graph.passes) {
        if (p === null || p === undefined) {
          continue;
        }
        if (typeof p !== 'object') {
          continue;
        }
        const ext = p as {
          encodePicking?: (
            passEncoder: GPURenderPassEncoder,
            colorAttachment: GPUTextureView,
            depthStencilAttachment: GPUTextureView
          ) => void;
        };
        if (typeof ext.encodePicking === 'function') {
          try {
            ext.encodePicking(pass, colorView, depthView);
          } catch (e) {
            console.error('[PickingEngine] encodePicking failed', e);
          }
        }
      }

      pass.end();
    },

    async pickAt(x: number, y: number): Promise<PickResult | null> {
      if (!colorTex) {
        throw new Error('[PickingEngine] pickAt: color texture missing');
      }
      const { tx, ty } = mapScreenToTexel(x, y);
      await device.queue.onSubmittedWorkDone().catch(() => undefined);

      const buf = await readTextureRegionRaw(device, colorTex, tx, ty, 1, 1, BYTES_RGBA32UINT);
      const id = readColorIdFromRgba32UintPixel(buf);
      return resolveColorId(id);
    },

    async pickInRect(x1: number, y1: number, x2: number, y2: number): Promise<PickResult[]> {
      const xa = Math.min(x1, x2);
      const xb = Math.max(x1, x2);
      const ya = Math.min(y1, y2);
      const yb = Math.max(y1, y2);
      const sx0 = Math.max(0, Math.floor(xa));
      const sy0 = Math.max(0, Math.floor(ya));
      const sx1 = Math.min(pickW - 1, Math.floor(xb));
      const sy1 = Math.min(pickH - 1, Math.floor(yb));
      const rw = sx1 - sx0 + 1;
      const rh = sy1 - sy0 + 1;
      if (rw <= 0 || rh <= 0 || !colorTex) {
        return [];
      }

      const buf = await readTextureRegionRaw(
        device,
        colorTex,
        sx0,
        sy0,
        rw,
        rh,
        BYTES_RGBA32UINT
      );

      const u32 = new Uint32Array(buf.byteLength / 4);
      const out: PickResult[] = [];
      const seen = new Set<number>();

      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          const base = (py * rw + px) * 4;
          const id = u32[base] >>> 0;
          if (id === 0 || seen.has(id)) {
            continue;
          }
          seen.add(id);
          const pr = resolveColorId(id);
          if (pr) {
            out.push(pr);
          }
        }
      }
      return out;
    },

    async raycast(origin: Vec3f, direction: Vec3f, maxDistance: number): Promise<PickResult[]> {
      if (!origin || origin.length < 3 || !direction || direction.length < 3) {
        throw new Error('[PickingEngine] raycast: invalid origin or direction');
      }
      if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
        return [];
      }
      normalize3(direction);
      return [];
    },

    async readDepthAt(x: number, y: number): Promise<number> {
      if (!depthTex || !depthHandle) {
        throw new Error('[PickingEngine] readDepthAt: depth surface missing');
      }
      const { tx, ty } = mapScreenToTexel(x, y);
      await device.queue.onSubmittedWorkDone().catch(() => undefined);

      try {
        const buf = await uploader.readbackTexture(depthHandle, tx, ty, 1, 1);
        const f = new Float32Array(buf, 0, 1);
        const d = f[0];
        if (!Number.isFinite(d)) {
          return 0;
        }
        return d;
      } catch (e) {
        console.error('[PickingEngine] readDepthAt readback failed', e);
        return 0;
      }
    },

    unprojectScreenToWorld(
      screenX: number,
      screenY: number,
      depth: number,
      inverseVPMatrix: Mat4f
    ): Vec3f {
      if (!inverseVPMatrix || inverseVPMatrix.length < 16) {
        throw new Error('[PickingEngine] unprojectScreenToWorld: invalid inverseVPMatrix');
      }
      if (!Number.isFinite(depth)) {
        throw new Error('[PickingEngine] unprojectScreenToWorld: depth must be finite');
      }
      const d = Math.min(1, Math.max(0, depth));
      const ndcX = (2 * screenX) / pickW - 1;
      const ndcY = 1 - (2 * screenY) / pickH;
      const clip = new Float32Array(4);
      const v = new Float32Array([ndcX, ndcY, d, 1]);
      mulMat4Vec4(clip, inverseVPMatrix, v);
      if (Math.abs(clip[3]) < EPSILON) {
        return vec3(clip[0], clip[1], clip[2]);
      }
      return vec3(clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]);
    },

    screenToGeodetic(
      screenX: number,
      screenY: number,
      _vpMatrix: Mat4f,
      inverseVPMatrix: Mat4f
    ): [number, number, number] | null {
      if (!_vpMatrix || _vpMatrix.length < 16 || !inverseVPMatrix || inverseVPMatrix.length < 16) {
        throw new Error('[PickingEngine] screenToGeodetic: invalid matrices');
      }

      const ndcX = (2 * screenX) / pickW - 1;
      const ndcY = 1 - (2 * screenY) / pickH;

      const pNear = new Float32Array(4);
      const pFar = new Float32Array(4);
      mulMat4Vec4(pNear, inverseVPMatrix, new Float32Array([ndcX, ndcY, 0, 1]));
      mulMat4Vec4(pFar, inverseVPMatrix, new Float32Array([ndcX, ndcY, 1, 1]));
      if (Math.abs(pNear[3]) < EPSILON || Math.abs(pFar[3]) < EPSILON) {
        return null;
      }
      const o = vec3(pNear[0] / pNear[3], pNear[1] / pNear[3], pNear[2] / pNear[3]);
      const pF = vec3(pFar[0] / pFar[3], pFar[1] / pFar[3], pFar[2] / pFar[3]);
      const dir = new Float32Array([pF[0] - o[0], pF[1] - o[1], pF[2] - o[2]]);
      const dirN = normalize3(dir);

      if (Math.abs(dirN[2]) > EPSILON) {
        const tPlane = -o[2] / dirN[2];
        if (tPlane > 0) {
          const x = o[0] + dirN[0] * tPlane;
          const y = o[1] + dirN[1] * tPlane;
          const z = o[2] + dirN[2] * tPlane;
          return ecefToLonLatHeight(x, y, z);
        }
      }

      const tS = raySphereNearestT(o, dirN, WGS84_MEAN_RADIUS_M);
      if (tS !== null) {
        const x = o[0] + dirN[0] * tS;
        const y = o[1] + dirN[1] * tS;
        const z = o[2] + dirN[2] * tS;
        return ecefToLonLatHeight(x, y, z);
      }

      return null;
    },

    async pickRegion(x: number, y: number, width: number, height: number): Promise<Uint32Array> {
      if (!colorTex) {
        throw new Error('[PickingEngine] pickRegion: color texture missing');
      }
      if (width <= 0 || height <= 0) {
        throw new Error('[PickingEngine] pickRegion: width/height must be positive');
      }
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const rw = Math.min(pickW - x0, Math.floor(width));
      const rh = Math.min(pickH - y0, Math.floor(height));
      if (rw <= 0 || rh <= 0) {
        return new Uint32Array(0);
      }

      const buf = await readTextureRegionRaw(device, colorTex, x0, y0, rw, rh, BYTES_RGBA32UINT);
      const u32 = new Uint32Array(buf.byteLength / 4);
      const ids = new Uint32Array(rw * rh);
      for (let row = 0; row < rh; row++) {
        for (let col = 0; col < rw; col++) {
          const srcIdx = (row * rw + col) * 4;
          ids[row * rw + col] = u32[srcIdx] >>> 0;
        }
      }
      return ids;
    },

    registerLayer(layerId: string, resolver: (colorId: number) => PickResult | null): void {
      if (!layerId || typeof layerId !== 'string') {
        throw new Error('[PickingEngine] registerLayer: layerId must be a non-empty string');
      }
      if (typeof resolver !== 'function') {
        throw new Error('[PickingEngine] registerLayer: resolver must be a function');
      }
      if (!resolvers.has(layerId)) {
        registrationOrder.push(layerId);
      }
      resolvers.set(layerId, resolver);
    },

    unregisterLayer(layerId: string): void {
      resolvers.delete(layerId);
      const idx = registrationOrder.indexOf(layerId);
      if (idx >= 0) {
        registrationOrder.splice(idx, 1);
      }
    },

    resizePickingTarget(width: number, height: number): void {
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error('[PickingEngine] resizePickingTarget: dimensions must be finite');
      }
      if (width <= 0 || height <= 0) {
        throw new Error('[PickingEngine] resizePickingTarget: dimensions must be positive');
      }
      ensureSurfaces(width, height);
    },
  };

  return engine;
}
