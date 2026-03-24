// ============================================================
// L4 scene — FeatureStateManager：跨瓦片要素状态同步与 GPU 上传
// ============================================================

import { GeoForgeError } from './source-manager.ts';

/**
 * 与 L1 GPUUploader 兼容的最小缓冲句柄（前向引用，避免 scene→gpu 硬依赖）。
 */
export interface BufferHandleLike {
  /**
   * 稳定句柄 id（用于 ResourceManager / 调试标签）。
   */
  readonly id: string;

  /**
   * 底层 WebGPU 缓冲。
   */
  readonly buffer: GPUBuffer;

  /**
   * 分配的字节长度。
   */
  readonly size: number;
}

/**
 * GPU 上传器最小接口：由 L1 Uploader 实现注入。
 */
export interface GPUUploaderLike {
  /**
   * 上传只读数据到 GPUBuffer（返回可追踪句柄）。
   *
   * @param data - 二进制负载
   * @param usage - WebGPU 缓冲用途位
   * @param label - 可选调试标签
   */
  uploadBuffer(data: ArrayBuffer | ArrayBufferView, usage: GPUBufferUsageFlags, label?: string): BufferHandleLike;
}

/**
 * 要素状态变更事件详情。
 */
export interface FeatureStateChangeEvent {
  /**
   * 数据源 ID。
   */
  readonly sourceId: string;

  /**
   * 要素 ID（字符串形式，与 promoteId / Feature.id 对齐）。
   */
  readonly featureId: string;

  /**
   * 合并后的完整状态快照；移除为 null。
   */
  readonly state: Readonly<Record<string, unknown>> | null;
}

/**
 * 状态变更订阅回调。
 *
 * @param ev - 事件详情
 */
export type FeatureStateChangeHandler = (ev: FeatureStateChangeEvent) => void;

/**
 * FeatureStateManager 公共接口。
 */
export interface FeatureStateManager {
  /**
   * 为单个要素设置/合并状态（浅合并一层键）。
   *
   * @param sourceId - 数据源
   * @param featureId - 要素 id（字符串或有限数值，与 GeoJSON id 对齐）
   * @param patch - 状态补丁
   */
  setState(sourceId: string, featureId: string | number, patch: Readonly<Record<string, unknown>>): void;

  /**
   * 移除某要素的全部状态跟踪。
   *
   * @param sourceId - 数据源
   * @param featureId - 要素 id
   * @returns 是否曾存在状态
   */
  removeState(sourceId: string, featureId: string | number): boolean;

  /**
   * 读取某要素当前完整状态快照。
   *
   * @param sourceId - 数据源
   * @param featureId - 要素 id
   */
  getState(sourceId: string, featureId: string | number): Readonly<Record<string, unknown>> | undefined;

  /**
   * 批量设置状态（每个要素独立浅合并）。
   *
   * @param updates - 批量更新列表
   */
  setStates(updates: readonly FeatureStateBatchItem[]): void;

  /**
   * 清空全部或指定数据源的状态。
   *
   * @param sourceId - 若省略则清空所有
   */
  clearStates(sourceId?: string): void;

  /**
   * 将当前全部状态序列化并上传到 GPU（供 compute/shader 读取）。
   *
   * @param uploader - 上传器
   * @returns GPU 缓冲句柄
   */
  uploadStatesToGPU(uploader: GPUUploaderLike): BufferHandleLike;

  /**
   * 订阅状态变更。
   *
   * @param handler - 回调
   * @returns 取消订阅函数
   */
  onStateChange(handler: FeatureStateChangeHandler): () => void;

  /**
   * 当前跟踪的 (source, feature) 对数量。
   */
  readonly trackedFeatureCount: number;
}

/**
 * 批量更新项：单要素补丁。
 */
export interface FeatureStateBatchItem {
  /**
   * 数据源 ID。
   */
  readonly sourceId: string;

  /**
   * 要素 ID（字符串或数值）。
   */
  readonly featureId: string | number;

