/**
 * useWebGPUMap — WebGPU-based 2.5D tile renderer for GeoForge.
 *
 * Replaces the Canvas 2D path for 2.5D mode with a real GPU pipeline:
 *   - Perspective camera via {@link computeCamera25D} (from useCamera25D)
 *   - Frustum-culled, LOD-aware tiles via {@link coveringTiles}
 *   - Batched vertex upload + per-tile texture bind-group switching
 *   - Distance fog to mask the horizon
 *
 * The hook owns the full lifecycle: adapter → device → pipeline → frame loop → cleanup.
 *
 * @module useWebGPUMap
 * @stability experimental
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';
import {
    computeCamera25D,
    coveringTiles,
    TILE_SIZE,
} from '@/hooks/useCamera25D';
import type { Camera25DState, TileID } from '@/hooks/useCamera25D';
import tileShaderSource from '@/packages/gpu/src/wgsl/tile-25d.wgsl?raw';

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

/**
 * Pitch for 2.5D rendering in radians (35° ≈ 0.6109 rad).
 * Matches the value used by the Canvas 2D 2.5D path in useCanvasMap.
 */
const PITCH_25D_RAD = 35 * Math.PI / 180;

/**
 * Vertical FOV for the 2.5D perspective camera (radians).
 * 0.6435 rad ≈ 36.87° — matches the design document exactly.
 */
const FOV_25D = 0.6435;

/**
 * Camera bearing in radians (north-up, no rotation).
 * 2.5D mode currently uses a fixed north-up orientation.
 */
const BEARING_25D = 0;

/**
 * Camera uniform buffer size in bytes.
 * Layout (WebGPU 16-byte alignment):
 *   offset  0: vpMatrix      mat4x4<f32>  64 bytes
 *   offset 64: cameraPosition vec3<f32>    12 bytes
 *   offset 76: worldSize      f32           4 bytes
 * Total = 80 bytes (multiple of 16 ✅).
 */
const CAMERA_UNIFORM_SIZE = 80;

/**
 * Maximum number of tiles rendered in a single frame.
 * Pre-allocating the vertex buffer for this many tiles avoids
 * per-frame buffer re-creation.
 */
const MAX_TILES_PER_FRAME = 512;

/**
 * Floats per vertex: worldPos(3) + uv(2) = 5.
 * Each vertex occupies 20 bytes (5 × 4).
 */
const FLOATS_PER_VERTEX = 5;

/**
 * Vertices per tile quad (4 corners).
 */
const VERTS_PER_TILE = 4;

/**
 * Shared vertex buffer size in bytes.
 * MAX_TILES_PER_FRAME × 4 verts × 20 bytes = 40 960 bytes.
 */
const VERTEX_BUFFER_SIZE = MAX_TILES_PER_FRAME * VERTS_PER_TILE * FLOATS_PER_VERTEX * 4;

/**
 * Index data for a single quad (two triangles, CCW winding).
 * Shared across all tiles via baseVertex offset in drawIndexed.
 */
const TILE_INDICES = new Uint16Array([0, 1, 2, 1, 3, 2]);

/**
 * OSM raster tile image dimensions (256 × 256 px).
 */
const OSM_TILE_PX = 256;

/**
 * Maximum number of GPU tile textures cached simultaneously.
 * When exceeded the oldest entries are evicted (simple insertion-order).
 */
const MAX_GPU_TILE_CACHE = 1024;

/**
 * Retry cooldown for failed tile loads (milliseconds).
 */
const TILE_RETRY_COOLDOWN_MS = 10_000;

/**
 * Background clear color for the 2.5D viewport (dark blue).
 * Matches the fogColor end-point in the WGSL shader.
 */
const CLEAR_COLOR: GPUColorDict = { r: 0.06, g: 0.08, b: 0.12, a: 1.0 };

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

/** Return value of the {@link useWebGPUMap} hook. */
interface WebGPUMapStatus {
    /** Current lifecycle state: 'unsupported' | 'initializing' | 'ready' | 'error'. */
    status: 'unsupported' | 'initializing' | 'ready' | 'error';
    /** Human-readable error description when `status === 'error'`. */
    error?: string;
}

