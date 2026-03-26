/**
 * @module preset-3d/globe-tiles
 * @description
 * 影像瓦片 **异步加载**（`fetch` → `ImageBitmap` → `GPUTexture`）、**LRU 淘汰**、以及 **曲面网格缓存**（`tessellateGlobeTile` + 索引缓冲）。
 * 不负责调度可见集（由 `coveringTilesGlobe` 在 `globe-3d` 侧调用）。
 *
 * @stability experimental
 */

import {
    getSegments,
    tessellateGlobeTile,
} from '../../globe/src/globe-tile-mesh.ts';
import { MAX_TILE_CACHE_SIZE } from './globe-constants.ts';
import type { CachedMesh, CachedTile, GlobeGPURefs, TileManagerState } from './globe-types.ts';
import { devWarn } from './globe-utils.ts';

/**
 * 为键 `z/x/y` 发起异步影像加载；若不存在缓存项则先插入占位 `CachedTile`。
 *
 * @param key - 与调度器一致的 `"z/x/y"`
 * @param z,x,y - 瓦片坐标
 * @param device - 创建纹理与 bind group
 * @param refs - 需含 `tileBindGroupLayout`、`sampler`
 * @param tileState - 写入 `tileCache` / `tileLRU` 并可能触发 {@link evictTileCache}
 * @param isDestroyed - 完成回调中若 `true` 则关闭 bitmap 并放弃写入
 */
export function loadTileTexture(
    key: string,
    z: number,
    x: number,
    y: number,
    device: GPUDevice,
    refs: GlobeGPURefs,
    tileState: TileManagerState,
    isDestroyed: () => boolean,
): void {
    if (tileState.tileCache.has(key)) { return; }

    tileState.tileCache.set(key, {
        texture: null,
        bindGroup: null,
        loading: true,
        textureReady: false,
        demReady: false,
        demData: null,
    });
    tileState.tileLRU.push(key);

    evictTileCache(tileState);

    const url = tileState.tileUrlTemplate
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));

    fetchTileImage(url)
        .then((bitmap) => {
            if (isDestroyed() || !tileState.tileCache.has(key)) {
                bitmap.close();
                return;
            }

            const texture = device.createTexture({
                size: { width: bitmap.width, height: bitmap.height },
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING
                    | GPUTextureUsage.COPY_DST
                    | GPUTextureUsage.RENDER_ATTACHMENT,
                label: `Globe3D:tileTex:${key}`,
            });

            device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture },
                { width: bitmap.width, height: bitmap.height },
            );

            bitmap.close();

            const bindGroup = device.createBindGroup({
                layout: refs.tileBindGroupLayout!,
                entries: [
                    { binding: 0, resource: refs.sampler! },
                    { binding: 1, resource: texture.createView() },
                ],
                label: `Globe3D:tileBG:${key}`,
            });

            const cached = tileState.tileCache.get(key);
            if (cached) {
                cached.texture = texture;
                cached.bindGroup = bindGroup;
                cached.loading = false;
                cached.textureReady = true;
            }
        })
        .catch((err) => {
            devWarn(`[Globe3D] Failed to load tile ${key}:`, err);
            tileState.tileCache.delete(key);
            const idx = tileState.tileLRU.indexOf(key);
            if (idx >= 0) { tileState.tileLRU.splice(idx, 1); }
        });
}

/**
 * CORS 拉取瓦片并解码为 `ImageBitmap`；非图片 Content-Type 与空 body 会抛错。
 *
 * @param url - 完整 HTTP(S) URL
 * @throws Error 网络非 2xx、MIME 非图片、或 body 为空
 */
export async function fetchTileImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        headers: {
            'Accept': 'image/png,image/jpeg,image/webp,image/*,*/*;q=0.8',
        },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType && !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
        throw new Error(`Non-image Content-Type "${contentType}" for ${url}`);
    }

    const blob = await response.blob();

    if (blob.size === 0) {
        throw new Error(`Empty response body for ${url}`);
    }

    return createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
    });
}

/**
 * 按 `z/x/y` 键缓存 `GlobeTileMesh` 与对应 `indexBuffer`（GPU 常驻）。
 *
 * @param meshCache - `Globe3D` 的 `_tileState.meshCache`
 * @returns 新建或已存在的 {@link CachedMesh}
 */
export function getOrCreateTileMesh(
    device: GPUDevice,
    z: number,
    x: number,
    y: number,
    meshCache: Map<string, CachedMesh>,
): CachedMesh | null {
    const key = `${z}/${x}/${y}`;

    const existing = meshCache.get(key);
    if (existing) { return existing; }

    const segments = getSegments(z);
    const mesh = tessellateGlobeTile(z, x, y, segments);

    const indexBuffer = device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `Globe3D:indexBuf:${key}`,
    });
    device.queue.writeBuffer(indexBuffer, 0, mesh.indices.buffer as ArrayBuffer, mesh.indices.byteOffset, mesh.indices.byteLength);

    const entry: CachedMesh = { mesh, indexBuffer };
    meshCache.set(key, entry);

    return entry;
}

/**
 * 将 `key` 移到 `tileLRU` 末尾，表示最近使用。
 *
 * @param tileState - 含 `tileLRU`
 * @param key - 瓦片键
 */
export function touchTileLRU(tileState: TileManagerState, key: string): void {
    const idx = tileState.tileLRU.indexOf(key);
    if (idx >= 0) {
        tileState.tileLRU.splice(idx, 1);
        tileState.tileLRU.push(key);
    }
}

/**
 * 当 `tileLRU.length > MAX_TILE_CACHE_SIZE` 时从头部弹出并 `destroy` 纹理。
 *
 * @param tileState - 可变状态
 */
export function evictTileCache(tileState: TileManagerState): void {
    while (tileState.tileLRU.length > MAX_TILE_CACHE_SIZE) {
        const oldKey = tileState.tileLRU.shift()!;
        const cached = tileState.tileCache.get(oldKey);

        if (cached) {
            if (cached.texture) {
                cached.texture.destroy();
            }
            tileState.tileCache.delete(oldKey);
        }
    }
}

/**
 * 销毁所有瓦片纹理并清空 `tileCache` / `tileLRU`（切换影像图层时调用）。
 *
 * @param tileState - 目标状态
 */
export function clearTileCache(tileState: TileManagerState): void {
    for (const cached of tileState.tileCache.values()) {
        if (cached.texture) {
            cached.texture.destroy();
        }
    }
    tileState.tileCache.clear();
    tileState.tileLRU.length = 0;
}

/**
 * 销毁 `meshCache` 中全部索引缓冲并 `clear` Map（Globe 销毁流程的一部分）。
 *
 * @param meshCache - `z/x/y` → {@link CachedMesh}
 */
export function clearMeshCache(meshCache: Map<string, CachedMesh>): void {
    for (const entry of meshCache.values()) {
        entry.indexBuffer.destroy();
    }
    meshCache.clear();
}
