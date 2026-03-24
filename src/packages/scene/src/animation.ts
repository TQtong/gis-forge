// ============================================================
// L4/scene/animation.ts — 图层属性动画与时间轴（Clock）
// 层级：L4（场景）
// 职责：数值属性补间、动画状态机、全局时钟；flyTo 委托 CameraController。
// 依赖：L3 CameraController / CameraAnimation（零 npm）。
// ============================================================

import type { CameraAnimation, CameraController } from '../../runtime/src/camera-controller.ts';

// ---------------------------------------------------------------------------
// 常量（避免魔法数；时间与数值稳定性）
// ---------------------------------------------------------------------------

/** 最小动画时长（毫秒），过短会导致除零或肉眼不可见 */
const MIN_DURATION_MS = 1;

/** 默认动画时长（毫秒），与 Camera2D 默认 fly 时长同量级 */
const DEFAULT_DURATION_MS = 300;

/** 浮点比较 epsilon，用于判定 progress≈1 */
const PROGRESS_EPS = 1e-6;

/** 默认缓动：线性 [0,1]→[0,1] */
const DEFAULT_EASING: EasingFunction = (t: number) => t;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 缓动函数：输入归一化时间 t∈[0,1]，输出缓动后的插值因子。
 * 返回值应落在 [0,1] 附近（允许轻微超出以实现弹性效果）。
 *
 * @param t - 归一化时间 [0,1]
 * @returns 缓动因子
 */
export type EasingFunction = (t: number) => number;

/**
 * 属性动画的可选参数。
 *
 * @example
 * const opts: AnimationOptions = { duration: 500, easing: (t) => t * t, delay: 100, loop: false };
 */
export interface AnimationOptions {
  /**
   * 单次动画时长（毫秒）。
   * 必须为正有限数；非法时回退为 `DEFAULT_DURATION_MS`。
   * 单位：毫秒（ms）。
   */
  readonly duration?: number;

  /**
   * 缓动函数；省略则为线性插值。
   * 输入为归一化时间 t∈[0,1]。
   */
  readonly easing?: EasingFunction;

  /**
   * 开始补间前的延迟（毫秒）。
   * 延迟期间状态为 `pending`；非负有限数，否则视为 0。
   */
  readonly delay?: number;

  /**
   * 是否循环：`true` 为无限循环；有限正整数为剩余重复次数；`false`/0 为不循环。
   * 每次循环重新从 from→to 播放。
   */
  readonly loop?: boolean | number;
}

/**
 * 动画对外句柄：可查询进度、暂停/恢复/取消/反向，await `finished`。
 *
 * @example
 * const a = manager.animateProperty(obj, 'opacity', 0, 1, { duration: 400 });
 * a.finished.then(() => console.log('done'));
 */
export interface Animation {
  /**
   * 动画实例唯一 ID（UUID 或时间戳随机串）。
   */
  readonly id: string;

  /**
   * 状态机：`pending`（仅延迟阶段）→`running`→`finished` | `cancelled`；`paused` 为运行中暂停。
   */
  readonly state: 'pending' | 'running' | 'paused' | 'finished' | 'cancelled';

  /**
   * 线性进度 [0,1]（已含缓动前的归一化时间，再经 easing 映射前的 t）。
   *  finished/cancelled 后分别固定为 1 或 0（取消为当前瞬时进度快照）。
   */
  readonly progress: number;

  /**
   * 暂停动画（仅 `running` 有效）。
   *
   * @example
   * anim.pause();
   */
  pause(): void;

  /**
   * 从 `paused` 恢复为 `running`。
   *
   * @example
   * anim.resume();
   */
  resume(): void;

  /**
   * 取消动画并进入 `cancelled`，`finished` resolve。
   *
   * @example
   * anim.cancel();
   */
  cancel(): void;

  /**
   * 反转播放方向：从当前值折返向另一端；保持时长剩余比例一致（MVP 近似）。
   *
   * @example
   * anim.reverse();
   */
  reverse(): void;

  /**
   * 动画结束（完成、取消）时 resolve 的 Promise。
   */
  readonly finished: Promise<void>;
}

/**
 * 全局动画与场景时钟管理器。
 *
 * @example
 * const m = createAnimationManager();
 * m.setCameraController(camera);
 * m.flyTo({ zoom: 12, duration: 800 });
 */
export interface AnimationManager {
  /**
   * 绑定用于 `flyTo` 的相机控制器；`null` 表示未绑定。
   *
   * @param controller - 相机实例或 null
   *
   * @example
   * manager.setCameraController(camera);
   */
  setCameraController(controller: CameraController | null): void;

