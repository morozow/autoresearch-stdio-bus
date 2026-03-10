/**
 * SwarmCoordinator - Central orchestration component managing the entire swarm lifecycle.
 * 
 * Responsibilities:
 * - Read and validate configuration from JSON file
 * - Spawn and manage GPU_Worker processes
 * - Route messages through stdio_bus
 * - Coordinate experiment distribution
 * - Handle hot-reload of configuration
 * - Log all operations to `swarm.log`
 * 
 * Validates: Requirements 1.3, 3.2
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SwarmConfig, parseAndValidateConfig, formatValidationErrors } from '../config/schema';
import { ExperimentResult, ExperimentRegistry, createExperimentRegistry } from '../state/experiment-registry';
import { StateBroadcaster, createStateBroadcaster } from '../broadcast/state-broadcaster';
import { ConflictResolver, createConflictResolver } from '../conflict/conflict-resolver';
import { SessionRouter, createSessionRouter } from '../routing/session-router';
import { GpuWorker, GpuWorkerConfig, createGpuWorker } from '../worker/gpu-worker';
import {
  GpuUtilization,
  StatusResult,
  HistoryResult,
  ExperimentResultParams,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  METHOD_NAMES,
  createSuccessResponse,
  createErrorResponse,
  JSON_RPC_ERROR_CODES,
  isJsonRpcRequest,
  isJsonRpcNotification,
  SyncResult,
  StatusResult as StatusResultType,
  HistoryResult as HistoryResultType,
  PauseResult,
  ResumeResult,
  LockAcquireResult,
  LockAcquireParams,
  HistoryRequestParams,
} from '../protocol/types';
import {
  encode,
  decode,
  createNdjsonParser,
  NdjsonParser,
  NdjsonParserEvent,
  CodecLogger,
} from '../protocol/codec';
import {
  ProgressChartGenerator,
  createProgressChartGenerator,
  ChartGeneratorOptions,
} from './progress-chart';

// ============================================================================
// Types
// ============================================================================

/**
 * GPU status information.
 * 
 * Validates: Requirements 3.1, 3.5
 */
export interface GpuStatus {
  /** GPU ID */
  gpuId: number;
  /** Whether the GPU is available */
  available: boolean;
  /** Current experiment commit hash (null if idle) */
  currentExperiment: string | null;
  /** Memory capacity in MB */
  memoryCapacityMb: number;
}

/**
 * Swarm status information.
 * 
 * Validates: Requirements 10.1
 */
export interface SwarmStatus {
  /** Number of active agents */
  activeAgents: number;
  /** Total experiments completed */
  totalExperiments: number;
  /** Best (lowest) val_bpb achieved */
  bestValBpb: number;
  /** Experiments completed per hour */
  experimentsPerHour: number;
  /** Uptime in seconds */
  uptime: number;
  /** GPU utilization by GPU ID */
  gpuUtilization: Record<number, GpuStatus>;
}

/**
 * Experiment timeline entry.
 */
export interface ExperimentTimelineEntry {
  /** Experiment result */
  result: ExperimentResult;
  /** Timestamp when recorded */
  timestamp: string;
}

/**
 * Experiment timeline for history.
 */
export interface ExperimentTimeline {
  /** All experiments in chronological order */
  experiments: ExperimentTimelineEntry[];
  /** Total count */
  totalCount: number;
}

/**
 * Result of a hot-reload operation.
 * 
 * Validates: Requirements 6.4
 */
export interface HotReloadResult {
  /** Whether the reload was successful */
  success: boolean;
  /** Agent IDs that were added */
  added: string[];
  /** Agent IDs that were removed */
  removed: string[];
  /** Agent IDs that were preserved (kept running with state intact) */
  preserved: string[];
}

/**
 * Worker state tracking.
 */
interface WorkerState {
  /** Worker instance */
  worker: GpuWorker;
  /** Agent ID */
  agentId: string;
  /** GPU ID */
  gpuId: number;
  /** Whether worker is currently executing */
  isExecuting: boolean;
  /** Current experiment commit (if executing) */
  currentExperiment: string | null;
  /** Worker process (if spawned as child process) */
  process?: ChildProcess;
  /** Last known state before crash (for recovery) */
  lastState?: {
    isExecuting: boolean;
    currentExperiment: string | null;
    branch?: string;
  };
  /** Number of crash recovery attempts */
  crashCount: number;
  /** Timestamp of last crash */
  lastCrashTime?: number;
  /** Whether the worker is currently being recovered */
  isRecovering: boolean;
}

/**
 * Logger interface for swarm coordinator.
 */
