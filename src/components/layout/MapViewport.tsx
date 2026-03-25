import { useEffect, useRef, type ReactElement } from 'react';
import { FileDragOverlay } from '@/components/map-controls/FileDragOverlay';
import { MiniMap } from '@/components/map-controls/MiniMap';
import { TimeSlider } from '@/components/map-controls/TimeSlider';
import { CompassControl } from '@/components/map-controls/CompassControl';
import { CoordinateDisplay } from '@/components/map-controls/CoordinateDisplay';
import { FeaturePopup } from '@/components/map-controls/FeaturePopup';
import { LocateControl } from '@/components/map-controls/LocateControl';
import { MapContextMenu } from '@/components/map-controls/MapContextMenu';
import { ScaleBar } from '@/components/map-controls/ScaleBar';
import { ZoomControl } from '@/components/map-controls/ZoomControl';
import { HistoryPanel } from '@/components/history/HistoryPanel';
import { SplitViewControl } from '@/components/map-controls/SplitViewControl';
import { ToolHintBar } from '@/components/toolbar/ToolHintBar';
import { useWebGPUMap } from '@/hooks/useWebGPUMap';
import { useMapEvents } from '@/hooks/useMapEvents';
import { useResponsive } from '@/hooks/useResponsive';
import { useSelectTool } from '@/hooks/useSelectTool';
import { useMapStore } from '@/stores/mapStore';
import { useSelectionStore } from '@/stores/selectionStore';
import { useStatusStore } from '@/stores/statusStore';

/**
 * Central map region: single WebGPU canvas for all modes (2D / 2.5D / Globe),
 * overlays, and UI controls.
 *
 * @stability experimental
 */
export function MapViewport(): ReactElement {
    const breakpoint = useResponsive();
    const containerRef = useRef<HTMLDivElement>(null);
    const webgpuCanvasRef = useRef<HTMLCanvasElement>(null);
    const hoveredFeature = useSelectionStore((s) => s.hoveredFeature);
    const zoom = useMapStore((s) => s.zoom);
    const setStatusZoom = useStatusStore((s) => s.setZoom);

    /** Single unified WebGPU renderer — always active for every mode. */
    const webgpuStatus = useWebGPUMap(webgpuCanvasRef, containerRef);

    const { pointerClientPos, contextMenuPos, contextMenuLngLat, closeContextMenu } =
        useMapEvents(containerRef);
    const { selectionBox, lassoPoints } = useSelectTool();

    useEffect(() => {
        setStatusZoom(zoom);
    }, [setStatusZoom, zoom]);

    return (
        <div
            className={`w-full h-full relative bg-[#0a0e17] overflow-hidden ${breakpoint === 'mobile' ? 'pb-14' : ''}`}
            ref={containerRef}
        >
            {/* Single WebGPU canvas — renders 2D, 2.5D, and Globe modes */}
            <canvas
                ref={webgpuCanvasRef}
                className="absolute inset-0 z-[1] w-full h-full"
                aria-label="GeoForge 地图"
            />

            <SplitViewControl />
            <HistoryPanel />

            <ToolHintBar />

            <div className="absolute top-1/2 right-3 z-10 flex -translate-y-1/2 flex-col gap-1 items-center">
                <ZoomControl />
                <CompassControl />
                <LocateControl />
            </div>

            <div className="absolute bottom-3 left-3 z-10">
                <CoordinateDisplay />
            </div>

            <div className="absolute bottom-28 right-3 z-10 flex flex-col items-end gap-1">
                <ScaleBar />
            </div>

            <MiniMap />

            <TimeSlider
                visible={false}
                minTime={0}
                maxTime={1}
                currentTime={0}
                onChange={() => {
                    /* Wired when temporal layers exist */
                }}
            />

            <FileDragOverlay containerRef={containerRef} />

            {selectionBox && selectionBox.width + selectionBox.height > 2 && (
                <div
                    className="fixed z-30 border border-[var(--accent)] bg-[var(--drag-overlay)] pointer-events-none"
                    style={{
                        left: selectionBox.x,
                        top: selectionBox.y,
                        width: selectionBox.width,
                        height: selectionBox.height,
                    }}
                    aria-hidden
                />
            )}

            {lassoPoints.length > 1 && (
                <svg
                    className="fixed inset-0 z-30 pointer-events-none"
                    width="100%"
                    height="100%"
                    aria-hidden
                >
                    <polyline
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={2}
                        points={lassoPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                    />
                </svg>
            )}

            <FeaturePopup feature={hoveredFeature} position={pointerClientPos} />

            <MapContextMenu
                position={contextMenuPos}
                lngLat={contextMenuLngLat}
                onClose={closeContextMenu}
            />
        </div>
    );
}
