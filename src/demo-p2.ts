// ============================================================
// GeoForge P2 Enhancement MVP Demo — 热力图 / 点云 / 标记 / 拉伸 /
// 绘制·测量·选择交互 / Bloom·SSAO·Shadow 后处理包自检。
// 将测试结果写入 DOM，并用 Canvas 2D 展示 BloomPass CPU 管线效果。
// ============================================================

declare const __DEV__: boolean;

import { createHeatmapLayer } from '../packages/layer-heatmap/src/index.ts';
import { createPointCloudLayer } from '../packages/layer-pointcloud/src/index.ts';
import { createMarkerLayer } from '../packages/layer-marker/src/index.ts';
import { createExtrusionLayer } from '../packages/layer-extrusion/src/index.ts';
import { createDrawTool } from '../packages/interaction-draw/src/index.ts';
import { createMeasureTool } from '../packages/interaction-measure/src/index.ts';
import { createSelectTool } from '../packages/interaction-select/src/index.ts';
import { createBloomPass } from '../packages/postprocess-bloom/src/index.ts';
import { createSSAOPass } from '../packages/postprocess-ssao/src/index.ts';
import { createShadowPass } from '../packages/postprocess-shadow/src/index.ts';

// ============================================================
// 测试结果收集（与 demo-p1.ts 相同模式）
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

/** WGS84 平均地球半径（米），与 MeasureTool 内部常量一致，用于独立校验 Haversine */
const EARTH_RADIUS_M = 6371008.8;

/**
 * 计算两点间大圆距离（米），用于与 MeasureTool.getResult().distance 对照。
 *
 * @param a - 起点 [lng, lat]（度）
 * @param b - 终点 [lng, lat]（度）
 * @returns 距离（米）
 */
function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad;
    const dLng = (b[0] - a[0]) * toRad;
    const lat1 = a[1] * toRad;
    const lat2 = b[1] * toRad;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
    const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    return EARTH_RADIUS_M * c;
}

// ============================================================
// 各包单测（每包一项）
// ============================================================

test('HeatmapLayer: defaults + setRadius', () => {
    const layer = createHeatmapLayer({ id: 'heat-p2', source: 'points-src' });
    assert(layer.type === 'heatmap', `type should be 'heatmap', got '${layer.type}'`);
    assert(typeof layer.setRadius === 'function', 'setRadius should exist');
    layer.setRadius(42);
    return `type=${layer.type}, setRadius OK`;
});

test('PointCloudLayer: type + setColorMode / setPointSize', () => {
    const layer = createPointCloudLayer({ id: 'pc-p2', source: 'las-src' });
    assert(layer.type === 'pointcloud', `type should be 'pointcloud', got '${layer.type}'`);
    assert(typeof layer.setColorMode === 'function', 'setColorMode');
    assert(typeof layer.setPointSize === 'function', 'setPointSize');
    layer.setColorMode('height');
    layer.setPointSize(4);
    return `type=${layer.type}, colorMode=height, pointSize=4`;
});

test('MarkerLayer: addMarker / getMarker / removeMarker / markerCount', () => {
    const layer = createMarkerLayer({ id: 'markers-p2' });
    assert(layer.markerCount() === 0, 'initial count 0');
    layer.addMarker({ id: 'mk1', lngLat: [116.39, 39.91], label: 'A' });
    assert(layer.markerCount() === 1, 'count after add');
    const m = layer.getMarker('mk1');
    assert(m !== undefined && m.id === 'mk1', 'getMarker');
    layer.removeMarker('mk1');
    assert(layer.markerCount() === 0, 'count after remove');
    return 'CRUD + markerCount OK';
});

test('ExtrusionLayer: type fill-extrusion + setLight', () => {
    const layer = createExtrusionLayer({ id: 'ext-p2', source: 'buildings' });
    assert(layer.type === 'fill-extrusion', `type got '${layer.type}'`);
    assert(typeof layer.setLight === 'function', 'setLight');
    layer.setLight({ anchor: 'viewport', intensity: 0.8, position: [1.2, 210, 30] });
    return `type=${layer.type}, setLight OK`;
});

test('DrawTool: mode / setMode / isDrawing initially false', () => {
    const draw = createDrawTool({ mode: 'polygon' });
    assert(draw.mode === 'polygon', 'initial mode');
    assert(draw.isDrawing === false, 'not drawing initially');
    draw.setMode('line');
    assert(draw.mode === 'line', 'setMode');
    return `mode=${draw.mode}, isDrawing=${draw.isDrawing}`;
});

test('MeasureTool: distance mode + Haversine vs getResult', () => {
    const measure = createMeasureTool({ mode: 'distance' });
    assert(measure.mode === 'distance', 'mode');
    assert(measure.isMeasuring === false, 'not measuring initially');
    const p0: [number, number] = [11.58, 48.14];
    const p1: [number, number] = [11.59, 48.14];
    measure.handlePointerDown(100, 100, p0);
    measure.handlePointerDown(110, 100, p1);
    const expected = haversineMeters(p0, p1);
    const res = measure.getResult();
    assert(res.distance !== undefined, 'distance in result');
    const err = Math.abs(res.distance! - expected);
    assert(err < 1.0, `Haversine mismatch: got ${res.distance}, expected ~${expected}, err=${err}`);
    return `distance=${res.distance!.toFixed(2)} m (expect ~${expected.toFixed(2)} m)`;
});

