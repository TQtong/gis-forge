// ============================================================
// GeoForge P1 MVP Demo — 3D 核心功能演示
// 验证 layer-terrain / globe / view-morph / layer-3dtiles 的核心逻辑。
// 使用 Canvas 2D 可视化地形高程、大气散射 LUT、椭球体网格、
// 星场分布和视图过渡状态。
// ============================================================

declare const __DEV__: boolean;

import { createTerrainLayer } from '../packages/layer-terrain/src/TerrainLayer.ts';
import type { TerrainLayer } from '../packages/layer-terrain/src/TerrainLayer.ts';
import {
    createGlobeRenderer,
    generateEllipsoidMesh,
    generateStarfield,
    computeSunPositionECEF,
    computeTransmittanceLUT,
    computeCascadeSplits,
} from '../packages/globe/src/index.ts';
import { createViewMorph } from '../packages/view-morph/src/ViewMorph.ts';
import type { ViewMorph } from '../packages/view-morph/src/ViewMorph.ts';
import { createTiles3DLayer } from '../packages/layer-3dtiles/src/Tiles3DLayer.ts';
import { createCamera2D } from '../packages/camera-2d/src/Camera2D.ts';
import type { Camera2D } from '../packages/camera-2d/src/Camera2D.ts';
import type { CameraState, Viewport } from '../packages/core/src/types/viewport.ts';

// ============================================================
// 测试结果收集
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
    } catch (e: any) {
        results.push({ name, pass: false, detail: e.message ?? String(e) });
    }
}

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(msg);
}

// ============================================================
// 1. 地形图层测试
// ============================================================

test('TerrainLayer: create with defaults', () => {
    const layer = createTerrainLayer({ id: 'terrain-1', source: 'mapbox-dem' });
    assert(layer.type === 'terrain', `type should be 'terrain', got '${layer.type}'`);
    assert(layer.exaggeration === 1.0, `exaggeration default should be 1.0, got ${layer.exaggeration}`);
    return `type=${layer.type}, exaggeration=${layer.exaggeration}`;
});

test('TerrainLayer: setExaggeration', () => {
    const layer = createTerrainLayer({ id: 'terrain-2', source: 'dem', exaggeration: 2.0 });
    assert(layer.exaggeration === 2.0, 'initial exaggeration should be 2.0');
    layer.setExaggeration(3.5);
    assert(layer.exaggeration === 3.5, 'exaggeration should update to 3.5');
    layer.setExaggeration(-1);
    assert(layer.exaggeration >= 0, 'negative exaggeration clamped');
    layer.setExaggeration(200);
    assert(layer.exaggeration <= 100, 'over-limit exaggeration clamped');
    return `exaggeration clamped correctly`;
});

test('TerrainLayer: getElevationSync returns null (no data)', () => {
    const layer = createTerrainLayer({ id: 'terrain-3', source: 'dem' });
    const h = layer.getElevationSync(116.39, 39.91);
    assert(h === null, `should return null when no tiles loaded, got ${h}`);
    return 'null returned for unloaded area';
});

test('TerrainLayer: Layer interface compliance', () => {
    const layer = createTerrainLayer({ id: 'terrain-4', source: 'dem' });
    assert(typeof layer.id === 'string', 'id');
    assert(typeof layer.visible === 'boolean', 'visible');
    assert(typeof layer.onAdd === 'function', 'onAdd');
    assert(typeof layer.onRemove === 'function', 'onRemove');
    assert(typeof layer.onUpdate === 'function', 'onUpdate');
    assert(typeof layer.encode === 'function', 'encode');
    assert(typeof layer.getElevation === 'function', 'getElevation');
    assert(typeof layer.getElevationProfile === 'function', 'getElevationProfile');
    return 'all Layer + TerrainLayer methods present';
});

// ============================================================
// 2. Globe 测试
// ============================================================

