import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactElement,
} from 'react';
import { Loader2, MapPin, Search } from 'lucide-react';
import { useMapStore } from '@/stores/mapStore';

/**
 * One geocoding candidate shown in the search dropdown.
 */
export interface SearchCandidate {
    /** Stable id for keyboard navigation. */
    id: string;
    /** Primary place label. */
    name: string;
    /** Secondary region or admin label. */
    region: string;
    /** Destination center in degrees `[lng, lat]`. */
    center: [number, number];
    /** Optional zoom hint. */
    zoom?: number;
}

/**
 * Parses decimal degree pair like `116.4, 39.9` (optional spaces).
 *
 * @param raw - User input string.
 * @returns Parsed `[lng, lat]` or null when not matched.
 */
function parseDecimalCoordinatePair(raw: string): [number, number] | null {
    const s = raw.trim();
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return null;
    const lng = Number(m[1]);
    const lat = Number(m[2]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [lng, lat];
}

/**
 * Parses DMS like `116°23'12"E 39°54'36"N` (flexible spacing).
 *
 * @param raw - User input string.
 * @returns Parsed `[lng, lat]` in degrees or null.
 */
function parseDmsCoordinatePair(raw: string): [number, number] | null {
    const s = raw.trim();
    const re =
        /^\s*(\d{1,3})°\s*(\d{1,2})′\s*(\d{1,2}(?:\.\d+)?)″\s*([EWew])\s+(\d{1,2})°\s*(\d{1,2})′\s*(\d{1,2}(?:\.\d+)?)″\s*([NSns])\s*$/;
    const m = re.exec(s);
    if (!m) return null;
    const d1 = Number(m[1]);
    const m1 = Number(m[2]);
    const s1 = Number(m[3]);
    const hemi1 = m[4].toUpperCase();
    const d2 = Number(m[5]);
    const m2 = Number(m[6]);
    const s2 = Number(m[7]);
    const hemi2 = m[8].toUpperCase();
    let lng = d1 + m1 / 60 + s1 / 3600;
    if (hemi1 === 'W') lng = -lng;
    let lat = d2 + m2 / 60 + s2 / 3600;
    if (hemi2 === 'S') lat = -lat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [lng, lat];
}

/**
 * Builds mock candidates from the current query (deterministic, offline).
 *
 * @param q - Non-empty trimmed query.
 * @returns Up to five {@link SearchCandidate} rows.
 */
function mockCandidates(q: string): SearchCandidate[] {
    const baseLng = 116.4 + (q.length % 7) * 0.01;
    const baseLat = 39.9 + (q.length % 5) * 0.01;
    const names = ['示例地点', '公园', '广场', '道路交叉口', '地标建筑'];
    const regions = ['北京市', '海淀区', '朝阳区', '丰台区', '城市副中心'];
    return Array.from({ length: 5 }).map((_, i) => ({
        id: `mock-${i}`,
        name: `${names[i % names.length]} · ${q}`,
        region: regions[i % regions.length],
        center: [baseLng + i * 0.02, baseLat + i * 0.01] as [number, number],
        zoom: 14,
    }));
}

/**
 * Top-toolbar geocoder input with offline mock results and coordinate jump.
 *
 * @returns Search field + dropdown UI.
 */
export function SearchBox(): ReactElement {
    const inputId = useId();
    const listId = useId();
    const flyTo = useMapStore((s) => s.flyTo);

    const [value, setValue] = useState('');
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<number>(0);

    const trimmed = value.trim();
    const coordDecimal = useMemo(() => parseDecimalCoordinatePair(trimmed), [trimmed]);
    const coordDms = useMemo(() => parseDmsCoordinatePair(trimmed), [trimmed]);
    const coordParsed = coordDecimal ?? coordDms;

    const candidates = useMemo(() => {
        if (trimmed.length === 0) return [] as SearchCandidate[];
        return mockCandidates(trimmed);
    }, [trimmed]);

    useEffect(() => {
        if (!open) return;
        setHighlight(0);
    }, [open, trimmed, coordParsed]);

    useEffect(() => {
        const onDocMouseDown = (e: MouseEvent) => {
            const root = containerRef.current;
            if (!root) return;
            if (e.target instanceof Node && !root.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, []);

    useEffect(() => {
        if (!open || trimmed.length === 0 || coordParsed) {
            setLoading(false);
            return;
        }
        const id = ++requestRef.current;
        setLoading(true);
        setError(false);
        const t = window.setTimeout(() => {
            if (requestRef.current !== id) return;
            setLoading(false);
            if (trimmed.toLowerCase() === 'error') {
                setError(true);
                return;
            }
            if (trimmed.toLowerCase() === 'empty') {
                setError(false);
            }
        }, 420);
        return () => window.clearTimeout(t);
    }, [open, trimmed, coordParsed]);

    const showDropdown = open && trimmed.length > 0;
    const showNoResults =
        showDropdown && !coordParsed && !loading && !error && trimmed.toLowerCase() === 'empty';
    const showErrorState = showDropdown && !coordParsed && !loading && error;
    const showResults =
        showDropdown && !coordParsed && !loading && !error && trimmed.toLowerCase() !== 'empty' && candidates.length > 0;

    const totalItems = coordParsed ? 1 : candidates.length;

    const selectCandidate = useCallback(
        (c: SearchCandidate) => {
            flyTo(c.center, c.zoom);
            // Temporary marker hook point (engine integration later).
            console.info('[SearchBox] flyTo + temporary marker', c.center, c.zoom);
            setOpen(false);
            setValue('');
        },
        [flyTo],
    );

    const onSelectCoordinate = useCallback(() => {
        if (!coordParsed) return;
        flyTo(coordParsed, 15);
        console.info('[SearchBox] flyTo coordinate + temporary marker', coordParsed);
        setOpen(false);
        setValue('');
    }, [coordParsed, flyTo]);

    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            return;
        }
        if (!showDropdown) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (totalItems <= 0) return;
            setHighlight((h) => Math.min(totalItems - 1, h + 1));
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (totalItems <= 0) return;
            setHighlight((h) => Math.max(0, h - 1));
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (loading && !coordParsed) return;
            if (coordParsed) {
                onSelectCoordinate();
                return;
            }
            const c = candidates[highlight];
            if (c) selectCandidate(c);
        }
    };

    return (
        <div ref={containerRef} className="relative w-full min-w-[280px] max-w-[400px]">
            <label className="sr-only" htmlFor={inputId}>
                搜索地点或坐标
            </label>
            <div className="relative">
                <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-[var(--text-muted)] pointer-events-none"
                    aria-hidden
                />
                <input
                    id={inputId}
                    type="search"
                    role="combobox"
                    aria-expanded={showDropdown}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    placeholder="搜索地点或输入坐标..."
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        setOpen(true);
                        setError(false);
                    }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onKeyDown}
                    className="w-full h-8 pl-9 pr-9 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] text-sm outline-none focus:border-[var(--accent)]"
                />
                {loading && (
                    <Loader2
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-[var(--accent)] animate-spin"
                        aria-hidden
                    />
                )}
            </div>

            {showDropdown && (
                <div
                    id={listId}
                    role="listbox"
                    className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-lg max-h-[300px] overflow-y-auto"
                >
                    {coordParsed && (
                        <button
                            type="button"
                            role="option"
                            aria-selected={highlight === 0}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-panel-hover)] ${
                                highlight === 0 ? 'bg-[var(--highlight)]' : ''
                            }`}
                            onMouseEnter={() => setHighlight(0)}
                            onClick={() => onSelectCoordinate()}
                        >
                            <div className="text-[var(--text-primary)]">飞行到此坐标</div>
                            <div className="text-xs text-[var(--text-secondary)] font-mono">
                                {coordParsed[0].toFixed(5)}, {coordParsed[1].toFixed(5)}
                            </div>
                        </button>
                    )}

                    {loading && !coordParsed && (
                        <div className="px-3 py-2 text-xs text-[var(--text-secondary)]">正在搜索…</div>
                    )}

                    {showErrorState && (
                        <div className="px-3 py-2 text-xs text-[var(--error)]">搜索服务不可用，请检查网络</div>
                    )}

                    {showNoResults && (
                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">未找到匹配地点</div>
                    )}

                    {showResults &&
                        candidates.map((c, idx) => {
                            const active = idx === highlight;
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--bg-panel-hover)] ${
                                        active ? 'bg-[var(--highlight)]' : ''
                                    }`}
                                    onMouseEnter={() => setHighlight(idx)}
                                    onClick={() => selectCandidate(c)}
                                >
                                    <MapPin className="size-4 mt-0.5 text-[var(--accent)] shrink-0" aria-hidden />
                                    <div className="min-w-0">
                                        <div className="text-sm text-[var(--text-primary)] truncate">{c.name}</div>
                                        <div className="text-[10px] text-[var(--text-muted)] inline-block mt-0.5 px-1.5 py-0.5 rounded border border-[var(--border)]">
                                            {c.region}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                </div>
            )}
        </div>
    );
}
