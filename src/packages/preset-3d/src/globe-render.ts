/**
 * @module preset-3d/globe-render
 * @description
 * 单帧 **主渲染通道**内的子步骤：天穹 → 地球瓦片（多 draw）→ 大气。
 * 不负责 `beginRenderPass` / `endPass` 之外的全局状态；由 {@link import('./globe-3d.ts').Globe3D} `_renderFrame` 编排。
 *
 * @stability experimental
 */

import type { GlobeTileID, GlobeCamera } from '../../globe/src/globe-tile-mesh.ts';
import { meshToRTE, meshToRTEInto } from '../../globe/src/globe-tile-mesh.ts';
import { _skyUniformData, _tileParamsData } from './globe-buffers.ts';
import type { GlobeGPURefs, TileManagerState } from './globe-types.ts';
import { loadTileTexture, getOrCreateTileMesh, touchTileLRU } from './globe-tiles.ts';

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
        // v3 过渡：GlobeTileID.key 已从 string 改为 number，
        // 但 TileManagerState.tileCache 仍使用 string 键——Phase 2 将全面迁移到 TileCacheState。
        const strKey = `${tile.z}/${tile.x}/${tile.y}`;

        let cached = tileState.tileCache.get(strKey);
        if (!cached) {
            loadTileTexture(strKey, tile.z, tile.x, tile.y, device, refs, tileState, isDestroyed);
            cached = tileState.tileCache.get(strKey);
        }

        const tileHasTexture = cached !== undefined
            && cached.textureReady
            && cached.texture !== null
            && cached.bindGroup !== null;
        const tileBG = tileHasTexture ? cached!.bindGroup! : refs.fallbackBindGroup;
        if (!tileBG) { continue; }

        if (tileHasTexture) { touchTileLRU(tileState, strKey); }

        const meshData = getOrCreateTileMesh(device, tile.z, tile.x, tile.y, tileState.meshCache);
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

        _tileParamsData[0] = 0;
        _tileParamsData[1] = 0;
        _tileParamsData[2] = 1;
        _tileParamsData[3] = 1;
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