test('SelectTool: selectedCount + selectFeatures / clearSelection', () => {
    const sel = createSelectTool({ mode: 'click' });
    assert(sel.selectedCount === 0, 'initial 0');
    sel.selectFeatures(['f1', 'f2']);
    assert(sel.selectedCount === 2, 'after selectFeatures');
    sel.clearSelection();
    assert(sel.selectedCount === 0, 'after clear');
    return 'select/clear OK';
});

test('BloomPass: id bloom + enabled + setThreshold / setIntensity', () => {
    const bloom = createBloomPass();
    assert(bloom.id === 'bloom', `id=${bloom.id}`);
    assert(bloom.enabled === true, 'enabled default true');
    bloom.setThreshold(0.5);
    bloom.setIntensity(1.5);
    return `id=${bloom.id}, threshold/intensity set`;
});

test('SSAOPass: id ssao + setRadius / setKernelSize', () => {
    const ssao = createSSAOPass();
    assert(ssao.id === 'ssao', `id=${ssao.id}`);
    ssao.setRadius(0.75);
    ssao.setKernelSize(64);
    return `id=${ssao.id}, radius/kernel OK`;
});

test('ShadowPass: id shadow + setLightDirection / setBlurRadius', () => {
    const shadow = createShadowPass();
    assert(shadow.id === 'shadow', `id=${shadow.id}`);
    shadow.setLightDirection([0.3, 0.7, -0.6]);
    shadow.setBlurRadius(8);
    return `id=${shadow.id}, light/blur OK`;
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
// Bloom CPU 可视化：32×32 输入 + BloomPass.execute → Canvas
// ============================================================

const BLOOM_VIZ_SIZE = 32;

/**
 * 构建带中心亮斑的线性 RGBA 图像（Float32），背景暗、中心高亮以触发阈值提取与模糊。
 *
 * @returns 长度 BLOOM_VIZ_SIZE²×4 的输入缓冲
 */
function buildBloomTestInput(): Float32Array {
    const w = BLOOM_VIZ_SIZE;
    const h = BLOOM_VIZ_SIZE;
    const buf = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            buf[i] = 0.03;
            buf[i + 1] = 0.04;
            buf[i + 2] = 0.06;
            buf[i + 3] = 1.0;
        }
    }
    const cx = 16;
    const cy = 16;
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || x >= w || y < 0 || y >= h) continue;
            const i = (y * w + x) * 4;
            buf[i] = 2.8;
            buf[i + 1] = 2.6;
            buf[i + 2] = 3.2;
            buf[i + 3] = 1.0;
        }
    }
    return buf;
}

/**
 * 将 Float32 RGBA（线性近似）转为 ImageData（sRGB 字节），超 1.0 的值钳制到 255。
 *
 * @param src - RGBA float 缓冲
 * @param w - 宽
 * @param h - 高
 * @returns ImageData
 */
function floatRGBAtoImageData(src: Float32Array, w: number, h: number): ImageData {
    const img = new ImageData(w, h);
    const d = img.data;
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        d[o] = Math.max(0, Math.min(255, Math.round(src[o] * 255)));
        d[o + 1] = Math.max(0, Math.min(255, Math.round(src[o + 1] * 255)));
        d[o + 2] = Math.max(0, Math.min(255, Math.round(src[o + 2] * 255)));
        d[o + 3] = 255;
    }
    return img;
}

/**
 * 在目标 canvas 上绘制小分辨率像素图并放大（最近邻），便于观察 Bloom。
 *
 * @param canvas - 展示用 canvas（显示尺寸由 CSS 或此处设定）
 * @param imageData - 小图
 * @param scale - 整数放大倍数
 */
function blitPixelated(canvas: HTMLCanvasElement, imageData: ImageData, scale: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = imageData.width;
    const h = imageData.height;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    tctx.putImageData(imageData, 0, 0);
    canvas.width = w * scale;
    canvas.height = h * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, w * scale, h * scale);
}

/**
 * 绘制 Bloom 管线输入与输出对比。
 */
function drawBloomVisualization(): void {
    const inputCanvas = document.getElementById('bloom-input-canvas') as HTMLCanvasElement | null;
    const outputCanvas = document.getElementById('bloom-output-canvas') as HTMLCanvasElement | null;
    if (!inputCanvas || !outputCanvas) return;

    const w = BLOOM_VIZ_SIZE;
    const h = BLOOM_VIZ_SIZE;
    const input = buildBloomTestInput();
    const inputImg = floatRGBAtoImageData(input, w, h);
    blitPixelated(inputCanvas, inputImg, 8);

    const bloom = createBloomPass({
        threshold: 0.35,
        intensity: 1.25,
        radius: 0.65,
        blurIterations: 5,
    });
    const output = new Float32Array(w * h * 4);
    bloom.execute(input, null, output, w, h);
    const outputImg = floatRGBAtoImageData(output, w, h);
    blitPixelated(outputCanvas, outputImg, 8);
}

// ============================================================
// 入口
// ============================================================

function init(): void {
    renderResults();
    drawBloomVisualization();
    console.log('[GeoForge P2 MVP] all tests complete');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
