import * as React from 'react';
import {
    Panel,
    PanelGroup,
    PanelResizeHandle,
    type ImperativePanelHandle,
} from 'react-resizable-panels';
import { Globe3D } from '@/packages/preset-3d/src/globe-3d.ts';
import { Map2D, type MapEvent, type MapMouseEvent } from '@/packages/preset-2d/src/map-2d.ts';
import { Map25D } from '@/packages/preset-25d/src/map-25d.ts';
import type { RasterTileLayer } from '@/packages/layer-tile-raster/src/RasterTileLayer.ts';
import { InitLoading, WebGPUError } from '@/components/loading';
import { TopToolbar } from '@/components/layout/TopToolbar';
import { LeftPanel } from '@/components/layout/LeftPanel';
import { RightPanel } from '@/components/layout/RightPanel';
import { MapViewport } from '@/components/layout/MapViewport';
import { StatusBar } from '@/components/layout/StatusBar';
import type { MapViewMode } from '@/components/toolbar/ViewModeSwitch';

/**
 * 加载页最短展示时间（毫秒）。
 * 引擎 `ready()` 往往远小于 500ms 就完成，不设下限时界面会「闪一下」就消失。
 */
const MIN_LOADING_SCREEN_MS = 2500;

function createInitialEngineSteps(): Array<{ label: string; done: boolean }> {
    return [
        { label: '检测 WebGPU 环境', done: false },
        { label: '初始化 GPU 设备与画布', done: false },
        { label: '加载底图与瓦片图层', done: false },
    ];
}

// ════════════════════════════════════════════════════════════════
// 引擎生命周期——按 viewMode 分别初始化 / 销毁
// ════════════════════════════════════════════════════════════════

/** 所有引擎实例的联合引用，便于统一 teardown */
type EngineInstance = Globe3D | Map2D | Map25D;

interface BootContext {
    el: HTMLElement;
    setEngineProgress: React.Dispatch<React.SetStateAction<number>>;
    setEngineSteps: React.Dispatch<React.SetStateAction<Array<{ label: string; done: boolean }>>>;
    setEngineStatus: React.Dispatch<React.SetStateAction<'loading' | 'ready'>>;
    setCursorLabel: React.Dispatch<React.SetStateAction<string>>;
    setZoomLabel: React.Dispatch<React.SetStateAction<string>>;
    setTileCountLabel: React.Dispatch<React.SetStateAction<string>>;
    setFpsLabel: React.Dispatch<React.SetStateAction<string>>;
    setMemLabel: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * 标记步骤完成的辅助：按索引置 done=true
 */
function markStepDone(
    setEngineSteps: React.Dispatch<React.SetStateAction<Array<{ label: string; done: boolean }>>>,
    index: number,
): void {
    setEngineSteps((prev) => {
        const next = [...prev];
        if (next[index]) {
            next[index] = { ...next[index], done: true };
        }
        return next;
    });
}

// ─── Globe3D（3D 球体）引导 ──────────────────────────────────

function bootGlobe(ctx: BootContext): { engine: Globe3D; teardown: () => void } {
    const globe = new Globe3D({
        container: ctx.el,
        center: [116.3974, 39.9093],
        altitude: 20_000_000,
        bearing: 0,
        pitch: -90,
        atmosphere: true,
        skybox: true,
        enableRotate: true,
        enableZoom: true,
        enableTilt: true,
        maxPixelRatio: 2,
        accessibleTitle: 'GIS-Forge 3D Globe',
    });

    // 开发期：在 window 上暴露 globe 实例以便 console 调试
    if (import.meta.env.DEV) {
        (window as unknown as { __globe3d: unknown }).__globe3d = globe;
    }

    markStepDone(ctx.setEngineSteps, 1);
    ctx.setEngineProgress(35);

    // 默认不加载在线瓦片；需要底图时取消注释。
    // globe.addImageryLayer({
    //     url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    //     type: 'xyz',
    //     alpha: 1,
    // });

    let teardownEvents: (() => void) | undefined;

    const wireEvents = (): void => {
        const onViewChange = (): void => {
            const z = globe.getZoom().toFixed(2);
            const p = globe.getPitch().toFixed(1);
            const b = globe.getBearing().toFixed(1);
            const pos = globe.getCameraPosition();
            const altKm = (pos.alt / 1000).toFixed(0);
            ctx.setZoomLabel(`Z${z}  P${p}°  B${b}°  Alt${altKm}km`);
        };

        let fpsSecondStart = performance.now();
        let fpsCountInSecond = 0;

        const onRender = (): void => {
            const now = performance.now();
            fpsCountInSecond++;
            const elapsed = now - fpsSecondStart;
            if (elapsed >= 1000) {
                ctx.setFpsLabel(String(Math.round((fpsCountInSecond * 1000) / elapsed)));
                fpsCountInSecond = 0;
                fpsSecondStart = now;
            }
        };

        globe.on('move', onViewChange);
        globe.on('render', onRender);
        onViewChange();

        teardownEvents = (): void => {
            globe.off('move', onViewChange);
            globe.off('render', onRender);
        };
    };

    const bootStartedAt = performance.now();

    const progressTimer = setInterval(() => {
        ctx.setEngineProgress((p) => (p >= 90 ? p : p + 2));
    }, 150);

    let minimumOverlayTimer: ReturnType<typeof setTimeout> | null = null;

    void globe.ready().then(() => {
        const elapsed = performance.now() - bootStartedAt;
        const remaining = Math.max(0, MIN_LOADING_SCREEN_MS - elapsed);
        minimumOverlayTimer = setTimeout(() => {
            minimumOverlayTimer = null;
            clearInterval(progressTimer);
            ctx.setEngineProgress(100);
            ctx.setEngineSteps((prev) => prev.map((s) => ({ ...s, done: true })));
            ctx.setEngineStatus('ready');
            wireEvents();
        }, remaining);
    });

    const teardown = (): void => {
        clearInterval(progressTimer);
        if (minimumOverlayTimer !== null) { clearTimeout(minimumOverlayTimer); }
        teardownEvents?.();
        try { globe.remove(); } catch { /* ignore */ }
    };

    return { engine: globe, teardown };
}

// ─── Map2D（正射 2D）引导 ──────────────────────────────────

function bootMap2D(ctx: BootContext): { engine: Map2D; teardown: () => void } {
    const map = new Map2D({
        container: ctx.el,
        center: [116.3974, 39.9093],
        zoom: 10,
        accessibleTitle: 'GIS-Forge 二维地图',
    });

    markStepDone(ctx.setEngineSteps, 1);
    ctx.setEngineProgress(35);

    map.addSource('osm-raster', {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
    });

    map.addLayer({
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm-raster',
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 300 },
    });

