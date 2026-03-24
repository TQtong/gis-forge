// ============================================================
// GeoForge P3 Ecosystem MVP — OGC 数据源 / 兼容层 / analysis 子包自检
// 测试结果写入 #test-results / #stats；主区用 Canvas 2D 展示合成 DEM 山影。
// ============================================================

declare const __DEV__: boolean;

import { createWMTSSource } from '../packages/source-wmts/src/index.ts';
import { createWMSSource } from '../packages/source-wms/src/index.ts';
import { createWFSSource } from '../packages/source-wfs/src/index.ts';
import { createPMTilesSource } from '../packages/source-pmtiles/src/index.ts';
import { createMobileOptimizer } from '../packages/compat-mobile/src/index.ts';
import { createHiDPIAdapter } from '../packages/compat-hidpi/src/index.ts';
import { booleanOps } from '../packages/analysis/src/boolean/index.ts';
import { bufferOps } from '../packages/analysis/src/buffer/index.ts';
import { interpolationOps } from '../packages/analysis/src/interpolation/index.ts';
import { classificationOps } from '../packages/analysis/src/classification/index.ts';
import { gridOps } from '../packages/analysis/src/grid/index.ts';
import { rasterOps } from '../packages/analysis/src/raster/index.ts';
import { transformOps } from '../packages/analysis/src/transform/index.ts';
import { aggregationOps } from '../packages/analysis/src/aggregation/index.ts';
import { topologyOps } from '../packages/analysis/src/topology/index.ts';

import type { Feature, FeatureCollection } from '../packages/core/src/types/feature.ts';
import type { PolygonGeometry, PointGeometry } from '../packages/core/src/types/geometry.ts';
import type { BBox2D } from '../packages/core/src/types/math-types.ts';
import type { GPUCapabilities } from '../packages/compat-mobile/src/index.ts';
import type { DEMData } from '../packages/analysis/src/raster/index.ts';

// ============================================================
// 测试结果收集（与 demo-p1 / demo-p2 相同模式）
// ============================================================

interface TestResult {
    name: string;
    pass: boolean;
    detail: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => string): void {
    try {
        const detail = fn();
        results.push({ name, pass: true, detail });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ name, pass: false, detail: msg });
    }
}

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(msg);
}

// ============================================================
// 各包单测
// ============================================================

test('WMTSSource: type wmts', () => {
    const src = createWMTSSource({
        url: 'https://example.com/wmts',
        layer: 'layer',
        matrixSet: 'EPSG:3857',
    });
    assert(src.type === 'wmts', `expected type 'wmts', got '${src.type}'`);
    return `type=${src.type}`;
});

test('WMSSource: type wms', () => {
    const src = createWMSSource({
        url: 'https://example.com/wms',
        layers: 'layer',
    });
    assert(src.type === 'wms', `expected type 'wms', got '${src.type}'`);
    return `type=${src.type}`;
});

test('WFSSource: type wfs', () => {
    const src = createWFSSource({
        url: 'https://example.com/wfs',
        typeName: 'ns:layer',
    });
    assert(src.type === 'wfs', `expected type 'wfs', got '${src.type}'`);
    return `type=${src.type}`;
});

test('PMTilesSource: type pmtiles', () => {
    const src = createPMTilesSource({
        url: 'https://example.com/tiles.pmtiles',
    });
    assert(src.type === 'pmtiles', `expected type 'pmtiles', got '${src.type}'`);
    return `type=${src.type}`;
});

test('MobileOptimizer: mock GPU → profile', () => {
    const opt = createMobileOptimizer({ autoDetect: false });
    const caps: GPUCapabilities = {
        adapterDescription: 'Test GPU',
        vendor: 'test',
        maxTextureSize: 8192,
        supportsCompute: true,
        supportsFloat32Filter: true,
        supportsTimestampQuery: false,
        estimatedMemoryMB: 8192,
    };
    const profile = opt.detect(caps);
    assert(profile.level === 'high', `expected high tier, got '${profile.level}'`);
    assert(profile.gpu === 'Test GPU', 'gpu string');
    return `level=${profile.level}, gpu=${profile.gpu}`;
});

