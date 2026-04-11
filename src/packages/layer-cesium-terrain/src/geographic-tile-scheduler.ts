// ============================================================
// geographic-tile-scheduler.ts — Cesium Geographic TMS 瓦片调度器
//
// 输入：相机状态（center lngLat, zoom, pitch, bearing, viewport）
// 输出：当前视野内需要渲染的 Cesium 地理瓦片列表（按距离升序）
//
// Cesium 地理 TMS 约定：
//   • z=0 共 2 张：x∈{0,1}, y∈{0}，各覆盖 180° 经度 × 180° 纬度
//   • z=N：x∈[0, 2*2^N), y∈[0, 2^N)
//   • y=0 在南端（自下而上）
//
// 调度策略：按相机 zoom 取对应 Cesium zoom（≈ mercatorZoom - 1），从
// 相机中心瓦片向外扩展；pitch 越大覆盖半径越大以应对远景地平线。
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';

/** Camera25D 默认 fov（弧度） */
const CAMERA_FOV_RAD = 0.6435;

/** 前方瓦片半径上限（防止 pitch→90° 时无限增长） */
const MAX_FORWARD_TILES = 16;
/** 横向/后方硬上限 */
const MAX_SIDE_TILES = 8;
/** 单帧最多调度瓦片数（防 LRU thrashing） */
const MAX_SCHEDULED_TILES = 128;

export interface GeographicScheduledTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export interface GeographicScheduleOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** Cesium 地理瓦片：经纬度 → (x, y)（浮点） */
function lngLatToGeographicTileFloat(
  lng: number, lat: number, z: number,
): [number, number] {
  const tilesX = 2 * Math.pow(2, z);
  const tilesY = Math.pow(2, z);
  const lonStep = 360 / tilesX;
  const latStep = 180 / tilesY;
  const fx = (lng + 180) / lonStep;
  const fy = (lat + 90) / latStep;
  return [fx, fy];
}

/** 判断 Cesium 瓦片是否在 available 矩阵内（若 provider 提供） */
export interface AvailabilityChecker {
  isTileAvailable(z: number, x: number, y: number): boolean;
}

export function computeGeographicCoveringTiles(
  camera: CameraState,
  availability: AvailabilityChecker,
  opts: GeographicScheduleOptions,
): GeographicScheduledTile[] {
  const minZ = Math.max(0, opts.minZoom);
  const maxZ = Math.max(minZ, opts.maxZoom);

  // Mercator renderZoom → Cesium zoom（差 1，因为 Cesium 根层 2×1 而
  // Mercator 根层 1×1）
  let cesiumZ = Math.round(camera.zoom) - 1;
  if (cesiumZ < minZ) { cesiumZ = minZ; }
  if (cesiumZ > maxZ) { cesiumZ = maxZ; }

  const tilesX = 2 * Math.pow(2, cesiumZ);
  const tilesY = Math.pow(2, cesiumZ);

  // 相机中心在 Cesium z 层的瓦片浮点坐标
  const [fcx, fcy] = lngLatToGeographicTileFloat(
    camera.center[0], camera.center[1], cesiumZ,
  );
  const cxTile = Math.floor(fcx);
  const cyTile = Math.floor(fcy);

  // 计算前 / 后 / 横向覆盖半径（基于 Camera25D pitch 几何）
  const pitch = Math.max(0, Math.min(Math.PI / 2 - 0.02, camera.pitch ?? 0));
  const halfFov = CAMERA_FOV_RAD / 2;
  const h = opts.viewportHeight;
  const cameraToCenter = h / 2 / Math.tan(halfFov);
  const altitude = cameraToCenter * Math.cos(pitch);
  const offsetBack = cameraToCenter * Math.sin(pitch);

  // 前方视锥上边缘射线与地面的交点
  const topAngle = pitch + halfFov;
  let forwardPx: number;
  if (topAngle >= Math.PI / 2 - 1e-3) {
    forwardPx = MAX_FORWARD_TILES * 256;
  } else {
    forwardPx = altitude * Math.tan(topAngle);
  }
  // Cesium 瓦片在当前 zoom 下的像素尺寸约等于 256（等效 Mercator 512/2）
  const TILE_PX = 256;
  const forwardTiles = Math.min(
    MAX_FORWARD_TILES,
    Math.ceil(Math.max(1, (forwardPx - offsetBack) / TILE_PX) + 1),
  );
  const botAngle = Math.max(0, pitch - halfFov);
  const backPx = altitude * Math.tan(botAngle);
  const backwardTiles = Math.min(
    MAX_SIDE_TILES,
    Math.max(1, Math.ceil((offsetBack - backPx) / TILE_PX) + 1),
  );
  const w = opts.viewportWidth;
  const lateralTiles = Math.min(
    MAX_SIDE_TILES,
    Math.max(2, Math.ceil((w / 2) / TILE_PX * (1 + Math.sin(pitch) * 0.5)) + 1),
  );

  // bearing 方向投影到 x/y 轴得 AABB
  const bearing = camera.bearing ?? 0;
  const cosB = Math.cos(bearing);
  const sinB = Math.sin(bearing);
  // Cesium TMS y 向上（北+），mercator y 向下（南+），bearing=0 相机看北
  // → 相机前方对应 y 方向增大（tmsY 增大 = 北）
  const fwdDx = sinB * forwardTiles;
  const fwdDy = cosB * forwardTiles;
  const backDx = -sinB * backwardTiles;
  const backDy = -cosB * backwardTiles;
  const latDx = cosB * lateralTiles;
  const latDy = -sinB * lateralTiles;

  const minDx = Math.min(fwdDx - latDx, fwdDx + latDx, backDx - latDx, backDx + latDx);
  const maxDx = Math.max(fwdDx - latDx, fwdDx + latDx, backDx - latDx, backDx + latDx);
  const minDy = Math.min(fwdDy - latDy, fwdDy + latDy, backDy - latDy, backDy + latDy);
  const maxDy = Math.max(fwdDy - latDy, fwdDy + latDy, backDy - latDy, backDy + latDy);

  const dxLo = Math.max(-MAX_SIDE_TILES, Math.floor(minDx));
  const dxHi = Math.min(MAX_FORWARD_TILES, Math.ceil(maxDx));
  const dyLo = Math.max(-MAX_SIDE_TILES, Math.floor(minDy));
  const dyHi = Math.min(MAX_FORWARD_TILES, Math.ceil(maxDy));

  const result: GeographicScheduledTile[] = [];
  for (let dy = dyLo; dy <= dyHi; dy++) {
    for (let dx = dxLo; dx <= dxHi; dx++) {
      const tx = cxTile + dx;
      const ty = cyTile + dy;
      if (tx < 0 || tx >= tilesX || ty < 0 || ty >= tilesY) { continue; }
      if (!availability.isTileAvailable(cesiumZ, tx, ty)) { continue; }
      const distance = Math.hypot(dx, dy);
      result.push({ z: cesiumZ, x: tx, y: ty, distance });
    }
  }
  result.sort((a, b) => a.distance - b.distance);
  if (result.length > MAX_SCHEDULED_TILES) {
    result.length = MAX_SCHEDULED_TILES;
  }
  return result;
}
