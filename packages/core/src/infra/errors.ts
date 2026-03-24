// ============================================================
// infra/errors.ts — 结构化错误与开发者提示（自研实现）
// 所有对外与内部抛错应优先使用 GeoForgeError，便于日志聚合与文档链接。
// 零外部依赖。
// ============================================================

// ======================== 错误码 ========================

/**
 * 引擎统一错误码字面量表。
 * 值字符串为稳定标识符，可用于遥测与国际化 key。
 */
export const GeoForgeErrorCode = {
  /** WebGPU 设备丢失（上下文需重建） */
  DEVICE_LOST: 'GPU_DEVICE_LOST',
  /** WGSL 或管线编译失败 */
  SHADER_COMPILE_FAILED: 'GPU_SHADER_COMPILE',
  /** GPU 缓冲区分配失败或超出限制 */
  BUFFER_OOM: 'GPU_BUFFER_OOM',
  /** 纹理尺寸超过硬件或实现上限 */
  TEXTURE_SIZE_EXCEEDED: 'GPU_TEXTURE_SIZE',
  /** 瓦片网络或 I/O 加载失败 */
  TILE_LOAD_FAILED: 'DATA_TILE_LOAD',
  /** 瓦片字节解码失败 */
  TILE_DECODE_FAILED: 'DATA_TILE_DECODE',
  /** GeoJSON 文本解析失败 */
  GEOJSON_PARSE_FAILED: 'DATA_GEOJSON_PARSE',
  /** 引用的数据源不存在或未注册 */
  SOURCE_NOT_FOUND: 'DATA_SOURCE_NOT_FOUND',
  /** 图层规范字段缺失或类型不合法 */
  INVALID_LAYER_SPEC: 'CONFIG_INVALID_LAYER',
  /** 投影标识无法识别 */
  UNKNOWN_PROJECTION: 'CONFIG_UNKNOWN_PROJECTION',
  /** 图层类型未注册 */
  UNKNOWN_LAYER_TYPE: 'CONFIG_UNKNOWN_LAYER_TYPE',
  /** 扩展初始化失败 */
  EXTENSION_INIT_FAILED: 'EXT_INIT_FAILED',
  /** 扩展渲染阶段失败 */
  EXTENSION_RENDER_FAILED: 'EXT_RENDER_FAILED',
  /** 扩展因安全策略被禁用 */
  EXTENSION_DISABLED: 'EXT_DISABLED',
  /** Worker 进程崩溃或被终止 */
  WORKER_CRASH: 'WORKER_CRASH',
  /** Worker 任务超时 */
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',
} as const;

/**
 * 单个错误码的字符串联合类型。
 */
export type GeoForgeErrorCodeType = (typeof GeoForgeErrorCode)[keyof typeof GeoForgeErrorCode];

// ======================== GeoForgeError ========================

/**
 * GeoForge 结构化错误。
 * 在标准 Error 上附加 `code` 与可选 `context`，便于上层按类型恢复或降级。
 */
export class GeoForgeError extends Error {
  /**
   * 稳定错误码（见 {@link GeoForgeErrorCode}）。
   */
  readonly code: GeoForgeErrorCodeType;

  /**
   * 附加上下文（图层 ID、瓦片坐标、资源名等），不得包含敏感凭据。
   */
  readonly context: Record<string, any>;

  /**
   * 可选的底层原因（如 DOMException、网络错误）。
   */
  readonly cause?: Error;

  /**
   * @param code - 错误码枚举值
   * @param message - 人类可读说明（短句，勿带换行）
   * @param context - 可选上下文键值
   * @param cause - 可选原因链
   *
   * @example
   * throw new GeoForgeError(
   *   GeoForgeErrorCode.SHADER_COMPILE_FAILED,
   *   '投影模块编译失败',
   *   { layerId: 'buildings', moduleId: 'proj-mercator' },
   * );
   */
  constructor(
    code: GeoForgeErrorCodeType,
    message: string,
    context?: Record<string, any>,
    cause?: Error,
  ) {
    // 归一化 message，避免 undefined 传入父类
    const safeMessage =
      typeof message === 'string' && message.length > 0 ? message : '[GeoForgeError] empty message';

    super(safeMessage);

    this.name = 'GeoForgeError';
    this.code = code;
    this.context =
      context !== undefined && context !== null ? { ...context } : ({} as Record<string, any>);
    this.cause = cause;

    // 保持 cause 与 Error.cause（ES2022）一致，便于调试器展示
    if (cause !== undefined) {
      (this as Error & { cause?: Error }).cause = cause;
    }

    // 捕获堆栈，排除当前构造帧（V8；非标准 API，需宽松类型）
    const ErrCtor = Error as unknown as {
      captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
    };
    if (typeof ErrCtor.captureStackTrace === 'function') {
      ErrCtor.captureStackTrace(this, GeoForgeError);
    }
  }
}

