// ============================================================
// @geoforge/preset-25d — Map25D（2.5D 地图，继承 Map2D）
// 在 2D 基础上提供俯仰/方位角/光照 API；俯仰上限默认 85°。
// 俯仰与方位角的**公共 API 使用度（°）**，与 maxPitch 单位一致；
// 内部通过 jumpTo/flyTo 与 Map2D 的弧度制相机对齐。
// ============================================================

import type { LightSpec } from '../../core/src/types/style-spec.ts';

import { GeoForgeError, GeoForgeErrorCode, Map2D } from '../../preset-2d/src/map-2d.ts';
import type { AnimationOptions, Map2DOptions } from '../../preset-2d/src/map-2d.ts';

// --- 从 L0 再导出光照类型（与 StyleSpec.light 一致） ---
export type { LightSpec } from '../../core/src/types/style-spec.ts';

/** 默认最大俯仰角（度），对标常见 Web 地图可倾斜上限。 */
const DEFAULT_MAX_PITCH_DEG = 85;

/** 全圆角度（度）。 */
const FULL_CIRCLE_DEG = 360;

/** 将度转为弧度（用于调用 Map2D / FlyToOptions）。 */
const DEG2RAD = Math.PI / 180;

/** 将弧度转为度（用于对外 getter）。 */
const RAD2DEG = 180 / Math.PI;

/**
 * 与 MapLibre 风格对齐的默认全局光照（与 core/types/style-spec LightSpec 一致）。
 */
const DEFAULT_LIGHT: LightSpec = {
  anchor: 'viewport',
  color: '#ffffff',
  intensity: 0.5,
  position: [1.15, 210, 30],
};

/**
 * Map25D 构造选项：在 {@link Map2DOptions} 基础上增加 2.5D 参数。
 */
export interface Map25DOptions extends Map2DOptions {
  /**
   * 初始俯仰角（度）。
   * 范围 [0, maxPitch]；默认 0（正俯视）。
   */
  readonly pitch?: number;

  /**
   * 初始方位角（度）。
   * 范围 [0, 360)；0 表示正北，顺时针为正。
   */
  readonly bearing?: number;

  /**
   * 允许的最大俯仰角（度）。
   * 默认 85。
   */
  readonly maxPitch?: number;
}

/**
 * 将角度归一化到 [0, 360) 度区间。
 *
 * @param deg - 方位角（度），可为任意有限值
 * @returns 归一化后的角度（度）
 *
 * @example
 * normalizeBearingDeg(370); // 10
 */
export function normalizeBearingDeg(deg: number): number {
  // 非有限输入：无法定义方向，返回 0 作为安全默认值
  if (!Number.isFinite(deg)) {
    return 0;
  }
  // 使用模运算将任意角度折叠到 [0, 360)
  let x = deg % FULL_CIRCLE_DEG;
  if (x < 0) {
    x += FULL_CIRCLE_DEG;
  }
  return x;
}

/**
 * 将俯仰角限制在 [0, maxPitchDeg]（度）。
 *
 * @param pitchDeg - 俯仰角（度）
 * @param maxPitchDeg - 上限（度）
 * @returns 钳制后的俯仰角（度）
 *
 * @example
 * clampPitchDeg(100, 85); // 85
 */
export function clampPitchDeg(pitchDeg: number, maxPitchDeg: number): number {
  // 输入非法时直接返回 0，避免 NaN 传播到 GPU 矩阵
  if (!Number.isFinite(pitchDeg) || !Number.isFinite(maxPitchDeg)) {
    return 0;
  }
  const hi = Math.max(0, maxPitchDeg);
  if (pitchDeg < 0) {
    return 0;
  }
  if (pitchDeg > hi) {
    return hi;
  }
  return pitchDeg;
}

/**
 * 合并两个 LightSpec，后者覆盖前者。
 *
 * @param base - 基础光照
 * @param patch - 覆盖项
 * @returns 合并后的新对象
 *
 * @example
 * mergeLight(DEFAULT_LIGHT, { intensity: 0.8 });
 */
export function mergeLight(base: LightSpec, patch: Partial<LightSpec> | undefined): LightSpec {
  const cloneTuple = (p: readonly [number, number, number]): [number, number, number] => [
    p[0],
    p[1],
    p[2],
  ];
  // patch 为空时直接浅拷贝 base，避免共享引用被外部修改
  if (patch === undefined) {
    return {
      anchor: base.anchor,
      color: base.color,
      intensity: base.intensity,
      position: base.position !== undefined ? cloneTuple(base.position) : undefined,
    };
  }
  const pos: [number, number, number] | undefined =
    patch.position !== undefined
      ? cloneTuple(patch.position)
      : base.position !== undefined
        ? cloneTuple(base.position)
        : undefined;
  return {
    anchor: patch.anchor ?? base.anchor,
    color: patch.color ?? base.color,
    intensity: patch.intensity ?? base.intensity,
    position: pos,
  };
}

/**
 * Map25D：在 {@link Map2D} 上增加俯仰、方位角与光照控制。
 *
 * @example
 * const map = new Map25D({ container: '#map', pitch: 45, bearing: 20, maxPitch: 60 });
 */
export class Map25D extends Map2D {
  /**
   * 最大俯仰角（度），由构造选项确定。
   */
  private readonly _maxPitch: number;