/** Per-tile GPU resources cached by tile key ("z/x/y"). */
interface GPUTileEntry {
    /** The GPU texture holding the decoded tile image. */
    texture: GPUTexture;
    /** Bind group pairing the shared sampler + this tile's texture. */
    bindGroup: GPUBindGroup;
    /** Insertion timestamp for simple LRU eviction. */
    createdAt: number;
}

/**
 * Immutable GPU resources created once during initialisation.
 * Stored in a ref so the frame loop closure can access them.
 */
interface PipelineResources {
    /** Set to true when device is lost or resources are torn down. */
    disposed: boolean;
    /** WebGPU logical device. */
    device: GPUDevice;
    /** Canvas WebGPU context for obtaining the current swap-chain texture. */
    context: GPUCanvasContext;
    /** Preferred swap-chain texture format (e.g. 'bgra8unorm'). */
    format: GPUTextureFormat;
    /** Compiled render pipeline for tile quads. */
    pipeline: GPURenderPipeline;
    /** Layout for bind-group 0 (camera uniforms). */
    cameraBindGroupLayout: GPUBindGroupLayout;
    /** Layout for bind-group 1 (sampler + tile texture). */
    tileBindGroupLayout: GPUBindGroupLayout;
    /** Camera uniform GPU buffer (80 bytes). */
    cameraUniformBuffer: GPUBuffer;
    /** Pre-bound bind group for the camera uniforms (group 0). */
    cameraBindGroup: GPUBindGroup;
    /** Shared vertex buffer for all tile quads in a frame. */
    vertexBuffer: GPUBuffer;
    /** Shared index buffer (6 indices for one quad). */
    indexBuffer: GPUBuffer;
    /** Linear, clamp-to-edge sampler shared by all tiles. */
    sampler: GPUSampler;
    /** Depth texture for the current canvas size. Recreated on resize. */
    depthTexture: GPUTexture;
    /** Depth texture view (recreated alongside depthTexture). */
    depthView: GPUTextureView;
    /** GPU tile texture cache: key → GPUTileEntry. */
    tileCache: Map<string, GPUTileEntry>;
    /** Tile keys currently being fetched (prevents duplicate requests). */
    loadingTiles: Set<string>;
    /** Failed tile keys → timestamp of last failure. */
    failedTiles: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════
// Tile vertex computation  (§V.4 of design doc)
// ═══════════════════════════════════════════════════════════

/**
 * Compute the 4 world-space vertices for a tile quad.
 *
 * Each vertex contains 5 floats: [worldX, worldY, worldZ=0, u, v].
 * The tile occupies `[x0, y0] → [x1, y1]` on the z = 0 ground plane,
 * where the size is derived from `worldSize / 2^tileZoom`.
 *
 * @param tz        - Tile zoom level.
 * @param tx        - Tile column index (may be outside [0, 2^tz) for world copies).
 * @param ty        - Tile row index.
 * @param worldSize - TILE_SIZE × 2^zoom (camera's floating-point worldSize).
 * @param out       - Pre-allocated Float32Array to write into (20 floats starting at `offset`).
 * @param offset    - Float offset into `out` where writing begins.
 *
 * @example
 * const buf = new Float32Array(20);
 * computeTileVertices(10, 512, 340, 524288, buf, 0);
 */
function computeTileVertices(
    tz: number,
    tx: number,
    ty: number,
    worldSize: number,
    out: Float32Array,
    offset: number,
): void {
    /* Number of tiles at this zoom level */
    const numTiles = 1 << tz;
    /* World-pixel size of one tile (fractional-zoom aware) */
    const tileSize = worldSize / numTiles;

    const x0 = tx * tileSize;
    const y0 = ty * tileSize;
    const x1 = x0 + tileSize;
    const y1 = y0 + tileSize;

    /* Top-left vertex (u=0, v=0) */
    out[offset]      = x0;
    out[offset + 1]  = y0;
    out[offset + 2]  = 0;
    out[offset + 3]  = 0;
    out[offset + 4]  = 0;

    /* Top-right vertex (u=1, v=0) */
    out[offset + 5]  = x1;
    out[offset + 6]  = y0;
    out[offset + 7]  = 0;
    out[offset + 8]  = 1;
    out[offset + 9]  = 0;

    /* Bottom-left vertex (u=0, v=1) */
    out[offset + 10] = x0;
    out[offset + 11] = y1;
    out[offset + 12] = 0;
    out[offset + 13] = 0;
    out[offset + 14] = 1;

    /* Bottom-right vertex (u=1, v=1) */
    out[offset + 15] = x1;
    out[offset + 16] = y1;
    out[offset + 17] = 0;
    out[offset + 18] = 1;
    out[offset + 19] = 1;
}

// ═══════════════════════════════════════════════════════════
// Camera uniform writer  (§V.2 of design doc)
// ═══════════════════════════════════════════════════════════

/**
 * Pack camera state into a 80-byte Float32Array and upload to the GPU.
 *
 * Layout mirrors the WGSL `CameraUniforms` struct:
 *   float[0..15]  vpMatrix       (64 bytes)
 *   float[16..18] cameraPosition (12 bytes)
 *   float[19]     worldSize      ( 4 bytes)
 *
 * @param device - WebGPU device (for queue.writeBuffer).
 * @param buffer - Destination GPU buffer (≥ 80 bytes, usage UNIFORM | COPY_DST).
 * @param camera - Camera state from {@link computeCamera25D}.
 * @param scratch - Pre-allocated Float32Array(20) to avoid per-frame allocation.
 */
function writeCameraUniforms(
    device: GPUDevice,
    buffer: GPUBuffer,
    camera: Camera25DState,
    scratch: Float32Array,
): void {
    /* 16 floats for the VP matrix */
    scratch.set(camera.vpMatrix, 0);
    /* 3 floats for camera position */
    scratch[16] = camera.cameraPosition[0];
    scratch[17] = camera.cameraPosition[1];
    scratch[18] = camera.cameraPosition[2];
    /* 1 float for worldSize */
    scratch[19] = camera.worldSize;

    device.queue.writeBuffer(buffer, 0, scratch.buffer);
}

// ═══════════════════════════════════════════════════════════
// Depth texture factory
// ═══════════════════════════════════════════════════════════

/**
 * Create (or recreate) a depth texture matching the canvas dimensions.
 *
 * Uses `depth24plus` format with standard Z (near = 0, far = 1).
 *
 * @param device - WebGPU device.
 * @param width  - Canvas width in physical pixels (≥ 1).
 * @param height - Canvas height in physical pixels (≥ 1).
 * @returns `{ texture, view }` — caller is responsible for destroying the old texture.
 */
function createDepthTexture(
    device: GPUDevice,
    width: number,
    height: number,
): { texture: GPUTexture; view: GPUTextureView } {
    const texture = device.createTexture({
        size: [width, height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const view = texture.createView();
    return { texture, view };
}

// ═══════════════════════════════════════════════════════════
// GPU tile texture management
// ═══════════════════════════════════════════════════════════

/**
 * Request an OSM tile image and, on load, create a GPU texture + bind group.
 *
 * The function is non-blocking: it starts an `Image` fetch and writes
 * the result into `res.tileCache` when the bitmap is ready.
 * Duplicate requests for the same key are suppressed via `res.loadingTiles`.
 *
 * @param tile          - Tile identifier (z/x/y + key).
 * @param res           - Pipeline resources (device, layouts, caches).
 * @param scheduleFrame - Callback to request a new frame once the texture arrives.
 */
function requestTileLoad(
    tile: TileID,
    res: PipelineResources,
    scheduleFrame: () => void,
): void {
    const { key } = tile;

    /* Already loading or loaded — skip */
    if (res.loadingTiles.has(key) || res.tileCache.has(key)) return;

    /* Check failure cooldown */
    const failTime = res.failedTiles.get(key);
    if (failTime !== undefined && Date.now() - failTime < TILE_RETRY_COOLDOWN_MS) return;

    res.loadingTiles.add(key);
    res.failedTiles.delete(key);

    /* Wrap x into valid [0, 2^z) range for the OSM URL */
    const numTiles = 1 << tile.z;
    const wrappedX = ((tile.x % numTiles) + numTiles) % numTiles;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://tile.openstreetmap.org/${tile.z}/${wrappedX}/${tile.y}.png`;

    img.onload = () => {
        res.loadingTiles.delete(key);

        /* Guard: device may have been lost or hook unmounted while loading */
        if (res.disposed) return;

        /* Convert to ImageBitmap for GPU upload (non-blocking decode) */
        createImageBitmap(img).then((bitmap) => {
            if (res.disposed) return;

            /* Evict oldest entries when the cache is full */
            if (res.tileCache.size >= MAX_GPU_TILE_CACHE) {
                evictOldestTiles(res, Math.max(1, MAX_GPU_TILE_CACHE / 8));
            }

            /* Create GPU texture from the decoded bitmap */
            const texture = res.device.createTexture({
                size: [bitmap.width, bitmap.height],
                format: 'rgba8unorm',
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });

            res.device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture },
                [bitmap.width, bitmap.height],
            );

            /* Create per-tile bind group (group 1: sampler + texture) */
            const bindGroup = res.device.createBindGroup({
                layout: res.tileBindGroupLayout,
                entries: [
                    { binding: 0, resource: res.sampler },
                    { binding: 1, resource: texture.createView() },
                ],
            });

            res.tileCache.set(key, {
                texture,
                bindGroup,
                createdAt: Date.now(),
            });

            /* New texture arrived — request a frame so it appears immediately */
            scheduleFrame();
        }).catch(() => {
            /* bitmap decode failed — record as failure */
            res.failedTiles.set(key, Date.now());
        });
    };

    img.onerror = () => {
        res.loadingTiles.delete(key);
        res.failedTiles.set(key, Date.now());
    };
}

/**
 * Evict the N oldest tile entries from the GPU cache.
 *
 * Destroys the GPUTexture of each evicted entry to free VRAM.
 *
 * @param res   - Pipeline resources containing tileCache.
 * @param count - Number of entries to evict.
 */
function evictOldestTiles(res: PipelineResources, count: number): void {
    /* Build a sorted list by createdAt ascending */
    const entries = [...res.tileCache.entries()];
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);

    const toEvict = Math.min(count, entries.length);
    for (let i = 0; i < toEvict; i++) {
        const [evictKey, entry] = entries[i];
        entry.texture.destroy();
        res.tileCache.delete(evictKey);
    }
}

/**
 * Look up a loaded parent tile for placeholder rendering when the exact
 * tile texture hasn't arrived yet.
 *
 * Walks up to 5 zoom levels toward the root, returning the first ancestor
 * that has a cached GPU texture.
 *
 * @param tile  - The requested tile.
 * @param cache - GPU tile cache map.
 * @returns The matching GPUTileEntry, or `null` if no ancestor is cached.
 */
function getPlaceholderEntry(
    tile: TileID,
    cache: Map<string, GPUTileEntry>,
): GPUTileEntry | null {
    for (let dz = 1; dz <= tile.z && dz <= 5; dz++) {
        const parentZ = tile.z - dz;
        const parentX = tile.x >> dz;
        const parentY = tile.y >> dz;
        const parentKey = `${parentZ}/${parentX}/${parentY}`;
        const entry = cache.get(parentKey);
        if (entry) return entry;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════
// Pipeline factory  (§V.1 of design doc)
// ═══════════════════════════════════════════════════════════

/**
 * One-time creation of the tile render pipeline + bind group layouts.
 *
 * The pipeline accepts:
 *   - Vertex buffer: float32x3 (worldPos) + float32x2 (uv), stride 20 bytes
 *   - Bind group 0: camera uniform buffer
 *   - Bind group 1: sampler + texture_2d<f32>
 *   - Depth: depth24plus, write enabled, less-equal compare (standard Z)
 *   - Primitive: triangle-list, no culling (ground tiles are single-sided but
 *     at extreme pitch the backface may peek through, so we leave it off)
 *
 * @param device - WebGPU logical device.
 * @param format - Preferred swap-chain texture format.
 * @returns Pipeline and both bind group layouts.
 */
function createTilePipeline(
    device: GPUDevice,
    format: GPUTextureFormat,
): {
    pipeline: GPURenderPipeline;
    cameraBindGroupLayout: GPUBindGroupLayout;
    tileBindGroupLayout: GPUBindGroupLayout;
} {
    const shaderModule = device.createShaderModule({
        label: 'tile-25d shader',
        code: tileShaderSource,
    });

    /* Bind group 0: camera uniforms (vertex + fragment) */
    const cameraBindGroupLayout = device.createBindGroupLayout({
        label: 'camera bind group layout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        }],
    });

    /* Bind group 1: tile sampler + texture (fragment only) */
    const tileBindGroupLayout = device.createBindGroupLayout({
        label: 'tile bind group layout',
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' },
            },
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        label: 'tile-25d pipeline layout',
        bindGroupLayouts: [cameraBindGroupLayout, tileBindGroupLayout],
    });

    const pipeline = device.createRenderPipeline({
        label: 'tile-25d render pipeline',
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [{
                arrayStride: FLOATS_PER_VERTEX * 4,
                attributes: [
                    {
                        shaderLocation: 0,
                        offset: 0,
                        format: 'float32x3',
                    },
                    {
                        shaderLocation: 1,
                        offset: 12,
                        format: 'float32x2',
                    },
                ],
            }],
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{ format }],
        },
        depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less-equal',
        },
        primitive: {
            topology: 'triangle-list',
            cullMode: 'none',
        },
    });

    return { pipeline, cameraBindGroupLayout, tileBindGroupLayout };
}

