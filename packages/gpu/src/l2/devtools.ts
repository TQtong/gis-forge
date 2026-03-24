// ============================================================
// devtools.ts — L2 DevTools：渲染层诊断面板（MVP 桩实现）
// 零 npm 依赖；后续由 FrameGraph / ResourceManager 注入真实数据。
// ============================================================

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

/**
 * DevTools 子集错误码。
 */
export const DevToolsErrorCode = {
  /** 录制帧或回放参数非法。 */
  CONFIG_INVALID_FRAME: 'CONFIG_INVALID_FRAME',
  /** show* 开关参数类型错误。 */
  CONFIG_INVALID_FLAG: 'CONFIG_INVALID_FLAG',
} as const;

/**
 * {@link DevToolsErrorCode} 联合类型。
 */
export type DevToolsErrorCode = (typeof DevToolsErrorCode)[keyof typeof DevToolsErrorCode];

/**
 * L2 DevTools 抛出的结构化错误。
 */
export class DevToolsError extends Error {
  /** 错误码。 */
  public readonly code: DevToolsErrorCode;

  /** 诊断上下文。 */
  public readonly context?: Record<string, unknown>;

  /**
   * @param code - 错误码
   * @param message - 说明
   * @param context - 可选上下文
   * @param cause - 可选原因
   */
  constructor(
    code: DevToolsErrorCode,
    message: string,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'DevToolsError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, DevToolsError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 一帧录制快照：序号、时间戳与命令序列。
 */
export interface FrameRecording {
  /** 单调递增帧序号（由录制器维护）。 */
  readonly frameIndex: number;
  /** 时间戳（ms，performance.now 或 Date.now）。 */
  readonly timestamp: number;
  /** 本帧记录的 GPU 命令。 */
  readonly commands: Array<{
    type: 'draw' | 'compute' | 'copy';
    layerId?: string;
    vertexCount?: number;
    instanceCount?: number;
  }>;
}

/**
 * 瓦片网格诊断项（MVP 返回空数组）。
 */
export type TileGridItem = {
  /** 瓦片坐标（Web 墨卡托或源定义）。 */
  coord: { x: number; y: number; z: number };
  /** 加载状态机字符串。 */
  state: string;
  /** 数据源 id。 */
  sourceId: string;
  /** 估算字节大小。 */
  byteSize: number;
  /** 加载耗时（ms）。 */
  loadTimeMs: number;
};

/**
 * 内存分解统计（MVP 返回空表与零计数）。
 */
export interface MemoryBreakdown {
  /** Buffer 列表。 */
  buffers: Array<{ label: string; size: number }>;
  /** 纹理列表。 */
  textures: Array<{ label: string; size: number; format: string }>;
  /** Pipeline 数量。 */
  pipelines: number;
  /** BindGroup 数量。 */
  bindGroups: number;
  /** 估算总字节。 */
  total: number;
  /** 预算上限（字节）。 */
  budget: number;
}

/**
 * Shader 变体条目（MVP 返回空数组）。
 */
export type ShaderVariantEntry = {
  /** 缓存键。 */
  key: string;
  /** 编译时间戳（ms）。 */
  compiledAt: number;
  /** 上一帧是否使用。 */
  usedInLastFrame: boolean;
};

/**
 * 单图层性能条目（MVP 返回空数组）。
 */
export type LayerStatEntry = {
  /** 图层 id。 */
  layerId: string;
  /** DrawCall 数。 */
  drawCalls: number;
  /** 三角形数。 */
  triangles: number;
  /** GPU 时间（ms）。 */
  gpuTimeMs: number;
  /** 可见瓦片数。 */
  visibleTiles: number;
};

/**
 * 异步队列状态（MVP 返回零与空列表）。
 */
export interface QueueStatus {
  /** 待处理请求数。 */
  pendingRequests: number;
  /** 活跃 Worker 数。 */
  activeWorkers: number;
  /** 空闲 Worker 数。 */
  idleWorkers: number;
  /** 卡住的任务描述列表。 */
  stalledTasks: string[];
}

/**
 * L2 诊断面板 API。
 */
export interface DevTools {
  /** 当前是否启用（启用后才累积录制等）。 */
  readonly enabled: boolean;
  /** 打开诊断（副作用：允许录制与可视化开关）。 */
  enable(): void;
  /** 关闭诊断（停止累积，保留历史由实现决定）。 */
  disable(): void;
  /** 瓦片网格快照（MVP 空）。 */
  getTileGrid(): TileGridItem[];
  /** 是否绘制瓦片边界（MVP 仅保存标志）。 */
  showTileBorders(show: boolean): void;
  /** 是否显示瓦片加载顺序（MVP 仅保存标志）。 */
  showTileLoadOrder(show: boolean): void;
  /** GPU 内存分解（MVP 空）。 */
  getMemoryBreakdown(): MemoryBreakdown;
  /** Shader 变体列表（MVP 空）。 */
  getShaderVariants(): ShaderVariantEntry[];
  /** 图层性能（MVP 空）。 */
  getLayerStats(): LayerStatEntry[];
  /** 开始录制帧序列（清空缓冲区）。 */
  startRecording(): void;
  /** 停止录制并返回已录制的帧列表。 */
  stopRecording(): FrameRecording[];
  /**
   * 回放一帧（MVP：校验并保存最后回放帧；若当前处于录制会话且 DevTools 已启用，则同时将该帧追加到内部录制缓冲）。
   *
   * @param frame - 录制帧
   */
  replayFrame(frame: FrameRecording): void;
  /** 请求/Worker 队列状态（MVP 零值）。 */
  getQueueStatus(): QueueStatus;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/** 单次录制缓冲允许的最大帧数，防止内存无限增长。 */
const MAX_RECORDING_FRAMES = 10_000;

/**
 * 校验 FrameRecording 结构。
 *
 * @param frame - 待校验对象
 * @param allowEmptyCommands - 是否允许 commands 为空
 *
 * @example
 * assertValidFrameRecording({ frameIndex: 0, timestamp: 1, commands: [] }, true);
 */
function assertValidFrameRecording(frame: FrameRecording, allowEmptyCommands: boolean): void {
  if (frame === null || frame === undefined || typeof frame !== 'object') {
    throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, 'FrameRecording 必须为非空对象', {
      frame,
    });
  }

  if (typeof frame.frameIndex !== 'number' || !Number.isFinite(frame.frameIndex) || frame.frameIndex < 0) {
    throw new DevToolsError(
      DevToolsErrorCode.CONFIG_INVALID_FRAME,
      'frameIndex 必须为非负有限数',
      { frameIndex: frame.frameIndex },
    );
  }

  if (typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0) {
    throw new DevToolsError(
      DevToolsErrorCode.CONFIG_INVALID_FRAME,
      'timestamp 必须为非负有限数',
      { timestamp: frame.timestamp },
    );
  }

  if (!Array.isArray(frame.commands)) {
    throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, 'commands 必须为数组', {});
  }

  if (!allowEmptyCommands && frame.commands.length === 0) {
    throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, 'commands 不能为空', {
      frameIndex: frame.frameIndex,
    });
  }