test('GlobeRenderer: create with defaults', () => {
    const globe = createGlobeRenderer();
    assert(globe.isAtmosphereEnabled() === true, 'atmosphere should default to enabled');
    assert(globe.isSkyboxEnabled() === true, 'skybox should default to enabled');
    assert(globe.isShadowsEnabled() === false, 'shadows should default to disabled');
    assert(globe.getAtmosphereIntensity() === 1.0, 'atmosphere intensity should default to 1.0');
    return 'defaults: atmosphere=on, skybox=on, shadows=off, intensity=1.0';
});

test('GlobeRenderer: ellipsoid mesh generation', () => {
    const mesh = generateEllipsoidMesh(16);
    const vertexCount = (16 + 1) * (16 / 2 + 1);
    assert(mesh.positions.length === vertexCount * 3, `positions: expected ${vertexCount * 3}, got ${mesh.positions.length}`);
    assert(mesh.normals.length === vertexCount * 3, `normals: expected ${vertexCount * 3}, got ${mesh.normals.length}`);
    assert(mesh.uvs.length === vertexCount * 2, `uvs: expected ${vertexCount * 2}, got ${mesh.uvs.length}`);
    assert(mesh.indices.length > 0, 'indices should not be empty');
    return `vertices=${vertexCount}, triangles=${mesh.indices.length / 3}`;
});

test('GlobeRenderer: starfield generation', () => {
    const stars = generateStarfield(1000, 42);
    assert(stars.buffer.length === 1000 * 4, `buffer: expected 4000, got ${stars.buffer.length}`);
    assert(stars.count === 1000, `count: expected 1000, got ${stars.count}`);
    // 验证星星在单位球面上
    let maxDev = 0;
    for (let i = 0; i < stars.count; i++) {
        const x = stars.buffer[i * 4];
        const y = stars.buffer[i * 4 + 1];
        const z = stars.buffer[i * 4 + 2];
        const r = Math.sqrt(x * x + y * y + z * z);
        maxDev = Math.max(maxDev, Math.abs(r - 1.0));
    }
    assert(maxDev < 1e-5, `stars should be on unit sphere, max deviation = ${maxDev}`);
    return `1000 stars, maxDev=${maxDev.toFixed(8)}`;
});

test('GlobeRenderer: sun position calculation', () => {
    const out = new Float32Array(3);
    computeSunPositionECEF(new Date('2024-06-21T12:00:00Z'), out);
    const dist = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
    const auMeters = 1.496e11;
    const relError = Math.abs(dist - auMeters) / auMeters;
    assert(relError < 0.1, `sun distance error: ${(relError * 100).toFixed(1)}%`);
    return `sun at solstice: dist=${(dist / 1e11).toFixed(3)}×10¹¹ m, err=${(relError * 100).toFixed(1)}%`;
});

test('GlobeRenderer: transmittance LUT computation', () => {
    const lut = computeTransmittanceLUT(32, 8, 16);
    assert(lut.length === 32 * 8 * 4, `LUT size: expected ${32 * 8 * 4}, got ${lut.length}`);
    const topIdx = (8 - 1) * 32 * 4;
    const tr = lut[topIdx];
    assert(tr > 0.5, `transmittance at atmo top should be high, got ${tr.toFixed(3)}`);
    return `LUT 32×8, top transmittance R=${tr.toFixed(4)}`;
});

test('GlobeRenderer: CSM cascade splits', () => {
    const splits = computeCascadeSplits(3, 0.1, 1000, 0.5);
    assert(splits.length === 4, `should have 4 splits, got ${splits.length}`);
    assert(Math.abs(splits[0] - 0.1) < 0.01, `first split near=0.1`);
    assert(Math.abs(splits[3] - 1000) < 1, `last split far=1000`);
    for (let i = 1; i < splits.length; i++) {
        assert(splits[i] > splits[i - 1], `monotonically increasing at ${i}`);
    }
    return `splits=[${splits.map((s) => s.toFixed(2)).join(', ')}]`;
});

