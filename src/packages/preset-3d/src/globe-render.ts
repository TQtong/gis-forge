/**
 * @module preset-3d/globe-render
 * @description
 * 单帧 **主渲染通道**内的子步骤：天穹 → 地球瓦片（多 draw）→ 大气。
 * 不负责 `beginRenderPass` / `endPass` 之外的全局状态；由 {@link import('./globe-3d.ts').Globe3D} `_renderFrame` 编排。
 *
 * @stability experimental
 */

import type { GlobeTileID, GlobeCamera } from '../../globe/src/globe-tile-mesh.ts';
import {
    meshToRTE,
    meshToRTEInto,
    getSegments,
    tileChordSag,
} from '../../globe/src/globe-tile-mesh.ts';
import { _skyUniformData, _tileParamsData } from './globe-buffers.ts';
import type { GlobeGPURefs, TileManagerState } from './globe-types.ts';
import { getOrCreateTileMesh, touchTileLRU, loadTileTexture, flushPendingDestroys } from './globe-tiles.ts';

export { flushPendingDestroys };

/**
 * 沿 z/x/y 向上回溯，找到第一个 textureReady 的祖先瓦片。
 * 用于子瓦片纹理还未加载时的"父级回退渲染"——避免出现一闪而过的白瓦片。
 *
 * @param tileState - 当前瓦片缓存
 * @param z - 子瓦片 zoom
 * @param x - 子瓦片列号
 * @param y - 子瓦片行号
 * @returns `{ ancestorZ, ancestorX, ancestorY, cached }` 或 null（无可用祖先）
 */
function _findReadyAncestor(
    tileState: TileManagerState,
    z: number, x: number, y: number,
): { ancestorZ: number; ancestorX: number; ancestorY: number; cached: ReturnType<TileManagerState['tileCache']['get']> } | null {
    // ⚠ 早退：tileCache 为空 → 不可能找到任何祖先 → 不要浪费 string 拼接
    // 这是 imagery 关闭时的常态，避免每帧 ~60 tiles × ~10 levels = ~600 string allocs。
    if (tileState.tileCache.size === 0) return null;

    let cz = z;
    let cx = x;
    let cy = y;
    while (cz > 0) {
        cz -= 1;
        cx >>= 1;
        cy >>= 1;
        const cached = tileState.tileCache.get(`${cz}/${cx}/${cy}`);
        if (cached && cached.textureReady && cached.bindGroup && cached.texture) {
            return { ancestorZ: cz, ancestorX: cx, ancestorY: cy, cached };
        }
    }
    return null;
}

/**
 * 给定子瓦片 (z, x, y) 与就绪的祖先瓦片 (az, ax, ay)，
 * 计算出在祖先 UV 空间中应当采样的子矩形 [u0, v0, du, dv]，写入 _tileParamsData。
 *
 * 几何：每下沉一级，UV 区域减半。子瓦片 (x, y) 在 z 级中的归一化 UV 起点：
 *   u0 = (x - (ax << dz)) / 2^dz
 *   v0 = (y - (ay << dz)) / 2^dz
 *   du = dv = 1 / 2^dz
 *
 * 其中 dz = z - az。
 */
function _writeAncestorUV(
    z: number, x: number, y: number,
    az: number, ax: number, ay: number,
    out: Float32Array,
): void {
    const dz = z - az;
    const inv = 1 / (1 << dz);
    const u0 = (x - (ax << dz)) * inv;
    const v0 = (y - (ay << dz)) * inv;
    out[0] = u0;
    out[1] = v0;
    out[2] = inv;
    out[3] = inv;
}

/**
 * 给定本帧实际渲染的瓦片集合，返回相机应使用的最小安全高度（米）。
 *
 * ⚠ **关键设计**：取**最精细 LOD**（z 最大）的弦割下沉量，不是最粗的。
 *
 * 几何理由：相机能不能往下走，受限于"它正下方那个 mesh 多边形面"——
 * 而正下方的瓦片永远是 z 最高的（距离相机最近 → SSE 最大 → 最深细分）。
 * 远处地平线那些 z=0/1/2 大瓦片的 sag 虽然大，但它们离相机远，不会刺穿
 * 相机所在位置的局部 mesh 面。
 *
 * 之前的 bug：取最粗 z=0 的 sag(~7.6km)，导致只要视野里有任何远处的
 * z=0 瓦片，整个相机就被卡在 11km 高度，没法贴近地面。
 *
 * 正确：取最精细 z=N 的 sag——
 *   - 高空（视野全是 z=0~3）：minSafeAlt ≈ 几百米，相机可以慢慢往下
 *   - 低空（正下方瓦片 z=15~22）：minSafeAlt ≈ 微米级，可以贴地 0.1m
 *
 * @param tiles - 本帧 coveringTilesGlobe 的输出
 * @returns 最小安全高度（米）；空数组返回 0
 */
