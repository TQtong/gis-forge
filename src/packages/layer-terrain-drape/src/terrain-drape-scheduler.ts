// ============================================================
// terrain-drape-scheduler.ts — Mercator XYZ 覆盖瓦片调度
//
// 从 RasterTileLayer 精简提取的 Mercator XYZ 调度逻辑，增加了
// Camera25D pitch 几何计算（前方远端需要更多瓦片）。
//
// 特性：
//   • IoU 节流：视口几乎不变时复用上帧结果
//   • pitch 感知：高 pitch 下前方半径增大
//   • 按距离排序：近的优先加载
//   • 硬上限 MAX_SCHEDULED_TILES 防 LRU thrashing
// ============================================================

import type { CameraState } from '../../core/src/types/viewport.ts';
import {
  TILE_PIXEL_SIZE,
  MAX_SCHEDULED_TILES,
  SCHEDULE_IOU_THRESHOLD,
  SCHEDULE_MAX_SKIP_FRAMES,
} from './types.ts';

/** Camera25D 默认 fov（弧度） */
const CAMERA_FOV_RAD = 0.6435;
const MAX_FWD = 16;
const MAX_SIDE = 8;

export interface ScheduledTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export interface SchedulerOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

// ── IoU 节流状态（模块级单例） ──
let schedLastZ = -1;
let schedLastBBox: [number, number, number, number] | null = null;
let schedCached: ScheduledTile[] = [];
let schedFrameCount = 0;

function bboxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const iW = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iH = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const iArea = iW * iH;
  const aW = a[2] - a[0];
  const aH = a[3] - a[1];
  const bW = b[2] - b[0];
  const bH = b[3] - b[1];
  const uArea = aW * aH + bW * bH - iArea;
  return uArea > 0 ? iArea / uArea : 0;
}

function lngLatToTileFloat(
  lng: number, lat: number, z: number,
): [number, number] {
  const n = Math.pow(2, z);
  const fx = ((lng + 180) / 360) * n;
  const maxLat = 85.051128779806604;
  const cLat = Math.max(-maxLat, Math.min(maxLat, lat));
  const latRad = (cLat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [fx, fy];
}

/**
 * 计算当前视野覆盖的 Mercator XYZ 瓦片列表。
 */
export function computeTerrainDrapeCoveringTiles(
  camera: CameraState,
  opts: SchedulerOptions,
): ScheduledTile[] {
  const minZ = Math.max(0, opts.minZoom);
  const maxZ = Math.max(minZ, opts.maxZoom);
  let renderZoom = Math.round(camera.zoom);
  if (renderZoom < minZ) { renderZoom = minZ; }
  if (renderZoom > maxZ) { renderZoom = maxZ; }

  const n = Math.pow(2, renderZoom);
  const [fcx, fcy] = lngLatToTileFloat(camera.center[0], camera.center[1], renderZoom);
  const cxTile = Math.floor(fcx);
  const cyTile = Math.floor(fcy);

  // ── pitch 几何 ──
  const pitch = Math.max(0, Math.min(Math.PI / 2 - 0.02, camera.pitch ?? 0));
  const halfFov = CAMERA_FOV_RAD / 2;
  const h = opts.viewportHeight;
  const cameraToCenter = h / 2 / Math.tan(halfFov);
  const altitude = cameraToCenter * Math.cos(pitch);
  const offsetBack = cameraToCenter * Math.sin(pitch);

  const topAngle = pitch + halfFov;
  let forwardPx: number;
  if (topAngle >= Math.PI / 2 - 1e-3) {
    forwardPx = MAX_FWD * TILE_PIXEL_SIZE;
  } else {
    forwardPx = altitude * Math.tan(topAngle);
  }
  const forwardTiles = Math.min(MAX_FWD, Math.ceil(Math.max(1, (forwardPx - offsetBack) / TILE_PIXEL_SIZE) + 1));
  const botAngle = Math.max(0, pitch - halfFov);
  const backPx = altitude * Math.tan(botAngle);
  const backwardTiles = Math.min(MAX_SIDE, Math.max(1, Math.ceil((offsetBack - backPx) / TILE_PIXEL_SIZE) + 1));
  const w = opts.viewportWidth;
  const lateralTiles = Math.min(MAX_SIDE, Math.max(2, Math.ceil((w / 2) / TILE_PIXEL_SIZE * (1 + Math.sin(pitch) * 0.5)) + 1));

  // bearing 投影 → AABB
  const bearing = camera.bearing ?? 0;
  const cosB = Math.cos(bearing);
  const sinB = Math.sin(bearing);
  const fwdDx = -sinB * forwardTiles;
  const fwdDy = -cosB * forwardTiles;
  const backDx = sinB * backwardTiles;
  const backDy = cosB * backwardTiles;
  const latDx = cosB * lateralTiles;
  const latDy = -sinB * lateralTiles;

  const corners = [
    [fwdDx - latDx, fwdDy - latDy],
    [fwdDx + latDx, fwdDy + latDy],
    [backDx - latDx, backDy - latDy],
    [backDx + latDx, backDy + latDy],
  ];
  let minDx = Infinity, maxDx = -Infinity, minDy = Infinity, maxDy = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minDx) { minDx = cx; }
    if (cx > maxDx) { maxDx = cx; }
    if (cy < minDy) { minDy = cy; }
    if (cy > maxDy) { maxDy = cy; }
  }
  const dxLo = Math.max(-MAX_FWD, Math.floor(minDx));
  const dxHi = Math.min(MAX_FWD, Math.ceil(maxDx));
  const dyLo = Math.max(-MAX_FWD, Math.floor(minDy));
  const dyHi = Math.min(MAX_FWD, Math.ceil(maxDy));

  // ── IoU 节流 ──
  const currentBBox: [number, number, number, number] = [
    cxTile + dxLo, cyTile + dyLo,
    cxTile + dxHi, cyTile + dyHi,
  ];
  schedFrameCount++;
  if (
    renderZoom === schedLastZ &&
    schedLastBBox !== null &&
    bboxIoU(schedLastBBox, currentBBox) >= SCHEDULE_IOU_THRESHOLD &&
    schedFrameCount < SCHEDULE_MAX_SKIP_FRAMES
  ) {
    return schedCached;
  }
  schedLastZ = renderZoom;
  schedLastBBox = currentBBox;
  schedFrameCount = 0;

  // ── 产出瓦片 ──
  const result: ScheduledTile[] = [];
  const maxTile = n - 1;
  for (let dy = dyLo; dy <= dyHi; dy++) {
    for (let dx = dxLo; dx <= dxHi; dx++) {
      const tx = cxTile + dx;
      const ty = cyTile + dy;
      if (tx < 0 || tx > maxTile || ty < 0 || ty > maxTile) { continue; }
      const distance = Math.hypot(dx, dy);
      result.push({ z: renderZoom, x: tx, y: ty, distance });
    }
  }
  result.sort((a, b) => a.distance - b.distance);
  if (result.length > MAX_SCHEDULED_TILES) {
    result.length = MAX_SCHEDULED_TILES;
  }
  schedCached = result;
  return result;
}
