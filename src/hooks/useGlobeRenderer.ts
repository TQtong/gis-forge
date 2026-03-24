import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useMapStore } from '@/stores/mapStore';
import { useStatusStore } from '@/stores/statusStore';

const DEG = Math.PI / 180;

const COASTS: [number, number][] = [
    [-10,35],[0,35],[10,35],[15,38],[25,37],[30,35],[35,32],[35,30],
    [40,28],[45,25],[50,25],[55,22],[60,25],[65,25],[70,20],[75,15],
    [80,10],[85,15],[90,22],[95,20],[100,15],[105,20],[110,22],[115,30],
    [120,32],[125,35],[130,35],[135,35],[140,38],[145,42],
];
const AMERICAS: [number, number][] = [
    [-130,50],[-125,48],[-120,35],[-115,30],[-110,25],[-105,20],
    [-100,18],[-95,18],[-90,15],[-85,10],[-80,8],[-75,5],[-70,-5],
    [-65,-15],[-60,-20],[-55,-25],[-50,-30],[-45,-22],[-40,-15],
    [-50,-5],[-55,5],[-60,10],[-65,10],[-70,12],[-80,10],
];
const AFRICA: [number, number][] = [
    [-15,35],[-5,35],[5,35],[10,32],[12,30],[15,25],[20,15],
    [25,10],[30,5],[35,0],[40,-5],[38,-10],[35,-20],[30,-30],
    [25,-33],[20,-33],[15,-25],[10,-15],[5,-5],[0,5],[-5,10],
    [-10,15],[-15,20],[-17,25],[-15,30],
];
const EUROPE: [number, number][] = [
    [-10,36],[-9,38],[-8,42],[-5,44],[0,44],[3,43],[5,46],[7,48],
    [10,48],[13,52],[14,54],[10,56],[12,58],[18,60],[24,60],[28,58],
    [30,55],[32,50],[30,46],[28,42],[26,40],[22,38],[20,36],[15,38],
    [10,44],[5,48],[0,48],[-5,46],[-8,44],[-10,40],
];

function project(
    lon: number, lat: number,
    centerLon: number, centerLat: number,
): { x: number; y: number; visible: boolean } {
    const lam = lon * DEG;
    const phi = lat * DEG;
    const lam0 = centerLon * DEG;
    const phi0 = centerLat * DEG;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinPhi0 = Math.sin(phi0);
    const cosPhi0 = Math.cos(phi0);
    const dLam = lam - lam0;
    const cosDLam = Math.cos(dLam);

    const cosC = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosDLam;

    const x = cosPhi * Math.sin(dLam);
    const y = cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosDLam;

    return { x, y, visible: cosC > -0.05 };
}