    let teardownEvents: (() => void) | undefined;

    const wireEvents = (): void => {
        const onPointerMove = (ev: MapEvent | MapMouseEvent): void => {
            if (ev.type !== 'mousemove') { return; }
            const me = ev as MapMouseEvent;
            ctx.setCursorLabel(`${me.lngLat[0].toFixed(4)}, ${me.lngLat[1].toFixed(4)}`);
        };
        const onViewChange = (): void => {
            ctx.setZoomLabel(map.getZoom().toFixed(2));
        };

        let fpsSecondStart = performance.now();
        let fpsCountInSecond = 0;

        const onRender = (): void => {
            const now = performance.now();
            fpsCountInSecond++;
            const elapsed = now - fpsSecondStart;
            if (elapsed >= 1000) {
                ctx.setFpsLabel(String(Math.round((fpsCountInSecond * 1000) / elapsed)));
                fpsCountInSecond = 0;
                fpsSecondStart = now;
            }

            let visibleTiles = 0;
            let cacheBytes = 0;
            for (const layer of map.scene.layers.values()) {
                if (layer.type !== 'raster') { continue; }
                const rl = layer as RasterTileLayer;
                visibleTiles += rl.visibleTiles;
                const data = typeof rl.getData === 'function'
                    ? (rl.getData() as { cacheBytes?: number })
                    : {};
                cacheBytes += typeof data.cacheBytes === 'number' ? data.cacheBytes : 0;
            }
            ctx.setTileCountLabel(String(visibleTiles));
            ctx.setMemLabel((cacheBytes / (1024 * 1024)).toFixed(1));
        };

        const onMapClick = (ev: MapEvent | MapMouseEvent): void => {
            if (ev.type !== 'click') { return; }
            const me = ev as MapMouseEvent;
            console.info('[App] map click', me.lngLat[0], me.lngLat[1]);
        };

        map.on('mousemove', onPointerMove);
        map.on('move', onViewChange);
        map.on('render', onRender);
        map.on('click', onMapClick);
        ctx.setZoomLabel(map.getZoom().toFixed(2));

        teardownEvents = (): void => {
            map.off('mousemove', onPointerMove);
            map.off('move', onViewChange);
            map.off('render', onRender);
            map.off('click', onMapClick);
        };
    };

    const bootStartedAt = performance.now();

    const progressTimer = setInterval(() => {
        ctx.setEngineProgress((p) => (p >= 90 ? p : p + 2));
    }, 150);

    let minimumOverlayTimer: ReturnType<typeof setTimeout> | null = null;

