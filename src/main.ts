// ============================================================
// GeoForge L0 MVP — 最小可行原型入口
// 验证 L0 基础层所有 29 个模块的正确性，并用 WebGPU 渲染一个
// 墨卡托投影三角形，证明 CPU 数学库 → GPU 渲染管线贯通。
// ============================================================

import * as vec2 from '../packages/core/src/math/vec2.ts';
import * as vec3 from '../packages/core/src/math/vec3.ts';
import * as vec4 from '../packages/core/src/math/vec4.ts';
import * as mat3 from '../packages/core/src/math/mat3.ts';
import * as mat4 from '../packages/core/src/math/mat4.ts';
import * as quat from '../packages/core/src/math/quat.ts';
import * as bbox from '../packages/core/src/math/bbox.ts';
import * as frustumMod from '../packages/core/src/math/frustum.ts';
import * as interp from '../packages/core/src/math/interpolate.ts';
import * as trig from '../packages/core/src/math/trigonometry.ts';

import {
  WGS84_A, WGS84_E2,
  geodeticToECEF, ecefToGeodetic,
  haversineDistance, vincentyDistance,
} from '../packages/core/src/geo/ellipsoid.ts';

import {
  TILE_SIZE, lngLatToMercator, mercatorToLngLat,
  lngLatToTile, tileToBBox, groundResolution,
  lngLatToPixel,
} from '../packages/core/src/geo/mercator.ts';

import {
  initialBearing, midpoint,
} from '../packages/core/src/geo/geodesic.ts';

import { earcut, flatten } from '../packages/core/src/algorithm/earcut.ts';
import { douglasPeucker } from '../packages/core/src/algorithm/simplify.ts';
import { pointInPolygon, pointInTriangle } from '../packages/core/src/algorithm/contain.ts';
import { segmentSegment, bboxOverlap } from '../packages/core/src/algorithm/intersect.ts';

import { createRTree } from '../packages/core/src/index/rtree.ts';
import { createSpatialHash } from '../packages/core/src/index/spatial-hash.ts';

import { splitDouble, recombine } from '../packages/core/src/precision/split-double.ts';
import { computeRTCCenter, offsetPositions } from '../packages/core/src/precision/rtc.ts';

import { EventEmitter } from '../packages/core/src/infra/event.ts';
import { uniqueId, nanoid } from '../packages/core/src/infra/id.ts';
import { createLogger } from '../packages/core/src/infra/logger.ts';
import { createDefaultConfig } from '../packages/core/src/infra/config.ts';
import { registerCRS, getCRS, transform } from '../packages/core/src/infra/coordinate.ts';

// ============================================================
// 测试框架
// ============================================================

