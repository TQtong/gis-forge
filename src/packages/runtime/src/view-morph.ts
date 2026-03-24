// ============================================================
// L3/view-morph.ts — 视图模式过渡（2D / 2.5D / 3D）插值器
// 层级：L3
// 职责：在两种 CameraController 之间对 CameraState 关键参数做时间插值。
// ============================================================

import type { CameraController } from './camera-controller.ts';
import type { CameraState, Viewport } from '../../core/src/types/viewport.ts';

/** 视图模式枚举 */
export type ViewMode = '2d' | '25d' | '3d';

/** morph 选项 */
export interface ViewMorphOptions {
  /** 过渡时长（毫秒） */
  readonly duration?: number;
  /** 归一化时间 t∈[0,1] 的缓动函数 */
  readonly easing?: (t: number) => number;
}

/** 单次 morph 动画句柄 */
export interface ViewMorphAnimation {
  /** 完成或取消时 resolve */
  readonly finished: Promise<void>;
  /** 取消过渡 */
  cancel(): void;
}

/** ViewMorph 控制器 */
export interface ViewMorph {
  /** 开始一次模式过渡 */
  morphTo(
    targetMode: ViewMode,
    fromCamera: CameraController,
    toCamera: CameraController,
    options?: ViewMorphOptions
  ): ViewMorphAnimation;
  /** 是否正在过渡 */
  readonly isMorphing: boolean;
  /** 当前逻辑模式（初始或最近一次完成的 target） */
  readonly currentMode: ViewMode;
  /** 归一化进度 [0,1] */
  readonly progress: number;
  /** 取消当前 morph */
  cancel(): void;
}

/** 默认视口（当调用方未提供时） */
const DEFAULT_VIEWPORT: Viewport = {
  width: 1024,
  height: 768,
  physicalWidth: 1024,
  physicalHeight: 768,
  pixelRatio: 1,
};

/** 最小 morph 时长，避免除零 */
const MIN_DURATION_MS = 16;

/**
 * 钳制数值。
 *
 * @param v - 值
 * @param lo - 下界
 * @param hi - 上界
 * @returns 钳制结果
 *
 * @example
 * clamp(3, 0, 2);
 */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return 0;
  }
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.min(b, Math.max(a, v));
}

/**
 * 线性插值。
 *
 * @param a - 起点
 * @param b - 终点
 * @param t - 因子
 * @returns 结果
 *
 * @example
 * lerp(0, 10, 0.5);
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * 默认缓动（smoothstep）。
 *
 * @param t - [0,1]
 * @returns 缓动值
 *
 * @example
 * easeDef(0.2);
 */
function easeDef(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * 对两个 CameraState 做字段插值，写入 `toCamera`（通过 jumpTo）。
 *
 * @param a - 起始状态
 * @param b - 结束状态
 * @param t - [0,1]
 * @param toCam - 目标控制器
 *
 * @example
 * applyBlendedState(sa, sb, 0.5, cam);
 */
function applyBlendedState(a: CameraState, b: CameraState, t: number, toCam: CameraController): void {
  const c0 = lerp(a.center[0], b.center[0], t);
  const c1 = lerp(a.center[1], b.center[1], t);
  const zm = lerp(a.zoom, b.zoom, t);
  const br = lerp(a.bearing, b.bearing, t);
  const pi = lerp(a.pitch, b.pitch, t);
  // jumpTo 在两种控制器上均存在；合并失败时分项降级
  try {
    toCam.jumpTo({ center: [c0, c1], zoom: zm, bearing: br, pitch: pi });
  } catch (e) {
    console.error('[ViewMorph] jumpTo failed', e);
    try {
      toCam.setCenter([c0, c1]);
    } catch (e2) {
      console.error('[ViewMorph] setCenter fallback failed', e2);
    }
  }
}

/**
 * 创建 ViewMorph 实例。
 *
 * @param initialMode - 初始 currentMode
 * @returns ViewMorph
 *
 * @example
 * const vm = createViewMorph('2d');
 */
export function createViewMorph(initialMode?: ViewMode): ViewMorph {
  let currentMode: ViewMode = initialMode ?? '2d';
  let morphing = false;
  let progress = 0;
  let rafId: number | null = null;
  let startMs = 0;
  let durationMs = 0;
  let easing: (n: number) => number = easeDef;
  let fromSnap: CameraState | null = null;
  let toSnap: CameraState | null = null;
  let targetCam: CameraController | null = null;
  let finishResolve: (() => void) | null = null;

  const morphImpl: ViewMorph = {
    get isMorphing() {
      return morphing;
    },
    get currentMode() {
      return currentMode;
    },
    get progress() {
      return progress;
    },
    cancel(): void {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      morphing = false;
      progress = 0;
      fromSnap = null;
      toSnap = null;
      targetCam = null;
      if (finishResolve) {
        finishResolve();
        finishResolve = null;
      }
    },
    morphTo(
      targetMode: ViewMode,
      fromCamera: CameraController,
      toCamera: CameraController,
      options?: ViewMorphOptions
    ): ViewMorphAnimation {
      // 若已有 morph，先取消避免帧回调重叠
      morphImpl.cancel();
      const vp = DEFAULT_VIEWPORT;
      durationMs = Math.max(MIN_DURATION_MS, options?.duration ?? 800);
      easing = options?.easing ?? easeDef;
      // 起始/结束快照：deltaTime=0 仅构建矩阵
      let s0: CameraState;
      let s1: CameraState;
      try {
        s0 = fromCamera.update(0, vp);
      } catch (e) {
        console.error('[ViewMorph] fromCamera.update failed', e);
        s0 = fromCamera.state;
      }
      try {
        // 目标相机先同步到其自身当前逻辑状态
        s1 = toCamera.update(0, vp);
      } catch (e) {
        console.error('[ViewMorph] toCamera.update failed', e);
        s1 = toCamera.state;
      }
      fromSnap = s0;
      toSnap = s1;
      targetCam = toCamera;
      morphing = true;
      progress = 0;
      startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      let resolved = false;
      const finished = new Promise<void>((resolve) => {
        finishResolve = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
      });

      const step = (): void => {
        if (!morphing || !fromSnap || !toSnap || !targetCam) {
          return;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const u = clamp((now - startMs) / durationMs, 0, 1);
        const te = easing(u);
        progress = te;
        applyBlendedState(fromSnap, toSnap, te, targetCam);
        try {
          targetCam.update(0, vp);
        } catch (e) {
          console.error('[ViewMorph] toCamera.update during morph', e);
        }
        if (u >= 1) {
          morphing = false;
          progress = 1;
          currentMode = targetMode;
          rafId = null;
          fromSnap = null;
          toSnap = null;
          targetCam = null;
          if (finishResolve) {
            finishResolve();
            finishResolve = null;
          }
          return;
        }
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(step);
        } else {
          // 无 rAF 环境：同步推进（测试/Worker）
          setTimeout(step, MIN_DURATION_MS);
        }
      };

      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(step);
      } else {
        setTimeout(step, 0);
      }

      const anim: ViewMorphAnimation = {
        finished,
        cancel: () => {
          morphImpl.cancel();
        },
      };
      return anim;
    },
  };

  return morphImpl;
}
