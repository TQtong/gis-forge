// Run with Playwright installed, or set PLAYWRIGHT_PATH to its package directory.
// Start `npm run dev` first. This check uses the real configured terrain and OSM services.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  const output = path.resolve(__dirname, '../../artifacts/terrain25d.local');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', error => failures.push(String(error)));
    await page.goto(`${process.env.TEST_BASE_URL || 'http://localhost:3010'}/tests/browser/terrain25d.html`);
    await page.waitForFunction(() => window.mapReady, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.gpuErrors = [];
      window.frameCount = 0;
      window.drawCounts = {};
      map._device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
      map.on('render', () => window.frameCount++);
      const draw = GPURenderPassEncoder.prototype.drawIndexed;
      GPURenderPassEncoder.prototype.drawIndexed = function (count, ...args) {
        drawCounts[count] = (drawCounts[count] || 0) + 1;
        return draw.call(this, count, ...args);
      };
    });
    await page.waitForFunction(() => map._terrainSource()?.sampleElevation(115.96, 40.46) > 0, null, { timeout: 30000 });
    const results = [];
    for (const [name, center, zoom, pitch, bearing] of [
      ['mountain85', [115.96, 40.46], 13, 85, 0],
      ['close85', [115.96, 40.46], 17, 85, 180],
      ['downhill22', [116.0399, 40.0467], 22, 48.7, 218],
      ['stationary13', [115.8647, 39.895], 13, 0, 280.5],
      ['outside', [-74.006, 40.7128], 11, 65, 0],
      ['return', [115.96, 40.46], 13, 75, 270],
    ]) {
      if (name === 'stationary13') { await page.setViewportSize({ width: 1560, height: 1200 }); }
      await page.evaluate(({ center, zoom, pitch, bearing }) => {
        map.jumpTo({ center, zoom }); map.setPitch(pitch); map.setBearing(bearing);
        window.drawCounts = {}; window.frameCount = 0;
      }, { center, zoom, pitch, bearing });
      await page.waitForTimeout(5000);
      if (name === 'downhill22') {
        await page.waitForFunction(() => map._terrainSource()?.sampleElevation(116.0399, 40.0467) > 0
          && map._layerInstances.get('terrain').getData().loadingCount === 0, null, { timeout: 30000 });
        await page.waitForTimeout(1000); // Finish the displayed mesh's height transition.
      }
      if (name === 'stationary13') {
        await page.waitForFunction(() => {
          const idle = map._layerInstances.get('terrain').getData().loadingCount === 0
            && map._layerInstances.get('imagery').getData().loadingCount === 0;
          if (!idle) { window.idleSince = 0; return false; }
          window.idleSince ||= performance.now();
          return performance.now() - window.idleSince > 1000;
        }, null, { timeout: 45000 });
      }
      const state = await page.evaluate(() => {
        const camera = map._cameraState, m = camera.viewMatrix;
        const world = 512 * 2 ** camera.zoom;
        const x = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
        const y = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
        const cy = (1 - Math.asinh(Math.tan(camera.center[1] * Math.PI / 180)) / Math.PI) / 2 * world;
        const lng = camera.center[0] + x / world * 360;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy + y) / world))) * 180 / Math.PI;
        return {
          canvasCount: document.querySelectorAll('canvas').length,
          targetElevation: camera.targetElevation, altitude: camera.altitude,
          farMetres: camera.projectionMatrix[14] / camera.projectionMatrix[10]
            * 40075016.68557849 * Math.cos(camera.center[1] * Math.PI / 180) / world,
          clearance: camera.altitude - (map._collisionTerrain(lng, lat) ?? 0),
          draws: drawCounts, frames: frameCount, gpuErrors,
          imagery: map._layerInstances.get('imagery').getData(),
          terrain: map._layerInstances.get('terrain').getData(),
        };
      });
      assert.equal(state.canvasCount, 1);
      assert.equal(state.terrain.surfaceOnly, true);
      assert(state.imagery.visibleCount > 0 && state.imagery.visibleCount <= 200);
      assert.equal(Object.keys(state.draws).length, 1, 'only the unified surface should draw');
      assert(!state.draws[6], 'the old four-vertex ground plane must not draw');
      assert(state.clearance >= 4.99, 'camera must stay at least 5m above the surface');
      assert.deepEqual(state.gpuErrors, []);
      if (name === 'outside') { assert.equal(state.targetElevation, 0); }
      if (name === 'stationary13') {
        const before = await page.screenshot();
        state.stability = await page.evaluate(() => new Promise(resolve => {
          const matrices = new Set(), tileCounts = new Set(), revisions = new Set(), targets = new Set();
          let frames = 0;
          const start = performance.now();
          const sample = () => {
            matrices.add(Array.from(map._cameraState.vpMatrix).join(','));
            tileCounts.add(map._layerInstances.get('imagery').visibleTiles);
            revisions.add(map._terrainSource().revision);
            targets.add(map._cameraState.targetElevation);
            frames++;
            if (performance.now() - start >= 5000) {
              map.off('render', sample);
              resolve({ frames, matrixCount: matrices.size, tileCounts: [...tileCounts], revisionCount: revisions.size, targets: [...targets] });
            }
          };
          map.on('render', sample);
        }));
        const after = await page.screenshot();
        assert.equal(state.stability.revisionCount, 1, 'wait for terrain loading to settle before checking stationary stability');
        assert.equal(state.stability.matrixCount, 1, 'a stationary camera must not oscillate with display LOD');
        assert.equal(state.stability.tileCounts.length, 1, 'stationary tile coverage must not alternate parent/children');
        assert(before.equals(after), 'the settled stationary surface must render identical pixels');
      }
      const screenshot = await page.screenshot({ path: path.join(output, `${name}.png`) });
      if (name === 'downhill22') {
        // Every ray points down here. A dark cleared pixel means missing ground,
        // even if tile counts and draw calls otherwise look healthy.
        const emptyFraction = await page.evaluate(async base64 => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let empty = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 25 && data[i + 1] < 30 && data[i + 2] < 45) { empty++; }
          }
          bitmap.close();
          return empty / (data.length / 4);
        }, screenshot.toString('base64'));
        state.emptyFraction = emptyFraction;
        assert(emptyFraction < 0.001, `downhill terrain must fill the view; ${(emptyFraction * 100).toFixed(2)}% was empty`);
        assert(state.farMetres > state.altitude, 'the far plane must include the valley below the orbit target');
      }
      results.push({ name, ...state });
    }
    // Exercise wheel and pan through the same event handlers used by the application.
    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, -300);
    await page.mouse.down();
    await page.mouse.move(820, 650, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 1800, height: 700 });
    await page.evaluate(() => { map.setLayoutProperty('terrain', 'visibility', 'none'); map.setPitch(65); });
    await page.waitForTimeout(1000);
    assert.deepEqual(await page.evaluate(() => [map._canvas.width, map._canvas.height, map._cameraState.targetElevation]), [1800, 700, 0]);
    await page.evaluate(() => map.setLayoutProperty('terrain', 'visibility', 'visible'));
    await page.waitForTimeout(1000);
    await page.evaluate(() => map.remove());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('canvas').count(), 0);
    assert.deepEqual(await page.evaluate(() => gpuErrors), []);
    assert.deepEqual(failures, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`Browser terrain checks passed (${results.length} camera scenarios, wheel/pan, resize, hide/show, teardown).`);
    console.log(`Screenshots and diagnostics: ${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