  /**
   * 状态补丁对象。
   */
  readonly patch: Readonly<Record<string, unknown>>;
}

/** 内部嵌套 Map：sourceId → featureId → state */
type StateMap = Map<string, Map<string, Record<string, unknown>>>;

/**
 * 将任意值转为非空字符串 id（用于内部键）。
 *
 * @param featureId - 原始 id
 * @returns 字符串键
 */
function normalizeFeatureId(featureId: string | number): string {
  if (typeof featureId === 'number') {
    if (!Number.isFinite(featureId)) {
      throw new GeoForgeError('FEATURE_STATE_ID_INVALID', 'featureId must be finite when numeric', {});
    }
    return String(featureId);
  }
  if (typeof featureId === 'string' && featureId.length > 0) {
    return featureId;
  }
  throw new GeoForgeError('FEATURE_STATE_ID_INVALID', 'featureId must be non-empty string or finite number', {});
}

/**
 * 验证 sourceId。
 *
 * @param sourceId - id
 */
function assertSourceId(sourceId: string): void {
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    throw new GeoForgeError('FEATURE_STATE_SOURCE_INVALID', 'sourceId must be non-empty string', {});
  }
}

/**
 * 序列化负载结构（JSON 友好）。
 */
interface SerializedFeatureStatePayload {
  /** 格式版本，便于 GPU 侧解析演进 */
  readonly v: number;
  /** 条目数 */
  readonly count: number;
  /** 扁平列表 */
  readonly entries: ReadonlyArray<{
    readonly s: string;
    readonly f: string;
    readonly st: Readonly<Record<string, unknown>>;
  }>;
}

/**
 * 具体实现。
 */
class FeatureStateManagerImpl implements FeatureStateManager {
  /** 主状态表 */
  private readonly root: StateMap = new Map();

  /** 变更监听器 */
  private readonly listeners = new Set<FeatureStateChangeHandler>();

  /** 单调缓冲 id */
  private bufferSerial = 0;