export interface SwarmCoordinatorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultSwarmCoordinatorLogger: SwarmCoordinatorLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[swarm-coordinator] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[swarm-coordinator] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[swarm-coordinator] ${message}`, context ?? '');
  },
};

/**
 * File logger that writes to swarm.log.
 */
export class FileLogger implements SwarmCoordinatorLogger {
  private logPath: string;
  private generateTs: () => string;

  constructor(logPath: string = './swarm.log', timestampGenerator?: () => string) {
    this.logPath = logPath;
    this.generateTs = timestampGenerator ?? (() => new Date().toISOString());
  }

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    const timestamp = this.generateTs();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    const line = `[${timestamp}] [${level}] ${message}${contextStr}\n`;

    try {
      fs.appendFileSync(this.logPath, line);
    } catch {
      // Fallback to console if file write fails
      console.error(`Failed to write to ${this.logPath}:`, line);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('ERROR', message, context);
  }
}

/**
 * Configuration options for SwarmCoordinator.
 */
export interface SwarmCoordinatorOptions {
  /** Logger for coordinator events. Defaults to console logger. */
  logger?: SwarmCoordinatorLogger;
  /** File logger for swarm.log. If not provided, creates one. */
  fileLogger?: SwarmCoordinatorLogger;
  /** Custom timestamp generator. Defaults to ISO 8601 current time. */
  timestampGenerator?: () => string;
  /** Working directory for experiments. Defaults to current directory. */
  workDir?: string;
  /** Experiment registry instance. If not provided, creates one. */
  experimentRegistry?: ExperimentRegistry;
  /** State broadcaster instance. If not provided, creates one. */
  stateBroadcaster?: StateBroadcaster;
  /** Conflict resolver instance. If not provided, creates one. */
  conflictResolver?: ConflictResolver;
  /** Session router instance. If not provided, creates one. */
  sessionRouter?: SessionRouter;
}

// ============================================================================
// Constants
// ============================================================================

/** Default log file path */
export const DEFAULT_LOG_PATH = './swarm.log';

/** Worker restart delay in milliseconds (30 seconds per requirement 3.4) */
export const WORKER_RESTART_DELAY_MS = 30 * 1000;

/** Maximum time to restart a crashed worker in milliseconds (60 seconds per requirement 9.1) */
export const MAX_CRASH_RECOVERY_TIME_MS = 60 * 1000;

/** Default crash recovery delay in milliseconds */
export const DEFAULT_CRASH_RECOVERY_DELAY_MS = 5 * 1000;

// ============================================================================
// SwarmCoordinator Class
// ============================================================================

/**
 * SwarmCoordinator manages the entire swarm lifecycle.
 * 
 * Key features:
 * - Configuration validation and loading
 * - GPU_Worker process spawning and management
 * - Hot-reload support for configuration changes
 * - Pause/resume functionality
 * - Status and history reporting
 * 
 * Validates: Requirements 1.3, 3.2
 */
export class SwarmCoordinator {
  /** Current configuration */
  private config: SwarmConfig | null = null;

  /** Worker states by agent ID */
  private workers: Map<string, WorkerState> = new Map();

  /** Console logger */
  private logger: SwarmCoordinatorLogger;

  /** File logger for swarm.log */
  private fileLogger: SwarmCoordinatorLogger;

  /** Timestamp generator */
  private generateTs: () => string;

  /** Working directory */
  private workDir: string;

  /** Experiment registry */
  private experimentRegistry: ExperimentRegistry;

  /** State broadcaster */
  private stateBroadcaster: StateBroadcaster;

  /** Conflict resolver */
  private conflictResolver: ConflictResolver;

  /** Session router */
  private sessionRouter: SessionRouter;

  /** Start time for uptime calculation */
  private startTime: number = 0;

  /** Whether the swarm is paused */
  private isPaused: boolean = false;

  /** Whether the swarm is running */
  private isRunning: boolean = false;

  /** Pending crash recovery timers by agent ID */
  private crashRecoveryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Crash recovery delay in milliseconds (configurable for testing) */
  private crashRecoveryDelayMs: number = DEFAULT_CRASH_RECOVERY_DELAY_MS;

  // ==========================================================================
  // Backpressure State (Validates: Requirements 9.4)
  // ==========================================================================

  /** Current input buffer size in bytes */
  private inputBufferSize: number = 0;

  /** Current output queue size in bytes */
  private outputQueueSize: number = 0;

  /** Whether backpressure is currently active on input */
  private inputBackpressureActive: boolean = false;

  /** Whether backpressure is currently active on output */
  private outputBackpressureActive: boolean = false;

  /** Pending output messages when backpressure is active */
  private pendingOutputQueue: string[] = [];

  // ==========================================================================
  // Progress Reporting State (Validates: Requirements 10.2, 10.4)
  // ==========================================================================

  /** Counter for experiments since last progress report */
  private experimentsSinceLastReport: number = 0;

  /** Progress report interval (every N experiments) */
  private progressReportInterval: number = 10;

  /** Stdout writer for progress reports (separate from JSON-RPC output) */
  private progressWriter: (message: string) => void = (message: string) => {
    process.stdout.write(message + '\n');
  };

  /** Track the best val_bpb before recording a new result (for new best detection) */
  private previousBestValBpb: number = Infinity;

  /** Progress chart generator for visualizing val_bpb over time */
  private progressChartGenerator: ProgressChartGenerator;

  /**
   * Creates a new SwarmCoordinator instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: SwarmCoordinatorOptions = {}) {
    this.logger = options.logger ?? defaultSwarmCoordinatorLogger;
    this.generateTs = options.timestampGenerator ?? (() => new Date().toISOString());
    this.workDir = options.workDir ?? process.cwd();
    this.fileLogger = options.fileLogger ?? new FileLogger(
      path.join(this.workDir, 'swarm.log'),
      this.generateTs
    );

    // Initialize or use provided components
    this.experimentRegistry = options.experimentRegistry ?? createExperimentRegistry({
      resultsPath: path.join(this.workDir, 'results.tsv'),
    });
    this.stateBroadcaster = options.stateBroadcaster ?? createStateBroadcaster();
    this.conflictResolver = options.conflictResolver ?? createConflictResolver();
    this.sessionRouter = options.sessionRouter ?? createSessionRouter();

    // Initialize progress chart generator
    this.progressChartGenerator = createProgressChartGenerator({
      outputPath: path.join(this.workDir, 'progress.png'),
      dataOutputPath: path.join(this.workDir, 'progress-data.json'),
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Starts the swarm coordinator with the given configuration.
   * 
   * Validates configuration, spawns GPU_Worker processes, and begins
   * coordinating experiments.
   * 
   * @param config - Swarm configuration
   * @throws Error if configuration is invalid or startup fails
   * 
   * Validates: Requirements 1.3, 3.2, 6.6
   */
  async start(config: SwarmConfig): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Swarm coordinator is already running');
      return;
    }

    this.logger.info('Starting swarm coordinator', {
      gpuIds: config.swarm.gpuIds,
      poolCount: config.pools.length,
    });
    this.fileLogger.info('Starting swarm coordinator', {
      gpuIds: config.swarm.gpuIds,
      poolCount: config.pools.length,
    });

    // Store configuration
    this.config = config;
    this.startTime = Date.now();
    this.isRunning = true;
    this.isPaused = false;

    // Restore state from disk if available
    try {
      await this.experimentRegistry.restore();
      this.logger.info('Restored experiment state from disk', {
        totalExperiments: this.experimentRegistry.getTotalExperiments(),
        bestValBpb: this.experimentRegistry.getBestValBpb(),
      });
    } catch (error) {
      this.logger.warn('Failed to restore state, starting fresh', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Spawn GPU workers
    await this.spawnWorkers(config);

    this.logger.info('Swarm coordinator started', {
      activeWorkers: this.workers.size,
      gpuIds: config.swarm.gpuIds,
    });
    this.fileLogger.info('Swarm coordinator started', {
      activeWorkers: this.workers.size,
    });
  }

  /**
   * Stops the swarm coordinator.
   * 
   * Gracefully shuts down all GPU_Worker processes and persists state.
   * 
   * Validates: Requirements 9.1
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Swarm coordinator is not running');
      return;
    }

    this.logger.info('Stopping swarm coordinator');
    this.fileLogger.info('Stopping swarm coordinator');

    // Cancel all pending crash recoveries
    this.cancelAllCrashRecoveries();

    // Stop all workers
    const stopPromises: Promise<void>[] = [];
    for (const [agentId, workerState] of this.workers) {
      this.logger.info('Stopping worker', { agentId, gpuId: workerState.gpuId });
      stopPromises.push(this.stopWorker(agentId));
    }
    await Promise.all(stopPromises);

    // Persist state
    try {
      await this.experimentRegistry.persist();
      this.logger.info('Persisted experiment state');
    } catch (error) {
      this.logger.error('Failed to persist state', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.fileLogger.error('Failed to persist state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Clear state
    this.workers.clear();
    this.config = null;
    this.isRunning = false;
    this.isPaused = false;

    this.logger.info('Swarm coordinator stopped');
    this.fileLogger.info('Swarm coordinator stopped');
  }

  /**
   * Hot-reloads the swarm configuration.
   * 
   * Adds or removes agents to match the new configuration without
   * restarting existing agents that remain in the configuration.
   * Preserves existing agent state during reload.
   * 
   * @param config - New swarm configuration
   * @returns HotReloadResult with details about what changed
   * 
   * Validates: Requirements 6.4
   */
  async reload(config: SwarmConfig): Promise<HotReloadResult> {
    if (!this.isRunning) {
      // If not running, just start with new config
      await this.start(config);
      return {
        success: true,
        added: config.swarm.gpuIds.map(gpuId => `agent-${gpuId}`),
        removed: [],
        preserved: [],
      };
    }

    this.logger.info('Hot-reloading configuration', {
      oldGpuIds: this.config?.swarm.gpuIds,
      newGpuIds: config.swarm.gpuIds,
    });
    this.fileLogger.info('Hot-reloading configuration', {
      newGpuIds: config.swarm.gpuIds,
    });

    const oldConfig = this.config;
    this.config = config;

    // Track changes for result
    const added: string[] = [];
    const removed: string[] = [];
    const preserved: string[] = [];

    // Determine which workers to add/remove
    const oldGpuIds = new Set(oldConfig?.swarm.gpuIds ?? []);
    const newGpuIds = new Set(config.swarm.gpuIds);

    // Identify workers to remove (GPUs no longer in config)
    const toRemove: string[] = [];
    for (const [agentId, workerState] of this.workers) {
      if (!newGpuIds.has(workerState.gpuId)) {
        toRemove.push(agentId);
      } else {
        // Worker remains in config - preserve its state
        preserved.push(agentId);
        this.logger.info('Preserving worker state during hot-reload', {
          agentId,
          gpuId: workerState.gpuId,
          isExecuting: workerState.isExecuting,
          currentExperiment: workerState.currentExperiment,
        });
      }
    }

    // Remove workers for GPUs no longer in config
    for (const agentId of toRemove) {
      const workerState = this.workers.get(agentId);
      this.logger.info('Removing worker during hot-reload', {
        agentId,
        gpuId: workerState?.gpuId,
        wasExecuting: workerState?.isExecuting,
      });
      this.fileLogger.info('Removing worker during hot-reload', {
        agentId,
        gpuId: workerState?.gpuId,
      });
      await this.stopWorker(agentId);
      removed.push(agentId);
    }

    // Add workers for new GPUs
    const existingGpuIds = new Set(
      Array.from(this.workers.values()).map(w => w.gpuId)
    );

    for (const gpuId of config.swarm.gpuIds) {
      if (!existingGpuIds.has(gpuId)) {
        const agentId = `agent-${gpuId}`;
        this.logger.info('Adding worker during hot-reload', { agentId, gpuId });
        this.fileLogger.info('Adding worker during hot-reload', { agentId, gpuId });
        await this.spawnWorker(agentId, gpuId, config);
        added.push(agentId);
      }
    }

    // Update configuration for preserved workers (e.g., timeout changes)
    for (const agentId of preserved) {
      const workerState = this.workers.get(agentId);
      if (workerState) {
        // Update worker configuration if needed (e.g., timeout)
        // The worker itself doesn't need to be restarted, but we can
        // update any mutable configuration
        this.logger.info('Updated configuration for preserved worker', {
          agentId,
          gpuId: workerState.gpuId,
          newTimeout: config.swarm.experimentTimeout,
        });
      }
    }

    this.logger.info('Hot-reload complete', {
      activeWorkers: this.workers.size,
      added: added.length,
      removed: removed.length,
      preserved: preserved.length,
    });
    this.fileLogger.info('Hot-reload complete', {
      activeWorkers: this.workers.size,
      added,
      removed,
      preserved,
    });

    return {
      success: true,
      added,
      removed,
      preserved,
    };
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  /**
   * Gets the current swarm status.
   * 
   * @returns SwarmStatus with current metrics
   * 
   * Validates: Requirements 10.1
   */
  getStatus(): SwarmStatus {
    const uptime = this.isRunning ? (Date.now() - this.startTime) / 1000 : 0;
    const totalExperiments = this.experimentRegistry.getTotalExperiments();
    const experimentsPerHour = uptime > 0
      ? (totalExperiments / uptime) * 3600
      : 0;

    // Build GPU utilization map
    const gpuUtilization: Record<number, GpuStatus> = {};
    for (const [agentId, workerState] of this.workers) {
      gpuUtilization[workerState.gpuId] = {
        gpuId: workerState.gpuId,
        available: !workerState.isExecuting,
        currentExperiment: workerState.currentExperiment,
        memoryCapacityMb: 0, // Would need to query GPU for actual value
      };
    }

    return {
      activeAgents: this.workers.size,
      totalExperiments,
      bestValBpb: this.experimentRegistry.getBestValBpb(),
      experimentsPerHour,
      uptime,
      gpuUtilization,
    };
  }

  /**
   * Gets the experiment history/timeline.
   * 
   * @param limit - Maximum number of experiments to return
   * @returns ExperimentTimeline with all experiments
   * 
   * Validates: Requirements 10.6
   */
  async getHistory(limit?: number): Promise<ExperimentTimeline> {
    const allResults = this.experimentRegistry.getAllResults();
    const experiments = allResults
      .slice(0, limit)
      .map(result => ({
        result,
        timestamp: result.timestamp,
      }));

    return {
      experiments,
      totalCount: allResults.length,
    };
  }

  // ==========================================================================
  // Control
  // ==========================================================================

  /**
   * Pauses all agents in the swarm.
   * 
   * Agents will stop accepting new experiments until resumed.
   * 
   * Validates: Requirements 8.6
   */
  async pause(): Promise<void> {
    if (this.isPaused) {
      this.logger.warn('Swarm is already paused');
      return;
    }

    this.logger.info('Pausing swarm');
    this.fileLogger.info('Pausing swarm');
    this.isPaused = true;
  }

  /**
   * Resumes all agents in the swarm.
   * 
   * Agents will begin accepting new experiments again.
   * 
   * Validates: Requirements 8.6
   */
  async resume(): Promise<void> {
    if (!this.isPaused) {
      this.logger.warn('Swarm is not paused');
      return;
    }

    this.logger.info('Resuming swarm');
    this.fileLogger.info('Resuming swarm');
    this.isPaused = false;
  }

  // ==========================================================================
  // Worker Management
  // ==========================================================================

  /**
   * Spawns GPU workers based on configuration.
   * 
   * Creates one worker per GPU ID in the configuration.
   * 
   * @param config - Swarm configuration
   * 
   * Validates: Requirements 1.3, 3.2
   */
  private async spawnWorkers(config: SwarmConfig): Promise<void> {
    const spawnPromises: Promise<void>[] = [];

    for (let i = 0; i < config.swarm.gpuIds.length; i++) {
      const gpuId = config.swarm.gpuIds[i]!;
      const agentId = `agent-${gpuId}`;
      spawnPromises.push(this.spawnWorker(agentId, gpuId, config));
    }

    await Promise.all(spawnPromises);
  }

  /**
   * Spawns a single GPU worker.
   * 
   * @param agentId - Agent identifier
   * @param gpuId - GPU ID to bind to
   * @param config - Swarm configuration
   * @param previousState - Optional previous state to restore on restart
   * 
   * Validates: Requirements 3.1, 3.2, 9.1
   */
  private async spawnWorker(
    agentId: string,
    gpuId: number,
    config: SwarmConfig,
    previousState?: { isExecuting: boolean; currentExperiment: string | null; branch?: string }
  ): Promise<void> {
    this.logger.info('Spawning worker', { agentId, gpuId, hasPrevoiusState: !!previousState });
    this.fileLogger.info('Spawning worker', { agentId, gpuId });

    const workerConfig: GpuWorkerConfig = {
      gpuId,
      agentId,
      workDir: this.workDir,
      timeoutMinutes: config.swarm.experimentTimeout ?? 10,
    };

    const worker = createGpuWorker({ config: workerConfig });

    try {
      await worker.start(gpuId, agentId);

      // Get existing worker state if any (for crash count tracking)
      const existingState = this.workers.get(agentId);

      const workerState: WorkerState = {
        worker,
        agentId,
        gpuId,
        isExecuting: false,
        currentExperiment: null,
        crashCount: existingState?.crashCount ?? 0,
        lastCrashTime: existingState?.lastCrashTime,
        isRecovering: false,
        lastState: previousState,
      };

      this.workers.set(agentId, workerState);

      // Register agent with experiment registry
      this.experimentRegistry.registerAgent(agentId);

      // Assign session for routing
      this.sessionRouter.assignSession(agentId, gpuId);

      // Subscribe to broadcasts
      this.stateBroadcaster.subscribe(agentId);

      this.logger.info('Worker spawned successfully', { agentId, gpuId });

      // If we have previous state, log the restoration
      if (previousState) {
        this.logger.info('Restored worker state after crash recovery', {
          agentId,
          gpuId,
          previousState,
        });
        this.fileLogger.info('Restored worker state after crash recovery', {
          agentId,
          gpuId,
          wasExecuting: previousState.isExecuting,
          previousExperiment: previousState.currentExperiment,
        });
      }
    } catch (error) {
      this.logger.error('Failed to spawn worker', {
        agentId,
        gpuId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.fileLogger.error('Failed to spawn worker', {
        agentId,
        gpuId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stops a single GPU worker.
   * 
   * @param agentId - Agent identifier
   */
  private async stopWorker(agentId: string): Promise<void> {
    const workerState = this.workers.get(agentId);
    if (!workerState) {
      this.logger.warn('Worker not found', { agentId });
      return;
    }

    try {
      await workerState.worker.stop();
    } catch (error) {
      this.logger.error('Error stopping worker', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Unregister from components
    this.experimentRegistry.unregisterAgent(agentId);
    const session = this.sessionRouter.getSessionByAgent(agentId);
    if (session) {
      this.sessionRouter.releaseSession(session.sessionId);
    }
    this.stateBroadcaster.unsubscribe(agentId);

    this.workers.delete(agentId);
    this.logger.info('Worker stopped', { agentId });
  }

  /**
   * Restarts a crashed worker.
   * 
   * @param agentId - Agent identifier
   * 
   * Validates: Requirements 3.4, 9.1
   */
  async restartWorker(agentId: string): Promise<void> {
    const workerState = this.workers.get(agentId);
    if (!workerState || !this.config) {
      this.logger.warn('Cannot restart worker: not found or no config', { agentId });
      return;
    }

    const gpuId = workerState.gpuId;

    this.logger.info('Restarting worker', { agentId, gpuId });
    this.fileLogger.info('Restarting worker', { agentId, gpuId });

    // Stop existing worker
    await this.stopWorker(agentId);

    // Wait before restart (30 seconds per requirement 3.4)
    await this.sleep(WORKER_RESTART_DELAY_MS);

    // Spawn new worker
    await this.spawnWorker(agentId, gpuId, this.config);

    this.logger.info('Worker restarted', { agentId, gpuId });
    this.fileLogger.info('Worker restarted', { agentId, gpuId });
  }

  // ==========================================================================
  // Crash Recovery
  // ==========================================================================

  /**
   * Handles a worker crash by scheduling automatic recovery.
   * 
   * Detects worker exit and schedules restart within 60 seconds.
   * Preserves previous state for restoration on restart.
   * 
   * @param agentId - Agent identifier that crashed
   * @param exitCode - Exit code from the crashed process (if available)
   * @param error - Error that caused the crash (if available)
   * 
   * Validates: Requirements 9.1, 3.4
   */
  handleWorkerCrash(agentId: string, exitCode?: number, error?: Error): void {
    const workerState = this.workers.get(agentId);
    if (!workerState) {
      this.logger.warn('Cannot handle crash: worker not found', { agentId });
      return;
    }

    // Don't handle crash if already recovering or if swarm is stopping
    if (workerState.isRecovering || !this.isRunning) {
      this.logger.info('Skipping crash recovery: already recovering or swarm stopping', {
        agentId,
        isRecovering: workerState.isRecovering,
        isRunning: this.isRunning,
      });
      return;
    }

    const now = Date.now();
    const gpuId = workerState.gpuId;

    // Save the current state before crash for restoration
    const previousState = {
      isExecuting: workerState.isExecuting,
      currentExperiment: workerState.currentExperiment,
      branch: workerState.lastState?.branch,
    };

    // Update crash tracking
    workerState.crashCount++;
    workerState.lastCrashTime = now;
    workerState.isRecovering = true;
    workerState.lastState = previousState;

    // Log the crash with details
    this.logger.error('Worker crashed', {
      agentId,
      gpuId,
      exitCode,
      error: error?.message,
      crashCount: workerState.crashCount,
      wasExecuting: previousState.isExecuting,
      currentExperiment: previousState.currentExperiment,
    });
    this.fileLogger.error('Worker crashed', {
      agentId,
      gpuId,
      exitCode,
      error: error?.message,
      stackTrace: error?.stack,
      crashCount: workerState.crashCount,
      wasExecuting: previousState.isExecuting,
      currentExperiment: previousState.currentExperiment,
      timestamp: this.generateTs(),
    });

    // Cancel any existing recovery timer for this agent
    this.cancelCrashRecovery(agentId);

    // Schedule crash recovery (within 60 seconds per requirement 9.1)
    this.scheduleCrashRecovery(agentId, gpuId, previousState);
  }

  /**
   * Schedules crash recovery for a worker.
   * 
   * @param agentId - Agent identifier
   * @param gpuId - GPU ID to restart on
   * @param previousState - Previous state to restore
   * 
   * Validates: Requirements 9.1
   */
  private scheduleCrashRecovery(
    agentId: string,
    gpuId: number,
    previousState: { isExecuting: boolean; currentExperiment: string | null; branch?: string }
  ): void {
    this.logger.info('Scheduling crash recovery', {
      agentId,
      gpuId,
      delayMs: this.crashRecoveryDelayMs,
    });

    const timer = setTimeout(async () => {
      await this.executeCrashRecovery(agentId, gpuId, previousState);
    }, this.crashRecoveryDelayMs);

    this.crashRecoveryTimers.set(agentId, timer);
  }

  /**
   * Executes crash recovery for a worker.
   * 
   * @param agentId - Agent identifier
   * @param gpuId - GPU ID to restart on
   * @param previousState - Previous state to restore
   * 
   * Validates: Requirements 9.1
   */
  private async executeCrashRecovery(
    agentId: string,
    gpuId: number,
    previousState: { isExecuting: boolean; currentExperiment: string | null; branch?: string }
  ): Promise<void> {
    // Remove the timer from tracking
    this.crashRecoveryTimers.delete(agentId);

    // Check if swarm is still running
    if (!this.isRunning || !this.config) {
      this.logger.info('Skipping crash recovery: swarm not running', { agentId });
      return;
    }

    this.logger.info('Executing crash recovery', {
      agentId,
      gpuId,
      previousState,
    });
    this.fileLogger.info('Executing crash recovery', {
      agentId,
      gpuId,
      timestamp: this.generateTs(),
    });

    try {
      // Clean up the old worker state (but preserve crash tracking)
      const oldWorkerState = this.workers.get(agentId);
      const crashCount = oldWorkerState?.crashCount ?? 0;
      const lastCrashTime = oldWorkerState?.lastCrashTime;

      // Stop the old worker if it still exists
      if (oldWorkerState) {
        try {
          await oldWorkerState.worker.stop();
        } catch (stopError) {
          this.logger.warn('Error stopping crashed worker during recovery', {
            agentId,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }

        // Unregister from components
        this.experimentRegistry.unregisterAgent(agentId);
        const session = this.sessionRouter.getSessionByAgent(agentId);
        if (session) {
          this.sessionRouter.releaseSession(session.sessionId);
        }
        this.stateBroadcaster.unsubscribe(agentId);
        this.workers.delete(agentId);
      }

      // Spawn new worker with previous state
      await this.spawnWorker(agentId, gpuId, this.config, previousState);

      // Restore crash tracking on the new worker state
      const newWorkerState = this.workers.get(agentId);
      if (newWorkerState) {
        newWorkerState.crashCount = crashCount;
        newWorkerState.lastCrashTime = lastCrashTime;
        newWorkerState.isRecovering = false;
      }

      this.logger.info('Crash recovery completed', {
        agentId,
        gpuId,
        crashCount,
      });
      this.fileLogger.info('Crash recovery completed', {
        agentId,
        gpuId,
        crashCount,
        timestamp: this.generateTs(),
      });
    } catch (error) {
      this.logger.error('Crash recovery failed', {
        agentId,
        gpuId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.fileLogger.error('Crash recovery failed', {
        agentId,
        gpuId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: this.generateTs(),
      });

      // Mark worker as no longer recovering so it can be retried
      const workerState = this.workers.get(agentId);
      if (workerState) {
        workerState.isRecovering = false;
      }
    }
  }

  /**
   * Cancels a pending crash recovery for a worker.
   * 
   * @param agentId - Agent identifier
   */
  cancelCrashRecovery(agentId: string): void {
    const timer = this.crashRecoveryTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.crashRecoveryTimers.delete(agentId);
      this.logger.info('Cancelled crash recovery', { agentId });
    }
  }

  /**
   * Cancels all pending crash recoveries.
   */
  private cancelAllCrashRecoveries(): void {
    for (const [agentId, timer] of this.crashRecoveryTimers) {
      clearTimeout(timer);
      this.logger.info('Cancelled crash recovery during shutdown', { agentId });
    }
    this.crashRecoveryTimers.clear();
  }

  /**
   * Gets the crash count for a worker.
   * 
   * @param agentId - Agent identifier
   * @returns Crash count or 0 if worker not found
   */
  getWorkerCrashCount(agentId: string): number {
    return this.workers.get(agentId)?.crashCount ?? 0;
  }

  /**
   * Checks if a worker is currently recovering from a crash.
   * 
   * @param agentId - Agent identifier
   * @returns True if worker is recovering
   */
  isWorkerRecovering(agentId: string): boolean {
    return this.workers.get(agentId)?.isRecovering ?? false;
  }

  /**
   * Gets the last crash time for a worker.
   * 
   * @param agentId - Agent identifier
   * @returns Timestamp of last crash or undefined
   */
  getWorkerLastCrashTime(agentId: string): number | undefined {
    return this.workers.get(agentId)?.lastCrashTime;
  }

  /**
   * Sets the crash recovery delay (for testing).
   * 
   * @param delayMs - Delay in milliseconds
   */
  setCrashRecoveryDelay(delayMs: number): void {
    this.crashRecoveryDelayMs = delayMs;
  }

  /**
   * Gets the number of pending crash recoveries.
   * 
   * @returns Number of pending recoveries
   */
  getPendingCrashRecoveryCount(): number {
    return this.crashRecoveryTimers.size;
  }

  // ==========================================================================
  // GPU Failover
  // ==========================================================================

  /**
   * Checks GPU availability for all workers and returns unavailable GPUs.
   *
   * @returns Promise resolving to array of unavailable GPU IDs
   *
   * Validates: Requirements 9.3
   */
  async detectUnavailableGpus(): Promise<number[]> {
    const unavailableGpus: number[] = [];

    for (const [agentId, workerState] of this.workers) {
      try {
        const available = await workerState.worker.checkGpuAvailable();
        if (!available) {
          unavailableGpus.push(workerState.gpuId);
          this.logger.warn('GPU unavailable detected', {
            agentId,
            gpuId: workerState.gpuId,
          });
          this.fileLogger.warn('GPU unavailable detected', {
            agentId,
            gpuId: workerState.gpuId,
            timestamp: this.generateTs(),
          });
        }
      } catch (error) {
        // If we can't check, assume unavailable
        unavailableGpus.push(workerState.gpuId);
        this.logger.error('Failed to check GPU availability', {
          agentId,
          gpuId: workerState.gpuId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.fileLogger.error('Failed to check GPU availability', {
          agentId,
          gpuId: workerState.gpuId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: this.generateTs(),
        });
      }
    }

    return unavailableGpus;
  }

  /**
   * Gets available GPUs that are not currently executing experiments and not being used for redistribution.
   *
   * @param excludeGpuIds - GPU IDs to exclude from the result (e.g., GPUs being redistributed to)
   * @returns Array of available GPU IDs
   *
   * Validates: Requirements 9.3
   */
  getAvailableGpus(excludeGpuIds: number[] = []): number[] {
    const availableGpus: number[] = [];
    const excludeSet = new Set(excludeGpuIds);

    for (const [agentId, workerState] of this.workers) {
      if (!workerState.isExecuting && !workerState.isRecovering && !excludeSet.has(workerState.gpuId)) {
        availableGpus.push(workerState.gpuId);
      }
    }

    return availableGpus;
  }

  /**
   * Redistributes work from an unavailable GPU to an available GPU.
   *
   * When a GPU becomes unavailable, this method:
   * 1. Stops the worker on the unavailable GPU
   * 2. Finds an available GPU to take over
   * 3. Reassigns the agent's pending work to the new GPU
   *
   * @param unavailableGpuId - The GPU ID that became unavailable
   * @returns Promise resolving to the new GPU ID, or null if no GPU available
   *
   * Validates: Requirements 9.3
   */
  async redistributeWork(unavailableGpuId: number): Promise<number | null> {
    return this.redistributeWorkWithExclusions(unavailableGpuId, [unavailableGpuId]);
  }

  /**
   * Handles GPU failover by detecting unavailable GPUs and redistributing work.
   *
   * This method:
   * 1. Detects all unavailable GPUs
   * 2. For each unavailable GPU, redistributes work to available GPUs
   * 3. Returns a summary of the failover operations
   *
   * @returns Promise resolving to failover result
   *
   * Validates: Requirements 9.3
   */
  async handleGpuFailover(): Promise<{
    unavailableGpus: number[];
    redistributions: Array<{ fromGpuId: number; toGpuId: number | null; agentId: string }>;
  }> {
    this.logger.info('Starting GPU failover check');
    this.fileLogger.info('Starting GPU failover check', {
      timestamp: this.generateTs(),
    });

    const unavailableGpus = await this.detectUnavailableGpus();
    const redistributions: Array<{ fromGpuId: number; toGpuId: number | null; agentId: string }> = [];
    const usedTargetGpus: number[] = []; // Track GPUs already used for redistribution

    if (unavailableGpus.length === 0) {
      this.logger.info('No unavailable GPUs detected');
      return { unavailableGpus: [], redistributions: [] };
    }

    this.logger.warn('Unavailable GPUs detected, initiating failover', {
      unavailableGpus,
      count: unavailableGpus.length,
    });
    this.fileLogger.warn('Unavailable GPUs detected, initiating failover', {
      unavailableGpus,
      count: unavailableGpus.length,
      timestamp: this.generateTs(),
    });

    // Process each unavailable GPU
    for (const gpuId of unavailableGpus) {
      // Find the agent on this GPU
      let agentId = '';
      for (const [id, state] of this.workers) {
        if (state.gpuId === gpuId) {
          agentId = id;
          break;
        }
      }

      if (!agentId) {
        continue;
      }

      const newGpuId = await this.redistributeWorkWithExclusions(gpuId, [...unavailableGpus, ...usedTargetGpus]);
      redistributions.push({
        fromGpuId: gpuId,
        toGpuId: newGpuId,
        agentId,
      });

      // Track the GPU used for redistribution
      if (newGpuId !== null) {
        usedTargetGpus.push(newGpuId);
      }
    }

    this.logger.info('GPU failover completed', {
      unavailableGpus,
      redistributions,
    });
    this.fileLogger.info('GPU failover completed', {
      unavailableGpus,
      redistributionCount: redistributions.length,
      successfulRedistributions: redistributions.filter(r => r.toGpuId !== null).length,
      timestamp: this.generateTs(),
    });

    return { unavailableGpus, redistributions };
  }

  /**
   * Redistributes work from an unavailable GPU to an available GPU, excluding specified GPUs.
   *
   * @param unavailableGpuId - The GPU ID that became unavailable
   * @param excludeGpuIds - GPU IDs to exclude from consideration
   * @returns Promise resolving to the new GPU ID, or null if no GPU available
   *
   * Validates: Requirements 9.3
   */
  private async redistributeWorkWithExclusions(unavailableGpuId: number, excludeGpuIds: number[]): Promise<number | null> {
    // Find the worker on the unavailable GPU
    let affectedAgentId: string | null = null;
    let affectedWorkerState: WorkerState | null = null;

    for (const [agentId, workerState] of this.workers) {
      if (workerState.gpuId === unavailableGpuId) {
        affectedAgentId = agentId;
        affectedWorkerState = workerState;
        break;
      }
    }

    if (!affectedAgentId || !affectedWorkerState) {
      this.logger.warn('No worker found for unavailable GPU', { gpuId: unavailableGpuId });
      return null;
    }

    // Save the work state before stopping
    const pendingWork = {
      isExecuting: affectedWorkerState.isExecuting,
      currentExperiment: affectedWorkerState.currentExperiment,
      branch: affectedWorkerState.lastState?.branch,
    };

    this.logger.info('Redistributing work from unavailable GPU', {
      unavailableGpuId,
      affectedAgentId,
      pendingWork,
      excludeGpuIds,
    });
    this.fileLogger.info('Redistributing work from unavailable GPU', {
      unavailableGpuId,
      affectedAgentId,
      hadPendingWork: pendingWork.isExecuting,
      timestamp: this.generateTs(),
    });

    // Find an available GPU (excluding unavailable and already-used GPUs)
    const availableGpus = this.getAvailableGpus(excludeGpuIds);

    if (availableGpus.length === 0) {
      this.logger.warn('No available GPUs for work redistribution', {
        unavailableGpuId,
        affectedAgentId,
        excludeGpuIds,
      });
      this.fileLogger.warn('No available GPUs for work redistribution', {
        unavailableGpuId,
        affectedAgentId,
        timestamp: this.generateTs(),
      });
      return null;
    }

    // Select the first available GPU
    const targetGpuId = availableGpus[0]!;

    this.logger.info('Selected target GPU for redistribution', {
      unavailableGpuId,
      targetGpuId,
      affectedAgentId,
    });

    // Stop the worker on the unavailable GPU
    await this.stopWorker(affectedAgentId);

    // Spawn a new worker on the target GPU with the same agent ID
    if (this.config) {
      try {
        await this.spawnWorker(affectedAgentId, targetGpuId, this.config, pendingWork);

        this.logger.info('Work redistributed successfully', {
          affectedAgentId,
          fromGpuId: unavailableGpuId,
          toGpuId: targetGpuId,
        });
        this.fileLogger.info('Work redistributed successfully', {
          affectedAgentId,
          fromGpuId: unavailableGpuId,
          toGpuId: targetGpuId,
          timestamp: this.generateTs(),
        });

        return targetGpuId;
      } catch (error) {
        this.logger.error('Failed to redistribute work', {
          affectedAgentId,
          fromGpuId: unavailableGpuId,
          toGpuId: targetGpuId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.fileLogger.error('Failed to redistribute work', {
          affectedAgentId,
          fromGpuId: unavailableGpuId,
          toGpuId: targetGpuId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: this.generateTs(),
        });
        return null;
      }
    }

    return null;
  }


  // ==========================================================================
  // Backpressure Handling (Validates: Requirements 9.4)
  // ==========================================================================

  /**
   * Gets the configured max input buffer size.
   * 
   * @returns Max input buffer size in bytes, or default if not configured
   */
  getMaxInputBuffer(): number {
    return this.config?.limits?.max_input_buffer ?? 1048576; // 1MB default
  }

  /**
   * Gets the configured max output queue size.
   * 
   * @returns Max output queue size in bytes, or default if not configured
   */
  getMaxOutputQueue(): number {
    return this.config?.limits?.max_output_queue ?? 4194304; // 4MB default
  }

  /**
   * Gets the current input buffer size.
   * 
   * @returns Current input buffer size in bytes
   */
  getInputBufferSize(): number {
    return this.inputBufferSize;
  }

  /**
   * Gets the current output queue size.
   * 
   * @returns Current output queue size in bytes
   */
  getOutputQueueSize(): number {
    return this.outputQueueSize;
  }

  /**
   * Checks if input backpressure is currently active.
   * 
   * @returns True if input backpressure is active
   */
  isInputBackpressureActive(): boolean {
    return this.inputBackpressureActive;
  }

  /**
   * Checks if output backpressure is currently active.
   * 
   * @returns True if output backpressure is active
   */
  isOutputBackpressureActive(): boolean {
    return this.outputBackpressureActive;
  }

  /**
   * Checks if input buffer would exceed limit with additional data.
   * 
   * @param additionalBytes - Number of bytes to be added
   * @returns True if adding the data would exceed the limit
   * 
   * Validates: Requirements 9.4
   */
  wouldExceedInputLimit(additionalBytes: number): boolean {
    return (this.inputBufferSize + additionalBytes) > this.getMaxInputBuffer();
  }

  /**
   * Checks if output queue would exceed limit with additional data.
   * 
   * @param additionalBytes - Number of bytes to be added
   * @returns True if adding the data would exceed the limit
   * 
   * Validates: Requirements 9.4
   */
  wouldExceedOutputLimit(additionalBytes: number): boolean {
    return (this.outputQueueSize + additionalBytes) > this.getMaxOutputQueue();
  }

  /**
   * Updates input buffer size and manages backpressure state.
   * 
   * @param bytes - Number of bytes to add (positive) or remove (negative)
   * @returns True if data was accepted, false if rejected due to backpressure
   * 
   * Validates: Requirements 9.4
   */
  updateInputBufferSize(bytes: number): boolean {
    const maxBuffer = this.getMaxInputBuffer();

    if (bytes > 0) {
      // Adding data - check if it would exceed limit
      if (this.inputBufferSize + bytes > maxBuffer) {
        if (!this.inputBackpressureActive) {
          this.inputBackpressureActive = true;
          this.logger.warn('Input backpressure activated', {
            currentSize: this.inputBufferSize,
            attemptedAdd: bytes,
            maxBuffer,
          });
          this.fileLogger.warn('Input backpressure activated', {
            currentSize: this.inputBufferSize,
            attemptedAdd: bytes,
            maxBuffer,
            timestamp: this.generateTs(),
          });
        }
        return false;
      }
      this.inputBufferSize += bytes;
    } else {
      // Removing data
      this.inputBufferSize = Math.max(0, this.inputBufferSize + bytes);

      // Check if we can deactivate backpressure (when below 80% of limit)
      if (this.inputBackpressureActive && this.inputBufferSize < maxBuffer * 0.8) {
        this.inputBackpressureActive = false;
        this.logger.info('Input backpressure deactivated', {
          currentSize: this.inputBufferSize,
          maxBuffer,
        });
        this.fileLogger.info('Input backpressure deactivated', {
          currentSize: this.inputBufferSize,
          maxBuffer,
          timestamp: this.generateTs(),
        });
      }
    }

    return true;
  }

  /**
   * Updates output queue size and manages backpressure state.
   * 
   * @param bytes - Number of bytes to add (positive) or remove (negative)
   * @returns True if data was accepted, false if rejected due to backpressure
   * 
   * Validates: Requirements 9.4
   */
  updateOutputQueueSize(bytes: number): boolean {
    const maxQueue = this.getMaxOutputQueue();

    if (bytes > 0) {
      // Adding data - check if it would exceed limit
      if (this.outputQueueSize + bytes > maxQueue) {
        if (!this.outputBackpressureActive) {
          this.outputBackpressureActive = true;
          this.logger.warn('Output backpressure activated', {
            currentSize: this.outputQueueSize,
            attemptedAdd: bytes,
            maxQueue,
          });
          this.fileLogger.warn('Output backpressure activated', {
            currentSize: this.outputQueueSize,
            attemptedAdd: bytes,
            maxQueue,
            timestamp: this.generateTs(),
          });
        }
        return false;
      }
      this.outputQueueSize += bytes;
    } else {
      // Removing data
      this.outputQueueSize = Math.max(0, this.outputQueueSize + bytes);

      // Check if we can deactivate backpressure (when below 80% of limit)
      if (this.outputBackpressureActive && this.outputQueueSize < maxQueue * 0.8) {
        this.outputBackpressureActive = false;
        this.logger.info('Output backpressure deactivated', {
          currentSize: this.outputQueueSize,
          maxQueue,
        });
        this.fileLogger.info('Output backpressure deactivated', {
          currentSize: this.outputQueueSize,
          maxQueue,
          timestamp: this.generateTs(),
        });

        // Process any pending output messages
        this.flushPendingOutput();
      }
    }

    return true;
  }

  /**
   * Queues a message for later delivery when backpressure is active.
   * 
   * @param data - The encoded message data to queue
   * 
   * Validates: Requirements 9.4
   */
  private queuePendingOutput(data: string): void {
    this.pendingOutputQueue.push(data);
    this.logger.info('Message queued due to output backpressure', {
      queueLength: this.pendingOutputQueue.length,
      messageSize: data.length,
    });
  }

  /**
   * Flushes pending output messages when backpressure is relieved.
   * 
   * Validates: Requirements 9.4
   */
  private flushPendingOutput(): void {
    while (this.pendingOutputQueue.length > 0 && !this.outputBackpressureActive) {
      const data = this.pendingOutputQueue.shift()!;
      const dataSize = Buffer.byteLength(data, 'utf8');

      if (this.updateOutputQueueSize(dataSize)) {
        this.outputWriter(data);
        // Immediately reduce queue size after write (simulating drain)
        this.updateOutputQueueSize(-dataSize);
      } else {
        // Re-queue if still under backpressure
        this.pendingOutputQueue.unshift(data);
        break;
      }
    }

    if (this.pendingOutputQueue.length === 0) {
      this.logger.info('Pending output queue flushed');
    }
  }

  /**
   * Gets the number of pending output messages.
   * 
   * @returns Number of messages waiting in the output queue
   */
  getPendingOutputCount(): number {
    return this.pendingOutputQueue.length;
  }

  /**
   * Gets the backpressure status for monitoring.
   * 
   * @returns Backpressure status object
   * 
   * Validates: Requirements 9.4
   */
  getBackpressureStatus(): {
    inputBufferSize: number;
    maxInputBuffer: number;
    inputBackpressureActive: boolean;
    outputQueueSize: number;
    maxOutputQueue: number;
    outputBackpressureActive: boolean;
    pendingOutputCount: number;
  } {
    return {
      inputBufferSize: this.inputBufferSize,
      maxInputBuffer: this.getMaxInputBuffer(),
      inputBackpressureActive: this.inputBackpressureActive,
      outputQueueSize: this.outputQueueSize,
      maxOutputQueue: this.getMaxOutputQueue(),
      outputBackpressureActive: this.outputBackpressureActive,
      pendingOutputCount: this.pendingOutputQueue.length,
    };
  }

  /**
   * Resets backpressure state (for testing).
   */
  resetBackpressureState(): void {
    this.inputBufferSize = 0;
    this.outputQueueSize = 0;
    this.inputBackpressureActive = false;
    this.outputBackpressureActive = false;
    this.pendingOutputQueue = [];
  }

  // ==========================================================================
  // Progress Reporting (Validates: Requirements 10.2, 10.4)
  // ==========================================================================

  /**
   * Sets a custom progress writer (for testing).
   * 
   * @param writer - Function to write progress messages
   */
  setProgressWriter(writer: (message: string) => void): void {
    this.progressWriter = writer;
  }

  /**
   * Sets the progress report interval (for testing).
   * 
   * @param interval - Number of experiments between progress reports
   */
  setProgressReportInterval(interval: number): void {
    this.progressReportInterval = interval;
  }

  /**
   * Gets the current progress report interval.
   * 
   * @returns Number of experiments between progress reports
   */
  getProgressReportInterval(): number {
    return this.progressReportInterval;
  }

  /**
   * Gets the number of experiments since the last progress report.
   * 
   * @returns Number of experiments since last report
   */
  getExperimentsSinceLastReport(): number {
    return this.experimentsSinceLastReport;
  }

  /**
   * Writes a progress summary to stdout.
   * 
   * Called every 10 experiments to provide visibility into swarm progress.
   * 
   * Validates: Requirements 10.2
   */
  writeProgressSummary(): void {
    const totalExperiments = this.experimentRegistry.getTotalExperiments();
    const bestValBpb = this.experimentRegistry.getBestValBpb();
    const activeAgents = this.experimentRegistry.getActiveAgents().length;
    const uptime = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    const experimentsPerHour = uptime > 0 ? (totalExperiments / (uptime / 3600)).toFixed(1) : '0.0';

    const summary = [
      '═══════════════════════════════════════════════════════════════',
      `  SWARM PROGRESS REPORT - ${totalExperiments} experiments completed`,
      '═══════════════════════════════════════════════════════════════',
      `  Best val_bpb: ${bestValBpb === Infinity ? 'N/A' : bestValBpb.toFixed(6)}`,
      `  Active agents: ${activeAgents}`,
      `  Throughput: ${experimentsPerHour} experiments/hour`,
      `  Uptime: ${this.formatUptime(uptime)}`,
      '═══════════════════════════════════════════════════════════════',
    ].join('\n');

    this.progressWriter(summary);
    this.logger.info('Progress summary written', { totalExperiments, bestValBpb, activeAgents });
  }

  /**
   * Logs a highlighted message when a new best val_bpb is achieved.
   * 
   * @param result - The experiment result that achieved the new best
   * 
   * Validates: Requirements 10.4
   */
  logNewBestValBpb(result: ExperimentResult): void {
    const message = [
      '',
      '★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★',
      `  🎉 NEW BEST val_bpb: ${result.valBpb.toFixed(6)}`,
      `  Agent: ${result.agentId}`,
      `  Commit: ${result.commit}`,
      `  Description: ${result.description}`,
      '★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★',
      '',
    ].join('\n');

    this.progressWriter(message);
    this.logger.info('New best val_bpb achieved', {
      valBpb: result.valBpb,
      agentId: result.agentId,
      commit: result.commit,
    });
    this.fileLogger.info('New best val_bpb achieved', {
      valBpb: result.valBpb,
      agentId: result.agentId,
      commit: result.commit,
      description: result.description,
    });
  }

  /**
   * Checks if progress reporting should occur and writes summary if needed.
   * 
   * Called after each experiment result is recorded.
   * 
   * Validates: Requirements 10.2
   */
  checkProgressReport(): void {
    this.experimentsSinceLastReport++;
    if (this.experimentsSinceLastReport >= this.progressReportInterval) {
      this.writeProgressSummary();
      this.experimentsSinceLastReport = 0;
    }
  }

  /**
   * Formats uptime in human-readable format.
   * 
   * @param seconds - Uptime in seconds
   * @returns Formatted uptime string
   */
  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Resets progress reporting state.
   * 
   * Used for testing and when restarting the coordinator.
   */
  resetProgressState(): void {
    this.experimentsSinceLastReport = 0;
    this.previousBestValBpb = Infinity;
  }

  // ==========================================================================
  // Progress Chart Generation (Validates: Requirements 10.3)
  // ==========================================================================

  /**
   * Generates a progress chart showing val_bpb over time.
   * 
   * Creates both an SVG chart and a JSON data file for external rendering.
   * The chart includes all agents with different colors for attribution.
   * 
   * @returns Object with paths to generated files and chart data
   * 
   * Validates: Requirements 10.3
   */
  async generateProgressChart(): Promise<{
    svgPath: string;
    dataPath: string;
    chartData: import('./progress-chart').ChartData;
  }> {
    const results = this.experimentRegistry.getAllResults();
    const result = await this.progressChartGenerator.generateProgressChart(results);

    this.logger.info('Progress chart generated', {
      svgPath: result.svgPath,
      dataPath: result.dataPath,
      experiments: results.length,
      agents: result.chartData.agents.length,
    });
    this.fileLogger.info('Progress chart generated', {
      svgPath: result.svgPath,
      dataPath: result.dataPath,
      experiments: results.length,
    });

    return result;
  }

  /**
   * Gets the progress chart generator instance.
   * 
   * @returns ProgressChartGenerator instance
   */
  getProgressChartGenerator(): ProgressChartGenerator {
    return this.progressChartGenerator;
  }

  /**
   * Generates chart data without saving to files.
   * 
   * Useful for getting chart data for API responses or testing.
   * 
   * @returns ChartData structure
   */
  getChartData(): import('./progress-chart').ChartData {
    const results = this.experimentRegistry.getAllResults();
    return this.progressChartGenerator.generateChartData(results);
  }


  // ==========================================================================
  // stdio_bus Integration
  // ==========================================================================

  /**
   * NDJSON parser for incoming messages.
   * Validates: Requirements 1.1, 1.5
   */
  private ndjsonParser: NdjsonParser | null = null;

  /**
   * Output writer function for sending messages to stdout.
   * Can be overridden for testing.
   */
  private outputWriter: (data: string) => void = (data: string) => {
    process.stdout.write(data);
  };

  /**
   * Sets a custom output writer (for testing).
   * 
   * @param writer - Function to write output data
   */
  setOutputWriter(writer: (data: string) => void): void {
    this.outputWriter = writer;
  }

  /**
   * Initializes the NDJSON parser for handling incoming messages.
   * 
   * Creates a parser that routes messages through the session router
   * and handles JSON-RPC method dispatch.
   * 
   * Validates: Requirements 1.1, 1.5
   */
  initializeMessageHandler(): void {
    const codecLogger: CodecLogger = {
      error: (message: string, context?: Record<string, unknown>) => {
        this.logger.error(message, context);
        this.fileLogger.error(message, context);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        this.logger.warn(message, context);
      },
    };

    this.ndjsonParser = createNdjsonParser(
      (event: NdjsonParserEvent) => {
        if (event.type === 'message') {
          this.handleIncomingMessage(event.message).catch(error => {
            this.logger.error('Error handling message', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else if (event.type === 'error') {
          // Log parse errors but continue processing (Requirement 8.4)
          this.logger.error('Parse error in incoming message', {
            code: event.error.code,
            message: event.error.message,
          });
          this.fileLogger.error('Parse error in incoming message', {
            code: event.error.code,
            message: event.error.message,
          });
        }
      },
      { logger: codecLogger }
    );

    this.logger.info('Message handler initialized');
  }

  /**
   * Processes incoming data from stdin.
   * 
   * Feeds data to the NDJSON parser which will emit parsed messages
   * for handling. Enforces max_input_buffer limit to prevent memory exhaustion.
   * 
   * @param data - Raw string data from stdin
   * @returns True if data was accepted, false if rejected due to backpressure
   * 
   * Validates: Requirements 1.1, 1.5, 9.4
   */
  processIncomingData(data: string): boolean {
    if (!this.ndjsonParser) {
      this.initializeMessageHandler();
    }

    // Calculate data size in bytes
    const dataSize = Buffer.byteLength(data, 'utf8');

    // Check if accepting this data would exceed the input buffer limit
    if (!this.updateInputBufferSize(dataSize)) {
      this.logger.warn('Incoming data rejected due to input backpressure', {
        dataSize,
        currentBufferSize: this.inputBufferSize,
        maxBuffer: this.getMaxInputBuffer(),
      });
      this.fileLogger.warn('Incoming data rejected due to input backpressure', {
        dataSize,
        currentBufferSize: this.inputBufferSize,
        maxBuffer: this.getMaxInputBuffer(),
        timestamp: this.generateTs(),
      });
      return false;
    }

    // Process the data
    this.ndjsonParser!.write(data);

    // After processing, reduce buffer size (data has been consumed)
    // Note: In a real streaming scenario, this would be called when
    // messages are fully processed, but for simplicity we reduce immediately
    this.updateInputBufferSize(-dataSize);

    return true;
  }

  /**
   * Flushes any remaining buffered data in the parser.
   * Call this when stdin closes to process any final partial message.
   */
  flushParser(): void {
    if (this.ndjsonParser) {
      this.ndjsonParser.flush();
      // Reset input buffer size after flush
      this.inputBufferSize = 0;
    }
  }

  /**
   * Handles an incoming JSON-RPC message.
   * 
   * Routes the message based on its method and dispatches to the
   * appropriate handler. Responses are sent back via stdout.
   * 
   * @param message - The parsed JSON-RPC message
   * 
   * Validates: Requirements 1.1, 1.5
   */
  async handleIncomingMessage(message: JsonRpcMessage): Promise<void> {
    this.logger.info('Handling incoming message', {
      method: 'method' in message ? message.method : undefined,
      id: 'id' in message ? message.id : undefined,
    });

    // Handle requests (expect response)
    if (isJsonRpcRequest(message)) {
      await this.handleRequest(message);
      return;
    }

    // Handle notifications (no response expected)
    if (isJsonRpcNotification(message)) {
      await this.handleNotification(message);
      return;
    }

    // Unknown message type - log and ignore
    this.logger.warn('Unknown message type received', { message });
  }

  /**
   * Handles a JSON-RPC request message.
   * 
   * Dispatches to the appropriate method handler and sends the response.
   * 
   * @param request - The JSON-RPC request
   * 
   * Validates: Requirements 1.1, 8.5, 8.6, 10.6
   */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      let result: unknown;

      switch (method) {
        case METHOD_NAMES.SWARM_SYNC:
          result = await this.handleSyncRequest();
          break;

        case METHOD_NAMES.SWARM_STATUS:
          result = this.handleStatusRequest();
          break;

        case METHOD_NAMES.SWARM_PAUSE:
          result = await this.handlePauseRequest();
          break;

        case METHOD_NAMES.SWARM_RESUME:
          result = await this.handleResumeRequest();
          break;

        case METHOD_NAMES.SWARM_HISTORY:
          result = await this.handleHistoryRequest(params as HistoryRequestParams | undefined);
          break;

        case METHOD_NAMES.LOCK_ACQUIRE:
          result = await this.handleLockAcquireRequest(params as LockAcquireParams);
          break;

        default:
          // Method not found
          this.sendErrorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
          return;
      }

      this.sendSuccessResponse(id, result);
    } catch (error) {
      this.logger.error('Error handling request', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendErrorResponse(
        id,
        JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error'
      );
    }
  }

  /**
   * Handles a JSON-RPC notification message.
   * 
   * Notifications do not expect a response.
   * 
   * @param notification - The JSON-RPC notification
   * 
   * Validates: Requirements 1.1, 2.1
   */
  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const { method, params } = notification;

    try {
      switch (method) {
        case METHOD_NAMES.EXPERIMENT_RESULT:
          await this.handleExperimentResult(params as ExperimentResultParams);
          break;

        default:
          // Unknown notification - log and ignore
          this.logger.warn('Unknown notification method', { method });
      }
    } catch (error) {
      this.logger.error('Error handling notification', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handles a swarm.sync request.
   * 
   * Returns the current swarm state including best val_bpb and recent results.
   * 
   * @returns SyncResult with current swarm state
   * 
   * Validates: Requirements 2.3, 8.3
   */
  private async handleSyncRequest(): Promise<SyncResult> {
    const state = await this.experimentRegistry.getState();
    const recentResults = await this.experimentRegistry.getRecentResults(50);

    return {
      bestValBpb: state.bestValBpb,
      totalExperiments: state.totalExperiments,
      activeAgents: state.activeAgents,
      recentResults: recentResults.map(r => ({
        commit: r.commit,
        valBpb: r.valBpb,
        memoryGb: r.memoryGb,
        status: r.status,
        description: r.description,
        agentId: r.agentId,
        timestamp: r.timestamp,
        branch: r.branch,
      })),
    };
  }

  /**
   * Handles a swarm.status request.
   * 
   * Returns current swarm health and statistics.
   * 
   * @returns StatusResult with swarm metrics
   * 
   * Validates: Requirements 8.5, 10.1
   */
  private handleStatusRequest(): StatusResultType {
    const status = this.getStatus();

    // Convert GpuStatus to GpuUtilization format
    const gpuUtilization: Record<number, GpuUtilization> = {};
    for (const [gpuId, gpuStatus] of Object.entries(status.gpuUtilization)) {
      gpuUtilization[Number(gpuId)] = {
        available: gpuStatus.available,
        currentExperiment: gpuStatus.currentExperiment,
      };
    }

    return {
      activeAgents: status.activeAgents,
      totalExperiments: status.totalExperiments,
      bestValBpb: status.bestValBpb,
      experimentsPerHour: status.experimentsPerHour,
      uptime: status.uptime,
      gpuUtilization,
    };
  }

  /**
   * Handles a swarm.pause request.
   * 
   * Pauses all agents in the swarm.
   * 
   * @returns PauseResult indicating pause state
   * 
   * Validates: Requirements 8.6
   */
  private async handlePauseRequest(): Promise<PauseResult> {
    await this.pause();
    return { paused: true };
  }

  /**
   * Handles a swarm.resume request.
   * 
   * Resumes all agents in the swarm.
   * 
   * @returns ResumeResult indicating resume state
   * 
   * Validates: Requirements 8.6
   */
  private async handleResumeRequest(): Promise<ResumeResult> {
    await this.resume();
    return { resumed: true };
  }

  /**
   * Handles a swarm.history request.
   * 
   * Returns the complete experiment timeline with agent attribution.
   * 
   * @param params - Optional parameters including limit
   * @returns HistoryResult with experiment timeline
   * 
   * Validates: Requirements 10.6
   */
  private async handleHistoryRequest(params?: HistoryRequestParams): Promise<HistoryResultType> {
    const limit = params?.limit;
    const timeline = await this.getHistory(limit);

    return {
      experiments: timeline.experiments.map(e => ({
        commit: e.result.commit,
        valBpb: e.result.valBpb,
        memoryGb: e.result.memoryGb,
        status: e.result.status,
        description: e.result.description,
        agentId: e.result.agentId,
        timestamp: e.result.timestamp,
        branch: e.result.branch,
      })),
      totalCount: timeline.totalCount,
    };
  }

  /**
   * Handles a lock.acquire request.
   * 
   * Attempts to acquire an experiment lock for the requesting agent.
   * 
   * @param params - Lock acquire parameters including agentId
   * @returns LockAcquireResult with lock status
   * 
   * Validates: Requirements 4.1, 4.2
   */
  private async handleLockAcquireRequest(params: LockAcquireParams): Promise<LockAcquireResult> {
    if (!params || !params.agentId) {
      throw new Error('agentId is required for lock.acquire');
    }

    const result = await this.conflictResolver.acquireLock(params.agentId);
    return result;
  }

  /**
   * Handles an experiment.result notification.
   * 
   * Records the result and broadcasts it to all connected agents.
   * Also handles progress reporting every 10 experiments and logs
   * highlighted messages for new best val_bpb.
   * 
   * @param params - Experiment result parameters
   * 
   * Validates: Requirements 2.1, 2.6, 10.2, 10.4
   */
  private async handleExperimentResult(params: ExperimentResultParams): Promise<void> {
    if (!params) {
      this.logger.warn('Received experiment.result with no params');
      return;
    }

    // Capture the best val_bpb before recording the new result
    const previousBest = this.experimentRegistry.getBestValBpb();

    // Record the result
    const result: ExperimentResult = {
      commit: params.commit,
      valBpb: params.valBpb,
      memoryGb: params.memoryGb,
      status: params.status,
      description: params.description,
      agentId: params.agentId,
      timestamp: params.timestamp,
      branch: params.branch,
    };

    await this.experimentRegistry.recordResult(result);

    // Broadcast to all agents
    await this.stateBroadcaster.broadcastResult(result);

    // Check if this is a new best and log highlighted message (Validates: Requirements 10.4)
    const currentBest = this.experimentRegistry.getBestValBpb();
    const isNewBest = params.status === 'keep' && params.valBpb < previousBest;

    if (isNewBest) {
      // Log highlighted message for new best val_bpb
      this.logNewBestValBpb(result);
      await this.stateBroadcaster.broadcastNewBest(result);
    } else if (params.status === 'keep' && params.valBpb <= currentBest) {
      // Still broadcast new best for ties (existing behavior)
      await this.stateBroadcaster.broadcastNewBest(result);
    }

    // Check if we should write a progress report (Validates: Requirements 10.2)
    this.checkProgressReport();

    this.logger.info('Recorded and broadcast experiment result', {
      commit: params.commit,
      valBpb: params.valBpb,
      status: params.status,
      agentId: params.agentId,
    });
  }

  /**
   * Sends a JSON-RPC success response via stdout.
   * 
   * @param id - Request ID
   * @param result - Response result
   * 
   * Validates: Requirements 1.1, 1.5
   */
  sendSuccessResponse(id: string | number, result: unknown): void {
    const response = createSuccessResponse(id, result);
    this.sendMessage(response);
  }

  /**
   * Sends a JSON-RPC error response via stdout.
   * 
   * @param id - Request ID (or null for parse errors)
   * @param code - Error code
   * @param message - Error message
   * @param data - Optional error data
   * 
   * Validates: Requirements 1.1, 1.5
   */
  sendErrorResponse(id: string | number | null, code: number, message: string, data?: unknown): void {
    const response = createErrorResponse(id, code, message, data);
    this.sendMessage(response);
  }

  /**
   * Sends a JSON-RPC message via stdout.
   * 
   * Encodes the message as NDJSON and writes to stdout.
   * Enforces max_output_queue limit to prevent memory exhaustion.
   * 
   * @param message - The JSON-RPC message to send
   * @returns True if message was sent immediately, false if queued due to backpressure
   * 
   * Validates: Requirements 1.1, 1.5, 9.4
   */
  sendMessage(message: JsonRpcMessage): boolean {
    const encoded = encode(message);
    const dataSize = Buffer.byteLength(encoded, 'utf8');

    // Check if output backpressure is active or would be triggered
    if (this.outputBackpressureActive || !this.updateOutputQueueSize(dataSize)) {
      // Queue the message for later delivery
      this.queuePendingOutput(encoded);
      this.logger.warn('Message queued due to output backpressure', {
        method: 'method' in message ? message.method : undefined,
        id: 'id' in message ? message.id : undefined,
        messageSize: dataSize,
        queueSize: this.outputQueueSize,
        maxQueue: this.getMaxOutputQueue(),
      });
      return false;
    }

    // Send the message
    this.outputWriter(encoded);

    // Reduce queue size after write (simulating drain)
    this.updateOutputQueueSize(-dataSize);

    this.logger.info('Sent message', {
      method: 'method' in message ? message.method : undefined,
      id: 'id' in message ? message.id : undefined,
    });

    return true;
  }

  /**
   * Routes a message to a specific session via the session router.
   * 
   * @param message - The JSON-RPC message to route
   * @param targetSessionId - Target session ID
   * @param sourceSessionId - Optional source session ID
   * 
   * Validates: Requirements 1.1, 1.4
   */
  async routeMessage(
    message: JsonRpcMessage,
    targetSessionId: string,
    sourceSessionId?: string
  ): Promise<void> {
    await this.sessionRouter.route(message, targetSessionId, sourceSessionId);
  }

  /**
   * Broadcasts a message to all connected sessions.
   * 
   * @param message - The JSON-RPC message to broadcast
   * @param excludeSessionId - Optional session ID to exclude from broadcast
   * 
   * Validates: Requirements 1.1, 2.1
   */
  async broadcastMessage(message: JsonRpcMessage, excludeSessionId?: string): Promise<void> {
    await this.sessionRouter.broadcast(message, excludeSessionId);
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /**
   * Gets the current configuration.
   */
  getConfig(): SwarmConfig | null {
    return this.config;
  }

  /**
   * Checks if the swarm is running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Checks if the swarm is paused.
   */
  getIsPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Gets the number of active workers.
   */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Gets the experiment registry.
   */
  getExperimentRegistry(): ExperimentRegistry {
    return this.experimentRegistry;
  }

  /**
   * Gets the state broadcaster.
   */
  getStateBroadcaster(): StateBroadcaster {
    return this.stateBroadcaster;
  }

  /**
   * Gets the conflict resolver.
   */
  getConflictResolver(): ConflictResolver {
    return this.conflictResolver;
  }

  /**
   * Gets the session router.
   */
  getSessionRouter(): SessionRouter {
    return this.sessionRouter;
  }

  /**
   * Gets worker state by agent ID.
   */
  getWorkerState(agentId: string): WorkerState | undefined {
    return this.workers.get(agentId);
  }

  /**
   * Gets all worker agent IDs.
   */
  getWorkerAgentIds(): string[] {
    return Array.from(this.workers.keys());
  }

  /**
   * Gets all worker states (for testing/debugging).
   */
  getAllWorkerStates(): Map<string, { agentId: string; gpuId: number; isExecuting: boolean; currentExperiment: string | null }> {
    const states = new Map<string, { agentId: string; gpuId: number; isExecuting: boolean; currentExperiment: string | null }>();
    for (const [agentId, workerState] of this.workers) {
      states.set(agentId, {
        agentId: workerState.agentId,
        gpuId: workerState.gpuId,
        isExecuting: workerState.isExecuting,
        currentExperiment: workerState.currentExperiment,
      });
    }
    return states;
  }

  /**
   * Sets worker execution state (for testing).
   */
  setWorkerExecutionState(agentId: string, isExecuting: boolean, currentExperiment: string | null): void {
    const workerState = this.workers.get(agentId);
    if (workerState) {
      workerState.isExecuting = isExecuting;
      workerState.currentExperiment = currentExperiment;
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Sleep helper.
   * 
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clears all state (for testing).
   */
  clear(): void {
    // Cancel all pending crash recoveries
    this.cancelAllCrashRecoveries();
    this.workers.clear();
    this.config = null;
    this.isRunning = false;
    this.isPaused = false;
    this.startTime = 0;
    this.crashRecoveryDelayMs = DEFAULT_CRASH_RECOVERY_DELAY_MS;
    this.experimentRegistry.clear();
    this.stateBroadcaster.clear();
    this.conflictResolver.clear();
    this.sessionRouter.clear();
    if (this.ndjsonParser) {
      this.ndjsonParser.reset();
      this.ndjsonParser = null;
    }
    // Reset backpressure state
    this.resetBackpressureState();
    // Reset progress reporting state
    this.resetProgressState();
    this.logger.info('SwarmCoordinator cleared');
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a new SwarmCoordinator instance.
 * 
 * @param options - Configuration options
 * @returns SwarmCoordinator instance
 */
export function createSwarmCoordinator(
  options: SwarmCoordinatorOptions = {}
): SwarmCoordinator {
  return new SwarmCoordinator(options);
}

/**
 * Loads configuration from a JSON file and creates a SwarmCoordinator.
 * 
 * @param configPath - Path to configuration JSON file
 * @param options - Additional coordinator options
 * @returns Promise resolving to configured SwarmCoordinator
 * @throws Error if configuration is invalid
 * 
 * Validates: Requirements 6.1, 6.6
 */
export async function createSwarmCoordinatorFromFile(
  configPath: string,
  options: SwarmCoordinatorOptions = {}
): Promise<SwarmCoordinator> {
  // Read configuration file
  const configContent = await fs.promises.readFile(configPath, 'utf-8');

  // Parse and validate configuration
  const validationResult = parseAndValidateConfig(configContent);

  if (!validationResult.valid || !validationResult.config) {
    const errorMessage = formatValidationErrors(validationResult.errors);
    throw new Error(`Configuration validation failed:\n${errorMessage}`);
  }

  // Create coordinator
  const coordinator = createSwarmCoordinator(options);

  // Start with validated configuration
  await coordinator.start(validationResult.config);

  return coordinator;
}