test('HiDPIAdapter: DPR + evaluate FPS', () => {
    const adapter = createHiDPIAdapter({
        dynamicResolution: true,
        fpsThreshold: 30,
        minResolutionScale: 0.5,
        degradeRate: 0.05,
        restoreRate: 0.02,
    });
    const dpr = adapter.getRecommendedDPR();
    assert(isFinite(dpr) && dpr > 0, 'getRecommendedDPR');
    adapter.startDynamicResolution();
    const ok = adapter.evaluate(60, 4);
    assert(ok.changed === false && ok.scale === 1, `evaluate(60): changed=${ok.changed}, scale=${ok.scale}`);
    const low = adapter.evaluate(20, 4);
    assert(low.changed === true && low.scale < 1, `evaluate(20): changed=${low.changed}, scale=${low.scale}`);
    return `dpr≈${dpr.toFixed(2)}, evaluate(60) unchanged, evaluate(20) scale=${low.scale.toFixed(3)}`;
});

test('BooleanOps: intersection of overlapping squares', () => {
    const square = (x0: number, y0: number, x1: number, y1: number): Feature<PolygonGeometry> => ({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
        },
        properties: {},
    });
    const a = square(0, 0, 2, 2);
    const b = square(1, 1, 3, 3);
    const inter = booleanOps.intersection(a, b);
    assert(inter !== null && inter.geometry.type === 'Polygon', 'intersection');
    const ring = inter!.geometry.coordinates[0]!;
    assert(ring.length >= 4, 'ring vertices');
    return `intersection ring length=${ring.length}`;
});

test('BufferOps: pointBuffer vertex count', () => {
    const pt: Feature<PointGeometry> = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
    };
    const steps = 8;
    const buf = bufferOps.pointBuffer(pt, 1000, steps);
    assert(buf !== null && buf.geometry.type === 'Polygon', 'buffer');
    const ring = buf!.geometry.coordinates[0]!;
    assert(ring.length === steps + 1, `expected ${steps + 1} ring positions (close), got ${ring.length}`);
    return `ring.length=${ring.length} (steps=${steps})`;
});

test('InterpolationOps: bilinear 2×2 corners', () => {
    const v = interpolationOps.bilinear(0, 1, 2, 3, 0.5, 0.5);
    assert(Math.abs(v - 1.5) < 1e-10, `expected 1.5, got ${v}`);
    return `bilinear(0,1,2,3,0.5,0.5)=${v}`;
});

test('ClassificationOps: jenks breaks', () => {
    const breaks = classificationOps.jenks([1, 2, 3, 10, 11, 12], 2);
    assert(breaks.length >= 3, 'breaks length');
    assert(breaks[0]! <= 1 && breaks[breaks.length - 1]! >= 12, 'span');
    const mid = breaks[1]!;
    assert(mid >= 3 && mid <= 10, `reasonable split near low/high gap, mid=${mid}`);
    return `breaks=[${breaks.map(x => x.toFixed(2)).join(', ')}]`;
});

test('GridOps: squareGrid features', () => {
    const bbox: BBox2D = { west: 0, south: 0, east: 1, north: 1 };
    const fc = gridOps.squareGrid(bbox, 0.25);
    assert(fc.features.length > 0, 'features');
    assert(fc.features[0]!.geometry.type === 'Polygon', 'polygon');
    return `features=${fc.features.length}`;
});

test('RasterOps: flat DEM slope all zero', () => {
    const n = 5;
    const values: number[][] = [];
    for (let r = 0; r < n; r++) {
        const row: number[] = [];
        for (let c = 0; c < n; c++) row.push(100);
        values.push(row);
    }
    const dem: DEMData = {
        values,
        rows: n,
        cols: n,
        bbox: { west: 0, south: 0, east: 100, north: 100 },
        cellSizeM: 25,
    };
    const slope = rasterOps.slope(dem, 1);
    for (let r = 0; r < slope.rows; r++) {
        for (let c = 0; c < slope.cols; c++) {
            const z = slope.values[r]![c]!;
            if (r === 0 || r === slope.rows - 1 || c === 0 || c === slope.cols - 1) {
                assert(isNaN(z), 'border NaN');
            } else {
                assert(Math.abs(z) < 1e-6, `interior slope ${z} at ${r},${c}`);
            }
        }
    }
    return 'interior slopes ~0';
});