function drawGlobe(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    centerLon: number, centerLat: number,
) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) * 0.78;

    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, w, h);

    const seed = 42;
    for (let i = 0; i < 200; i++) {
        const a = (seed * (i + 1) * 16807) % 2147483647;
        const b = (seed * (i + 1) * 48271) % 2147483647;
        const sx = (a / 2147483647) * w;
        const sy = (b / 2147483647) * h;
        const dx2 = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
        if (dx2 < (radius + 30) * (radius + 30)) continue;
        const brightness = 0.15 + ((a % 100) / 100) * 0.55;
        ctx.fillStyle = `rgba(255,255,255,${brightness})`;
        ctx.fillRect(sx, sy, 1.2, 1.2);
    }

    const atmo = ctx.createRadialGradient(cx, cy, radius * 0.97, cx, cy, radius * 1.2);
    atmo.addColorStop(0, 'rgba(83,168,182,0.3)');
    atmo.addColorStop(0.5, 'rgba(83,168,182,0.1)');
    atmo.addColorStop(1, 'rgba(83,168,182,0)');
    ctx.fillStyle = atmo;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.2, 0, Math.PI * 2);
    ctx.fill();

    const ocean = ctx.createRadialGradient(
        cx - radius * 0.25, cy - radius * 0.25, radius * 0.05,
        cx, cy, radius,
    );
    ocean.addColorStop(0, '#1e6fa0');
    ocean.addColorStop(0.5, '#185a80');
    ocean.addColorStop(1, '#0e3e5c');
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ocean;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    const drawLand = (coords: [number, number][], color: string, strokeColor: string) => {
        ctx.beginPath();
        let started = false;
        for (const [lon, lat] of coords) {
            const p = project(lon, lat, centerLon, centerLat);
            if (!p.visible) { started = false; continue; }
            const px = cx + p.x * radius;
            const py = cy - p.y * radius;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.8;
        ctx.stroke();
    };

    drawLand(COASTS, 'rgba(56,142,60,0.7)', 'rgba(56,142,60,0.4)');
    drawLand(AMERICAS, 'rgba(56,142,60,0.7)', 'rgba(56,142,60,0.4)');
    drawLand(AFRICA, 'rgba(56,142,60,0.7)', 'rgba(56,142,60,0.4)');
    drawLand(EUROPE, 'rgba(76,162,80,0.65)', 'rgba(76,162,80,0.35)');

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.5;
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 30) {
        ctx.beginPath();
        let started = false;
        for (let latDeg = -90; latDeg <= 90; latDeg += 2) {
            const p = project(lonDeg, latDeg, centerLon, centerLat);
            if (!p.visible) { started = false; continue; }
            const px = cx + p.x * radius;
            const py = cy - p.y * radius;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }
    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
        ctx.beginPath();
        let started = false;
        for (let lonDeg = -180; lonDeg <= 180; lonDeg += 2) {
            const p = project(lonDeg, latDeg, centerLon, centerLat);
            if (!p.visible) { started = false; continue; }
            const px = cx + p.x * radius;
            const py = cy - p.y * radius;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    const cp = project(centerLon, centerLat, centerLon, centerLat);
    if (cp.visible) {
        const dpx = cx + cp.x * radius;
        const dpy = cy - cp.y * radius;
        ctx.fillStyle = '#53a8b6';
        ctx.beginPath();
        ctx.arc(dpx, dpy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    ctx.restore();

    ctx.strokeStyle = 'rgba(83,168,182,0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
}

/**
 * Renders an interactive orthographic globe on a Canvas 2D element.
 * Supports drag-to-rotate and scroll-to-zoom (adjusts mapStore center).
 */
export function useGlobeRenderer(
    canvasRef: RefObject<HTMLCanvasElement | null>,
    containerRef: RefObject<HTMLDivElement | null>,
    active: boolean,
) {
    const isDragging = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const rafId = useRef(0);
    const fpsCounter = useRef({ frames: 0, lastTime: performance.now() });

    useEffect(() => {
        if (!active) return;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const resize = () => {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            canvas.width = rect.width;
            canvas.height = rect.height;
        };
        resize();

        const ro = new ResizeObserver(resize);
        ro.observe(container);

        const render = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const { center } = useMapStore.getState();
            drawGlobe(ctx, canvas.width, canvas.height, center[0], center[1]);

            fpsCounter.current.frames++;
            const now = performance.now();
            if (now - fpsCounter.current.lastTime >= 1000) {
                useStatusStore.getState().setFps(fpsCounter.current.frames);
                fpsCounter.current.frames = 0;
                fpsCounter.current.lastTime = now;
            }
        };

        render();

        const scheduleRender = () => {
            cancelAnimationFrame(rafId.current);
            rafId.current = requestAnimationFrame(render);
        };

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            isDragging.current = true;
            lastMouse.current = { x: e.clientX, y: e.clientY };
            canvas.style.cursor = 'grabbing';
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;
            const dx = e.clientX - lastMouse.current.x;
            const dy = e.clientY - lastMouse.current.y;
            lastMouse.current = { x: e.clientX, y: e.clientY };

            const store = useMapStore.getState();
            const [cLon, cLat] = store.center;
            const sensitivity = 0.3;
            const newLon = cLon - dx * sensitivity;
            const newLat = Math.max(-85, Math.min(85, cLat + dy * sensitivity));
            store.flyTo([newLon, newLat]);
            scheduleRender();
        };

        const onMouseUp = () => {
            isDragging.current = false;
            canvas.style.cursor = 'grab';
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const store = useMapStore.getState();
            const delta = e.deltaY > 0 ? -0.5 : 0.5;
            store.setZoom(Math.max(1, Math.min(20, store.zoom + delta)));
            scheduleRender();
        };

        canvas.style.cursor = 'grab';
        canvas.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });

        const unsub = useMapStore.subscribe(scheduleRender);

        return () => {
            cancelAnimationFrame(rafId.current);
            ro.disconnect();
            canvas.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('wheel', onWheel);
            unsub();
        };
    }, [active, canvasRef, containerRef]);
}
