// ============================================================
// infra/index.ts — 基础设施模块统一导出
// 聚合所有基础设施子模块，提供统一的命名导出入口。
// ============================================================

export { EventEmitter } from './event.ts';

export {
  createInternalBus,
  type InternalBus,
  type InternalEventMap,
} from './internal-bus.ts';

export {
  GeoForgeError,
  GeoForgeErrorCode,
  DEVELOPER_HINTS,
  formatErrorWithHint,
  type DeveloperHint,
  type GeoForgeErrorCodeType,
} from './errors.ts';

export { createObjectPool, type ObjectPool } from './object-pool.ts';

export { uniqueId, sequentialId, nanoid } from './id.ts';

export {
    Logger,
    createLogger,
    setLogLevel,
    getLogLevel,
    type LogLevel,
} from './logger.ts';

export {
    createDefaultConfig,
    mergeConfig,
    type EngineConfig,
} from './config.ts';

export {
    registerCRS,
    getCRS,
    transform,
    registerTransform,
    type CRSDefinition,
} from './coordinate.ts';

export {
    type ProjectionDef,
    type TileGridDefinition,
} from './projection.ts';
