/**
 * GpuWorker - Worker process bound to a specific GPU that executes training experiments.
 * 
 * Responsibilities:
 * - Set CUDA_VISIBLE_DEVICES environment variable
 * - Execute `uv run train.py > run.log 2>&1`
 * - Parse experiment output (val_bpb, peak_vram_mb)
 * - Enforce 10-minute timeout
 * - Report crashes with stack traces
 * - Handle SIGTERM for graceful shutdown
 * 
 * Validates: Requirements 3.1, 3.3, 3.4, 3.6, 7.2, 7.3, 9.1, 9.5
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { ExperimentResult } from '../state/experiment-registry';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration options for GpuWorker.
 * 
 * Validates: Requirements 3.1, 3.3
 */
export interface GpuWorkerConfig {
  /** GPU ID to bind to (sets CUDA_VISIBLE_DEVICES) */
  gpuId: number;
  /** Agent ID this worker is associated with */
  agentId: string;
  /** Working directory for experiments */
  workDir: string;
  /** Experiment timeout in minutes. Defaults to 10. */
  timeoutMinutes?: number;
}

/**
 * Logger interface for GPU worker.
 */
export interface GpuWorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultGpuWorkerLogger: GpuWorkerLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.error(`[gpu-worker] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[gpu-worker] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[gpu-worker] ${message}`, context ?? '');
  },
};

/**
 * Command executor interface for running shell commands.
 * Allows injection of mock executor for testing.
 */
export interface CommandExecutor {
  exec(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>;
  spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess;
}

/**
 * Default command executor using child_process.
 */
export const defaultCommandExecutor: CommandExecutor = {
  async exec(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
    const result = await execAsync(command, options);
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
  spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
    return spawn(command, args, options);
  },
};

/**
 * GPU checker interface for verifying GPU availability.
 * Allows injection of mock checker for testing.
 */
export interface GpuChecker {
  checkAvailable(gpuId: number, workDir?: string): Promise<boolean>;
  getMemoryCapacity(gpuId: number): Promise<number>;
}

/**
 * Default GPU checker using nvidia-smi for CUDA or Python check for MPS.
 */
export const defaultGpuChecker: GpuChecker = {
  async checkAvailable(gpuId: number, workDir?: string): Promise<boolean> {
    const deviceBackend = process.env.DEVICE_BACKEND?.toLowerCase() ?? 'cuda';

    if (deviceBackend === 'mps') {
      // For MPS (Apple Silicon), check if MPS is available via Python
      // MPS only has one "GPU" (the unified memory), so gpuId 0 is always valid
      if (gpuId !== 0) {
        return false;
      }
      try {
        // Build list of python paths to try, prioritizing workDir if provided
        const pythonPaths: string[] = [];

        if (workDir) {
          // Absolute path from workDir (most reliable)
          pythonPaths.push(path.join(workDir, '.venv', 'bin', 'python3'));
          pythonPaths.push(path.join(workDir, '.venv', 'bin', 'python'));
        }

        // Also try relative to cwd as fallback
        const cwd = process.cwd();
        pythonPaths.push(
          path.join(cwd, '.venv', 'bin', 'python3'),
          path.join(cwd, '..', '.venv', 'bin', 'python3'),
          path.join(cwd, '..', '..', '.venv', 'bin', 'python3'),
          'python3',
          'python'
        );

        for (const pythonPath of pythonPaths) {
          try {
            const { stdout } = await execAsync(`"${pythonPath}" -c "import torch; print(torch.backends.mps.is_available())"`);
            if (stdout.trim().toLowerCase() === 'true') {
              return true;
            }
          } catch {
            continue;
          }
        }
        return false;
      } catch {
        return false;
      }
    }

    // CUDA path - use nvidia-smi
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${gpuId} --query-gpu=name --format=csv,noheader`);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  },
  async getMemoryCapacity(gpuId: number): Promise<number> {
    const deviceBackend = process.env.DEVICE_BACKEND?.toLowerCase() ?? 'cuda';

    if (deviceBackend === 'mps') {
      // For MPS, get system memory as approximation (MPS uses unified memory)
      // Return a reasonable default for Apple Silicon
      try {
        const { stdout } = await execAsync('sysctl -n hw.memsize');
        const memoryBytes = parseInt(stdout.trim(), 10);
        // Return half of system memory as available for MPS (conservative estimate)
        return isNaN(memoryBytes) ? 16384 : Math.floor(memoryBytes / 1024 / 1024 / 2);
      } catch {
        return 16384; // Default 16GB for Apple Silicon
      }
    }

    // CUDA path - use nvidia-smi
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${gpuId} --query-gpu=memory.total --format=csv,noheader,nounits`);
      const memoryMb = parseInt(stdout.trim(), 10);
      return isNaN(memoryMb) ? 0 : memoryMb;
    } catch {
      return 0;
    }
  },
};

