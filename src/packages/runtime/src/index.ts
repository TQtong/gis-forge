// ============================================================
// runtime/index.ts — L3 调度层统一导出（Barrel Export）
// 导出 10 个模块的接口类型和工厂函数：
//   1.  ErrorRecovery      — 错误恢复
//   2.  RequestScheduler   — 网络请求调度
//   3.  WorkerPool         — Worker 任务池
//   4.  ResourceManager    — 资源管理
//   5.  MemoryBudget       — 内存预算
//   6.  TileScheduler      — 瓦片调度
//   7.  FrameScheduler     — 帧循环
//   8.  CameraController   — 相机控制器（含 Camera2D）
//   9.  Camera3D           — 3D 相机
//   10. ViewMorph          — 视图过渡
// ============================================================

export type { ErrorCategory, ErrorEvent, RetryPolicy, ErrorRecovery } from './error-recovery.ts';
export { createErrorRecovery } from './error-recovery.ts';

export type { RequestConfig, RequestPriority, ScheduledRequest, RequestScheduler } from './request-scheduler.ts';
export { createRequestScheduler } from './request-scheduler.ts';

export type { WorkerTaskType, WorkerTask, WorkerTaskResult, WorkerPoolConfig, WorkerPool } from './worker-pool.ts';
export { createWorkerPool } from './worker-pool.ts';

export type { ResourceType, ResourceState, Resource, ResourceManager } from './resource-manager.ts';
export { createResourceManager } from './resource-manager.ts';

export type {
  MemoryBudgetConfig,
  MemorySnapshot,
  EvictionResult,
  MemoryBudget,
  MemoryBudgetCheckOptions,
  CameraHistoryEntry,
  CameraDirectionEstimate,
  PredictiveEvictionStats,
} from './memory-budget.ts';
export { createMemoryBudget } from './memory-budget.ts';

export type { TileState, TilePriority, TileSchedulerConfig, TileSourceOptions, TileScheduleResult, TileScheduler } from './tile-scheduler.ts';
export { createTileScheduler, computeTilePriority } from './tile-scheduler.ts';

export type { FramePhase, FrameCallback, FrameScheduler } from './frame-scheduler.ts';
export { createFrameScheduler } from './frame-scheduler.ts';

export type { CameraType, CameraConstraints, CameraAnimation, CameraController } from './camera-controller.ts';
export { createCamera2D } from './camera-controller.ts';

export type { Camera3DOptions, Camera3D } from './camera-3d.ts';
export { createCamera3D } from './camera-3d.ts';

export type { ViewMode, ViewMorphOptions, ViewMorphAnimation, ViewMorph } from './view-morph.ts';
export { createViewMorph } from './view-morph.ts';

// ============================================================
// L3 全局初始化便捷函数
// ============================================================

import { createErrorRecovery } from './error-recovery.ts';
import { createRequestScheduler } from './request-scheduler.ts';
import { createWorkerPool } from './worker-pool.ts';
import { createResourceManager } from './resource-manager.ts';
import { createMemoryBudget } from './memory-budget.ts';
import { createTileScheduler } from './tile-scheduler.ts';
import { createFrameScheduler } from './frame-scheduler.ts';
import { createCamera2D } from './camera-controller.ts';
import { createViewMorph } from './view-morph.ts';

import type { ErrorRecovery } from './error-recovery.ts';
import type { RequestScheduler } from './request-scheduler.ts';
import type { WorkerPool } from './worker-pool.ts';
import type { ResourceManager } from './resource-manager.ts';
import type { MemoryBudget } from './memory-budget.ts';
import type { TileScheduler } from './tile-scheduler.ts';
import type { FrameScheduler } from './frame-scheduler.ts';
import type { CameraController } from './camera-controller.ts';
import type { ViewMorph } from './view-morph.ts';

/**
 * L3 全局初始化结果。
 */
export interface L3Context {
  readonly errorRecovery: ErrorRecovery;
  readonly requestScheduler: RequestScheduler;
  readonly workerPool: WorkerPool;
  readonly resourceManager: ResourceManager;
  readonly memoryBudget: MemoryBudget;
  readonly tileScheduler: TileScheduler;
  readonly frameScheduler: FrameScheduler;
  readonly camera: CameraController;
  readonly viewMorph: ViewMorph;
}

/**
 * 初始化 L3 调度层的所有模块。
 *
 * @returns L3Context
 *
 * @example
 * const l3 = await initializeL3();
 * l3.frameScheduler.start();
 */
export async function initializeL3(): Promise<L3Context> {
  // 1. ErrorRecovery — 最先，其他模块的错误汇报给它
  const errorRecovery = createErrorRecovery();

  // 2. RequestScheduler — 依赖 ErrorRecovery
  const requestScheduler = createRequestScheduler({}, errorRecovery);

  // 3. WorkerPool — 独立（MVP 模拟版）
  const workerPool = createWorkerPool();
  await workerPool.initialize({ workerCount: 2, maxQueueSize: 100, taskTimeout: 30000 });

  // 4. ResourceManager — 独立
  const resourceManager = createResourceManager();

  // 5. MemoryBudget — 独立
  const memoryBudget = createMemoryBudget();

  // 6. TileScheduler — 独立
  const tileScheduler = createTileScheduler();

  // 7. FrameScheduler — 独立
  const frameScheduler = createFrameScheduler();

  // 8. CameraController（默认 2D）
  const camera = createCamera2D();

  // 9. ViewMorph
  const viewMorph = createViewMorph();

  return {
    errorRecovery,
    requestScheduler,
    workerPool,
    resourceManager,
    memoryBudget,
    tileScheduler,
    frameScheduler,
    camera,
    viewMorph,
  };
}
