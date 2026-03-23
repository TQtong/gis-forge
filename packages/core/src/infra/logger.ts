// ============================================================
// infra/logger.ts — 日志系统（自研实现）
// 提供分级日志输出，支持前缀标识和 performance.mark 集成。
// 日志级别按严重性从低到高：debug < info < warn < error < none。
// 设置某个级别后，只有该级别及以上的日志才会输出。
// 零外部依赖。
// ============================================================

// ======================== 类型定义 ========================

/**
 * 日志级别类型。
 * - debug: 开发调试信息（性能数据、状态变更、内部步骤）
 * - info: 一般运行信息（初始化完成、配置加载）
 * - warn: 警告信息（性能降级、兼容性回退）
 * - error: 错误信息（操作失败、异常捕获）
 * - none: 完全静默（生产环境推荐）
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

// ======================== 内部常量 ========================

/**
 * 日志级别优先级映射。
 * 数字越大优先级越高，只有 >= 当前设定级别的日志才会输出。
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    none: 4,
};

// ======================== 内部状态 ========================

/** 全局日志级别，默认 'warn'（只输出警告和错误） */
let globalLogLevel: LogLevel = 'warn';

// ======================== 公共 API ========================

/**
 * 设置全局日志级别。
 * 影响所有通过 createLogger 创建的 Logger 实例。
 * 级别从低到高：debug < info < warn < error < none。
 *
 * @param level - 目标日志级别
 *
 * @example
 * setLogLevel('debug'); // 开发时启用所有日志
 * setLogLevel('none');  // 生产环境完全静默
 */
export function setLogLevel(level: LogLevel): void {
    // 验证级别有效性
    if (LOG_LEVEL_PRIORITY[level] === undefined) {
        console.warn(`[Logger] Unknown log level: "${level}", falling back to "warn".`);
        globalLogLevel = 'warn';
        return;
    }

    globalLogLevel = level;
}

/**
 * 获取当前全局日志级别。
 *
 * @returns 当前日志级别
 */
export function getLogLevel(): LogLevel {
    return globalLogLevel;
}

/**
 * 日志记录器类。
 * 每个实例带有固定前缀，输出格式为 `[前缀] 消息`。
 * 支持 debug/info/warn/error 四个级别，受全局日志级别控制。
 * 可通过 performance.mark 集成性能标记。
 *
 * @example
 * const log = new Logger('TileScheduler');
 * log.info('Loading tile', { x: 3, y: 5, z: 14 });
 * // 输出: [TileScheduler] Loading tile {x: 3, y: 5, z: 14}
 */
export class Logger {
    /** 日志前缀标识，通常为模块/类名 */
    private readonly _prefix: string;

    /**
     * 构造日志记录器。
     *
     * @param prefix - 日志前缀（如模块名 'TileScheduler', 'DeviceManager'）
     */
    constructor(prefix: string) {
        this._prefix = prefix;
    }

    /**
     * 输出调试级别日志。
     * 用于开发时的详细状态跟踪，生产环境应禁用。
     *
     * @param message - 日志消息
     * @param args - 附加参数（传给 console.debug）
     *
     * @example
     * log.debug('Frame rendered', { fps: 60, drawCalls: 42 });
     */
    debug(message: string, ...args: unknown[]): void {
        if (LOG_LEVEL_PRIORITY[globalLogLevel] > LOG_LEVEL_PRIORITY.debug) {
            return;
        }

        if (args.length > 0) {
            console.debug(`[${this._prefix}]`, message, ...args);
        } else {
            console.debug(`[${this._prefix}]`, message);
        }
    }

    /**
     * 输出信息级别日志。
     * 用于记录重要的运行状态变更（初始化完成、配置加载等）。
     *
     * @param message - 日志消息
     * @param args - 附加参数
     *
     * @example
     * log.info('Engine initialized', { gpu: 'WebGPU', workers: 4 });
     */
    info(message: string, ...args: unknown[]): void {
        if (LOG_LEVEL_PRIORITY[globalLogLevel] > LOG_LEVEL_PRIORITY.info) {
            return;
        }

        if (args.length > 0) {
            console.info(`[${this._prefix}]`, message, ...args);
        } else {
            console.info(`[${this._prefix}]`, message);
        }
    }

    /**
     * 输出警告级别日志。
     * 用于记录非致命问题（性能降级、兼容性回退、配置覆盖等）。
     *
     * @param message - 日志消息
     * @param args - 附加参数
     *
     * @example
     * log.warn('GPU memory budget exceeded, evicting LRU tiles');
     */
    warn(message: string, ...args: unknown[]): void {
        if (LOG_LEVEL_PRIORITY[globalLogLevel] > LOG_LEVEL_PRIORITY.warn) {
            return;
        }

        if (args.length > 0) {
            console.warn(`[${this._prefix}]`, message, ...args);
        } else {
            console.warn(`[${this._prefix}]`, message);
        }
    }

    /**
     * 输出错误级别日志。
     * 用于记录操作失败、异常捕获等严重问题。
     *
     * @param message - 日志消息
     * @param args - 附加参数（通常包含 Error 对象）
     *
     * @example
     * log.error('Failed to compile shader', error);
     */
    error(message: string, ...args: unknown[]): void {
        if (LOG_LEVEL_PRIORITY[globalLogLevel] > LOG_LEVEL_PRIORITY.error) {
            return;
        }

        if (args.length > 0) {
            console.error(`[${this._prefix}]`, message, ...args);
        } else {
            console.error(`[${this._prefix}]`, message);
        }
    }

    /**
     * 创建 performance.mark 标记点。
     * 用于性能分析——在 DevTools Performance 面板中显示自定义标记。
     * 如果 `performance` API 不可用（如 Worker 中），静默忽略。
     *
     * @param label - 标记名称（会自动添加前缀）
     *
     * @example
     * log.mark('frame-start');
     * // 在 Performance 面板中显示 "TileScheduler:frame-start"
     */
    mark(label: string): void {
        // 检查 performance API 是否可用
        if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
            try {
                performance.mark(`${this._prefix}:${label}`);
            } catch {
                // 静默忽略 —— 某些环境中 performance.mark 可能抛异常
            }
        }
    }

    /**
     * 测量两个标记之间的耗时。
     * 结果以 debug 级别输出。
     *
     * @param label - 测量名称
     * @param startMark - 起始标记名称
     * @param endMark - 结束标记名称
     *
     * @example
     * log.mark('parse-start');
     * // ... 执行解析 ...
     * log.mark('parse-end');
     * log.measure('parse-duration', 'parse-start', 'parse-end');
     */
    measure(label: string, startMark: string, endMark: string): void {
        if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
            try {
                const fullStart = `${this._prefix}:${startMark}`;
                const fullEnd = `${this._prefix}:${endMark}`;
                const entry = performance.measure(`${this._prefix}:${label}`, fullStart, fullEnd);

                // 以 debug 级别输出测量结果
                this.debug(`${label}: ${entry.duration.toFixed(2)}ms`);
            } catch {
                // 标记可能不存在，静默忽略
            }
        }
    }
}

/**
 * 创建一个带前缀的日志记录器实例。
 * 工厂函数，与 `new Logger(prefix)` 等价，但更符合函数式风格。
 *
 * @param prefix - 日志前缀（建议使用模块/类名）
 * @returns 新的 Logger 实例
 *
 * @example
 * const log = createLogger('DeviceManager');
 * log.info('WebGPU device acquired');
 */
export function createLogger(prefix: string): Logger {
    return new Logger(prefix);
}