/**
 * Options for creating a GpuWorker instance.
 */
export interface GpuWorkerOptions {
  /** GPU worker configuration */
  config: GpuWorkerConfig;
  /** Logger for worker events. Defaults to console logger. */
  logger?: GpuWorkerLogger;
  /** Command executor for running shell commands. Defaults to child_process. */
  commandExecutor?: CommandExecutor;
  /** GPU checker for verifying GPU availability. Defaults to nvidia-smi. */
  gpuChecker?: GpuChecker;
  /** Custom timestamp generator. Defaults to ISO 8601 current time. */
  timestampGenerator?: () => string;
}

/**
 * Worker state enumeration.
 */
export type WorkerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * Parsed experiment output from run.log.
 */
export interface ParsedExperimentOutput {
  /** Validation bits per byte */
  valBpb: number;
  /** Peak VRAM usage in MB */
  peakVramMb: number;
  /** Whether the experiment crashed */
  crashed: boolean;
  /** Stack trace if crashed */
  stackTrace?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default experiment timeout in minutes */
export const DEFAULT_TIMEOUT_MINUTES = 10;

/** Experiment command to execute */
export const EXPERIMENT_COMMAND = 'uv run train.py > run.log 2>&1';

/** Run log filename */
export const RUN_LOG_FILENAME = 'run.log';

// ============================================================================
// GpuWorker Class
// ============================================================================

/**
 * GpuWorker manages experiment execution on a specific GPU.
 * 
 * Key features:
 * - Binds to a specific GPU via CUDA_VISIBLE_DEVICES
 * - Verifies GPU availability before starting
 * - Executes experiments with timeout enforcement
 * - Parses experiment output for val_bpb and memory usage
 * - Handles graceful shutdown on SIGTERM
 * 
 * Validates: Requirements 3.1, 3.3, 3.4, 3.6, 7.2, 7.3, 9.1, 9.5
 */
export class GpuWorker {
  /** GPU ID this worker is bound to */
  private gpuId: number;

  /** Agent ID this worker is associated with */
  private agentId: string;

  /** Working directory for experiments */
  private workDir: string;

  /** Experiment timeout in milliseconds */
  private timeoutMs: number;

  /** Current worker state */
  private state: WorkerState = 'idle';

  /** Current experiment process */
  private currentProcess: ChildProcess | null = null;

  /** Current experiment timeout timer */
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  /** Flag indicating if worker is currently executing an experiment */
  private isExecuting: boolean = false;

  /** Logger instance */
  private logger: GpuWorkerLogger;

  /** Command executor */
  private commandExecutor: CommandExecutor;

  /** GPU checker */
  private gpuChecker: GpuChecker;

  /** Timestamp generator */
  private generateTs: () => string;

  /** SIGTERM handler reference for cleanup */
  private sigtermHandler: (() => void) | null = null;

  /**
   * Creates a new GpuWorker instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: GpuWorkerOptions) {
    this.gpuId = options.config.gpuId;
    this.agentId = options.config.agentId;
    this.workDir = options.config.workDir;
    this.timeoutMs = (options.config.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60 * 1000;
    this.logger = options.logger ?? defaultGpuWorkerLogger;
    this.commandExecutor = options.commandExecutor ?? defaultCommandExecutor;
    this.gpuChecker = options.gpuChecker ?? defaultGpuChecker;
    this.generateTs = options.timestampGenerator ?? (() => new Date().toISOString());
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Starts the GPU worker.
   * 
   * Verifies GPU availability before starting. If the GPU is unavailable,
   * throws an error.
   * 
   * @param gpuId - GPU ID to bind to (overrides config if provided)
   * @param agentId - Agent ID (overrides config if provided)
   * @throws Error if GPU is unavailable
   * 
   * Validates: Requirements 3.1, 3.3
   */
  async start(gpuId?: number, agentId?: string): Promise<void> {
    // Update config if parameters provided
    if (gpuId !== undefined) {
      this.gpuId = gpuId;
    }
    if (agentId !== undefined) {
      this.agentId = agentId;
    }

    this.state = 'starting';
    this.logger.info('Starting GPU worker', {
      gpuId: this.gpuId,
      agentId: this.agentId,
      workDir: this.workDir,
    });

    // Verify GPU availability
    const gpuAvailable = await this.checkGpuAvailable();
    if (!gpuAvailable) {
      this.state = 'error';
      const error = new Error(`GPU ${this.gpuId} is not available`);
      this.logger.error('GPU unavailable', {
        gpuId: this.gpuId,
        error: error.message,
      });
      throw error;
    }

    // Set up SIGTERM handler for graceful shutdown
    this.setupSigtermHandler();

    this.state = 'running';
    this.logger.info('GPU worker started', {
      gpuId: this.gpuId,
      agentId: this.agentId,
    });
  }

