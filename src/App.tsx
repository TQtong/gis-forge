import * as React from 'react';
import {
    Panel,
    PanelGroup,
    PanelResizeHandle,
    type ImperativePanelHandle,
} from 'react-resizable-panels';
import { Globe3D } from '@/packages/preset-3d/src/globe-3d.ts';
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
 * 应用壳：顶栏 + 可拖拽三栏 + 底栏状态；主区域为 Globe3D + OSM 栅格瓦片。
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
        let globe: Globe3D | null = null;
        let teardownGlobeEvents: (() => void) | undefined;
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
            globe = new Globe3D({
                container: el,
                center: [116.3974, 39.9093],
                altitude: 2_000_000,
                bearing: 0,
                pitch: -30,
                atmosphere: true,
                skybox: true,
                enableRotate: true,
                enableZoom: true,
                enableTilt: true,
                maxPixelRatio: 2,
                accessibleTitle: 'GeoForge 3D Globe',
            });

            setEngineSteps((prev) => {
                const next = [...prev];
                if (next[1]) {
                    next[1] = { ...next[1], done: true };
                }
                return next;
            });
            setEngineProgress(35);

            // 添加 OSM 栅格瓦片底图
            globe.addImageryLayer({
                url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                type: 'xyz',
                alpha: 1,
            });

            progressTimer = setInterval(() => {
                setEngineProgress((p) => (p >= 90 ? p : p + 2));
            }, 150);

            const wireGlobeEvents = (): void => {
                if (globe === null) { return; }

                // 视图变化时更新状态栏
                const onViewChange = (): void => {
                    if (globe === null) { return; }
                    const z = globe.getZoom().toFixed(2);
                    const p = globe.getPitch().toFixed(1);
                    const b = globe.getBearing().toFixed(1);
                    const pos = globe.getCameraPosition();
                    const altKm = (pos.alt / 1000).toFixed(0);
                    setZoomLabel(`Z${z}  P${p}°  B${b}°  Alt${altKm}km`);
                };

                // FPS 计数
                let fpsSecondStart = performance.now();
                let fpsCountInSecond = 0;

                const onRender = (): void => {
                    if (globe === null) { return; }
                    const now = performance.now();
                    fpsCountInSecond++;
                    const elapsed = now - fpsSecondStart;
                    if (elapsed >= 1000) {
                        setFpsLabel(String(Math.round((fpsCountInSecond * 1000) / elapsed)));
                        fpsCountInSecond = 0;
                        fpsSecondStart = now;
                    }
                };

                globe.on('move', onViewChange);
                globe.on('render', onRender);

                // 初始更新状态栏
                onViewChange();

                teardownGlobeEvents = (): void => {
                    globe!.off('move', onViewChange);
                    globe!.off('render', onRender);
                };
            };

            void globe.ready().then(() => {
                if (globe === null) { return; }
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
                    wireGlobeEvents();
                }, remaining);
            });
        } catch (err) {
            if (progressTimer !== null) {
                clearInterval(progressTimer);
            }
            console.error('[App] Globe3D 初始化失败', err);
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
            teardownGlobeEvents?.();
            try {
                globe?.remove();
            } catch {
                // ignore
            }
            globe = null;
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