  /**
   * @inheritdoc
   * @stability stable
   */
  public setState(sourceId: string, featureId: string | number, patch: Readonly<Record<string, unknown>>): void {
    assertSourceId(sourceId);
    const fid = normalizeFeatureId(featureId);
    if (patch === undefined || patch === null || typeof patch !== 'object') {
      throw new GeoForgeError('FEATURE_STATE_PATCH_INVALID', 'patch must be a non-null object', { sourceId, fid });
    }
    let bySource = this.root.get(sourceId);
    if (bySource === undefined) {
      bySource = new Map();
      this.root.set(sourceId, bySource);
    }
    const prev = bySource.get(fid);
    const next: Record<string, unknown> = { ...(prev ?? {}) };
    // 浅合并：新键覆盖旧键
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      next[k] = v;
    }
    bySource.set(fid, next);
    this.emitChange({ sourceId, featureId: fid, state: next });
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public removeState(sourceId: string, featureId: string | number): boolean {
    assertSourceId(sourceId);
    const fid = normalizeFeatureId(featureId);
    const bySource = this.root.get(sourceId);
    if (bySource === undefined) {
      return false;
    }
    const existed = bySource.delete(fid);
    if (existed) {
      if (bySource.size === 0) {
        this.root.delete(sourceId);
      }
      this.emitChange({ sourceId, featureId: fid, state: null });
    }
    return existed;
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public getState(sourceId: string, featureId: string | number): Readonly<Record<string, unknown>> | undefined {
    assertSourceId(sourceId);
    const fid = normalizeFeatureId(featureId);
    const bySource = this.root.get(sourceId);
    if (bySource === undefined) {
      return undefined;
    }
    const st = bySource.get(fid);
    if (st === undefined) {
      return undefined;
    }
    // 返回浅拷贝，防止外部修改内部表
    return { ...st };
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public setStates(updates: readonly FeatureStateBatchItem[]): void {
    if (!Array.isArray(updates)) {
      throw new GeoForgeError('FEATURE_STATE_BATCH_INVALID', 'setStates: updates must be an array', {});
    }
    // 顺序应用，后者覆盖前者同一 key
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      if (u === undefined || typeof u !== 'object') {
        throw new GeoForgeError('FEATURE_STATE_BATCH_ITEM_INVALID', `setStates: item ${i} invalid`, { index: i });
      }
      this.setState(u.sourceId, u.featureId, u.patch);
    }
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public clearStates(sourceId?: string): void {
    if (sourceId === undefined) {
      const keys = Array.from(this.root.keys());
      for (const s of keys) {
        const byF = this.root.get(s);
        if (byF === undefined) {
          continue;
        }
        const fids = Array.from(byF.keys());
        for (const f of fids) {
          this.removeState(s, f);
        }
      }
      return;
    }
    assertSourceId(sourceId);
    const bySource = this.root.get(sourceId);
    if (bySource === undefined) {
      return;
    }
    const fids = Array.from(bySource.keys());
    for (const f of fids) {
      this.removeState(sourceId, f);
    }
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public uploadStatesToGPU(uploader: GPUUploaderLike): BufferHandleLike {
    if (uploader === undefined || uploader === null || typeof uploader.uploadBuffer !== 'function') {
      throw new GeoForgeError('FEATURE_STATE_UPLOADER_INVALID', 'uploadStatesToGPU: invalid uploader', {});
    }
    const entries: Array<{
      readonly s: string;
      readonly f: string;
      readonly st: Readonly<Record<string, unknown>>;
    }> = [];
    this.root.forEach((byF, s) => {
      byF.forEach((st, f) => {
        entries.push({ s, f, st });
      });
    });
    const payload: SerializedFeatureStatePayload = {
      v: 1,
      count: entries.length,
      entries,
    };
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch (e) {
      throw new GeoForgeError(
        'FEATURE_STATE_SERIALIZE_FAILED',
        e instanceof Error ? e.message : String(e),
        {},
      );
    }
    const enc = new TextEncoder();
    const bytes = enc.encode(json);
    // 保证 ArrayBuffer 对齐到字节偏移 0（部分上传器要求）
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.bufferSerial += 1;
    const label = `feature-state:${this.bufferSerial}`;
    try {
      // STORAGE | COPY_DST 常见组合：供 compute shader 读
      const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      return uploader.uploadBuffer(copy.buffer, usage, label);
    } catch (e) {
      throw new GeoForgeError(
        'FEATURE_STATE_GPU_UPLOAD_FAILED',
        e instanceof Error ? e.message : String(e),
        { label },
      );
    }
  }

  /**
   * @inheritdoc
   * @stability stable
   */
  public onStateChange(handler: FeatureStateChangeHandler): () => void {
    if (typeof handler !== 'function') {
      throw new GeoForgeError('FEATURE_STATE_HANDLER_INVALID', 'onStateChange: handler must be a function', {});
    }
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /**
   * @inheritdoc
   */
  public get trackedFeatureCount(): number {
    let n = 0;
    this.root.forEach((byF) => {
      n += byF.size;
    });
    return n;
  }

  /**
   * 分发变更事件（快照拷贝监听器避免重入修改集合）。
   *
   * @param ev - 事件
   */
  private emitChange(ev: FeatureStateChangeEvent): void {
    const copy = Array.from(this.listeners.values());
    for (const h of copy) {
      try {
        h(ev);
      } catch (e) {
        // 监听器异常隔离：不中断其他监听者
        void e;
      }
    }
  }
}

/**
 * 创建 FeatureStateManager 实例。
 *
 * @returns 新的管理器
 *
 * @example
 * const fsm = createFeatureStateManager();
 * fsm.setState('osm', 'way/1', { hover: true });
 * const n = fsm.trackedFeatureCount;
 */
export function createFeatureStateManager(): FeatureStateManager {
  return new FeatureStateManagerImpl();
}