  /**
   * Stops the GPU worker.
   * 
   * Kills any running experiment and cleans up resources.
   * 
   * Validates: Requirements 3.4, 9.1
   */
  async stop(): Promise<void> {
    this.state = 'stopping';
    this.logger.info('Stopping GPU worker', {
      gpuId: this.gpuId,
      agentId: this.agentId,
    });

    // Kill any running experiment
    if (this.isExecuting) {
      await this.killExperiment();
    }

    // Remove SIGTERM handler
    this.removeSigtermHandler();

    this.state = 'stopped';
    this.logger.info('GPU worker stopped', {
      gpuId: this.gpuId,
      agentId: this.agentId,
    });
  }

  // ==========================================================================
  // Experiment Execution
  // ==========================================================================

  /**
   * Runs an experiment on the assigned GPU.
   * 
   * Executes `uv run train.py > run.log 2>&1` with CUDA_VISIBLE_DEVICES set.
   * Enforces the configured timeout (default 10 minutes).
   * 
   * @param branch - Git branch the experiment is running on
   * @returns Promise resolving to ExperimentResult
   * 
   * Validates: Requirements 3.6, 7.2, 7.3, 9.5
   */
  async runExperiment(branch: string): Promise<ExperimentResult> {
    if (this.isExecuting) {
      throw new Error('Worker is already executing an experiment');
    }

    this.isExecuting = true;
    const startTime = Date.now();

    this.logger.info('Starting experiment', {
      gpuId: this.gpuId,
      agentId: this.agentId,
      branch,
      timeoutMs: this.timeoutMs,
    });

    try {
      // Execute the experiment
      const { exitCode, timedOut, output } = await this.executeExperiment();

      // Parse the output
      const parsed = await this.parseExperimentOutput();

      // Determine status
      let status: 'keep' | 'discard' | 'crash';
      if (timedOut || parsed.crashed || exitCode !== 0) {
        status = 'crash';
      } else if (parsed.valBpb > 0) {
        // Assume keep if we got a valid val_bpb
        // The actual keep/discard decision is made by the coordinator
        status = 'keep';
      } else {
        status = 'discard';
      }

      // Get commit hash from git
      const commit = await this.getCurrentCommit();

      // Build result
      const result: ExperimentResult = {
        commit,
        valBpb: status === 'crash' ? 0 : parsed.valBpb,
        memoryGb: parsed.peakVramMb / 1024,
        status,
        description: timedOut ? 'Experiment timed out' : (parsed.stackTrace ?? ''),
        agentId: this.agentId,
        timestamp: this.generateTs(),
        branch,
      };

      const elapsed = Date.now() - startTime;
      this.logger.info('Experiment completed', {
        gpuId: this.gpuId,
        agentId: this.agentId,
        commit,
        status,
        valBpb: result.valBpb,
        elapsedMs: elapsed,
        timedOut,
      });

      return result;
    } finally {
      this.isExecuting = false;
      this.clearTimeout();
    }
  }

  /**
   * Kills the currently running experiment.
   * 
   * Used for timeout enforcement or graceful shutdown.
   * 
   * Validates: Requirements 9.5
   */
  async killExperiment(): Promise<void> {
    if (!this.currentProcess) {
      this.logger.warn('No experiment to kill');
      return;
    }

    this.logger.info('Killing experiment', {
      gpuId: this.gpuId,
      agentId: this.agentId,
      pid: this.currentProcess.pid,
    });

    // Try graceful termination first
    this.currentProcess.kill('SIGTERM');

    // Wait a bit for graceful shutdown
    await this.sleep(1000);

    // Force kill if still running
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill('SIGKILL');
    }

