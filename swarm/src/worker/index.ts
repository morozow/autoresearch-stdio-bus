/**
 * Worker module for GPU-bound experiment execution.
 * 
 * Exports:
 * - GpuWorker: Worker process bound to a specific GPU
 * - Types: GpuWorkerConfig, GpuWorkerOptions, WorkerState
 * - Factory: createGpuWorker, createGpuWorkerFromConfig
 */

export {
  GpuWorker,
  createGpuWorker,
  createGpuWorkerFromConfig,
  defaultGpuWorkerLogger,
  defaultCommandExecutor,
  defaultGpuChecker,
  DEFAULT_TIMEOUT_MINUTES,
  EXPERIMENT_COMMAND,
  RUN_LOG_FILENAME,
} from './gpu-worker';

export type {
  GpuWorkerConfig,
  GpuWorkerLogger,
  GpuWorkerOptions,
  CommandExecutor,
  GpuChecker,
  WorkerState,
  ParsedExperimentOutput,
} from './gpu-worker';