  for (let i = 0; i < frame.commands.length; i++) {
    const cmd = frame.commands[i];
    if (cmd === undefined || typeof cmd !== 'object') {
      throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, `commands[${i}] 非法`, { i });
    }
    if (cmd.type !== 'draw' && cmd.type !== 'compute' && cmd.type !== 'copy') {
      throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, `commands[${i}].type 非法`, {
        type: cmd.type,
      });
    }
    if (cmd.layerId !== undefined && typeof cmd.layerId !== 'string') {
      throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, `commands[${i}].layerId 非法`, {});
    }
    if (cmd.vertexCount !== undefined) {
      if (typeof cmd.vertexCount !== 'number' || !Number.isFinite(cmd.vertexCount) || cmd.vertexCount < 0) {
        throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, `commands[${i}].vertexCount 非法`, {});
      }
    }
    if (cmd.instanceCount !== undefined) {
      if (typeof cmd.instanceCount !== 'number' || !Number.isFinite(cmd.instanceCount) || cmd.instanceCount < 0) {
        throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FRAME, `commands[${i}].instanceCount 非法`, {});
      }
    }
  }
}

/**
 * 创建 DevTools 实例（MVP：空数据 + 内存安全录制）。
 *
 * @returns DevTools 实例
 *
 * @example
 * const dt = createDevTools();
 * dt.enable();
 * dt.startRecording();
 * dt.replayFrame({ frameIndex: 0, timestamp: 0, commands: [{ type: 'draw' }] });
 * const rec = dt.stopRecording();
 */