    this.currentProcess = null;
    this.clearTimeout();
  }

  // ==========================================================================
  // Health Checks
  // ==========================================================================

  /**
   * Checks if the assigned GPU is available.
   * 
   * Uses nvidia-smi to verify GPU accessibility.
   * 
   * @returns Promise resolving to true if GPU is available
   * 
   * Validates: Requirements 3.3
   */
  async checkGpuAvailable(): Promise<boolean> {
    const available = await this.gpuChecker.checkAvailable(this.gpuId, this.workDir);
    this.logger.info('GPU availability check', {
      gpuId: this.gpuId,
      available,
      workDir: this.workDir,
    });
    return available;
  }

  /**
   * Gets the memory capacity of the assigned GPU.
   * 
   * @returns Promise resolving to memory capacity in MB
   * 
   * Validates: Requirements 3.5
   */
  async getMemoryCapacity(): Promise<number> {
    const memoryMb = await this.gpuChecker.getMemoryCapacity(this.gpuId);
    this.logger.info('GPU memory capacity', {
      gpuId: this.gpuId,
      memoryMb,
    });
    return memoryMb;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Executes the experiment command.
   * 
   * @returns Promise resolving to exit code, timeout flag, and output
   */
  private async executeExperiment(): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
    return new Promise((resolve) => {
      const deviceBackend = process.env.DEVICE_BACKEND?.toLowerCase() ?? 'cuda';

      // Build environment with device-specific settings
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DEVICE_BACKEND: deviceBackend,
      };

      // Set CUDA_VISIBLE_DEVICES only for CUDA backend
      if (deviceBackend === 'cuda') {
        env.CUDA_VISIBLE_DEVICES = String(this.gpuId);
      }

      this.logger.info('Executing experiment command', {
        command: EXPERIMENT_COMMAND,
        gpuId: this.gpuId,
        deviceBackend,
        cudaVisibleDevices: env.CUDA_VISIBLE_DEVICES,
        workDir: this.workDir,
      });

      // Spawn the process using shell to handle redirection
      this.currentProcess = this.commandExecutor.spawn('sh', ['-c', EXPERIMENT_COMMAND], {
        cwd: this.workDir,
        env,
      });

      let output = '';
      let timedOut = false;

      // Capture stdout (though it's redirected to file)
      this.currentProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      // Capture stderr
      this.currentProcess.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      // Set up timeout
      this.timeoutTimer = setTimeout(() => {
        timedOut = true;
        this.logger.warn('Experiment timeout reached', {
          gpuId: this.gpuId,
          agentId: this.agentId,
          timeoutMs: this.timeoutMs,
        });
        this.killExperiment();
      }, this.timeoutMs);

      // Handle process exit
      this.currentProcess.on('close', (code: number | null) => {
        this.clearTimeout();
        const exitCode = code ?? (timedOut ? -1 : 0);
        this.logger.info('Experiment process exited', {
          gpuId: this.gpuId,
          exitCode,
          timedOut,
        });
        resolve({ exitCode, timedOut, output });
      });

      // Handle process error
      this.currentProcess.on('error', (error: Error) => {
        this.clearTimeout();
        this.logger.error('Experiment process error', {
          gpuId: this.gpuId,
          error: error.message,
        });
        resolve({ exitCode: -1, timedOut: false, output: error.message });
      });
    });
  }

  /**
   * Parses the experiment output from run.log.
   * 
   * Extracts val_bpb and peak_vram_mb from the log file.
   * 
   * @returns Promise resolving to parsed output
   */
  private async parseExperimentOutput(): Promise<ParsedExperimentOutput> {
    const logPath = path.join(this.workDir, RUN_LOG_FILENAME);

    try {
      const content = await fs.promises.readFile(logPath, 'utf-8');
      return this.parseLogContent(content);
    } catch (error) {
      this.logger.warn('Failed to read run.log', {
        logPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valBpb: 0,
        peakVramMb: 0,
        crashed: true,
        stackTrace: `Failed to read run.log: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Parses log content to extract experiment metrics.
   * 
   * @param content - Log file content
   * @returns Parsed experiment output
   */
  private parseLogContent(content: string): ParsedExperimentOutput {
    let valBpb = 0;
    let peakVramMb = 0;
    let crashed = false;
    let stackTrace: string | undefined;

    // Look for val_bpb in various formats
    // Common patterns: "val_bpb: 0.997900", "val_bpb=0.997900", "val_bpb 0.997900"
    const valBpbMatch = content.match(/val_bpb[:\s=]+(\d+\.?\d*)/i);
    if (valBpbMatch && valBpbMatch[1]) {
      valBpb = parseFloat(valBpbMatch[1]);
    }

    // Look for peak VRAM in various formats
    // Common patterns: "peak_vram_mb: 44000", "peak_vram: 44000 MB", "VRAM: 44.0 GB"
    const vramMbMatch = content.match(/(?:peak_)?vram(?:_mb)?[:\s=]+(\d+\.?\d*)\s*(?:mb)?/i);
    if (vramMbMatch && vramMbMatch[1]) {
      peakVramMb = parseFloat(vramMbMatch[1]);
    }

    // Also check for GB format
    const vramGbMatch = content.match(/(?:peak_)?vram[:\s=]+(\d+\.?\d*)\s*gb/i);
    if (vramGbMatch && vramGbMatch[1]) {
      peakVramMb = parseFloat(vramGbMatch[1]) * 1024;
    }

    // Check for crash indicators
    const crashIndicators = [
      'Traceback',
      'Error:',
      'Exception:',
      'CUDA out of memory',
      'RuntimeError',
      'OOM',
      'killed',
      'Segmentation fault',
    ];

    for (const indicator of crashIndicators) {
      if (content.includes(indicator)) {
        crashed = true;
        // Extract stack trace (last 50 lines or from Traceback)
        const lines = content.split('\n');
        const tracebackIndex = lines.findIndex(line => line.includes('Traceback'));
        if (tracebackIndex !== -1) {
          stackTrace = lines.slice(tracebackIndex).join('\n');
        } else {
          stackTrace = lines.slice(-50).join('\n');
        }
        break;
      }
    }

    return {
      valBpb,
      peakVramMb,
      crashed,
      stackTrace,
    };
  }

  /**
   * Gets the current git commit hash.
   * 
   * @returns Promise resolving to 7-char commit hash
   */
  private async getCurrentCommit(): Promise<string> {
    try {
      const { stdout } = await this.commandExecutor.exec('git rev-parse --short=7 HEAD', {
        cwd: this.workDir,
      });
      return stdout.trim();
    } catch (error) {
      this.logger.warn('Failed to get current commit', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'unknown';
    }
  }

  /**
   * Sets up SIGTERM handler for graceful shutdown.
   */
  private setupSigtermHandler(): void {
    this.sigtermHandler = () => {
      this.logger.info('Received SIGTERM, initiating graceful shutdown');
      this.stop();
    };
    process.on('SIGTERM', this.sigtermHandler);
  }

  /**
   * Removes SIGTERM handler.
   */
  private removeSigtermHandler(): void {
    if (this.sigtermHandler) {
      process.removeListener('SIGTERM', this.sigtermHandler);
      this.sigtermHandler = null;
    }
  }

  /**
   * Clears the experiment timeout timer.
   */
  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Sleep helper.
   * 
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /**
   * Gets the GPU ID this worker is bound to.
   */
  getGpuId(): number {
    return this.gpuId;
  }

  /**
   * Gets the agent ID this worker is associated with.
   */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Gets the current worker state.
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Checks if the worker is currently executing an experiment.
   */
  isRunningExperiment(): boolean {
    return this.isExecuting;
  }

  /**
   * Gets the experiment command that will be executed.
   */
  getExperimentCommand(): string {
    return EXPERIMENT_COMMAND;
  }

  /**
   * Gets the CUDA_VISIBLE_DEVICES value that will be set.
   */
  getCudaVisibleDevices(): string {
    return String(this.gpuId);
  }

  /**
   * Gets the working directory.
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Gets the timeout in minutes.
   */
  getTimeoutMinutes(): number {
    return this.timeoutMs / 60 / 1000;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new GpuWorker instance.
 * 
 * @param options - Configuration options
 * @returns GpuWorker instance
 */
export function createGpuWorker(options: GpuWorkerOptions): GpuWorker {
  return new GpuWorker(options);
}

/**
 * Creates a GpuWorker with simplified config.
 * 
 * @param config - GPU worker configuration
 * @param logger - Optional logger
 * @returns GpuWorker instance
 */
export function createGpuWorkerFromConfig(
  config: GpuWorkerConfig,
  logger?: GpuWorkerLogger
): GpuWorker {
  return new GpuWorker({
    config,
    logger,
  });
}
