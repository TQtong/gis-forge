import * as React from 'react';

export type MapViewportProps = {
    /** 地图挂载点（Map2D 容器） */
    mapContainerRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * 中间地图区域：仅占位容器，由 App 传入 ref 供 Map2D 挂载。
 */
export function MapViewport({ mapContainerRef }: MapViewportProps): React.ReactElement {
    return (
        <main className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-primary)]">
            <div
                ref={mapContainerRef}
                className="m-2 min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)]"
                aria-label="地图视图"
            />
        </main>
    );
}