  /**
   * 对对象上的数值属性做补间动画。
   *
   * @param target - 可写属性包（弱类型以兼容图层对象）
   * @param property - 属性名
   * @param from - 起始数值
   * @param to - 结束数值
   * @param options - 时长/缓动/延迟/循环
   * @returns 动画句柄
   *
   * @example
   * const anim = manager.animateProperty(layer, 'opacity', 0, 1, { duration: 500 });
   */
  animateProperty(
    target: Record<string, unknown>,
    property: string,
    from: number,
    to: number,
    options?: AnimationOptions,
  ): Animation;

  /**
   * 委托 `CameraController.flyTo`；需先 `setCameraController`。
   *
   * @param options - 与 CameraController.flyTo 一致
   * @returns 相机动画句柄
   *
   * @example
   * manager.flyTo({ center: [116.4, 39.9], zoom: 10, duration: 1500 });
   */
  flyTo(options: Parameters<CameraController['flyTo']>[0]): CameraAnimation;

  /**
   * 将场景时钟绝对时间设为指定秒（非负有限）。
   *
   * @param seconds - 时钟时间（秒）
   *
   * @example
   * manager.setClock(3.5);
   */
  setClock(seconds: number): void;

  /**
   * 只读时钟视图：当前时间（秒）、倍速、是否播放。
   */
  readonly clock: {
    /** 当前累计时间（秒），`pauseClock` 时冻结 */
    readonly currentTime: number;
    /** 时间倍率；0 表示不推进；负值按规范钳为 0 */
    readonly multiplier: number;
    /** 是否处于播放（非暂停） */
    readonly isPlaying: boolean;
  };

  /**
   * 开始或继续时钟推进。
   *
   * @example
   * manager.playClock();
   */
  playClock(): void;

  /**
   * 暂停时钟（不修改 currentTime）。
   *
   * @example
   * manager.pauseClock();
   */
  pauseClock(): void;

  /**
   * 每帧调用：推进所有属性动画与全局时钟。
   *
   * @param deltaTime - 距上一帧时间（秒），应非负有限
   *
   * @example
   * manager.update(dt);
   */
  update(deltaTime: number): void;

  /**
   * 按 ID 获取动画句柄（若不存在则 undefined）。
   *
   * @param id - 动画 ID
   *
   * @example
   * const a = manager.getAnimation(id);
   */
  getAnimation(id: string): Animation | undefined;

  /**
   * 当前未处于 `finished`/`cancelled` 的动画列表（含 `pending`/`paused`）。
   *
   * @example
   * const list = manager.getActiveAnimations();
   */
  getActiveAnimations(): readonly Animation[];

  /**
   * 取消所有由本管理器创建的属性动画（不影响已委托的 CameraAnimation）。
   *
   * @example
   * manager.cancelAll();
   */
  cancelAll(): void;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * 将数值限制在 [0,1]；非法输入回退 0。
 *
 * @param t - 输入
 * @returns 钳制结果
 *
 * @example
 * clamp01(1.2); // → 1
 */
function clamp01(t: number): number {
  // 非有限数直接视为 0，避免 NaN 污染插值
  if (!Number.isFinite(t)) {
    return 0;
  }
  if (t < 0) {
    return 0;
  }
  if (t > 1) {
    return 1;
  }
  return t;
}

/**
 * 线性插值。
 *
 * @param a - 起点
 * @param b - 终点
 * @param t - 因子 [0,1]
 * @returns 插值结果
 *
 * @example
 * lerp(0, 10, 0.5); // → 5
 */
function lerp(a: number, b: number, t: number): number {
  const tt = clamp01(t);
  // 起点终点非有限时回退为 0，避免写坏属性
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return 0;
  }
  return a + (b - a) * tt;
}

/**
 * 生成动画 ID（优先 crypto.randomUUID）。
 *
 * @returns 唯一字符串
 *
 * @example
 * const id = makeAnimId();
 */
