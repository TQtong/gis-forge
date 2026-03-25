import * as React from 'react';

export type StatusBarProps = {
    cursorLabel: string;
    zoomLabel: string;
    tileCountLabel: string;
    fpsLabel: string;
    memLabel: string;
};

function Separator(): React.ReactElement {
    return (
        <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
            │
        </span>
    );
}

/**
 * 底部状态栏：经纬度、缩放、瓦片数、FPS、缓存占用。
 */
export function StatusBar({
    cursorLabel,
    zoomLabel,
    tileCountLabel,
    fpsLabel,
    memLabel,
}: StatusBarProps): React.ReactElement {
    return (
        <footer
            className="h-7 flex shrink-0 items-center gap-0 overflow-x-auto border-t border-[var(--border)] bg-[var(--bg-panel)] px-3 text-xs text-[var(--text-secondary)]"
            role="contentinfo"
        >
            <span className="whitespace-nowrap" title="鼠标位置（经度, 纬度）">
                📍 {cursorLabel}
            </span>
            <Separator />
            <span className="whitespace-nowrap">z: {zoomLabel}</span>
            <Separator />
            <span className="whitespace-nowrap" title="当前可见栅格瓦片数">
                ⬡ {tileCountLabel}
            </span>
            <Separator />
            <span className="whitespace-nowrap" title="渲染帧率（由 render 事件推算）">
                {fpsLabel} fps
            </span>
            <Separator />
            <span className="whitespace-nowrap" title="栅格纹理缓存占用（估算）">
                {memLabel} MB
            </span>
        </footer>
    );
}
