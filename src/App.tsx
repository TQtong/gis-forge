import * as React from 'react';
import {
    Hand,
    Columns2,
    History,
    Layers,
    Map,
    Mountain,
    PenLine,
    Ruler,
    Search,
    Settings,
    MousePointer,
    SquareDashed,
} from 'lucide-react';
import { MapFull } from '@/packages/preset-full/src/map-full.ts';

/**
 * 应用壳：侧栏与顶栏为静态布局；主区域挂载 GeoForge MapFull（当前固定为 2D 模式）。
 */
export function App(): React.ReactElement {
    const mapContainerRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        const el = mapContainerRef.current;
        if (el === null) {
            return;
        }

        let map: MapFull | null = null;
        try {
            map = new MapFull({
                container: el,
                mode: '2d',
                center: [116.3974, 39.9093],
                zoom: 10,
                pitch: 0,
                bearing: 0,
                accessibleTitle: 'GeoForge 二维地图',
            });
        } catch (err) {
            console.error('[App] MapFull 初始化失败', err);
            return;
        }

        return () => {
            try {
                map?.remove();
            } catch {
                // 重复销毁或容器已脱离文档时忽略
            }
            map = null;
        };
    }, []);

    return (
        <div className="h-screen w-screen overflow-hidden flex flex-col bg-[var(--bg-primary)]">
<header
                className="h-12 flex items-center px-3 gap-2 bg-[var(--bg-panel)] border-b border-[var(--border)] shrink-0"
                role="banner"
            >
                <div className="flex items-center gap-3 min-w-0 shrink-0">
                    <div className="flex items-center gap-2">
                        <Map aria-hidden className="text-[var(--accent)]" strokeWidth={2} size={20} />
                        <span className="text-base font-semibold text-[var(--text-primary)] whitespace-nowrap">
                            GeoForge
                        </span>
                    </div>
                    <div
                        className="flex rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-0.5 text-xs"
                        role="group"
                        aria-label="视图模式（静态）"
                    >
                        <span className="px-2 py-1 rounded bg-[var(--accent)] text-white">2D</span>
                        <span className="px-2 py-1 rounded text-[var(--text-secondary)]">2.5D</span>
                        <span className="px-2 py-1 rounded text-[var(--text-secondary)]">3D</span>
                    </div>
                </div>
                <div className="flex-1 flex justify-center px-2 min-w-0">
                    <div className="flex w-full max-w-md items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1.5">
                        <Search className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                        <span className="text-sm text-[var(--text-muted)] truncate">搜索地点（静态预览）</span>
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 text-[var(--text-secondary)]">
                    <span className="p-2 rounded-md" title="平移" aria-hidden>
                        <Hand className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="选择" aria-hidden>
                        <MousePointer className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="框选" aria-hidden>
                        <SquareDashed className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="绘制" aria-hidden>
                        <PenLine className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="测量" aria-hidden>
                        <Ruler className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="分析" aria-hidden>
                        <Mountain className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="操作历史" aria-hidden>
                        <History className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="分屏对比" aria-hidden>
                        <Columns2 className="size-5" strokeWidth={2} />
                    </span>
                    <span className="p-2 rounded-md" title="设置" aria-hidden>
                        <Settings className="size-5" strokeWidth={2} />
                    </span>
                </div>
            </header>
            <div className="flex flex-1 min-h-0">
                <aside
                    className="w-[18%] min-w-[200px] max-w-[280px] flex flex-col overflow-hidden bg-[var(--bg-panel)] border-r border-[var(--border)]"
                    aria-label="图层面板（静态）"
                >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
                        <span className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                            <Layers className="size-4 text-[var(--accent)]" aria-hidden />
                            图层
                        </span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        <div className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-2 text-xs text-[var(--text-secondary)]">
                            底图 · 示例
                        </div>
                        <div className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-2 text-xs text-[var(--text-secondary)]">
                            矢量 · 示例
                        </div>
                    </div>
                    <div className="shrink-0 border-t border-[var(--border)] p-2 text-xs text-[var(--text-muted)]">
                        地形 / 书签 / 标注（静态占位）
                    </div>
                </aside>
                <main className="flex-1 min-w-0 relative flex flex-col bg-[var(--bg-primary)]">
                    <div
                        ref={mapContainerRef}
                        className="flex-1 m-2 min-h-0 rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--bg-panel)]"
                        aria-label="地图视图"
                    />
                    <div className="h-8 shrink-0 flex items-center justify-center border-t border-[var(--border)] bg-[var(--bg-panel)]/80 text-[10px] text-[var(--text-muted)]">
                        工具提示栏（静态占位）
                    </div>
                </main>
                <aside
                    className="w-[20%] min-w-[220px] max-w-[320px] flex flex-col bg-[var(--bg-panel)] border-l border-[var(--border)] overflow-y-auto"
                    aria-label="属性与样式（静态）"
                >
                    <nav
                        className="flex shrink-0 border-b border-[var(--border)] px-1"
                        role="tablist"
                        aria-label="右侧面板"
                    >
                        <span className="flex-1 px-2 py-2 text-xs font-medium text-center border-b-2 border-[var(--accent)] text-[var(--accent)]">
                            属性
                        </span>
                        <span className="flex-1 px-2 py-2 text-xs font-medium text-center border-b-2 border-transparent text-[var(--text-secondary)]">
                            样式
                        </span>
                        <span className="flex-1 px-2 py-2 text-xs font-medium text-center border-b-2 border-transparent text-[var(--text-secondary)]">
                            图例
                        </span>
                    </nav>
                    <div className="flex-1 flex flex-col min-h-0 px-3 py-6 text-sm text-[var(--text-secondary)] text-center leading-relaxed">
                        未选择要素。静态预览，无地图交互。
                    </div>
                </aside>
            </div>
            <footer
                className="h-7 flex items-center px-3 gap-0 text-xs bg-[var(--bg-panel)] border-t border-[var(--border)] text-[var(--text-secondary)] shrink-0 overflow-x-auto"
                role="contentinfo"
            >
                <span className="whitespace-nowrap">📍 —° —′ —″ , —° —′ —″</span>
                <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
                    │
                </span>
                <span className="whitespace-nowrap">z: —</span>
                <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
                    │
                </span>
                <span className="whitespace-nowrap">⬡ —</span>
                <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
                    │
                </span>
                <span className="whitespace-nowrap">— fps</span>
                <span className="text-[var(--text-secondary)] opacity-30 px-1 select-none" aria-hidden>
                    │
                </span>
                <span className="whitespace-nowrap">— MB</span>
            </footer>
        </div>
    );  }