    void map.ready().then(() => {
        const elapsed = performance.now() - bootStartedAt;
        const remaining = Math.max(0, MIN_LOADING_SCREEN_MS - elapsed);
        minimumOverlayTimer = setTimeout(() => {
            minimumOverlayTimer = null;
            clearInterval(progressTimer);
            ctx.setEngineProgress(100);
            ctx.setEngineSteps((prev) => prev.map((s) => ({ ...s, done: true })));
            ctx.setEngineStatus('ready');
            wireEvents();
        }, remaining);
    });

    const teardown = (): void => {
        clearInterval(progressTimer);
        if (minimumOverlayTimer !== null) { clearTimeout(minimumOverlayTimer); }
        teardownEvents?.();
        try { map.remove(); } catch { /* ignore */ }
    };

    return { engine: map, teardown };
}

// ─── Map25D（透视 2.5D）引导 ────────────────────────────────

function bootMap25D(ctx: BootContext): { engine: Map25D; teardown: () => void } {
    const map = new Map25D({
        container: ctx.el,
        center: [116.3974, 39.9093],
        zoom: 10,
        pitch: 45,
        bearing: 0,
        maxPitch: 85,
        accessibleTitle: 'GIS-Forge 2.5D 地图',
    });

    markStepDone(ctx.setEngineSteps, 1);
    ctx.setEngineProgress(35);

    map.addSource('osm-raster', {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
    });

    map.addLayer({
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm-raster',
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 300 },
    });

    let teardownEvents: (() => void) | undefined;

    const wireEvents = (): void => {
        const onPointerMove = (ev: MapEvent | MapMouseEvent): void => {
            if (ev.type !== 'mousemove') { return; }
            const me = ev as MapMouseEvent;
            ctx.setCursorLabel(`${me.lngLat[0].toFixed(4)}, ${me.lngLat[1].toFixed(4)}`);
        };
        const onViewChange = (): void => {
            const z = map.getZoom().toFixed(2);
            const p = map.getPitch().toFixed(1);
            const b = map.getBearing().toFixed(1);
            ctx.setZoomLabel(`Z${z}  P${p}°  B${b}°`);
        };

        let fpsSecondStart = performance.now();
        let fpsCountInSecond = 0;

        const onRender = (): void => {
            const now = performance.now();
            fpsCountInSecond++;
            const elapsed = now - fpsSecondStart;
            if (elapsed >= 1000) {
                ctx.setFpsLabel(String(Math.round((fpsCountInSecond * 1000) / elapsed)));
                fpsCountInSecond = 0;
                fpsSecondStart = now;
            }

            let visibleTiles = 0;
            let cacheBytes = 0;
            for (const layer of map.scene.layers.values()) {
                if (layer.type !== 'raster') { continue; }
                const rl = layer as RasterTileLayer;
                visibleTiles += rl.visibleTiles;
                const data = typeof rl.getData === 'function'
                    ? (rl.getData() as { cacheBytes?: number })
                    : {};
                cacheBytes += typeof data.cacheBytes === 'number' ? data.cacheBytes : 0;
            }
            ctx.setTileCountLabel(String(visibleTiles));
            ctx.setMemLabel((cacheBytes / (1024 * 1024)).toFixed(1));
        };

        const onMapClick = (ev: MapEvent | MapMouseEvent): void => {
            if (ev.type !== 'click') { return; }
            const me = ev as MapMouseEvent;
            console.info('[App] map click', me.lngLat[0], me.lngLat[1]);
        };

        map.on('mousemove', onPointerMove);
        map.on('move', onViewChange);
        map.on('render', onRender);
        map.on('click', onMapClick);
        onViewChange();

        teardownEvents = (): void => {
            map.off('mousemove', onPointerMove);
            map.off('move', onViewChange);
            map.off('render', onRender);
            map.off('click', onMapClick);
        };
    };

    const bootStartedAt = performance.now();

    const progressTimer = setInterval(() => {
        ctx.setEngineProgress((p) => (p >= 90 ? p : p + 2));
    }, 150);

    let minimumOverlayTimer: ReturnType<typeof setTimeout> | null = null;

    void map.ready().then(() => {
        const elapsed = performance.now() - bootStartedAt;
        const remaining = Math.max(0, MIN_LOADING_SCREEN_MS - elapsed);
        minimumOverlayTimer = setTimeout(() => {
            minimumOverlayTimer = null;
            clearInterval(progressTimer);
            ctx.setEngineProgress(100);
            ctx.setEngineSteps((prev) => prev.map((s) => ({ ...s, done: true })));
            ctx.setEngineStatus('ready');
            wireEvents();
        }, remaining);
    });

    const teardown = (): void => {
        clearInterval(progressTimer);
        if (minimumOverlayTimer !== null) { clearTimeout(minimumOverlayTimer); }
        teardownEvents?.();
        try { map.remove(); } catch { /* ignore */ }
    };

    return { engine: map, teardown };
}

