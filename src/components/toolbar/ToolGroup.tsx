import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
    BarChart3,
    ChevronDown,
    Hand,
    MousePointer,
    Pencil,
    Ruler,
} from 'lucide-react';
import type { ToolType } from '@/types';
import { DrawToolMenu } from '@/components/toolbar/DrawToolMenu';
import { MeasureToolMenu } from '@/components/toolbar/MeasureToolMenu';
import { SelectToolMenu } from '@/components/toolbar/SelectToolMenu';
import { useMapStore } from '@/stores/mapStore';

/** Which sub-menu is expanded in the toolbar (mutually exclusive). */
type OpenMenu = 'none' | 'select' | 'draw' | 'measure' | 'analysis';

const ICON_SIZE = 18;

/**
 * Mutually exclusive map tools with dropdowns for select, draw, measure, and a static analysis entry.
 *
 * @returns Horizontal toolbar segment for the top bar.
 */
export function ToolGroup(): ReactElement {
    const activeTool = useMapStore((s) => s.activeTool);
    const setActiveTool = useMapStore((s) => s.setActiveTool);
    const [openMenu, setOpenMenu] = useState<OpenMenu>('none');
    const analysisWrapRef = useRef<HTMLDivElement>(null);

    const closeMenus = useCallback(() => setOpenMenu('none'), []);

    useEffect(() => {
        if (openMenu !== 'analysis') {
            return;
        }
        const handlePointerDown = (ev: PointerEvent) => {
            const el = analysisWrapRef.current;
            if (!el || el.contains(ev.target as Node)) {
                return;
            }
            setOpenMenu('none');
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [openMenu]);

    const isSelectActive =
        activeTool === 'select-click' || activeTool === 'select-box' || activeTool === 'select-lasso';
    const isDrawActive = activeTool.startsWith('draw-');
    const isMeasureActive = activeTool.startsWith('measure-');

    const panClasses =
        activeTool === 'pan'
            ? 'bg-[var(--accent)] text-white rounded-md'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] rounded-md';

    const selectClasses = isSelectActive
        ? 'bg-[var(--accent)] text-white rounded-md'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] rounded-md';

    const drawClasses = isDrawActive
        ? 'bg-[var(--accent)] text-white rounded-md'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] rounded-md';

    const measureClasses = isMeasureActive
        ? 'bg-[var(--accent)] text-white rounded-md'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] rounded-md';

    const analysisOpen = openMenu === 'analysis';
    const analysisClasses = analysisOpen
        ? 'bg-[var(--accent)] text-white rounded-md'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-panel-hover)] rounded-md';

    return (
        <div className="flex items-center gap-0.5" role="toolbar" aria-label="地图工具">
            <button
                type="button"
                title="平移"
                aria-label="平移"
                aria-pressed={activeTool === 'pan'}
                className={`relative flex items-center p-1.5 transition-colors ${panClasses}`}
                onClick={() => {
                    closeMenus();
                    setActiveTool('pan');
                }}
            >
                <Hand className="shrink-0" width={ICON_SIZE} height={ICON_SIZE} strokeWidth={2} aria-hidden />
            </button>

            <div className="w-px h-5 bg-[var(--border)] mx-1 shrink-0" aria-hidden />

            <div className="relative">
                <button
                    type="button"
                    title="选择"
                    aria-label="选择"
                    aria-expanded={openMenu === 'select'}
                    aria-haspopup="menu"
                    className={`relative flex items-center gap-0.5 p-1.5 transition-colors ${selectClasses}`}
                    onClick={() => setOpenMenu((m) => (m === 'select' ? 'none' : 'select'))}
                >
                    <MousePointer className="shrink-0" width={ICON_SIZE} height={ICON_SIZE} strokeWidth={2} aria-hidden />
                    <ChevronDown className="size-3 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                </button>
                {openMenu === 'select' && (
                    <SelectToolMenu
                        onSelect={(tool) => {
                            setActiveTool(tool);
                            closeMenus();
                        }}
                        onClose={closeMenus}
                    />
                )}
            </div>

            <div className="relative">
                <button
                    type="button"
                    title="绘制"
                    aria-label="绘制"
                    aria-expanded={openMenu === 'draw'}
                    aria-haspopup="menu"
                    className={`relative flex items-center gap-0.5 p-1.5 transition-colors ${drawClasses}`}
                    onClick={() => setOpenMenu((m) => (m === 'draw' ? 'none' : 'draw'))}
                >
                    <Pencil className="shrink-0" width={ICON_SIZE} height={ICON_SIZE} strokeWidth={2} aria-hidden />
                    <ChevronDown className="size-3 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                </button>
                {openMenu === 'draw' && (
                    <DrawToolMenu
                        onSelect={(tool) => {
                            setActiveTool(tool);
                            closeMenus();
                        }}
                        onClose={closeMenus}
                    />
                )}
            </div>

            <div className="relative">
                <button
                    type="button"
                    title="测量"
                    aria-label="测量"
                    aria-expanded={openMenu === 'measure'}
                    aria-haspopup="menu"
                    className={`relative flex items-center gap-0.5 p-1.5 transition-colors ${measureClasses}`}
                    onClick={() => setOpenMenu((m) => (m === 'measure' ? 'none' : 'measure'))}
                >
                    <Ruler className="shrink-0" width={ICON_SIZE} height={ICON_SIZE} strokeWidth={2} aria-hidden />
                    <ChevronDown className="size-3 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                </button>
                {openMenu === 'measure' && (
                    <MeasureToolMenu
                        onSelect={(tool) => {
                            setActiveTool(tool);
                            closeMenus();
                        }}
                        onClose={closeMenus}
                    />
                )}
            </div>

            <div className="w-px h-5 bg-[var(--border)] mx-1 shrink-0" aria-hidden />

            <div className="relative" ref={analysisWrapRef}>
                <button
                    type="button"
                    title="分析"
                    aria-label="分析菜单"
                    aria-expanded={analysisOpen}
                    aria-haspopup="menu"
                    className={`flex items-center p-1.5 transition-colors ${analysisClasses}`}
                    onClick={() => setOpenMenu((m) => (m === 'analysis' ? 'none' : 'analysis'))}
                >
                    <BarChart3 className="shrink-0" width={ICON_SIZE} height={ICON_SIZE} strokeWidth={2} aria-hidden />
                </button>
                {analysisOpen && (
                    <div
                        className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] rounded-md border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-lg"
                        role="menu"
                        aria-label="空间分析"
                    >
                        {[
                            '缓冲区分析',
                            '叠加分析',
                            '等值线',
                            '热力密度',
                            'Voronoi',
                            '视域分析',
                            '坡度坡向',
                            '山体阴影',
                            '分类统计',
                        ].map((label) => (
                            <button
                                key={label}
                                type="button"
                                role="menuitem"
                                className="block w-full px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-panel-hover)]"
                                onClick={() => closeMenus()}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
