import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader2, LocateFixed } from 'lucide-react';
import { toast } from 'sonner';
import { useMapStore } from '@/stores/mapStore';

type LocateStatus = 'idle' | 'loading' | 'error';

const ERROR_RESET_MS = 1800;

/**
 * Geolocation control: flies the map to the device position with toast feedback.
 *
 * @returns Absolute-positioned button for the map overlay stack.
 */
export function LocateControl(): ReactElement {
    const flyTo = useMapStore((s) => s.flyTo);
    const zoom = useMapStore((s) => s.zoom);
    const [status, setStatus] = useState<LocateStatus>('idle');
    const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearErrorTimer = useCallback(() => {
        if (errorTimerRef.current !== null) {
            clearTimeout(errorTimerRef.current);
            errorTimerRef.current = null;
        }
    }, []);

    const scheduleErrorReset = useCallback(() => {
        clearErrorTimer();
        errorTimerRef.current = setTimeout(() => {
            setStatus('idle');
            errorTimerRef.current = null;
        }, ERROR_RESET_MS);
    }, [clearErrorTimer]);

    useEffect(() => {
        return () => clearErrorTimer();
    }, [clearErrorTimer]);

    const onLocate = useCallback(() => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            toast.error('浏览器不支持定位', { description: '请使用支持 Geolocation 的浏览器。' });
            setStatus('error');
            scheduleErrorReset();
            return;
        }
        setStatus('loading');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lng = pos.coords.longitude;
                const lat = pos.coords.latitude;
                if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
                    toast.error('定位结果无效');
                    setStatus('error');
                    scheduleErrorReset();
                    return;
                }
                flyTo([lng, lat], Math.max(zoom, 14));
                toast.success('已定位到当前位置', {
                    description: `${lng.toFixed(5)}°E, ${lat.toFixed(5)}°N`,
                });
                setStatus('idle');
            },
            (err) => {
                const msg = err.message || '无法获取位置';
                toast.error('定位失败', { description: msg });
                setStatus('error');
                scheduleErrorReset();
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 60_000 },
        );
    }, [flyTo, scheduleErrorReset, zoom]);

    const iconClass =
        status === 'error'
            ? 'text-[var(--error)]'
            : 'text-[var(--text-primary)]';

    return (
        <button
            type="button"
            title="定位到我的位置"
            aria-label="定位到我的位置"
            aria-busy={status === 'loading'}
            disabled={status === 'loading'}
            onClick={onLocate}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bg-panel)]/80 backdrop-blur border border-[var(--border)] text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-panel-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-70"
        >
            {status === 'loading' ? (
                <Loader2 className="size-4 animate-spin text-[var(--accent)]" aria-hidden />
            ) : (
                <LocateFixed className={`size-4 ${iconClass}`} strokeWidth={2} aria-hidden />
            )}
        </button>
    );
}