// ======================== 开发者提示 ========================

/**
 * 与错误码绑定的开发者提示条目。
 */
export interface DeveloperHint {
  /** 错误码（与 {@link GeoForgeError.code} 对齐） */
  readonly code: GeoForgeErrorCodeType;
  /** 简短标题或摘要 */
  readonly message: string;
  /** 可执行的排查建议 */
  readonly suggestion: string;
  /** 可选文档 URL */
  readonly docUrl?: string;
}

/**
 * 为每个 {@link GeoForgeErrorCode} 预置的排查提示映射。
 * Key 为错误码字符串值。
 */
export const DEVELOPER_HINTS: ReadonlyMap<string, DeveloperHint> = new Map<
  string,
  DeveloperHint
>([
  [
    GeoForgeErrorCode.DEVICE_LOST,
    {
      code: GeoForgeErrorCode.DEVICE_LOST,
      message: 'GPU 设备丢失',
      suggestion:
        '监听 device:lost 后释放旧资源；在 device:restored 中重建 Device、Surface 与 Pipeline。检查驱动与超时挂起。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.SHADER_COMPILE_FAILED,
    {
      code: GeoForgeErrorCode.SHADER_COMPILE_FAILED,
      message: '着色器或管线编译失败',
      suggestion:
        '检查 WGSL 语法、绑定组布局与顶点属性对齐；确认 ShaderAssembler 模块拼接顺序与宏变体一致。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.BUFFER_OOM,
    {
      code: GeoForgeErrorCode.BUFFER_OOM,
      message: 'GPU 缓冲区内存不足',
      suggestion:
        '降低几何批次、启用 MemoryBudget 淘汰、检查 BufferPool 泄漏；大上传改为分块或流式。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.TEXTURE_SIZE_EXCEEDED,
    {
      code: GeoForgeErrorCode.TEXTURE_SIZE_EXCEEDED,
      message: '纹理尺寸超限',
      suggestion:
        '查询 GPU 的 maxTextureDimension2D；对影像做分级或分块；使用瓦片纹理而非单张大图。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.TILE_LOAD_FAILED,
    {
      code: GeoForgeErrorCode.TILE_LOAD_FAILED,
      message: '瓦片加载失败',
      suggestion:
        '检查网络、URL 模板、CORS 与 TLS；对 404/429 使用指数退避与 RequestScheduler 限流。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.TILE_DECODE_FAILED,
    {
      code: GeoForgeErrorCode.TILE_DECODE_FAILED,
      message: '瓦片解码失败',
      suggestion:
        '确认 MIME 与字节序；矢量瓦片走 Worker 解码；校验 Protobuf/MVT 版本与 extent。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.GEOJSON_PARSE_FAILED,
    {
      code: GeoForgeErrorCode.GEOJSON_PARSE_FAILED,
      message: 'GeoJSON 解析失败',
      suggestion:
        '校验 RFC 7946 几何类型与坐标维数；对超大文件使用流式解析或 Worker。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.SOURCE_NOT_FOUND,
    {
      code: GeoForgeErrorCode.SOURCE_NOT_FOUND,
      message: '数据源未找到',
      suggestion:
        '确认 addSource 在引用图层之前执行；检查 sourceId 拼写与 SourceManager 注册表。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.INVALID_LAYER_SPEC,
    {
      code: GeoForgeErrorCode.INVALID_LAYER_SPEC,
      message: '图层规范无效',
      suggestion:
        '对照 StyleSpec：必填字段、类型与 filter 表达式；使用 LayerManager 校验错误上下文。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.UNKNOWN_PROJECTION,
    {
      code: GeoForgeErrorCode.UNKNOWN_PROJECTION,
      message: '未知投影',
      suggestion:
        '在投影注册表注册 CRS/Projection；检查 proj 字符串或 EPSG 代码是否受支持。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.UNKNOWN_LAYER_TYPE,
    {
      code: GeoForgeErrorCode.UNKNOWN_LAYER_TYPE,
      message: '未知图层类型',
      suggestion:
        '使用 registerPlugin 注册 LayerPlugin；确认 type 字段与内置/扩展类型一致。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.EXTENSION_INIT_FAILED,
    {
      code: GeoForgeErrorCode.EXTENSION_INIT_FAILED,
      message: '扩展初始化失败',
      suggestion:
        '在 safeExecute 中查看 cause；检查扩展依赖的 WebGPU 特性与上下文 API。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.EXTENSION_RENDER_FAILED,
    {
      code: GeoForgeErrorCode.EXTENSION_RENDER_FAILED,
      message: '扩展渲染失败',
      suggestion:
        '检查 EP 钩子返回值与资源生命周期；临时禁用扩展以隔离问题。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.EXTENSION_DISABLED,
    {
      code: GeoForgeErrorCode.EXTENSION_DISABLED,
      message: '扩展已禁用',
      suggestion:
        '连续失败触发熔断时，查阅日志后修复扩展再重新注册；勿在禁用态调用渲染钩子。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.WORKER_CRASH,
    {
      code: GeoForgeErrorCode.WORKER_CRASH,
      message: 'Worker 崩溃',
      suggestion:
        '检查 Worker 入口与 transferable；捕获未处理异常；使用 WorkerPool 自动重启策略。',
      docUrl: undefined,
    },
  ],
  [
    GeoForgeErrorCode.WORKER_TIMEOUT,
    {
      code: GeoForgeErrorCode.WORKER_TIMEOUT,
      message: 'Worker 任务超时',
      suggestion:
        '增大任务时限、拆分数据块或减少单次几何复杂度；检查主线程是否阻塞 postMessage。',
      docUrl: undefined,
    },
  ],
]);

/**
 * 将错误格式化为多行可读字符串（含码、消息、建议、文档与上下文）。
 *
 * @param error - GeoForgeError 实例；若运行时传入非该类型，将退化为通用字符串
 * @returns 多行文本，适合日志与 DevTools 展示
 *
 * @example
 * try {
 *   throw new GeoForgeError(GeoForgeErrorCode.TILE_LOAD_FAILED, '404', { url: 'https://x' });
 * } catch (e) {
 *   console.log(formatErrorWithHint(e as GeoForgeError));
 * }
 */
export function formatErrorWithHint(error: GeoForgeError): string {
  // 运行时类型守卫：避免非预期对象导致抛错
  if (!(error instanceof GeoForgeError)) {
    const fallback =
      error !== undefined && error !== null && typeof (error as Error).message === 'string'
        ? (error as Error).message
        : String(error);
    return `[Non-GeoForgeError] ${fallback}`;
  }

  const lines: string[] = [];
  const hint = DEVELOPER_HINTS.get(error.code);

  // 首行：错误码与主消息（与控制台 filter 兼容）
  lines.push(`[${error.code}] ${error.message}`);

  // 若有注册提示，输出摘要与建议
  if (hint !== undefined) {
    lines.push(`Hint: ${hint.message}`);
    lines.push(`Suggestion: ${hint.suggestion}`);
    if (hint.docUrl !== undefined && hint.docUrl.length > 0) {
      lines.push(`Doc: ${hint.docUrl}`);
    }
  } else {
    // 无映射时仍输出通用引导，避免静默
    lines.push('Hint: (no developer hint registered for this code)');
  }

  // 序列化 context（浅层，避免循环引用）
  const ctxKeys = Object.keys(error.context);
  if (ctxKeys.length > 0) {
    try {
      lines.push(`Context: ${JSON.stringify(error.context)}`);
    } catch {
      // JSON.stringify 在循环引用时抛错，退化为键列表
      lines.push(`Context: [keys only] ${ctxKeys.join(', ')}`);
    }
  }

  // 附加 cause 一行
  if (error.cause !== undefined) {
    lines.push(`Cause: ${error.cause.name}: ${error.cause.message}`);
  }

  return lines.join('\n');
}