function makeAnimId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 受限环境可能拒绝调用，走退化分支
  }
  return `l4-anim-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 规范化 AnimationOptions 中的 duration/delay/loop/easing。
 *
 * @param options - 用户选项
 * @returns 规范化后的参数元组
 *
 * @example
 * const x = normalizeAnimOptions({ duration: -1, delay: NaN });
 */
function normalizeAnimOptions(options: AnimationOptions | undefined): {
  durationMs: number;
  delayMs: number;
  easing: EasingFunction;
  loop: boolean;
  loopCount: number;
} {
  // duration：正有限数，否则默认
  let durationMs = options?.duration;
  if (!Number.isFinite(durationMs as number) || (durationMs as number) <= 0) {
    durationMs = DEFAULT_DURATION_MS;
  }
  durationMs = Math.max(MIN_DURATION_MS, durationMs as number);

  // delay：非负有限
  let delayMs = options?.delay ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    delayMs = 0;
  }

  const easing = typeof options?.easing === 'function' ? options!.easing! : DEFAULT_EASING;

  let loop = false;
  let loopCount = 0;
  const lp = options?.loop;
  if (lp === true) {
    loop = true;
    loopCount = Infinity;
  } else if (typeof lp === 'number' && Number.isFinite(lp) && lp > 0) {
    loop = true;
    loopCount = Math.floor(lp);
  }

  return { durationMs, delayMs, easing, loop, loopCount };
}

/**
 * 可变的属性动画记录（实现 Animation 接口）。
 *
 * @internal
 */
type PropertyAnimInternal = Animation & {
  /** 内部：推进一帧（由 AnimationManager.update 调用） */
  _tick(nowMs: number): void;
};

/**
 * 创建 AnimationManager 单例实现。
 *
 * @returns 管理器实例
 *
 * @example
 * export const animations = createAnimationManager();
 */
export function createAnimationManager(): AnimationManager {
  /** 当前绑定的相机，供 flyTo 使用 */
  let cameraRef: CameraController | null = null;

  /** 属性动画表 */
  const anims = new Map<string, PropertyAnimInternal>();

  /** 时钟：累计秒、是否播放（倍速 MVP 固定为 1，见 `clock.multiplier`） */
  let clockSeconds = 0;
  let clockPlaying = false;

  /** MVP：时钟倍速固定为 1（后续可由样式/无障碍策略驱动） */
  const CLOCK_MULTIPLIER_MVP = 1;

  const manager: AnimationManager = {
    setCameraController(controller: CameraController | null): void {
      // 允许显式解绑，避免持有已销毁相机
      cameraRef = controller;
    },

    animateProperty(
      target: Record<string, unknown>,
      property: string,
      from: number,
      to: number,
      options?: AnimationOptions,
    ): Animation {
      // 目标与属性名校验
      if (target == null || typeof target !== 'object') {
        throw new TypeError('[AnimationManager] animateProperty: target must be a non-null object.');
      }
      if (typeof property !== 'string' || property.length === 0) {
        throw new TypeError('[AnimationManager] animateProperty: property must be a non-empty string.');
      }
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new RangeError('[AnimationManager] animateProperty: from/to must be finite numbers.');
      }

      const { durationMs, delayMs, easing, loop, loopCount } = normalizeAnimOptions(options);
      const id = makeAnimId();

      let state: Animation['state'] = delayMs > 0 ? 'pending' : 'running';
      const startedAtMs = performance.now();
      /** 延迟结束时刻 */
      const delayEndMs = startedAtMs + delayMs;
      /** 补间开始时刻（延迟后） */
      let tweenStartMs = delayEndMs;
      /** 是否反向播放（reverse） */
      let reversed = false;
      /** 已完成的循环次数（有限循环） */
      let cyclesDone = 0;
      /** 暂停：记录暂停时刻 */
      let pausedAtMs: number | null = null;

      let lastProgress = 0;
      let resolvedFinished = false;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });

      const finishResolve = (): void => {
        if (resolvedFinished) {
          return;
        }
        resolvedFinished = true;
        try {
          resolveFinished();
        } catch {
          // Promise executor 不应抛；防御性捕获
        }
      };

      const removeSelf = (): void => {
        anims.delete(id);
      };

      const applyValue = (uRaw: number): void => {
        // uRaw 为归一化 [0,1] 时间；先 clamp
        const u = clamp01(uRaw);
        let te = u;
        try {
          te = easing(u);
        } catch (err) {
          // 用户 easing 抛错时回退线性，避免中断整帧
          console.error('[AnimationManager] easing error, fallback linear', err);
          te = u;
        }
        te = clamp01(te);
        const effFrom = reversed ? to : from;
        const effTo = reversed ? from : to;
        const value = lerp(effFrom, effTo, te);
        try {
          // 写入目标属性；若不可写则由宿主对象决定
          (target as Record<string, unknown>)[property] = value;
        } catch (err) {
          console.error('[AnimationManager] failed to write property', property, err);
        }
        lastProgress = u;
      };

      const internal: PropertyAnimInternal = {
        id,
        get state() {
          return state;
        },
        get progress() {
          return clamp01(lastProgress);
        },
        pause(): void {
          if (state !== 'running') {
            return;
          }
          state = 'paused';
          pausedAtMs = performance.now();
        },
        resume(): void {
          if (state !== 'paused') {
            return;
          }
          // 恢复时将 tween 起点后移，抵消暂停时长
          const now = performance.now();
          if (pausedAtMs != null) {
            const pausedDelta = now - pausedAtMs;
            tweenStartMs += pausedDelta;
            pausedAtMs = null;
          }
          state = 'running';
        },
        cancel(): void {
          if (state === 'finished' || state === 'cancelled') {
            return;
          }
          state = 'cancelled';
          removeSelf();
          finishResolve();
        },
        reverse(): void {
          if (state === 'finished' || state === 'cancelled') {
            return;
          }
          // 翻转方向并_seek 时间轴使当前值连续
          reversed = !reversed;
          const u = clamp01(lastProgress);
          const now = performance.now();
          // 新的 tween 从当前进度继续向“新方向的终点”走满剩余时间比例
          const remain = 1 - u;
          tweenStartMs = now - remain * durationMs;
        },
        finished,
        _tick(nowMs: number): void {
          if (state === 'finished' || state === 'cancelled' || state === 'paused') {
            return;
          }

          // 延迟阶段
          if (state === 'pending') {
            if (nowMs < delayEndMs) {
              return;
            }
            state = 'running';
            tweenStartMs = nowMs;
          }

          if (state !== 'running') {
            return;
          }

          const elapsedTween = nowMs - tweenStartMs;
          const u = clamp01(elapsedTween / durationMs);

          applyValue(u);

          if (u >= 1 - PROGRESS_EPS) {
            cyclesDone += 1;
            // 仍需继续循环时重置时间轴；否则收尾
            if (loop && (loopCount === Infinity || cyclesDone < loopCount)) {
              tweenStartMs = nowMs;
              lastProgress = 0;
              return;
            }
            state = 'finished';
            applyValue(1);
            removeSelf();
            finishResolve();
          }
        },
      };

      anims.set(id, internal);
      return internal;
    },

    flyTo(options: Parameters<CameraController['flyTo']>[0]): CameraAnimation {
      if (cameraRef == null) {
        throw new Error('[AnimationManager] flyTo: call setCameraController() before flyTo().');
      }
      try {
        return cameraRef.flyTo(options ?? {});
      } catch (err) {
        // 委托失败时向上抛出，便于宿主捕获
        throw err instanceof Error
          ? err
          : new Error(`[AnimationManager] flyTo failed: ${String(err)}`);
      }
    },

    setClock(seconds: number): void {
      if (!Number.isFinite(seconds) || seconds < 0) {
        clockSeconds = 0;
        return;
      }
      clockSeconds = seconds;
    },

    get clock() {
      return {
        get currentTime() {
          return clockSeconds;
        },
        get multiplier() {
          return CLOCK_MULTIPLIER_MVP;
        },
        get isPlaying() {
          return clockPlaying;
        },
      };
    },

    playClock(): void {
      clockPlaying = true;
    },

    pauseClock(): void {
      clockPlaying = false;
    },

    update(deltaTime: number): void {
      // delta 非有限或非正时不推进，避免时钟爆炸
      let dt = deltaTime;
      if (!Number.isFinite(dt) || dt < 0) {
        dt = 0;
      }
      if (clockPlaying) {
        clockSeconds += dt * CLOCK_MULTIPLIER_MVP;
        if (!Number.isFinite(clockSeconds) || clockSeconds < 0) {
          clockSeconds = 0;
        }
      }

      const nowMs = performance.now();
      // 复制键：避免 tick 中删除导致迭代异常
      const list = Array.from(anims.values());
      for (let i = 0; i < list.length; i++) {
        try {
          list[i]._tick(nowMs);
        } catch (err) {
          // 单个动画错误隔离，避免拖垮整帧
          console.error('[AnimationManager] animation tick error', err);
        }
      }
    },

    getAnimation(id: string): Animation | undefined {
      if (typeof id !== 'string' || id.length === 0) {
        return undefined;
      }
      return anims.get(id);
    },

    getActiveAnimations(): readonly Animation[] {
      return Array.from(anims.values());
    },

    cancelAll(): void {
      const list = Array.from(anims.values());
      for (let i = 0; i < list.length; i++) {
        try {
          list[i].cancel();
        } catch (err) {
          console.error('[AnimationManager] cancelAll item error', err);
        }
      }
      anims.clear();
    },
  };

  return manager;
}