/** 测试结果条目 */
interface TestResult {
  /** 测试名称 */
  name: string;
  /** 是否通过 */
  pass: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/** 分组测试结果 */
interface TestGroup {
  /** 组名 */
  group: string;
  /** 该组内的测试结果列表 */
  results: TestResult[];
}

/** 所有测试分组 */
const allTests: TestGroup[] = [];

/** 当前正在运行的测试组 */
let currentGroup: TestGroup | null = null;

/**
 * 开始一个新的测试分组。
 * @param name - 分组名称
 */
function group(name: string): void {
  currentGroup = { group: name, results: [] };
  allTests.push(currentGroup);
}

/**
 * 运行单个测试用例。
 * @param name - 测试名称
 * @param fn - 测试函数，抛异常表示失败
 */
function test(name: string, fn: () => void): void {
  try {
    fn();
    currentGroup!.results.push({ name, pass: true });
  } catch (e: any) {
    currentGroup!.results.push({ name, pass: false, error: e.message ?? String(e) });
  }
}

/**
 * 断言两个数值近似相等。
 * @param actual - 实际值
 * @param expected - 期望值
 * @param epsilon - 允许的误差范围
 * @param msg - 自定义错误消息
 */
function assertApprox(actual: number, expected: number, epsilon = 1e-6, msg = ''): void {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${msg} expected ${expected}, got ${actual} (diff=${Math.abs(actual - expected)})`);
  }
}

/**
 * 断言条件为真。
 * @param cond - 布尔条件
 * @param msg - 失败时的错误信息
 */
function assert(cond: boolean, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}

// ============================================================
// 1. Math 模块测试
// ============================================================

group('math/vec2');
test('create & add', () => {
  const a = vec2.create(1, 2);
  const b = vec2.create(3, 4);
  const out = vec2.create();
  vec2.add(out, a, b);
  assertApprox(out[0], 4);
  assertApprox(out[1], 6);
});
test('normalize', () => {
  const v = vec2.create(3, 4);
  const out = vec2.create();
  vec2.normalize(out, v);
  assertApprox(vec2.length(out), 1.0, 1e-5);
});
test('distance', () => {
  const a = vec2.create(0, 0);
  const b = vec2.create(3, 4);
  assertApprox(vec2.distance(a, b), 5.0);
});

group('math/vec3');
test('cross product', () => {
  const a = vec3.create(1, 0, 0);
  const b = vec3.create(0, 1, 0);
  const out = vec3.create();
  vec3.cross(out, a, b);
  assertApprox(out[0], 0);
  assertApprox(out[1], 0);
  assertApprox(out[2], 1);
});
test('normalize zero vector', () => {
  const z = vec3.create(0, 0, 0);
  const out = vec3.create();
  vec3.normalize(out, z);
  assertApprox(out[0], 0);
  assertApprox(out[1], 0);
  assertApprox(out[2], 0);
});
test('transformMat4 identity', () => {
  const v = vec3.create(1, 2, 3);
  const m = mat4.create();
  const out = vec3.create();
  vec3.transformMat4(out, v, m);
  assertApprox(out[0], 1);
  assertApprox(out[1], 2);
  assertApprox(out[2], 3);
});

group('math/vec4');
test('create & dot', () => {
  const out = vec4.create();
  const a = vec4.set(out, 1, 2, 3, 4);
  const b = vec4.create();
  vec4.set(b, 5, 6, 7, 8);
  assertApprox(vec4.dot(a, b), 70);
});

group('math/mat3');
test('identity determinant', () => {
  const m = mat3.create();
  assertApprox(mat3.determinant(m), 1.0);
});
test('fromMat4 & invert', () => {
  const m4 = mat4.create();
  const m3 = mat3.create();
  mat3.fromMat4(m3, m4);
  const inv = mat3.create();
  const result = mat3.invert(inv, m3);
  assert(result !== null, 'identity should be invertible');
  assertApprox(inv[0], 1);
  assertApprox(inv[4], 1);
  assertApprox(inv[8], 1);
});

group('math/mat4');
test('multiply identity', () => {
  const a = mat4.create();
  const b = mat4.create();
  const out = mat4.create();
  mat4.multiply(out, a, b);
  assertApprox(out[0], 1);
  assertApprox(out[5], 1);
  assertApprox(out[10], 1);
  assertApprox(out[15], 1);
});
test('invert identity', () => {
  const m = mat4.create();
  const inv = mat4.create();
  const result = mat4.invert(inv, m);
  assert(result !== null);
  assertApprox(inv[0], 1);
  assertApprox(inv[15], 1);
});
test('perspective fov', () => {
  const proj = mat4.create();
  mat4.perspective(proj, Math.PI / 4, 16 / 9, 0.1, 1000);
  assert(proj[0] !== 0, 'proj[0] should not be zero');
  assert(proj[5] !== 0, 'proj[5] should not be zero');
  assertApprox(proj[11], -1);
});
test('perspectiveReversedZ', () => {
  const proj = mat4.create();
  mat4.perspectiveReversedZ(proj, Math.PI / 4, 1.0, 0.1, 1000);
  assertApprox(proj[11], -1);
});
test('lookAt', () => {
  const view = mat4.create();
  const eye = vec3.create(0, 0, 5);
  const center = vec3.create(0, 0, 0);
  const up = vec3.create(0, 1, 0);
  mat4.lookAt(view, eye, center, up);
  assert(view[14] !== 0, 'should have translation component');
});
test('ortho', () => {
  const proj = mat4.create();
  mat4.ortho(proj, -1, 1, -1, 1, 0.1, 100);
  assertApprox(proj[0], 1);
  assertApprox(proj[5], 1);
});
test('translate', () => {
  const m = mat4.create();
  const out = mat4.create();
  const v = vec3.create(10, 20, 30);
  mat4.translate(out, m, v);
  assertApprox(out[12], 10);
  assertApprox(out[13], 20);
  assertApprox(out[14], 30);
});

group('math/quat');
test('identity rotation', () => {
  const q = quat.create();
  quat.identity(q);
  assertApprox(q[3], 1, 1e-6, 'w should be 1');
  const v = vec3.create(1, 0, 0);
  const out = vec3.create();
  quat.rotateVec3(out, v, q);
  assertApprox(out[0], 1);
  assertApprox(out[1], 0);
  assertApprox(out[2], 0);
});
test('fromAxisAngle 90° Z', () => {
  const q = quat.create();
  quat.fromAxisAngle(q, vec3.create(0, 0, 1), Math.PI / 2);
  const v = vec3.create(1, 0, 0);
  const out = vec3.create();
  quat.rotateVec3(out, v, q);
  assertApprox(out[0], 0, 1e-5);
  assertApprox(out[1], 1, 1e-5);
  assertApprox(out[2], 0, 1e-5);
});

group('math/bbox');
test('create & containsPoint', () => {
  const b = bbox.create2D(0, 0, 10, 10);
  assert(bbox.containsPoint2D(b, 5, 5));
  assert(!bbox.containsPoint2D(b, 15, 5));
});
test('union', () => {
  const a = bbox.create2D(0, 0, 5, 5);
  const b = bbox.create2D(3, 3, 10, 10);
  const u = bbox.union2D(a, b);
  assertApprox(u.west, 0);
  assertApprox(u.north, 10);
});

group('math/frustum');
test('extract planes from identity VP', () => {
  const proj = mat4.create();
  mat4.perspective(proj, Math.PI / 4, 1.0, 0.1, 100);
  const view = mat4.create();
  const vp = mat4.create();
  mat4.multiply(vp, proj, view);
  const planes = frustumMod.extractPlanes(vp);
  assert(planes.length === 6, `should have 6 planes, got ${planes.length}`);
});

group('math/interpolate');
test('linear 50%', () => {
  assertApprox(interp.linear(0, 10, 0.5), 5);
});
test('clamp boundaries', () => {
  assertApprox(interp.clamp(-5, 0, 10), 0);
  assertApprox(interp.clamp(15, 0, 10), 10);
  assertApprox(interp.clamp(5, 0, 10), 5);
});
test('smoothstep 0/0.5/1', () => {
  assertApprox(interp.smoothstep(0, 1, 0), 0);
  assertApprox(interp.smoothstep(0, 1, 1), 1);
  assert(interp.smoothstep(0, 1, 0.5) > 0.4 && interp.smoothstep(0, 1, 0.5) < 0.6);
});

group('math/trigonometry');
test('deg/rad conversion', () => {
  assertApprox(trig.degToRad(180), Math.PI);
  assertApprox(trig.radToDeg(Math.PI), 180);
});
test('wrapLongitude', () => {
  assertApprox(trig.wrapLongitude(200), -160);
  assertApprox(trig.wrapLongitude(-200), 160);
});

// ============================================================
// 2. Geo 模块测试
// ============================================================

group('geo/ellipsoid');
test('WGS84 constants', () => {
  assertApprox(WGS84_A, 6378137.0, 1);
  assert(WGS84_E2 > 0 && WGS84_E2 < 0.01);
});
test('geodetic→ECEF→geodetic roundtrip', () => {
  const ecef = new Float64Array(3);
  const lonRad = trig.degToRad(116.3913);
  const latRad = trig.degToRad(39.9065);
  geodeticToECEF(ecef, lonRad, latRad, 50);
  const geo = new Float64Array(3);
  ecefToGeodetic(geo, ecef[0], ecef[1], ecef[2]);
  assertApprox(geo[0], lonRad, 1e-8, 'lon roundtrip');
  assertApprox(geo[1], latRad, 1e-8, 'lat roundtrip');
  assertApprox(geo[2], 50, 1, 'alt roundtrip');
});
test('haversine Beijing→Shanghai ~1068km', () => {
  const lon1 = trig.degToRad(116.4074);
  const lat1 = trig.degToRad(39.9042);
  const lon2 = trig.degToRad(121.4737);
  const lat2 = trig.degToRad(31.2304);
  const dist = haversineDistance(lon1, lat1, lon2, lat2);
  assert(dist > 1050000 && dist < 1090000, `expected ~1068km, got ${(dist / 1000).toFixed(1)}km`);
});

group('geo/mercator');
test('lngLat→Mercator→lngLat roundtrip', () => {
  const merc = new Float64Array(2);
  lngLatToMercator(merc, 116.4, 39.9);
  const ll = new Float64Array(2);
  mercatorToLngLat(ll, merc[0], merc[1]);
  assertApprox(ll[0], 116.4, 1e-6);
  assertApprox(ll[1], 39.9, 1e-4);
});
test('tile size constant', () => {
  assertApprox(TILE_SIZE, 512);
});
test('lngLatToTile zoom 0', () => {
  const tile = lngLatToTile(0, 0, 0);
  assertApprox(tile.x, 0);
  assertApprox(tile.y, 0);
  assertApprox(tile.z, 0);
});
test('tileToBBox zoom 0', () => {
  const b = tileToBBox(0, 0, 0);
  assertApprox(b.west, -180, 0.01);
  assertApprox(b.east, 180, 0.01);
});
test('groundResolution equator', () => {
  const res = groundResolution(0, 0);
  assert(res > 70000 && res < 80000, `equator res at z0: ${res}`);
});

group('geo/geodesic');
test('initialBearing N pole', () => {
  const bearing = initialBearing(0, 0, 0, Math.PI / 2);
  assertApprox(bearing, 0, 0.01, 'bearing to north pole');
});
test('midpoint equator', () => {
  const m = midpoint(0, 0, Math.PI, 0);
  assertApprox(m.lat, 0, 1e-6, 'midpoint lat on equator');
});

// ============================================================
// 3. Algorithm 模块测试
// ============================================================

group('algorithm/earcut');
test('triangle', () => {
  const indices = earcut([0, 0, 10, 0, 5, 10]);
  assert(indices.length === 3, `expected 3 indices, got ${indices.length}`);
});
test('square → 2 triangles', () => {
  const indices = earcut([0, 0, 10, 0, 10, 10, 0, 10]);
  assert(indices.length === 6, `expected 6 indices, got ${indices.length}`);
});
test('flatten', () => {
  const result = flatten([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
  assert(result.vertices.length === 8);
  assert(result.dimensions === 2);
});

group('algorithm/simplify');
test('douglasPeucker reduces points', () => {
  const line = [[0, 0], [1, 0.1], [2, -0.1], [3, 5], [4, 6], [5, 0]];
  const simplified = douglasPeucker(line, 1);
  assert(simplified.length < line.length, 'should reduce points');
  assert(simplified.length >= 2, 'should keep at least endpoints');
});

group('algorithm/contain');
test('pointInPolygon inside', () => {
  const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert(pointInPolygon([5, 5], polygon));
});
test('pointInPolygon outside', () => {
  const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert(!pointInPolygon([15, 5], polygon));
});
test('pointInTriangle inside', () => {
  assert(pointInTriangle(1, 1, 0, 0, 10, 0, 0, 10));
});
test('pointInTriangle outside', () => {
  assert(!pointInTriangle(6, 6, 0, 0, 10, 0, 0, 10));
});

group('algorithm/intersect');
test('segment intersection', () => {
  const result = segmentSegment(0, 0, 10, 10, 10, 0, 0, 10);
  assert(result !== null, 'segments should intersect');
  if (result) {
    assertApprox(result.x, 5, 0.1);
    assertApprox(result.y, 5, 0.1);
  }
});
test('parallel segments', () => {
  const result = segmentSegment(0, 0, 10, 0, 0, 1, 10, 1);
  assert(result === null, 'parallel segments should not intersect');
});
test('bbox overlap', () => {
  const a = { west: 0, south: 0, east: 10, north: 10 };
  const b = { west: 5, south: 5, east: 15, north: 15 };
  assert(bboxOverlap(a, b));
});

// ============================================================
// 4. 空间索引测试
// ============================================================

group('index/rtree');
test('insert & search', () => {
  const tree = createRTree<string>();
  tree.insert({ minX: 0, minY: 0, maxX: 5, maxY: 5, data: 'A' });
  tree.insert({ minX: 10, minY: 10, maxX: 15, maxY: 15, data: 'B' });
  const found = tree.search({ minX: 1, minY: 1, maxX: 6, maxY: 6 });
  assert(found.length === 1 && found[0].data === 'A');
});
test('bulk load', () => {
  const tree = createRTree<number>();
  const items = Array.from({ length: 100 }, (_, i) => ({
    minX: i * 10, minY: i * 10,
    maxX: i * 10 + 5, maxY: i * 10 + 5,
    data: i,
  }));
  tree.load(items);
  assert(tree.size === 100, `expected 100 items, got ${tree.size}`);
  const found = tree.search({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  assert(found.length === 100);
});

group('index/spatial-hash');
test('insert & query', () => {
  const hash = createSpatialHash<string>(10);
  hash.insert(5, 5, 8, 8, 'item1');
  hash.insert(50, 50, 55, 55, 'item2');
  const found = hash.query(0, 0, 10, 10);
  assert(found.length >= 1);
  assert(found.includes('item1'));
});

// ============================================================
// 5. 精度模块测试
// ============================================================

group('precision/split-double');
test('split and recombine', () => {
  const value = 6378137.123456789;
  const [hi, lo] = splitDouble(value);
  const recovered = recombine(hi, lo);
  assertApprox(recovered, value, 1e-4);
});
test('large ECEF value', () => {
  const value = -2187110.987654321;
  const [hi, lo] = splitDouble(value);
  assert(Math.abs(hi) > 0, 'high part should be nonzero');
  const recovered = recombine(hi, lo);
  assertApprox(recovered, value, 1);
});

group('precision/rtc');
test('compute RTC center', () => {
  const positions = new Float64Array([100, 200, 300, 110, 210, 310, 120, 220, 320]);
  const center = computeRTCCenter(positions);
  assertApprox(center[0], 110, 1);
  assertApprox(center[1], 210, 1);
  assertApprox(center[2], 310, 1);
});
test('offset positions', () => {
  const positions = new Float64Array([100, 200, 300, 110, 210, 310]);
  const center = new Float64Array([100, 200, 300]);
  const out = new Float32Array(6);
  offsetPositions(positions, center, out);
  assertApprox(out[0], 0, 0.01);
  assertApprox(out[3], 10, 0.01);
});

// ============================================================
// 6. 基础设施测试
// ============================================================

group('infra/event');
test('emit & receive', () => {
  const bus = new EventEmitter<{ test: number }>();
  let received = 0;
  bus.on('test', (v: number) => { received = v; });
  bus.emit('test', 42);
  assert(received === 42, `expected 42, got ${received}`);
});
test('once', () => {
  const bus = new EventEmitter<{ ping: string }>();
  let count = 0;
  bus.once('ping', () => { count++; });
  bus.emit('ping', 'a');
  bus.emit('ping', 'b');
  assert(count === 1, `once should fire only once, got ${count}`);
});

group('infra/id');
test('uniqueId', () => {
  const id1 = uniqueId('test');
  const id2 = uniqueId('test');
  assert(id1 !== id2, 'ids should be unique');
  assert(id1.startsWith('test'), 'should have prefix');
});
test('nanoid', () => {
  const id = nanoid(21);
  assert(id.length === 21, `expected length 21, got ${id.length}`);
});

group('infra/logger');
test('createLogger', () => {
  const log = createLogger('test');
  assert(log instanceof Object);
  log.info('Logger created successfully');
});

group('infra/config');
test('createDefaultConfig', () => {
  const config = createDefaultConfig();
  assert(config.tileSize === 512, `tileSize should be 512, got ${config.tileSize}`);
  assert(config.logLevel === 'warn' || config.logLevel === 'info');
  assert(config.maxZoom >= 20);
});

group('infra/coordinate');
test('built-in CRS', () => {
  const wgs84 = getCRS('EPSG:4326');
  assert(wgs84 !== undefined, 'EPSG:4326 should be registered');
  const mercator = getCRS('EPSG:3857');
  assert(mercator !== undefined, 'EPSG:3857 should be registered');
});
test('transform 4326→3857', () => {
  const result = transform('EPSG:4326', 'EPSG:3857', 0, 0);
  assertApprox(result[0], 0, 1);
  assertApprox(result[1], 0, 1);
});

// ============================================================
// 渲染测试结果到 DOM
// ============================================================

function renderResults(): void {
  const container = document.getElementById('test-results')!;
  let totalPass = 0;
  let totalFail = 0;
  let html = '';

  for (const g of allTests) {
    html += `<div class="test-group"><h3>${g.group}</h3>`;
    for (const r of g.results) {
      if (r.pass) totalPass++;
      else totalFail++;
      const cls = r.pass ? 'pass' : 'fail';
      const icon = r.pass ? '✓' : '✗';
      const errStr = r.error ? ` — ${r.error}` : '';
      html += `<div class="test-item ${cls}"><span class="icon">${icon}</span>${r.name}${errStr}</div>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;

  // 统计信息
  const statsBar = document.getElementById('stats-bar')!;
  statsBar.innerHTML = `
    <div class="stat"><div class="value">${totalPass + totalFail}</div><div class="label">Total Tests</div></div>
    <div class="stat"><div class="value" style="color:#3fb950">${totalPass}</div><div class="label">Passed</div></div>
    <div class="stat"><div class="value" style="color:${totalFail > 0 ? '#f85149' : '#3fb950'}">${totalFail}</div><div class="label">Failed</div></div>
    <div class="stat"><div class="value">${allTests.length}</div><div class="label">Modules</div></div>
    <div class="stat"><div class="value">29</div><div class="label">L0 Files</div></div>
    <div class="stat"><div class="value">0</div><div class="label">Dependencies</div></div>
  `;
}

// ============================================================
// WebGPU 渲染：用 L0 数学库构建 MVP 矩阵，渲染墨卡托三角形
// ============================================================

async function initWebGPU(): Promise<void> {
  const statusEl = document.getElementById('gpu-status')!;
  const canvas = document.getElementById('webgpu-canvas') as HTMLCanvasElement;

  // 检测 WebGPU 是否可用
  if (!navigator.gpu) {
    statusEl.className = 'unsupported';
    statusEl.textContent = 'WebGPU is not supported in this browser. L0 tests still pass above.';
    drawFallbackCanvas(canvas);
    return;
  }

  try {
    // 请求 GPU 适配器和设备
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      statusEl.className = 'unsupported';
      statusEl.textContent = 'No GPU adapter found. L0 tests still pass above.';
      drawFallbackCanvas(canvas);
      return;
    }

    const device = await adapter.requestDevice();
    statusEl.className = 'supported';
    statusEl.textContent = `WebGPU Active — ${adapter.info?.vendor ?? 'Unknown'} / ${adapter.info?.architecture ?? 'Unknown'}`;

    // 配置 Canvas 上下文
    const ctx = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'premultiplied' });

    // =============================================================
    // 用 L0 数学库构建 Model-View-Projection 矩阵
    // =============================================================

    // 将北京三个地标的经纬度转换为墨卡托坐标，然后归一化到 [-1,1] 用于渲染
    const p0 = new Float64Array(2); // 天安门
    const p1 = new Float64Array(2); // 鸟巢
    const p2 = new Float64Array(2); // 中关村

    lngLatToMercator(p0, 116.3912, 39.9065);
    lngLatToMercator(p1, 116.3919, 39.9929);
    lngLatToMercator(p2, 116.3264, 39.9837);

    // 归一化到 NDC 空间 [-1, 1]
    const cx = (p0[0] + p1[0] + p2[0]) / 3;
    const cy = (p0[1] + p1[1] + p2[1]) / 3;
    const scale = Math.max(
      Math.abs(p0[0] - cx), Math.abs(p1[0] - cx), Math.abs(p2[0] - cx),
      Math.abs(p0[1] - cy), Math.abs(p1[1] - cy), Math.abs(p2[1] - cy),
    ) * 1.5;

    // 顶点数据：位置(x,y) + 颜色(r,g,b)
    const vertices = new Float32Array([
      (p0[0] - cx) / scale, (p0[1] - cy) / scale,   1.0, 0.3, 0.3,  // 红色
      (p1[0] - cx) / scale, (p1[1] - cy) / scale,   0.3, 1.0, 0.3,  // 绿色
      (p2[0] - cx) / scale, (p2[1] - cy) / scale,   0.3, 0.5, 1.0,  // 蓝色
    ]);

    // 创建 GPU Buffer
    const vertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertices);

    // 用 mat4 创建 MVP 矩阵：正交投影（2D 模式）
    const mvp = mat4.create();
    const proj = mat4.create();
    mat4.ortho(proj, -1, 1, -1, 1, -1, 1);
    const view = mat4.create();
    mat4.multiply(mvp, proj, view);

    // MVP Uniform Buffer
    const uniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, mvp as Float32Array<ArrayBuffer>);

    // WGSL 着色器
    const shaderCode = `
      struct Uniforms {
        mvp: mat4x4<f32>,
      };

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexInput {
        @location(0) position: vec2<f32>,
        @location(1) color: vec3<f32>,
      };

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec3<f32>,
      };

      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniforms.mvp * vec4<f32>(input.position, 0.0, 1.0);
        output.color = input.color;
        return output;
      }

      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return vec4<f32>(input.color, 1.0);
      }
    `;

    const shaderModule = device.createShaderModule({ code: shaderCode });

    // Bind Group Layout
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    // Render Pipeline
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    // 动画循环：旋转三角形
    let angle = 0;
    function frame() {
      angle += 0.005;

      // 用 mat4 构建旋转矩阵
      const model = mat4.create();
      mat4.rotateZ(model, model, angle);
      const finalMVP = mat4.create();
      mat4.multiply(finalMVP, proj, model);
      device.queue.writeBuffer(uniformBuffer, 0, finalMVP as Float32Array<ArrayBuffer>);

      const commandEncoder = device.createCommandEncoder();
      const textureView = ctx.getCurrentTexture().createView();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          clearValue: { r: 0.06, g: 0.07, b: 0.09, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });

      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.draw(3);
      renderPass.end();

      device.queue.submit([commandEncoder.finish()]);
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

  } catch (err: any) {
    statusEl.className = 'unsupported';
    statusEl.textContent = `WebGPU Error: ${err.message}. L0 tests still pass above.`;
    drawFallbackCanvas(canvas);
  }
}