// ════════════════════════════════════════════════════════════════
// App 组件
// ════════════════════════════════════════════════════════════════

/**
 * 应用壳：顶栏（含 ViewModeSwitch）+ 可拖拽三栏 + 底栏状态。
 * 主区域根据 `viewMode` 挂载 Map2D / Map25D / Globe3D，切换时销毁旧引擎并重建新引擎。
 */
export function App(): React.ReactElement {
    const mapContainerRef = React.useRef<HTMLDivElement | null>(null);
    const leftPanelRef = React.useRef<ImperativePanelHandle>(null);
    const rightPanelRef = React.useRef<ImperativePanelHandle>(null);

    const [viewMode, setViewMode] = React.useState<MapViewMode>('globe');

    const [engineStatus, setEngineStatus] = React.useState<'loading' | 'ready'>('loading');
    const [engineProgress, setEngineProgress] = React.useState(0);
    const [engineSteps, setEngineSteps] = React.useState(createInitialEngineSteps);

    const [cursorLabel, setCursorLabel] = React.useState<string>('—');
    const [zoomLabel, setZoomLabel] = React.useState<string>('—');
    const [tileCountLabel, setTileCountLabel] = React.useState<string>('—');
    const [fpsLabel, setFpsLabel] = React.useState<string>('—');
    const [memLabel, setMemLabel] = React.useState<string>('—');

    const canUseWebGPU =
        typeof navigator !== 'undefined' && navigator.gpu !== undefined && navigator.gpu !== null;

    /**
     * 切换模式时：
     * 1. 先重置 loading 状态（显示加载遮罩）
     * 2. 再更新 viewMode（触发 useEffect 重建引擎）
     */
    const handleViewModeChange = React.useCallback((next: MapViewMode) => {
        if (next === viewMode) { return; }
        setEngineStatus('loading');
        setEngineProgress(0);
        setEngineSteps(createInitialEngineSteps());
        setCursorLabel('—');
        setZoomLabel('—');
        setTileCountLabel('—');
        setFpsLabel('—');
        setMemLabel('—');
        setViewMode(next);
    }, [viewMode]);

    React.useEffect(() => {
        const el = mapContainerRef.current;
        if (el === null) { return; }

        markStepDone(setEngineSteps, 0);
        setEngineProgress(12);

        const ctx: BootContext = {
            el,
            setEngineProgress,
            setEngineSteps,
            setEngineStatus,
            setCursorLabel,
            setZoomLabel,
            setTileCountLabel,
            setFpsLabel,
            setMemLabel,
        };

        let result: { engine: EngineInstance; teardown: () => void } | null = null;

        try {
            if (viewMode === '2d') {
                result = bootMap2D(ctx);
            } else if (viewMode === '2.5d') {
                result = bootMap25D(ctx);
            } else {
                result = bootGlobe(ctx);
            }
        } catch (err) {
            console.error(`[App] ${viewMode} 引擎初始化失败`, err);
            setEngineProgress(100);
            setEngineStatus('ready');
            return;
        }

        const { teardown } = result;

        return () => {
            teardown();
        };
    }, [viewMode]);

    if (!canUseWebGPU) {
        return <WebGPUError />;
    }

    return (
        <>
            <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-primary)]">
                <TopToolbar viewMode={viewMode} onViewModeChange={handleViewModeChange} />
                <PanelGroup direction="horizontal" className="min-h-0 flex-1">
                    <Panel
                        ref={leftPanelRef}
                        defaultSize={18}
                        minSize={0}
                        collapsible
                        className="min-w-0"
                    >
                        <LeftPanel />
                    </Panel>
                    <PanelResizeHandle className="w-px shrink-0 bg-[var(--border)] transition-colors hover:bg-[var(--accent)]" />
                    <Panel defaultSize={62} minSize={30} className="min-w-0">
                        <MapViewport mapContainerRef={mapContainerRef} />
                    </Panel>
                    <PanelResizeHandle className="w-px shrink-0 bg-[var(--border)] transition-colors hover:bg-[var(--accent)]" />
                    <Panel
                        ref={rightPanelRef}
                        defaultSize={20}
                        minSize={0}
                        collapsible
                        className="min-w-0"
                    >
                        <RightPanel />
                    </Panel>
                </PanelGroup>
                <StatusBar
                    cursorLabel={cursorLabel}
                    zoomLabel={zoomLabel}
                    tileCountLabel={tileCountLabel}
                    fpsLabel={fpsLabel}
                    memLabel={memLabel}
                />
            </div>
            {engineStatus === 'loading' && (
                <InitLoading progress={engineProgress} steps={engineSteps} />
            )}
        </>
    );
}