  /**
   * 当前全局光照参数（影响建筑拉伸等图层）。
   */
  private _light: LightSpec;

  /**
   * @param options - 2D + 2.5D 选项
   *
   * @example
   * new Map25D({ container: '#map', pitch: 30, bearing: 90 });
   */
  public constructor(options: Map25DOptions) {
    // 先完成 Map2D 初始化（挂载 canvas、解析中心与缩放）
    super(options);
    const maxPitchDeg = options.maxPitch ?? DEFAULT_MAX_PITCH_DEG;
    if (!Number.isFinite(maxPitchDeg) || maxPitchDeg <= 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'maxPitch 必须为正有限数', {
        maxPitch: maxPitchDeg,
      });
    }
    this._maxPitch = maxPitchDeg;
    this._light = mergeLight(DEFAULT_LIGHT, undefined);
    // 应用初始俯仰/方位（度 → 弧度）
    const pDeg = clampPitchDeg(options.pitch ?? 0, maxPitchDeg);
    const bDeg = normalizeBearingDeg(options.bearing ?? 0);
    try {
      this.jumpTo({
        pitch: pDeg * DEG2RAD,
        bearing: bDeg * DEG2RAD,
      });
    } catch (err) {
      // jumpTo 已校验；若仍失败，包装为统一错误
      throw new GeoForgeError(
        GeoForgeErrorCode.CONFIG_INVALID_VIEW,
        'Map25D 初始相机状态非法',
        { pitch: options.pitch, bearing: options.bearing },
        err,
      );
    }
  }

  /**
   * 返回当前俯仰角（度）。
   *
   * @returns 俯仰角 [0, maxPitch]
   *
   * @example
   * const p = map.getPitch();
   */
  public getPitch(): number {
    // Map2D 内部为弧度；对外转换为度
    return this.camera.getPitch() * RAD2DEG;
  }

  /**
   * 设置俯仰角（度），可选动画。
   *
   * @param pitch - 目标俯仰角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.setPitch(60, { duration: 500 });
   */
  public setPitch(pitch: number, options?: AnimationOptions): this {
    const pDeg = clampPitchDeg(pitch, this._maxPitch);
    const rad = pDeg * DEG2RAD;
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ pitch: rad });
      return this;
    }
    // 使用 flyTo 保持与 Map2D 相机动画一致
    this.flyTo({
      pitch: rad,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 返回当前方位角（度），范围 [0, 360)。
   *
   * @returns 方位角（度）
   *
   * @example
   * map.getBearing();
   */
  public getBearing(): number {
    return normalizeBearingDeg(this.camera.getBearing() * RAD2DEG);
  }

  /**
   * 设置方位角（度），可选动画。
   *
   * @param bearing - 目标方位角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.setBearing(90, { duration: 400 });
   */
  public setBearing(bearing: number, options?: AnimationOptions): this {
    const bDeg = normalizeBearingDeg(bearing);
    const rad = bDeg * DEG2RAD;
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ bearing: rad });
      return this;
    }
    this.flyTo({
      bearing: rad,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 旋转到指定方位角（度）。
   * 语义与 setBearing 相同，仅命名对标 MapLibre。
   *
   * @param bearing - 目标方位角（度）
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.rotateTo(180, { duration: 800 });
   */
  public rotateTo(bearing: number, options?: AnimationOptions): this {
    return this.setBearing(bearing, options);
  }

  /**
   * 将方位角重置为 0°（正北）。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.resetNorth({ duration: 300 });
   */
  public resetNorth(options?: AnimationOptions): this {
    return this.setBearing(0, options);
  }

  /**
   * 重置方位角为 0° 且俯仰为 0°。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.resetNorthPitch({ duration: 400 });
   */
  public resetNorthPitch(options?: AnimationOptions): this {
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, '动画 duration 非法', { duration });
    }
    if (duration === 0) {
      this.jumpTo({ bearing: 0, pitch: 0 });
      return this;
    }
    this.flyTo({
      bearing: 0,
      pitch: 0,
      duration,
      easing: options?.easing,
    });
    return this;
  }

  /**
   * 快速指北（与 resetNorth 相同，保留别名以兼容文档）。
   *
   * @param options - 动画选项
   * @returns this
   *
   * @example
   * map.snapToNorth();
   */
  public snapToNorth(options?: AnimationOptions): this {
    return this.resetNorth(options);
  }

  /**
   * 设置全局光照（合并到当前样式光照）。
   *
   * @param light - 部分或完整光照参数
   * @returns this
   *
   * @example
   * map.setLight({ anchor: 'map', intensity: 0.7 });
   */
  public setLight(light: LightSpec): this {
    if (light === undefined || light === null) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light 不能为空', {});
    }
    // 强度若提供，需为非负有限数
    if (light.intensity !== undefined && (!Number.isFinite(light.intensity) || light.intensity < 0)) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light.intensity 非法', {
        intensity: light.intensity,
      });
    }
    if (light.position !== undefined) {
      const [a, b, c] = light.position;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
        throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'light.position 分量非法', {
          position: light.position,
        });
      }
    }
    this._light = mergeLight(this._light, light);
    this.triggerRepaint();
    return this;
  }

  /**
   * 返回当前光照参数的浅拷贝。
   *
   * @returns 光照规格
   *
   * @example
   * const L = map.getLight();
   */
  public getLight(): LightSpec {
    return mergeLight(this._light, {});
  }
}