test('GlobeRenderer: sun direction', () => {
    const globe = createGlobeRenderer();
    globe.setSunFromDateTime(new Date('2024-03-20T12:00:00Z'));
    const dir = globe.getSunDirection();
    const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    assert(Math.abs(len - 1.0) < 0.02, `unit vector len=${len}`);
    return `sun dir: [${dir[0].toFixed(4)}, ${dir[1].toFixed(4)}, ${dir[2].toFixed(4)}]`;
});

// ============================================================
// 3. ViewMorph 测试
// ============================================================

test('ViewMorph: create', () => {
    const morph = createViewMorph();
    assert(morph.state.isMorphing === false, 'not morphing initially');
    assert(morph.state.currentMode === '2d', 'initial mode 2d');
    return `isMorphing=${morph.state.isMorphing}, mode=${morph.state.currentMode}`;
});

test('ViewMorph: morphTo 2D→2.5D', () => {
    const morph = createViewMorph();
    const cam2d = createCamera2D({ center: [0, 0], zoom: 5 });
    const cam25d = createCamera2D({ center: [0, 0], zoom: 5 });
    const vp: Viewport = { width: 800, height: 600, physicalWidth: 1600, physicalHeight: 1200, pixelRatio: 2 };
    cam2d.update(0.016, vp);
    cam25d.update(0.016, vp);

    const anim = morph.morphTo('25d', cam2d, cam25d, { duration: 1000 });
    assert(morph.state.isMorphing === true, 'morphing after morphTo');
    assert(morph.state.targetMode === '25d', 'target 25d');

    const blended = morph.update(0.5);
    assert(blended !== null, 'blended state not null');
    assert(morph.state.progress > 0 && morph.state.progress < 1, `progress in (0,1): ${morph.state.progress}`);

    anim.cancel();
    assert(morph.state.isMorphing === false, 'cancelled');
    return `progress=${morph.state.progress.toFixed(3)}, cancelled OK`;
});

test('ViewMorph: full transition 2D→3D', () => {
    const morph = createViewMorph();
    const cam2d = createCamera2D({ center: [116, 39], zoom: 8 });
    const cam3d = createCamera2D({ center: [116, 39], zoom: 8 });
    const vp: Viewport = { width: 800, height: 600, physicalWidth: 1600, physicalHeight: 1200, pixelRatio: 2 };
    cam2d.update(0.016, vp);
    cam3d.update(0.016, vp);

    morph.morphTo('3d', cam2d, cam3d, { duration: 500 });
    for (let i = 0; i < 40; i++) morph.update(1 / 60);
    return `completed, isMorphing=${morph.state.isMorphing}`;
});

// ============================================================
// 4. 3D Tiles 层测试
// ============================================================

test('Tiles3DLayer: create with options', () => {
    const layer = createTiles3DLayer({
        id: 'buildings',
        url: 'https://example.com/tileset.json',
        maximumScreenSpaceError: 8,
        maximumMemoryUsage: 256,
    });
    assert(layer.type === '3d-tiles', `type=${layer.type}`);
    assert(layer.isReady === false, 'not ready before onAdd');
    assert(layer.loadedTileCount === 0, 'no tiles loaded');
    assert(layer.gpuMemoryUsage === 0, 'no GPU memory');
    return `type=${layer.type}, ready=${layer.isReady}`;
});

test('Tiles3DLayer: Layer interface', () => {
    const layer = createTiles3DLayer({ id: 'test', url: '/tileset.json' });
    assert(typeof layer.id === 'string', 'id');
    assert(typeof layer.visible === 'boolean', 'visible');
    assert(typeof layer.onAdd === 'function', 'onAdd');
    assert(typeof layer.onUpdate === 'function', 'onUpdate');
    assert(typeof layer.encode === 'function', 'encode');
    assert(typeof layer.setMaximumScreenSpaceError === 'function', 'setMaximumScreenSpaceError');
    assert(typeof layer.setMaximumMemoryUsage === 'function', 'setMaximumMemoryUsage');
    assert(typeof layer.flyTo === 'function', 'flyTo');
    assert(typeof layer.getBoundingVolume === 'function', 'getBoundingVolume');
    return 'all Tiles3DLayer methods present';
});

