import * as React from 'react';
import {
    Panel,
    PanelGroup,
    PanelResizeHandle,
    type ImperativePanelHandle,
} from 'react-resizable-panels';
import { Map25D } from '@/packages/preset-25d/src/map-25d.ts';
import type { MapEvent, MapMouseEvent } from '@/packages/preset-2d/src/map-2d.ts';
import type { RasterTileLayer } from '@/packages/layer-tile-raster/src/RasterTileLayer.ts';
import { InitLoading, WebGPUError } from '@/components/loading';
import { TopToolbar } from '@/components/layout/TopToolbar';
import { LeftPanel } from '@/components/layout/LeftPanel';
import { RightPanel } from '@/components/layout/RightPanel';
import { MapViewport } from '@/components/layout/MapViewport';
import { StatusBar } from '@/components/layout/StatusBar';

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

/**
 * 应用壳：顶栏 + 可拖拽三栏 + 底栏状态；主区域为 Map25D + OSM 栅格瓦片。
 */
export function App(): React.ReactElement {
    const mapContainerRef = React.useRef<HTMLDivElement | null>(null);
    const leftPanelRef = React.useRef<ImperativePanelHandle>(null);
    const rightPanelRef = React.useRef<ImperativePanelHandle>(null);

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

    React.useEffect(() => {
        const el = mapContainerRef.current;
        if (el === null) {
            return;
        }

        const bootStartedAt = performance.now();
        let map: Map25D | null = null;
        let teardownMapEvents: (() => void) | undefined;
        let progressTimer: ReturnType<typeof setInterval> | null = null;
        let minimumOverlayTimer: ReturnType<typeof setTimeout> | null = null;

        setEngineSteps((prev) => {
            const next = [...prev];
            if (next[0]) {
                next[0] = { ...next[0], done: true };
            }
            return next;
        });
        setEngineProgress(12);

        try {
            map = new Map25D({
                container: el,
                center: [116.3974, 39.9093],
                zoom: 10,
                pitch: 45,
                bearing: 0,
                maxPitch: 85,
                accessibleTitle: 'GIS-Forge 2.5D 地图',
            });

            setEngineSteps((prev) => {
                const next = [...prev];
                if (next[1]) {
                    next[1] = { ...next[1], done: true };
                }
                return next;
            });
            setEngineProgress(35);

            // ── 单层地形 drape（参照 Mapbox GL v3 / MapLibre）──
            // 一个 source + 一个 layer 同时处理底图 + 地形。
            // 无 DEM 区域（如美国/非洲）自动退化为平面 OSM。
            map.addSource('terrain-base', {
                type: 'terrain-drape',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                maxzoom: 19,
                // 可选 elevation（Cesium QM 格式）
                elevationUrl: 'https://sooncps.xwbuilders.com/api/ugis-dataprocess/v1/terrain/NhBLlMx3/',
                elevationMaxZoom: 12,
                attribution: '© OpenStreetMap contributors',
            } as Record<string, unknown>);

            map.addLayer({
                id: 'basemap',
                type: 'terrain-drape',
                source: 'terrain-base',
                paint: {
                    'terrain-exaggeration': 1.5,
                    'terrain-opacity': 1,
                    'terrain-hillshade': 0.15,
                    'terrain-light-direction': [-0.5, -0.7, 1.0],
                },
            });

            progressTimer = setInterval(() => {
                setEngineProgress((p) => (p >= 90 ? p : p + 2));
            }, 150);

            const wireMapEvents = (): void => {
                if (map === null) {
                    return;
                }
                const onPointerMove = (ev: MapEvent | MapMouseEvent): void => {
                    if (ev.type !== 'mousemove') {
                        return;
                    }
                    const me = ev as MapMouseEvent;
                    setCursorLabel(`${me.lngLat[0].toFixed(4)}, ${me.lngLat[1].toFixed(4)}`);
                };
                const onViewChange = (): void => {
                    if (map === null) {
                        return;
                    }
                    const z = map.getZoom().toFixed(2);
                    const p = map.getPitch().toFixed(1);
                    const b = map.getBearing().toFixed(1);
                    setZoomLabel(`Z${z}  P${p}°  B${b}°`);
                };

                let fpsSecondStart = performance.now();
                let fpsCountInSecond = 0;

                const onRender = (): void => {
                    if (map === null) {
                        return;
                    }
                    const now = performance.now();
                    fpsCountInSecond++;
                    const elapsed = now - fpsSecondStart;
                    if (elapsed >= 1000) {
                        setFpsLabel(String(Math.round((fpsCountInSecond * 1000) / elapsed)));
                        fpsCountInSecond = 0;
                        fpsSecondStart = now;
                    }

                    let visibleTiles = 0;
                    let cacheBytes = 0;
                    for (const layer of map.scene.layers.values()) {
                        if (layer.type !== 'raster') {
                            continue;
                        }
                        const rl = layer as RasterTileLayer;
                        visibleTiles += rl.visibleTiles;
                        const data =
                            typeof rl.getData === 'function'
                                ? (rl.getData() as { cacheBytes?: number })
                                : {};
                        cacheBytes += typeof data.cacheBytes === 'number' ? data.cacheBytes : 0;
                    }
                    setTileCountLabel(String(visibleTiles));
                    setMemLabel((cacheBytes / (1024 * 1024)).toFixed(1));
                };

                const onMapClick = (ev: MapEvent | MapMouseEvent): void => {
                    if (ev.type !== 'click') {
                        return;
                    }
                    const me = ev as MapMouseEvent;
                    console.info('[App] map click', me.lngLat[0], me.lngLat[1]);
                };

                map.on('mousemove', onPointerMove);
                map.on('move', onViewChange);
                map.on('render', onRender);
                map.on('click', onMapClick);

                onViewChange();

                teardownMapEvents = (): void => {
                    map!.off('mousemove', onPointerMove);
                    map!.off('move', onViewChange);
                    map!.off('render', onRender);
                    map!.off('click', onMapClick);
                };
            };

            void map.ready().then(() => {
                if (map === null) {
                    return;
                }
                const elapsed = performance.now() - bootStartedAt;
                const remaining = Math.max(0, MIN_LOADING_SCREEN_MS - elapsed);
                minimumOverlayTimer = setTimeout(() => {
                    minimumOverlayTimer = null;
                    if (progressTimer !== null) {
                        clearInterval(progressTimer);
                        progressTimer = null;
                    }
                    setEngineProgress(100);
                    setEngineSteps((prev) => prev.map((s) => ({ ...s, done: true })));
                    setEngineStatus('ready');
                    wireMapEvents();
                }, remaining);
            });
        } catch (err) {
            if (progressTimer !== null) {
                clearInterval(progressTimer);
            }
            console.error('[App] Map25D 初始化失败', err);
            setEngineProgress(100);
            setEngineStatus('ready');
            return;
        }

        return () => {
            if (progressTimer !== null) {
                clearInterval(progressTimer);
            }
            if (minimumOverlayTimer !== null) {
                clearTimeout(minimumOverlayTimer);
            }
            teardownMapEvents?.();
            try {
                map?.remove();
            } catch {
                // ignore
            }
            map = null;
        };
    }, []);

    if (!canUseWebGPU) {
        return <WebGPUError />;
    }

    return (
        <>
            <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-primary)]">
                <TopToolbar />
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