// ═══════════════════════════════════════════════════════════
// Full GPU initialisation
// ═══════════════════════════════════════════════════════════

/**
 * Perform the complete WebGPU bootstrap sequence:
 *   adapter → device → context.configure → pipeline → buffers → sampler → depth.
 *
 * @param canvas    - The `<canvas>` element to render into.
 * @param width     - Initial physical pixel width.
 * @param height    - Initial physical pixel height.
 * @returns PipelineResources on success, or a string error message on failure.
 */
async function initWebGPU(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
): Promise<PipelineResources | string> {
    /* ── 1. Adapter ── */
    if (!navigator.gpu) {
        return 'WebGPU is not supported by this browser.';
    }

    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
    });
    if (!adapter) {
        return 'No suitable WebGPU adapter found.';
    }

    /* ── 2. Device ── */
    let device: GPUDevice;
    try {
        device = await adapter.requestDevice();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to create GPUDevice: ${msg}`;
    }

    /* ── 3. Canvas context ── */
    const context = canvas.getContext('webgpu');
    if (!context) {
        return 'Failed to obtain WebGPU canvas context.';
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
    });

    /* ── 4. Pipeline ── */
    const { pipeline, cameraBindGroupLayout, tileBindGroupLayout } =
        createTilePipeline(device, format);

    /* ── 5. Camera uniform buffer ── */
    const cameraUniformBuffer = device.createBuffer({
        label: 'camera uniforms',
        size: CAMERA_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    /* Pre-build the camera bind group (buffer reference never changes) */
    const cameraBindGroup = device.createBindGroup({
        label: 'camera bind group',
        layout: cameraBindGroupLayout,
        entries: [{
            binding: 0,
            resource: { buffer: cameraUniformBuffer },
        }],
    });

    /* ── 6. Shared vertex buffer ── */
    const vertexBuffer = device.createBuffer({
        label: 'tile vertex buffer',
        size: VERTEX_BUFFER_SIZE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    /* ── 7. Shared index buffer ── */
    const indexBuffer = device.createBuffer({
        label: 'tile index buffer',
        size: TILE_INDICES.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint16Array(indexBuffer.getMappedRange()).set(TILE_INDICES);
    indexBuffer.unmap();

    /* ── 8. Sampler ── */
    const sampler = device.createSampler({
        label: 'tile sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
    });

    /* ── 9. Depth texture ── */
    const { texture: depthTexture, view: depthView } =
        createDepthTexture(device, Math.max(1, width), Math.max(1, height));

    return {
        disposed: false,
        device,
        context,
        format,
        pipeline,
        cameraBindGroupLayout,
        tileBindGroupLayout,
        cameraUniformBuffer,
        cameraBindGroup,
        vertexBuffer,
        indexBuffer,
        sampler,
        depthTexture,
        depthView,
        tileCache: new Map(),
        loadingTiles: new Set(),
        failedTiles: new Map(),
    };
}

// ═══════════════════════════════════════════════════════════
// Cleanup helper
// ═══════════════════════════════════════════════════════════

/**
 * Destroy every GPU resource owned by the pipeline.
 *
 * Safe to call even if some resources are already destroyed.
 *
 * @param res - The pipeline resources to tear down.
 */
function destroyResources(res: PipelineResources): void {
    /* Destroy all cached tile textures */
    for (const entry of res.tileCache.values()) {
        entry.texture.destroy();
    }
    res.tileCache.clear();
    res.loadingTiles.clear();
    res.failedTiles.clear();

    /* Destroy GPU objects in reverse creation order */
    res.depthTexture.destroy();
    res.indexBuffer.destroy();
    res.vertexBuffer.destroy();
    res.cameraUniformBuffer.destroy();

    /* Unconfigure the context so the canvas can be reused */
    res.context.unconfigure();

    /* Destroy the device last (invalidates everything) */
    res.device.destroy();
}

// ═══════════════════════════════════════════════════════════
// React Hook
// ═══════════════════════════════════════════════════════════

/**
 * Manages the full WebGPU 2.5D tile rendering pipeline as a React hook.
 *
 * When `active` transitions to `true`:
 *   1. Bootstraps WebGPU (adapter → device → pipeline → buffers)
 *   2. Starts a `requestAnimationFrame` loop that reads mapStore state,
 *      computes the perspective camera, determines visible tiles, uploads
 *      vertex data in one batch, and draws each tile with its texture.
 *   3. Handles container resize (depth texture + context reconfigure).
 *
 * When `active` transitions to `false` or the component unmounts:
 *   All GPU resources are destroyed and the frame loop is cancelled.
 *
 * @param canvasRef    - Ref to the dedicated WebGPU `<canvas>` element.
 * @param containerRef - Ref to the container `<div>` (for ResizeObserver).
 * @param active       - `true` only when the view mode is '2.5d'.
 * @returns `{ status, error? }` reflecting the current lifecycle state.
 *
 * @stability experimental
 *
 * @example
 * const webgpuStatus = useWebGPUMap(webgpuCanvasRef, containerRef, mode === '2.5d');
 * if (webgpuStatus.status === 'error') console.warn(webgpuStatus.error);
 */
export function useWebGPUMap(
    canvasRef: RefObject<HTMLCanvasElement | null>,
    containerRef: RefObject<HTMLDivElement | null>,
    active: boolean,
): WebGPUMapStatus {
    const [status, setStatus] = useState<WebGPUMapStatus>({ status: 'unsupported' });

    /* Mutable refs survive across renders without triggering re-render */
    const resRef = useRef<PipelineResources | null>(null);
    const rafIdRef = useRef(0);
    const fpsCounterRef = useRef({ frames: 0, lastTime: performance.now() });

    /**
     * Pre-allocated scratch buffers reused every frame to avoid GC pressure:
     *   - uniformScratch: 20 floats (80 bytes) for camera uniforms
     *   - vertexScratch:  MAX_TILES × 4 verts × 5 floats for tile vertices
     */
    const uniformScratchRef = useRef(new Float32Array(CAMERA_UNIFORM_SIZE / 4));
    const vertexScratchRef = useRef(new Float32Array(MAX_TILES_PER_FRAME * VERTS_PER_TILE * FLOATS_PER_VERTEX));

    useEffect(() => {
        /* ── Guard: not active or DOM not ready ── */
        if (!active) {
            /* If we were previously initialised, tear down */
            if (resRef.current) {
                cancelAnimationFrame(rafIdRef.current);
                destroyResources(resRef.current);
                resRef.current = null;
            }
            return;
        }

        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        /* ── Quick WebGPU feature detection ── */
        if (!navigator.gpu) {
            setStatus({ status: 'unsupported', error: 'WebGPU not available' });
            return;
        }

        setStatus({ status: 'initializing' });

        /* ── Abort flag: if the effect re-fires before init finishes ── */
        let aborted = false;

        /* ── Size the canvas to the container ── */
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const physW = Math.max(1, Math.round(rect.width * dpr));
        const physH = Math.max(1, Math.round(rect.height * dpr));
        canvas.width = physW;
        canvas.height = physH;

        // ────────────────────────────────────────────────
        // Async initialisation
        // ────────────────────────────────────────────────
        initWebGPU(canvas, physW, physH).then((result) => {
            if (aborted) {
                /* Hook was cleaned up while we were awaiting — destroy immediately */
                if (typeof result !== 'string') destroyResources(result);
                return;
            }

            if (typeof result === 'string') {
                /* Initialisation failed with an error message */
                setStatus({ status: 'error', error: result });
                return;
            }

            const res = result;
            resRef.current = res;
            setStatus({ status: 'ready' });

            /* ── Subscribe to store changes → schedule frame ── */
            const unsub = useMapStore.subscribe(scheduleFrame);

            // ────────────────────────────────────────────
            // Render loop
            // ────────────────────────────────────────────

            /**
             * Request a new animation frame (debounced: cancels any pending one).
             */
            function scheduleFrame(): void {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = requestAnimationFrame(renderFrame);
            }

            /**
             * Core per-frame rendering function.
             *
             * 1. Read mapStore state
             * 2. Compute perspective camera
             * 3. Determine visible tiles
             * 4. Upload camera uniforms
             * 5. Batch-write tile vertices
             * 6. Begin render pass, draw each tile
             * 7. Submit command buffer
             */
            function renderFrame(): void {
                if (!resRef.current || resRef.current.disposed) return;
                const r = resRef.current;

                /* Re-request the next frame immediately (continuous loop) */
                rafIdRef.current = requestAnimationFrame(renderFrame);

                /* ── 1. Map state snapshot ── */
                const { center, zoom, bearing } = useMapStore.getState();
                const c = canvasRef.current;
                if (!c) return;
                const viewport = { width: c.width, height: c.height };

                /* ── 2. Camera ── */
                const camera: Camera25DState = computeCamera25D(
                    center,
                    zoom,
                    PITCH_25D_RAD,
                    bearing || BEARING_25D,
                    FOV_25D,
                    viewport,
                );

                /* ── 3. Covering tiles ── */
                const tiles = coveringTiles(camera);

                /* Clamp to MAX_TILES to stay within the vertex buffer capacity */
                const drawCount = Math.min(tiles.length, MAX_TILES_PER_FRAME);

                /* Report tile count to the status bar */
                useStatusStore.getState().setTiles(drawCount);

                /* ── 4. Camera uniforms ── */
                writeCameraUniforms(
                    r.device,
                    r.cameraUniformBuffer,
                    camera,
                    uniformScratchRef.current,
                );

                /* ── 5. Batch tile vertices ── */
                const vtx = vertexScratchRef.current;
                for (let i = 0; i < drawCount; i++) {
                    const t = tiles[i];
                    computeTileVertices(
                        t.z, t.x, t.y,
                        camera.worldSize,
                        vtx,
                        i * VERTS_PER_TILE * FLOATS_PER_VERTEX,
                    );
                }
                /* Write only the used portion to the GPU */
                const usedBytes = drawCount * VERTS_PER_TILE * FLOATS_PER_VERTEX * 4;
                if (usedBytes > 0) {
                    r.device.queue.writeBuffer(
                        r.vertexBuffer,
                        0,
                        vtx.buffer,
                        vtx.byteOffset,
                        usedBytes,
                    );
                }

                /* ── 6. Render pass ── */
                let colorView: GPUTextureView;
                try {
                    colorView = r.context.getCurrentTexture().createView();
                } catch {
                    /* Context lost or canvas not visible — skip this frame */
                    return;
                }

                const encoder = r.device.createCommandEncoder({
                    label: 'tile-25d frame',
                });

                const pass = encoder.beginRenderPass({
                    colorAttachments: [{
                        view: colorView,
                        clearValue: CLEAR_COLOR,
                        loadOp: 'clear',
                        storeOp: 'store',
                    }],
                    depthStencilAttachment: {
                        view: r.depthView,
                        depthClearValue: 1.0,
                        depthLoadOp: 'clear',
                        depthStoreOp: 'store',
                    },
                });

                pass.setPipeline(r.pipeline);
                pass.setBindGroup(0, r.cameraBindGroup);
                pass.setVertexBuffer(0, r.vertexBuffer);
                pass.setIndexBuffer(r.indexBuffer, 'uint16');

                /* ── 7. Draw each tile ── */
                for (let i = 0; i < drawCount; i++) {
                    const tile = tiles[i];

                    /* Look up cached GPU texture, or request loading */
                    let entry = r.tileCache.get(tile.key) ?? null;

                    if (!entry) {
                        /* Trigger async load for the exact tile */
                        requestTileLoad(tile, r, scheduleFrame);

                        /* Try a parent tile as placeholder */
                        entry = getPlaceholderEntry(tile, r.tileCache);
                    }

                    /* Skip tiles without any available texture */
                    if (!entry) continue;

                    pass.setBindGroup(1, entry.bindGroup);
                    /*
                     * drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
                     * baseVertex offsets into the shared vertex buffer so each tile
                     * reads its own 4 vertices while using the same 6-index pattern.
                     */
                    pass.drawIndexed(6, 1, 0, i * VERTS_PER_TILE, 0);
                }

                pass.end();
                r.device.queue.submit([encoder.finish()]);

                /* ── 8. FPS tracking ── */
                fpsCounterRef.current.frames++;
                const now = performance.now();
                if (now - fpsCounterRef.current.lastTime >= 1000) {
                    useStatusStore.getState().setFps(fpsCounterRef.current.frames);
                    fpsCounterRef.current.frames = 0;
                    fpsCounterRef.current.lastTime = now;
                }
            }

            // ────────────────────────────────────────────
            // Resize handling
            // ────────────────────────────────────────────

            const resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    if (entry.target !== container) continue;

                    const cr = entry.contentRect;
                    if (cr.width === 0 || cr.height === 0) continue;

                    const d = window.devicePixelRatio || 1;
                    const newW = Math.max(1, Math.round(cr.width * d));
                    const newH = Math.max(1, Math.round(cr.height * d));

                    /* Skip if dimensions haven't actually changed */
                    const cv = canvasRef.current;
                    if (!cv) continue;
                    if (cv.width === newW && cv.height === newH) continue;

                    cv.width = newW;
                    cv.height = newH;

                    const r = resRef.current;
                    if (!r || r.disposed) continue;

                    /* Destroy old depth texture and create a new one */
                    r.depthTexture.destroy();
                    const { texture, view } = createDepthTexture(r.device, newW, newH);
                    r.depthTexture = texture;
                    r.depthView = view;

                    scheduleFrame();
                }
            });

            resizeObserver.observe(container);

            /* Kick off the first frame */
            scheduleFrame();

            // ────────────────────────────────────────────
            // Device lost handler
            // ────────────────────────────────────────────

            res.device.lost.then((info) => {
                if (__DEV__) {
                    console.warn('[useWebGPUMap] GPU device lost:', info.message);
                }
                setStatus({
                    status: 'error',
                    error: `GPU device lost: ${info.message}`,
                });
            });

            // ────────────────────────────────────────────
            // Store cleanup callback in effect's local scope
            // ────────────────────────────────────────────

            /* eslint-disable-next-line @typescript-eslint/no-use-before-define */
            cleanupRef.current = () => {
                cancelAnimationFrame(rafIdRef.current);
                unsub();
                resizeObserver.disconnect();
                if (resRef.current) {
                    destroyResources(resRef.current);
                    resRef.current = null;
                }
            };
        });

        /* Local cleanup ref — assigned inside the async `.then()` block above */
        const cleanupRef = { current: null as (() => void) | null };

        return () => {
            aborted = true;
            if (cleanupRef.current) {
                cleanupRef.current();
            } else if (resRef.current) {
                /* Init finished synchronously between effect body and cleanup */
                cancelAnimationFrame(rafIdRef.current);
                destroyResources(resRef.current);
                resRef.current = null;
            }
        };
    }, [active, canvasRef, containerRef]);

    return status;
}

declare const __DEV__: boolean;
