/**
 * @module preset-3d/globe-atmosphere
 * @description
 * 大气层 **CPU 侧**球面网格生成（方案 A）：Float64 ECEF 顶点 + 索引，供 {@link import('./globe-gpu.ts').createGlobeGPUResources}
 * 上传索引一次、每帧 {@link import('./globe-render.ts').renderAtmosphere} 写顶点 RTE。
 *
 * 与「全屏 ray-sphere」相比，轮廓由几何+与瓦片相同 VP 路径决定，避免 Float32 蛋形伪影。
 *
 * @stability experimental
 */

import { WGS84_A } from '../../core/src/geo/ellipsoid.ts';
import type { GlobeTileMesh } from '../../globe/src/globe-tile-mesh.ts';
import {
    ATMO_RADIUS_FACTOR,
    ATMO_SPHERE_SEGMENTS,
    PI,
    TWO_PI,
} from './globe-constants.ts';

/**
 * 在半径为 `WGS84_A * ATMO_RADIUS_FACTOR` 的球面上做经纬度均匀细分，生成三角网格。
 *
 * @param segments - 纬向/经向分段数；默认 {@link ATMO_SPHERE_SEGMENTS}。顶点约 `(segments+1)²`，索引 `segments²×6`。
 * @returns 与 `GlobeTileMesh` 兼容的结构，可直接 `meshToRTE` 后送 GPU
 *
 * @remarks
 * - 极点处四边形退化由 GPU 裁剪，无需特殊扇形处理。
 * - `boundingSphere` 以原点为中心，半径 `atmoRadius`，供将来视锥裁剪复用。
 */
export function tessellateAtmosphereShell(segments: number = ATMO_SPHERE_SEGMENTS): GlobeTileMesh {
    const atmoRadius = WGS84_A * ATMO_RADIUS_FACTOR;
    const rows = segments + 1;
    const cols = segments + 1;
    const vertCount = rows * cols;
    const positions = new Float64Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);

    let vi = 0;
    for (let lat = 0; lat <= segments; lat++) {
        const theta = (lat / segments) * PI;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);

        for (let lng = 0; lng <= segments; lng++) {
            const phi = (lng / segments) * TWO_PI;
            const sinP = Math.sin(phi);
            const cosP = Math.cos(phi);

            const x = atmoRadius * sinT * cosP;
            const y = atmoRadius * sinT * sinP;
            const z = atmoRadius * cosT;

            positions[vi * 3] = x;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = z;

            normals[vi * 3] = sinT * cosP;
            normals[vi * 3 + 1] = sinT * sinP;
            normals[vi * 3 + 2] = cosT;

            uvs[vi * 2] = lng / segments;
            uvs[vi * 2 + 1] = lat / segments;

            vi++;
        }
    }

    const indexCount = segments * segments * 6;
    const indices = new Uint32Array(indexCount);
    let ii = 0;

    for (let latRow = 0; latRow < segments; latRow++) {
        for (let lngCol = 0; lngCol < segments; lngCol++) {
            const a = latRow * cols + lngCol;
            const b = a + cols;

            indices[ii++] = a;
            indices[ii++] = b;
            indices[ii++] = a + 1;

            indices[ii++] = a + 1;
            indices[ii++] = b;
            indices[ii++] = b + 1;
        }
    }

    const boundingSphere = {
        center: [0, 0, 0] as [number, number, number],
        radius: atmoRadius,
    };

    return {
        positions,
        normals,
        uvs,
        indices,
        indexCount,
        vertexCount: vertCount,
        boundingSphere,
    };
}