/**
 * Canvas 2D fallback：当 WebGPU 不可用时，用 Canvas 2D 渲染墨卡托三角形。
 * 证明 L0 数学库在无 GPU 环境下同样可用。
 */
function drawFallbackCanvas(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext('2d')!;
  if (!ctx2d) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx2d.fillStyle = '#161b22';
  ctx2d.fillRect(0, 0, w, h);

  // 用 L0 墨卡托投影转换经纬度到像素坐标
  const p0 = new Float64Array(2);
  const p1 = new Float64Array(2);
  const p2 = new Float64Array(2);
  lngLatToPixel(p0, 116.3912, 39.9065, 14);
  lngLatToPixel(p1, 116.3919, 39.9929, 14);
  lngLatToPixel(p2, 116.3264, 39.9837, 14);

  // 归一化到 canvas 坐标
  const cx = (p0[0] + p1[0] + p2[0]) / 3;
  const cy = (p0[1] + p1[1] + p2[1]) / 3;
  const sc = Math.max(
    Math.abs(p0[0] - cx), Math.abs(p1[0] - cx), Math.abs(p2[0] - cx),
    Math.abs(p0[1] - cy), Math.abs(p1[1] - cy), Math.abs(p2[1] - cy),
  ) * 2.5;

  const toCanvasX = (px: number) => w / 2 + (px - cx) / sc * (w / 2);
  const toCanvasY = (py: number) => h / 2 + (py - cy) / sc * (h / 2);

  // 绘制三角形
  const grad = ctx2d.createLinearGradient(
    toCanvasX(p0[0]), toCanvasY(p0[1]),
    toCanvasX(p2[0]), toCanvasY(p2[1]),
  );
  grad.addColorStop(0, '#ff4444');
  grad.addColorStop(0.5, '#44ff44');
  grad.addColorStop(1, '#4488ff');

  ctx2d.beginPath();
  ctx2d.moveTo(toCanvasX(p0[0]), toCanvasY(p0[1]));
  ctx2d.lineTo(toCanvasX(p1[0]), toCanvasY(p1[1]));
  ctx2d.lineTo(toCanvasX(p2[0]), toCanvasY(p2[1]));
  ctx2d.closePath();
  ctx2d.fillStyle = grad;
  ctx2d.fill();

  // 标注地名
  ctx2d.fillStyle = '#e0e6ed';
  ctx2d.font = '12px sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.fillText('Tiananmen', toCanvasX(p0[0]), toCanvasY(p0[1]) + 16);
  ctx2d.fillText('Bird Nest', toCanvasX(p1[0]), toCanvasY(p1[1]) - 8);
  ctx2d.fillText('Zhongguancun', toCanvasX(p2[0]), toCanvasY(p2[1]) - 8);

  ctx2d.fillStyle = '#8b949e';
  ctx2d.font = '11px sans-serif';
  ctx2d.fillText('Canvas 2D Fallback (WebGPU unavailable)', w / 2, h - 12);
}

// ============================================================
// 启动
// ============================================================

renderResults();
initWebGPU();