export function createDevTools(): DevTools {
  // 是否启用面板（与录制独立：录制还要求 isRecording）
  let enabledFlag = false;

  // 可视化开关（供未来渲染路径读取）
  let showBorders = false;
  let showLoadOrder = false;

  // 录制会话
  let isRecording = false;
  const recordingBuffer: FrameRecording[] = [];

  // 最近一次回放（诊断）
  let lastReplayed: FrameRecording | undefined;

  const api: DevTools = {
    get enabled(): boolean {
      return enabledFlag;
    },

    enable(): void {
      // 打开诊断：允许 pushFrame 写入（仍受录制会话约束）
      enabledFlag = true;
    },

    disable(): void {
      // 关闭：停止录制，避免后台无限增长
      enabledFlag = false;
      isRecording = false;
      recordingBuffer.length = 0;
    },

    getTileGrid(): TileGridItem[] {
      // MVP：无瓦片调度连接
      return [];
    },

    showTileBorders(show: boolean): void {
      if (typeof show !== 'boolean') {
        throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FLAG, 'showTileBorders 需要 boolean', {
          show,
        });
      }
      showBorders = show;
    },

    showTileLoadOrder(show: boolean): void {
      if (typeof show !== 'boolean') {
        throw new DevToolsError(DevToolsErrorCode.CONFIG_INVALID_FLAG, 'showTileLoadOrder 需要 boolean', {
          show,
        });
      }
      showLoadOrder = show;
    },

    getMemoryBreakdown(): MemoryBreakdown {
      // MVP：零填充
      return {
        buffers: [],
        textures: [],
        pipelines: 0,
        bindGroups: 0,
        total: 0,
        budget: 0,
      };
    },

    getShaderVariants(): ShaderVariantEntry[] {
      return [];
    },

    getLayerStats(): LayerStatEntry[] {
      return [];
    },

    startRecording(): void {
      // 新会话：清空旧缓冲
      recordingBuffer.length = 0;
      isRecording = true;
    },

    stopRecording(): FrameRecording[] {
      // 返回拷贝，停止会话
      isRecording = false;
      return recordingBuffer.map((f) => ({
        frameIndex: f.frameIndex,
        timestamp: f.timestamp,
        commands: f.commands.map((c) => ({ ...c })),
      }));
    },

    replayFrame(frame: FrameRecording): void {
      // 回放始终校验输入；不依赖 enabled，便于单元测试
      assertValidFrameRecording(frame, true);
      lastReplayed = {
        frameIndex: frame.frameIndex,
        timestamp: frame.timestamp,
        commands: frame.commands.map((c) => ({ ...c })),
      };
      // 录制会话：将同一快照写入内部缓冲（引擎每帧构造 FrameRecording 后传入）
      if (enabledFlag && isRecording) {
        if (recordingBuffer.length >= MAX_RECORDING_FRAMES) {
          recordingBuffer.shift();
        }
        recordingBuffer.push({
          frameIndex: frame.frameIndex,
          timestamp: frame.timestamp,
          commands: frame.commands.map((c) => ({ ...c })),
        });
      }
      // MVP：不触碰 GPU；未来在此注入 CommandEncoder 重放
    },

    getQueueStatus(): QueueStatus {
      return {
        pendingRequests: 0,
        activeWorkers: 0,
        idleWorkers: 0,
        stalledTasks: [],
      };
    },
  };

  return api;
}
