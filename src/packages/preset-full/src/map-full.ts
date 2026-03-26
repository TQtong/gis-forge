// ============================================================
// @gis-forge/preset-full — MapFull（2D/2.5D/3D 一体化预设）
// 继承 Map25D，并在需要时惰性挂载 Globe3D 以提供全球与 3D Tiles 能力。
// ============================================================

import { GeoForgeError, GeoForgeErrorCode } from '../../preset-2d/src/map-2d.ts';
import { Map25D } from '../../preset-25d/src/map-25d.ts';
import type { Map25DOptions } from '../../preset-25d/src/map-25d.ts';
import { Globe3D } from '../../preset-3d/src/globe-3d.ts';

/**
 * MapFull 构造选项：在 {@link Map25DOptions} 上要求显式初始模式。
 */
export interface MapFullOptions extends Map25DOptions {
  /**
   * 初始视图模式：平面 / 倾斜 / 全球。
   */
  readonly mode: '2d' | '25d' | '3d';
}

/**
 * MapFull：统一入口，组合 Map25D 与 Globe3D（惰性）。
 *
 * @example
 * const map = new MapFull({ container: '#map', mode: '25d', center: [0, 0], zoom: 2 });
 */
export class MapFull extends Map25D {
  /**
   * 当前模式。
   */
  private _mode: '2d' | '25d' | '3d';

  /**
   * 惰性初始化的 3D 地球实例。
   */
  private _globe: Globe3D | null = null;

  /**
   * 覆盖在地图容器上的 3D 宿主层（绝对定位）。
   */
  private readonly _globeShell: HTMLDivElement;

  /**
   * 模式切换的定时器句柄（避免重复 morph）。
   */
  private _modeTimer: number | null = null;

