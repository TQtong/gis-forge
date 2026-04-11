// ============================================================
// mercator.ts — Web Mercator 投影与地理瓦片工具
// ============================================================

import {
  DEG_TO_RAD,
  EARTH_CIRCUMFERENCE,
  TILE_PIXEL_SIZE,
} from './types.ts';

const MAX_LAT = 85.051128779806604;

export function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** 在给定世界尺度（= TILE_PIXEL_SIZE * 2^zoom 像素）下把 (lng,lat) 映射到 Web Mercator 像素 */
export function lngLatToMercatorPixel(
  lng: number,
  lat: number,
  worldSize: number,
): [number, number] {
  const px = ((lng + 180) / 360) * worldSize;
  const cLat = clampLat(lat);
  const latRad = cLat * DEG_TO_RAD;
  const py =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    worldSize;
  return [px, py];
}

/** 视中心纬度下每米对应的墨卡托像素数 */
export function metersPerPixel(lat: number, zoom: number): number {
  const worldSize = TILE_PIXEL_SIZE * Math.pow(2, zoom);
  // circumference / worldSize 即每像素多少米（赤道），再除 cos(lat) 得到该纬度
  const mPerPxEquator = EARTH_CIRCUMFERENCE / worldSize;
  return mPerPxEquator * Math.cos(clampLat(lat) * DEG_TO_RAD);
}

/** 把一米换算为当前世界尺度下的墨卡托像素（即 metersPerPixel 的倒数） */
export function pixelsPerMeter(lat: number, zoom: number): number {
  return 1 / metersPerPixel(lat, zoom);
}

// ---------------------------------------------------------------------------
// Geographic TMS (Cesium) 瓦片坐标 ↔ 经纬度 bbox
// Cesium 的地理瓦片在 z=0 是 2x1：x∈{0,1} 覆盖 -180..0 和 0..180；y∈{0} 覆盖 -90..90。
// y 轴：TMS 规范自下而上（y=0 = 南），与 OSM XYZ 相反。
// z>0：每级 x 数量 = 2 * 2^z，y 数量 = 2^z。
// ---------------------------------------------------------------------------

export function cesiumTileToGeographic(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const tilesX = 2 * Math.pow(2, z);
  const tilesY = Math.pow(2, z);
  const lonStep = 360 / tilesX;
  const latStep = 180 / tilesY;
  const west = -180 + x * lonStep;
  const east = west + lonStep;
  // y=0 = 南端，故 south = -90 + y*latStep
  const south = -90 + y * latStep;
  const north = south + latStep;
  return { west, south, east, north };
}

export function geographicToCesiumTile(
  lng: number,
  lat: number,
  z: number,
): [number, number] {
  const tilesX = 2 * Math.pow(2, z);
  const tilesY = Math.pow(2, z);
  const lonStep = 360 / tilesX;
  const latStep = 180 / tilesY;
  const x = Math.max(0, Math.min(tilesX - 1, Math.floor((lng + 180) / lonStep)));
  const y = Math.max(0, Math.min(tilesY - 1, Math.floor((lat + 90) / latStep)));
  return [x, y];
}

export function tileCountAtLevel(z: number): [number, number] {
  return [2 * Math.pow(2, z), Math.pow(2, z)];
}

// ---------------------------------------------------------------------------
// OSM / Web-Mercator XYZ 瓦片（与 Cesium Geographic TMS 不同：
//   OSM y=0 = 北；z=0 = 1×1 覆盖全球；每级切 4）
// ---------------------------------------------------------------------------

/** 经纬度 → OSM 瓦片坐标（浮点，保留小数） */
export function lngLatToOsmTileFloat(
  lng: number,
  lat: number,
  z: number,
): [number, number] {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = clampLat(lat) * DEG_TO_RAD;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return [x, y];
}

/**
 * 选一张尽量深的 OSM 瓦片，使其完全包含给定地理 bbox。
 * 从 maxOsmZoom 向下回退直到找到 floor(xSE)==floor(xNW) && floor(ySE)==floor(yNW)。
 */
export function pickCoveringOsmTile(
  west: number,
  south: number,
  east: number,
  north: number,
  maxOsmZoom: number,
): { z: number; x: number; y: number } {
  for (let z = Math.min(maxOsmZoom, 22); z >= 0; z--) {
    const [xw, yn] = lngLatToOsmTileFloat(west, north, z);
    const [xe, ys] = lngLatToOsmTileFloat(east, south, z);
    const x0 = Math.floor(xw);
    const x1 = Math.floor(xe - 1e-9);
    const y0 = Math.floor(yn);
    const y1 = Math.floor(ys - 1e-9);
    if (x0 === x1 && y0 === y1) {
      return { z, x: x0, y: y0 };
    }
  }
  return { z: 0, x: 0, y: 0 };
}

/**
 * 计算 (lng,lat) 在给定 OSM 瓦片 (z,x,y) 中的局部 UV ∈ [0,1]。
 * 瓦片边界：u=0 对应瓦片西边，u=1 对应东边；v=0 对应北边（纹理上沿），v=1 对应南边。
 */
export function lngLatToOsmTileUv(
  lng: number,
  lat: number,
  z: number,
  tileX: number,
  tileY: number,
): [number, number] {
  const [xf, yf] = lngLatToOsmTileFloat(lng, lat, z);
  return [xf - tileX, yf - tileY];
}

/** 展开 OSM URL 模板（`{z}/{x}/{y}`） */
export function buildOsmTileUrl(
  template: string,
  z: number,
  x: number,
  y: number,
): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}