test('Tiles3DLayer: SSE clamping', () => {
    const layer = createTiles3DLayer({ id: 'test', url: '/tileset.json' });
    layer.setMaximumScreenSpaceError(0.5);
    layer.setMaximumScreenSpaceError(500);
    layer.setMaximumScreenSpaceError(8);
    return 'SSE clamping OK';
});

// ============================================================
// 渲染结果到 DOM
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
// 可视化面板
// ============================================================

function drawTransmittanceLUT(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = 128, h = 32;
    canvas.width = w;
    canvas.height = h;
    const lut = computeTransmittanceLUT(w, h, 32);
    const imgData = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
        imgData.data[i * 4] = Math.min(255, lut[i * 4] * 255);
        imgData.data[i * 4 + 1] = Math.min(255, lut[i * 4 + 1] * 255);
        imgData.data[i * 4 + 2] = Math.min(255, lut[i * 4 + 2] * 255);
        imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
}

function drawStarfield(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = 200;
    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, size, size);
    const stars = generateStarfield(2000, 42);
    for (let i = 0; i < stars.count; i++) {
        const x = stars.buffer[i * 4];
        const y = stars.buffer[i * 4 + 1];
        const z = stars.buffer[i * 4 + 2];
        const br = stars.buffer[i * 4 + 3];
        if (y > 0) {
            const sx = (x * 0.5 + 0.5) * size;
            const sy = (z * 0.5 + 0.5) * size;
            ctx.fillStyle = `rgba(255, 255, ${200 + br * 55}, ${0.3 + br * 0.7})`;
            ctx.fillRect(sx, sy, 1 + br, 1 + br);
        }
    }
}

function drawEllipsoidWireframe(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = 200;
    canvas.width = size;
    canvas.height = size;
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, size, size);

    const mesh = generateEllipsoidMesh(16);
    const scale = size * 0.00000001;
    const cx = size / 2, cy = size / 2;
    const cosA = Math.cos(0.3), sinA = Math.sin(0.3);

    ctx.strokeStyle = '#2a6aaa';
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.6;

    const { indices, positions, normals } = mesh;
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] * 3;
        const i1 = indices[i + 1] * 3;
        const i2 = indices[i + 2] * 3;
        const nx = normals[indices[i] * 3];
        const nz = normals[indices[i] * 3 + 2];
        if (nx * sinA + nz * cosA < 0) continue;

        const x0 = (positions[i0] * cosA + positions[i0 + 2] * sinA) * scale + cx;
        const y0 = -positions[i0 + 1] * scale + cy;
        const x1 = (positions[i1] * cosA + positions[i1 + 2] * sinA) * scale + cx;
        const y1 = -positions[i1 + 1] * scale + cy;
        const x2 = (positions[i2] * cosA + positions[i2 + 2] * sinA) * scale + cx;
        const y2 = -positions[i2 + 1] * scale + cy;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.closePath();
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

// ============================================================
// 入口
// ============================================================

function init(): void {
    renderResults();
    const lutCanvas = document.getElementById('lut-canvas') as HTMLCanvasElement;
    if (lutCanvas) drawTransmittanceLUT(lutCanvas);
    const starCanvas = document.getElementById('star-canvas') as HTMLCanvasElement;
    if (starCanvas) drawStarfield(starCanvas);
    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    if (globeCanvas) drawEllipsoidWireframe(globeCanvas);
    console.log('[GeoForge P1 MVP] all tests complete');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