export function computeMinSafeAltitudeFromTiles(tiles: GlobeTileID[]): number {
    if (tiles.length === 0) return 0;
    let finestZ = -1;
    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i].z > finestZ) finestZ = tiles[i].z;
    }
    if (finestZ < 0) return 0;
    const segments = getSegments(finestZ);
    const sag = tileChordSag(finestZ, segments);
    return sag * 1.5;
}

/** 每帧复用，避免每瓦片 `new Float32Array`；按需扩容以覆盖最大细分顶点数 */
let _rteScratch = new Float32Array(4096 * 8);

/**
 * 绘制全屏天穹：上传 `inverseVP_RTE` 与海拔，每帧新建 sky bind group（layout 来自 pipeline）。
 *
 * @param device - GPU 设备
 * @param pass - 已开始的主 color+depth pass
 * @param gc - 含 `inverseVP_RTE`、`altitude`
 * @param refs - 需含 `skyPipeline`、`skyUniformBuffer`
 */
export function renderSkyDome(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
): void {
    if (!refs.skyPipeline || !refs.skyUniformBuffer) { return; }

    _skyUniformData.set(gc.inverseVP_RTE, 0);
    _skyUniformData[16] = gc.altitude;
    _skyUniformData[17] = 0;
    _skyUniformData[18] = 0;
    _skyUniformData[19] = 0;

    device.queue.writeBuffer(refs.skyUniformBuffer, 0, _skyUniformData);

    const skyBG = device.createBindGroup({
        layout: refs.skyPipeline.getBindGroupLayout(0),
        entries: [{
            binding: 0,
            resource: { buffer: refs.skyUniformBuffer },
        }],
        label: 'Globe3D:skyBG',
    });

    pass.setPipeline(refs.skyPipeline);
    pass.setBindGroup(0, skyBG);
    pass.draw(3);
}

/**
 * 遍历可见瓦片：触发异步加载、绑定纹理/RTE 顶点、indexed draw。
 *
 * @param device - GPU 设备
 * @param pass - 主 pass
 * @param gc - 当前帧 Globe 相机（RTE 减相机 ECEF）
 * @param tiles - `coveringTilesGlobe` 输出
 * @param refs - globe pipeline 与 bind group
 * @param tileState - 纹理 LRU 与网格缓存
 * @param isDestroyed - 若实例已销毁则中止异步纹理回调
 * @returns 统计本遍绘制的瓦片数与 draw call 增量
 *
 * @remarks
 * 顶点缓冲来自 {@link CachedMesh.vertexBuffer}，每帧仅 `writeBuffer` 更新 RTE。
 */