test('TransformOps: translate point', () => {
    const f: Feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [10, 20] },
        properties: {},
    };
    const out = transformOps.translate(f, 3, -4);
    const g = out.geometry;
    assert(g.type === 'Point', 'point');
    const coords = g.type === 'Point' ? g.coordinates : [0, 0];
    assert(Math.abs(coords[0] - 13) < 1e-10 && Math.abs(coords[1] - 16) < 1e-10, 'coords');
    return `[${coords[0]}, ${coords[1]}]`;
});

test('AggregationOps: sum', () => {
    const poly: FeatureCollection<PolygonGeometry> = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
                },
                properties: {},
            },
        ],
    };
    const pts: FeatureCollection<PointGeometry> = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [5, 5] },
                properties: { v: 7 },
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [2, 2] },
                properties: { v: 3 },
            },
        ],
    };
    const out = aggregationOps.sum(poly, pts, 'v');
    assert(out.features[0]!.properties!.sum === 10, 'sum');
    return `sum=${out.features[0]!.properties!.sum}`;
});

test('TopologyOps: booleanContains square / point', () => {
    const poly: Feature<PolygonGeometry> = {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
        },
        properties: {},
    };
    const inside: Feature<PointGeometry> = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [2, 2] },
        properties: {},
    };
    assert(topologyOps.booleanContains(poly, inside), 'contains');
    return 'square contains inner point';
});

// ============================================================
// 渲染结果到 DOM（#test-results / #stats）
// ============================================================

function renderResults(): void {
    const container = document.getElementById('test-results');
    if (!container) return;

    let passed = 0;
    let failed = 0;

    for (const r of results) {
        if (r.pass) passed++;
        else failed++;

        const el = document.createElement('div');
        el.className = `test-item ${r.pass ? 'pass' : 'fail'}`;
        el.innerHTML = `
            <span class="icon">${r.pass ? '✓' : '✗'}</span>
            <span class="name">${r.name}</span>
            <span class="detail">${r.detail}</span>
        `;
        container.appendChild(el);
    }

    const stats = document.getElementById('stats');
    if (stats) {
        stats.innerHTML = `
            <span class="stat pass">${passed} passed</span>
            ${failed > 0 ? `<span class="stat fail">${failed} failed</span>` : ''}
            <span class="stat total">${results.length} total</span>
        `;
    }
}

// ============================================================
// 山影可视化：32×32 高斯峰 DEM → RasterOps.hillshade → Canvas
// ============================================================

const HILL_VIZ_SIZE = 32;

/**
 * 构建中心高斯峰 DEM（米），用于山影演示。
 */
function buildGaussianPeakDem(size: number): DEMData {
    const values: number[][] = [];
    const cx = (size - 1) * 0.5;
    const cy = (size - 1) * 0.5;
    const sigma = size * 0.18;
    for (let r = 0; r < size; r++) {
        const row: number[] = [];
        for (let c = 0; c < size; c++) {
            const dx = c - cx;
            const dy = r - cy;
            const z = 500 * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
            row.push(z);
        }
        values.push(row);
    }
    const spanM = 320;
    return {
        values,
        rows: size,
        cols: size,
        bbox: { west: 0, south: 0, east: spanM, north: spanM },
        cellSizeM: spanM / size,
    };
}

/**
 * 将 hillshade DEM（0–255）绘制到 canvas，最近邻放大。
 */
function drawHillshadeCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    const dem = buildGaussianPeakDem(HILL_VIZ_SIZE);
    const hs = rasterOps.hillshade(dem, { azimuth: 315, altitude: 45, zFactor: 1 });
    const w = hs.cols;
    const h = hs.rows;
    const scale = 8;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            const v = hs.values[r]![c]!;
            const gray = isNaN(v) ? 0 : Math.max(0, Math.min(255, v));
            const o = (r * w + c) * 4;
            d[o] = gray;
            d[o + 1] = gray;
            d[o + 2] = gray;
            d[o + 3] = 255;
        }
    }
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    tctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, w * scale, h * scale);
}

function init(): void {
    renderResults();
    drawHillshadeCanvas(document.getElementById('hillshade-canvas') as HTMLCanvasElement | null);
    console.log('[GeoForge P3 MVP] all tests complete');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