  /**
   * @param options - 构造选项
   *
   * @example
   * new MapFull({ container: '#map', mode: '2d', zoom: 1 });
   */
  public constructor(options: MapFullOptions) {
    if (options === undefined || options === null) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'MapFullOptions 不能为空', {});
    }
    if (options.mode !== '2d' && options.mode !== '25d' && options.mode !== '3d') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'mode 必须是 2d | 25d | 3d', {
        mode: options.mode,
      });
    }
    super(options);
    this._mode = options.mode;
    // 创建覆盖层：默认隐藏，仅在 3D 模式显示
    this._globeShell = document.createElement('div');
    this._globeShell.style.position = 'absolute';
    this._globeShell.style.inset = '0';
    this._globeShell.style.zIndex = '2';
    this._globeShell.style.visibility = 'hidden';
    this._globeShell.style.pointerEvents = 'none';
    this.getContainer().appendChild(this._globeShell);
    // 应用初始模式（同步相机与可见性）
    this._applyMode(this._mode, 0);
  }

  /**
   * 返回惰性初始化的 Globe3D（用于 3D API）。
   *
   * @returns Globe3D 实例
   */
  private _ensureGlobe(): Globe3D {
    if (this._globe !== null) {
      return this._globe;
    }
    try {
      this._globe = new Globe3D({ container: this._globeShell });
      return this._globe;
    } catch (err) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'Globe3D 初始化失败', {}, err);
    }
  }

  /**
   * 将 MapFull 模式映射到相机俯仰（度）：2D→0，25D→45，3D→60（占位）。
   *
   * @param mode - 模式
   * @returns 建议俯仰角（度）
   */
  private _suggestPitchDegForMode(mode: '2d' | '25d' | '3d'): number {
    if (mode === '2d') {
      return 0;
    }
    if (mode === '25d') {
      return 45;
    }
    return 60;
  }

  /**
   * 应用模式到 UI 与相机（无动画）。
   *
   * @param mode - 目标模式
   * @param durationMs - 动画毫秒数（0 表示立即）
   */
  private _applyMode(mode: '2d' | '25d' | '3d', durationMs: number): void {
    const pitchDeg = this._suggestPitchDegForMode(mode);
    // 2D/25D：主地图可见；3D：显示地球覆盖层
    const mapCanvas = this.getCanvas();
    if (mode === '3d') {
      this._globeShell.style.visibility = 'visible';
      this._globeShell.style.pointerEvents = 'auto';
      mapCanvas.style.visibility = 'hidden';
      // 确保 Globe 已构造
      const g = this._ensureGlobe();
      if (durationMs > 0) {
        g.morphTo3D({ duration: durationMs });
      } else {
        void g.morphTo3D({ duration: 0 });
      }
    } else {
      this._globeShell.style.visibility = 'hidden';
      this._globeShell.style.pointerEvents = 'none';
      mapCanvas.style.visibility = 'visible';
      if (this._globe !== null) {
        if (durationMs > 0) {
          if (mode === '2d') {
            this._globe.morphTo2D({ duration: durationMs });
          } else {
            this._globe.morphTo25D({ duration: durationMs });
          }
        } else {
          if (mode === '2d') {
            void this._globe.morphTo2D({ duration: 0 });
          } else {
            void this._globe.morphTo25D({ duration: 0 });
          }
        }
      }
    }
    // 同步 2.5D 地图俯仰（度）
    if (durationMs === 0) {
      this.setPitch(pitchDeg, { duration: 0 });
    } else {
      this.setPitch(pitchDeg, { duration: durationMs });
    }
  }

  /**
   * 切换显示模式。
   *
   * @param mode - 目标模式
   * @param options - 过渡选项
   * @returns this
   *
   * @example
   * map.setMode('3d', { duration: 1200 });
   */
  public setMode(mode: '2d' | '25d' | '3d', options?: { duration?: number }): this {
    if (mode !== '2d' && mode !== '25d' && mode !== '3d') {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'setMode: 非法 mode', { mode });
    }
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(duration) || duration < 0) {
      throw new GeoForgeError(GeoForgeErrorCode.CONFIG_INVALID_VIEW, 'setMode: duration 非法', { duration });
    }
    if (this._modeTimer !== null) {
      window.clearTimeout(this._modeTimer);
      this._modeTimer = null;
    }
    this._mode = mode;
    if (duration === 0) {
      this._applyMode(mode, 0);
      return this;
    }
    // 延迟一帧应用，避免与正在进行的相机动画冲突（MVP）
    this._modeTimer = window.setTimeout(() => {
      this._applyMode(mode, duration);
      this._modeTimer = null;
    }, 0);
    return this;
  }

  /**
   * 当前模式（只读）。
   */
  public get currentMode(): '2d' | '25d' | '3d' {
    return this._mode;
  }

  /**
   * 注册 3D Tiles（转发到 Globe3D）。
   *
   * @param options - tileset 选项
   * @returns 记录 id
   *
   * @example
   * map.add3DTileset({ url: 'https://example.com/tileset.json' });
   */
  public add3DTileset(options: { url: string; maximumScreenSpaceError?: number; show?: boolean }): string {
    return this._ensureGlobe().add3DTileset(options);
  }

  /**
   * 移除 3D Tiles。
   *
   * @param id - 记录 id
   * @returns this
   */
  public remove3DTileset(id: string): this {
    this._ensureGlobe().remove3DTileset(id);
    return this;
  }

  /**
   * 设置地形夸大。
   *
   * @param value - 夸大系数
   * @returns this
   */
  public setTerrainExaggeration(value: number): this {
    this._ensureGlobe().setTerrainExaggeration(value);
    return this;
  }

  /**
   * 查询地形高度（异步）。
   *
   * @param lon - 经度
   * @param lat - 纬度
   * @returns 海拔（米）
   */
  public async getTerrainHeight(lon: number, lat: number): Promise<number> {
    return this._ensureGlobe().getTerrainHeight(lon, lat);
  }

  /**
   * 开关大气层（转发 Globe3D）。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setAtmosphereEnabled(enabled: boolean): this {
    this._ensureGlobe().setAtmosphereEnabled(enabled);
    return this;
  }

  /**
   * 开关阴影。
   *
   * @param enabled - 是否启用
   * @returns this
   */
  public setShadowsEnabled(enabled: boolean): this {
    this._ensureGlobe().setShadowsEnabled(enabled);
    return this;
  }

  /**
   * 设置仿真时间（转发 Globe3D）。
   *
   * @param date - 时间
   * @returns this
   */
  public setDateTime(date: Date): this {
    this._ensureGlobe().setDateTime(date);
    return this;
  }

  /**
   * 销毁：移除覆盖层并释放 Globe3D。
   */
  public override remove(): void {
    if (this._modeTimer !== null) {
      window.clearTimeout(this._modeTimer);
      this._modeTimer = null;
    }
    try {
      this._globe?.remove();
    } catch {
      // 忽略重复销毁
    }
    this._globe = null;
    try {
      const c = this.getContainer();
      if (this._globeShell.parentElement === c) {
        c.removeChild(this._globeShell);
      }
    } catch {
      // 地图已销毁或容器不可用时跳过后续 DOM 操作
    }
    super.remove();
  }
}