export function renderGlobeTiles(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    tiles: GlobeTileID[],
    refs: GlobeGPURefs,
    tileState: TileManagerState,
    isDestroyed: () => boolean,
): { tilesRendered: number; drawCalls: number } {
    if (!refs.globePipeline || !refs.cameraBindGroup || !refs.tileParamsBindGroup) {
        return { tilesRendered: 0, drawCalls: 0 };
    }

    pass.setPipeline(refs.globePipeline);
    pass.setBindGroup(0, refs.cameraBindGroup);
    pass.setBindGroup(2, refs.tileParamsBindGroup);

    let tilesRendered = 0;
    let drawCalls = 0;

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const strKey = `${tile.z}/${tile.x}/${tile.y}`;

        let cached = tileState.tileCache.get(strKey);
        // imageryEnabled=false 时整个分支跳过——零网络/零 CPU
        if (tileState.imageryEnabled && (!cached || (cached.loadError && !cached.textureReady))) {
            loadTileTexture(strKey, tile.z, tile.x, tile.y, device, refs, tileState, isDestroyed);
            cached = tileState.tileCache.get(strKey);
        }

        const tileHasTexture = cached !== undefined
            && cached.textureReady
            && cached.texture !== null
            && cached.bindGroup !== null;

        // ─── Phase C-3: 父级回退 ───
        // 子瓦片的纹理还未就绪 → 沿 quadtree 向上找到第一个就绪的祖先，
        // 用其纹理 + 计算出的 UV 子矩形渲染。这避免了"白瓦片闪烁"，
        // 给了用户一个低分辨率但视觉连续的画面，等待 LOD 完成。
        let tileBG: GPUBindGroup | null;
        let uvOffsetU = 0, uvOffsetV = 0, uvScaleU = 1, uvScaleV = 1;

        if (tileHasTexture) {
            tileBG = cached!.bindGroup!;
            touchTileLRU(tileState, strKey);
        } else {
            const ancestor = _findReadyAncestor(tileState, tile.z, tile.x, tile.y);
            if (ancestor) {
                tileBG = ancestor.cached!.bindGroup!;
                _writeAncestorUV(
                    tile.z, tile.x, tile.y,
                    ancestor.ancestorZ, ancestor.ancestorX, ancestor.ancestorY,
                    _tileParamsData,
                );
                uvOffsetU = _tileParamsData[0];
                uvOffsetV = _tileParamsData[1];
                uvScaleU = _tileParamsData[2];
                uvScaleV = _tileParamsData[3];
                // touch 祖先以延后它的 LRU 淘汰
                touchTileLRU(tileState, `${ancestor.ancestorZ}/${ancestor.ancestorX}/${ancestor.ancestorY}`);
            } else {
                tileBG = refs.fallbackBindGroup;
            }
        }
        if (!tileBG) { continue; }

        const meshData = getOrCreateTileMesh(
            device,
            tile.z, tile.x, tile.y,
            tileState.meshCache,
            tileState.pendingDestroyBuffers,
        );
        if (!meshData) { continue; }

        const vCount = meshData.mesh.vertexCount;
        const rteFloats = vCount * 8;
        if (_rteScratch.length < rteFloats) {
            _rteScratch = new Float32Array(rteFloats);
        }
        meshToRTEInto(_rteScratch, meshData.mesh, gc.cameraECEF);
        const rteBytes = rteFloats * 4;
        device.queue.writeBuffer(
            meshData.vertexBuffer,
            0,
            _rteScratch.buffer as ArrayBuffer,
            _rteScratch.byteOffset,
            rteBytes,
        );

        _tileParamsData[0] = uvOffsetU;
        _tileParamsData[1] = uvOffsetV;
        _tileParamsData[2] = uvScaleU;
        _tileParamsData[3] = uvScaleV;
        device.queue.writeBuffer(refs.tileParamsBuffer!, 0, _tileParamsData);

        pass.setBindGroup(1, tileBG);

        pass.setVertexBuffer(0, meshData.vertexBuffer);
        pass.setIndexBuffer(meshData.indexBuffer, 'uint32');
        pass.drawIndexed(meshData.mesh.indexCount);

        tilesRendered++;
        drawCalls++;
    }

    return { tilesRendered, drawCalls };
}

/**
 * RTE 更新大气顶点缓冲并 `drawIndexed`；须在瓦片之后、同一 pass 内调用以叠加混合。
 *
 * @param device - GPU 设备
 * @param pass - 主 pass
 * @param gc - 相机 ECEF 用于 `meshToRTE`
 * @param refs - 大气 pipeline、索引/顶点缓冲、`cameraBindGroup`
 */
export function renderAtmosphere(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    gc: GlobeCamera,
    refs: GlobeGPURefs,
): void {
    if (!refs.atmoPipeline || !refs.cameraBindGroup
        || !refs.atmoMesh || !refs.atmoIndexBuffer || !refs.atmoVertexBuffer) {
        return;
    }

    const rteVerts = meshToRTE(refs.atmoMesh, gc.cameraECEF);

    device.queue.writeBuffer(
        refs.atmoVertexBuffer,
        0,
        rteVerts.buffer as ArrayBuffer,
        rteVerts.byteOffset,
        rteVerts.byteLength,
    );

    pass.setPipeline(refs.atmoPipeline);
    pass.setBindGroup(0, refs.cameraBindGroup);

    pass.setVertexBuffer(0, refs.atmoVertexBuffer);
    pass.setIndexBuffer(refs.atmoIndexBuffer, 'uint32');

    pass.drawIndexed(refs.atmoMesh.indexCount);
}
