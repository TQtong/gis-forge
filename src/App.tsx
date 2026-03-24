import { useEffect, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { useUIStore } from '@/stores/uiStore';
import { useMapStore } from '@/stores/mapStore';
import { TopToolbar } from '@/components/layout/TopToolbar';
import { LeftPanel } from '@/components/layout/LeftPanel';
import { RightPanel } from '@/components/layout/RightPanel';
import { MapViewport } from '@/components/layout/MapViewport';
import { StatusBar } from '@/components/layout/StatusBar';
import { BufferAnalysis } from '@/components/analysis/BufferAnalysis';
import { GeoForgeToaster } from '@/components/common/Toast';
import { MobileTabBar } from '@/components/layout/MobileTabBar';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { InitLoading } from '@/components/loading/InitLoading';
import { WebGPUError } from '@/components/loading/WebGPUError';
import { useGeoForgeMap } from '@/hooks/useGeoForgeMap';
import { useUrlState } from '@/hooks/useUrlState';
import { ClassificationDialog } from '@/components/analysis/ClassificationDialog';
import { ContourAnalysis } from '@/components/analysis/ContourAnalysis';
import { HeatmapAnalysis } from '@/components/analysis/HeatmapAnalysis';
import { HillshadeAnalysis } from '@/components/analysis/HillshadeAnalysis';
import { OverlayAnalysis } from '@/components/analysis/OverlayAnalysis';
import { SlopeAnalysis } from '@/components/analysis/SlopeAnalysis';
import { VoronoiAnalysis } from '@/components/analysis/VoronoiAnalysis';
import { ViewshedAnalysis } from '@/components/analysis/ViewshedAnalysis';

/**
 * Root application shell: toolbar, three-column resizable panels, status bar.
 * Syncs `data-theme` with `useUIStore`, wires keyboard shortcuts for panels and tools.
 */
export function App() {
    useUrlState();

    const mapContainerRef = useRef<HTMLDivElement>(null);
    const { status: engineStatus, progress: engineProgress, steps: engineSteps } = useGeoForgeMap(mapContainerRef);

    const theme = useUIStore((s) => s.theme);
    const leftPanelCollapsed = useUIStore((s) => s.leftPanelCollapsed);
    const rightPanelCollapsed = useUIStore((s) => s.rightPanelCollapsed);
    const toggleLeftPanel = useUIStore((s) => s.toggleLeftPanel);
    const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);
    const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
    const fontSizePx = useUIStore((s) => s.fontSizePx);

    const setActiveTool = useMapStore((s) => s.setActiveTool);

    const leftPanelRef = useRef<ImperativePanelHandle>(null);
    const rightPanelRef = useRef<ImperativePanelHandle>(null);

    useEffect(() => {
        const root = document.documentElement;
        if (theme === 'light') {
            root.setAttribute('data-theme', 'light');
        } else {
            root.removeAttribute('data-theme');
        }
    }, [theme]);

    useEffect(() => {
        document.documentElement.style.fontSize = `${fontSizePx}px`;
    }, [fontSizePx]);

    useEffect(() => {
        const panel = leftPanelRef.current;
        if (!panel) return;
        if (leftPanelCollapsed) panel.collapse();
        else panel.expand();
    }, [leftPanelCollapsed]);

    useEffect(() => {
        const panel = rightPanelRef.current;
        if (!panel) return;
        if (rightPanelCollapsed) panel.collapse();
        else panel.expand();
    }, [rightPanelCollapsed]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target;
            const tag = target instanceof HTMLElement ? target.tagName : '';
            const inEditable =
                tag === 'INPUT' ||
                tag === 'TEXTAREA' ||
                (target instanceof HTMLElement && target.isContentEditable);

            if (e.key === '[' && !inEditable) {
                e.preventDefault();
                toggleLeftPanel();
                return;
            }
            if (e.key === ']' && !inEditable) {
                e.preventDefault();
                toggleRightPanel();
                return;
            }
            if (e.key === 'Escape') {
                if (inEditable) return;
                e.preventDefault();
                setActiveTool('pan');
                return;
            }
            if (e.key === 'F11') {
                e.preventDefault();
                const doc = document;
                if (!doc.fullscreenElement) {
                    void doc.documentElement.requestFullscreen().catch(() => {
                        /* User gesture or policy may block fullscreen; ignore. */
                    });
                } else {
                    void doc.exitFullscreen().catch(() => {
                        /* Exit may fail if not in fullscreen; ignore. */
                    });
                }
                return;
            }
            if (e.ctrlKey && (e.key === 'h' || e.key === 'H') && !inEditable) {
                e.preventDefault();
                const cur = useUIStore.getState().historyPanelOpen;
                setHistoryPanelOpen(!cur);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [toggleLeftPanel, toggleRightPanel, setActiveTool, setHistoryPanelOpen]);

    if (engineStatus === 'unsupported') {
        return <WebGPUError />;
    }

    if (engineStatus === 'loading') {
        return <InitLoading progress={engineProgress} steps={engineSteps} />;
    }

    return (
        <div className="h-screen w-screen overflow-hidden flex flex-col bg-[var(--bg-primary)]">
            <TopToolbar />
            <PanelGroup direction="horizontal" className="flex-1 min-h-0">
                <Panel
                    ref={leftPanelRef}
                    defaultSize={18}
                    minSize={0}
                    collapsible
                    className="min-w-0"
                >
                    <LeftPanel />
                </Panel>
                <PanelResizeHandle className="w-px shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors" />
                <Panel defaultSize={62} minSize={30} className="min-w-0">
                    <MapViewport />
                </Panel>
                <PanelResizeHandle className="w-px shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors" />
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
            <StatusBar />
            <BufferAnalysis />
            <OverlayAnalysis />
            <ContourAnalysis />
            <HeatmapAnalysis />
            <VoronoiAnalysis />
            <ViewshedAnalysis />
            <SlopeAnalysis />
            <HillshadeAnalysis />
            <ClassificationDialog />
            <SettingsDialog />
            <GeoForgeToaster />
            <MobileTabBar />
        </div>
    );
}
