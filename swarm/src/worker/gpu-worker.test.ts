/**
 * Unit tests for GpuWorker class.
 * 
 * Tests the GPU worker implementation including:
 * - CUDA_VISIBLE_DEVICES environment variable setting
 * - GPU availability verification
 * - Worker lifecycle management
 * - Experiment execution and timeout handling
 * 
 * Validates: Requirements 3.1, 3.3, 3.4, 3.6, 9.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  GpuWorker,
  createGpuWorker,
  createGpuWorkerFromConfig,
  GpuWorkerConfig,
  GpuWorkerLogger,
  CommandExecutor,
  GpuChecker,
  DEFAULT_TIMEOUT_MINUTES,
  EXPERIMENT_COMMAND,
} from './gpu-worker';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a silent logger for tests.
 */
function createSilentLogger(): GpuWorkerLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Creates a mock GPU checker.
 */
function createMockGpuChecker(available: boolean = true, memoryMb: number = 48000): GpuChecker {
  return {
    checkAvailable: vi.fn().mockResolvedValue(available),
    getMemoryCapacity: vi.fn().mockResolvedValue(memoryMb),
  };
}

/**
 * Creates a mock child process.
 */
function createMockChildProcess(exitCode: number = 0, delay: number = 10): EventEmitter & { killed: boolean; kill: () => void; stdout: EventEmitter; stderr: EventEmitter } {
  const process = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => void; stdout: EventEmitter; stderr: EventEmitter };
  process.killed = false;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn(() => {
    process.killed = true;
    process.emit('close', exitCode);
  });

  // Auto-emit close after delay
  setTimeout(() => {
    if (!process.killed) {
      process.emit('close', exitCode);
    }
  }, delay);

  return process;
}

/**
 * Creates a mock command executor.
 */
function createMockCommandExecutor(
  execResult: { stdout: string; stderr: string } = { stdout: 'abc1234', stderr: '' },
  spawnProcess?: ReturnType<typeof createMockChildProcess>
): CommandExecutor {
  return {
    exec: vi.fn().mockResolvedValue(execResult),
    spawn: vi.fn().mockReturnValue(spawnProcess ?? createMockChildProcess()),
  };
}

/**
 * Creates a default test config.
 */
function createTestConfig(overrides: Partial<GpuWorkerConfig> = {}): GpuWorkerConfig {
  return {
    gpuId: 0,
    agentId: 'agent-0',
    workDir: '/tmp/test-workdir',
    timeoutMinutes: 10,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GpuWorker', () => {
  let logger: GpuWorkerLogger;
  let gpuChecker: GpuChecker;
  let commandExecutor: CommandExecutor;

  beforeEach(() => {
    logger = createSilentLogger();
    gpuChecker = createMockGpuChecker();
    commandExecutor = createMockCommandExecutor();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create worker with config', () => {
      const config = createTestConfig({ gpuId: 2, agentId: 'agent-2' });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getGpuId()).toBe(2);
      expect(worker.getAgentId()).toBe('agent-2');
      expect(worker.getState()).toBe('idle');
    });

    it('should use default timeout of 10 minutes', () => {
      const config = createTestConfig();
      delete config.timeoutMinutes;

      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getTimeoutMinutes()).toBe(DEFAULT_TIMEOUT_MINUTES);
    });

    it('should use custom timeout when provided', () => {
      const config = createTestConfig({ timeoutMinutes: 5 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getTimeoutMinutes()).toBe(5);
    });
  });

  describe('CUDA_VISIBLE_DEVICES', () => {
    /**
     * Validates: Requirement 3.1
     * THE Swarm_Coordinator SHALL assign each GPU_Worker to a specific GPU 
     * via CUDA_VISIBLE_DEVICES environment variable
     */
    it('should return correct CUDA_VISIBLE_DEVICES value', () => {
      const config = createTestConfig({ gpuId: 3 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getCudaVisibleDevices()).toBe('3');
    });

    it('should set CUDA_VISIBLE_DEVICES when executing experiment', async () => {
      const config = createTestConfig({ gpuId: 2 });
      const mockProcess = createMockChildProcess(0, 10);
      const executor = createMockCommandExecutor({ stdout: 'abc1234', stderr: '' }, mockProcess);

      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor: executor,
      });

      await worker.start();

      // Start experiment (will fail to read log but that's ok for this test)
      try {
        await worker.runExperiment('test-branch');
      } catch {
        // Expected - no actual log file
      }

      // Verify spawn was called with correct env
      expect(executor.spawn).toHaveBeenCalledWith(
        'sh',
        ['-c', EXPERIMENT_COMMAND],
        expect.objectContaining({
          env: expect.objectContaining({
            CUDA_VISIBLE_DEVICES: '2',
          }),
        })
      );
    });
  });

  describe('GPU availability', () => {
    /**
     * Validates: Requirement 3.3
     * THE GPU_Worker SHALL verify GPU availability before starting experiments 
     * and report an error if the assigned GPU is unavailable
     */
    it('should verify GPU availability on start', async () => {
      const config = createTestConfig({ gpuId: 1 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      await worker.start();

      expect(gpuChecker.checkAvailable).toHaveBeenCalledWith(1, '/tmp/test-workdir');
      expect(worker.getState()).toBe('running');
    });

    it('should throw error if GPU is unavailable', async () => {
      const unavailableChecker = createMockGpuChecker(false);
      const config = createTestConfig({ gpuId: 99 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker: unavailableChecker,
        commandExecutor,
      });

      await expect(worker.start()).rejects.toThrow('GPU 99 is not available');
      expect(worker.getState()).toBe('error');
    });

    it('should check GPU availability via checkGpuAvailable method', async () => {
      const config = createTestConfig({ gpuId: 0 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      const available = await worker.checkGpuAvailable();

      expect(available).toBe(true);
      expect(gpuChecker.checkAvailable).toHaveBeenCalledWith(0, '/tmp/test-workdir');
    });

    it('should get memory capacity', async () => {
      const config = createTestConfig({ gpuId: 0 });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      const memoryMb = await worker.getMemoryCapacity();

      expect(memoryMb).toBe(48000);
      expect(gpuChecker.getMemoryCapacity).toHaveBeenCalledWith(0);
    });
  });

  describe('lifecycle', () => {
    it('should transition through states correctly', async () => {
      const config = createTestConfig();
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getState()).toBe('idle');

      await worker.start();
      expect(worker.getState()).toBe('running');

      await worker.stop();
      expect(worker.getState()).toBe('stopped');
    });

    it('should allow overriding gpuId and agentId on start', async () => {
      const config = createTestConfig({ gpuId: 0, agentId: 'agent-0' });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      await worker.start(5, 'agent-5');

      expect(worker.getGpuId()).toBe(5);
      expect(worker.getAgentId()).toBe('agent-5');
      expect(gpuChecker.checkAvailable).toHaveBeenCalledWith(5, '/tmp/test-workdir');
    });
  });

  describe('experiment execution', () => {
    it('should return correct experiment command', () => {
      const config = createTestConfig();
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getExperimentCommand()).toBe(EXPERIMENT_COMMAND);
    });

    it('should track execution state', async () => {
      const config = createTestConfig();
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      await worker.start();
      expect(worker.isRunningExperiment()).toBe(false);
    });

    it('should prevent concurrent experiments', async () => {
      const config = createTestConfig();
      // Create a process that doesn't auto-close
      const slowProcess = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => void; stdout: EventEmitter; stderr: EventEmitter };
      slowProcess.killed = false;
      slowProcess.stdout = new EventEmitter();
      slowProcess.stderr = new EventEmitter();
      slowProcess.kill = vi.fn(() => {
        slowProcess.killed = true;
        slowProcess.emit('close', 0);
      });

      const executor = createMockCommandExecutor({ stdout: 'abc1234', stderr: '' }, slowProcess);

      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor: executor,
      });

      await worker.start();

      // Start first experiment (won't complete)
      const firstExperiment = worker.runExperiment('branch-1');

      // Try to start second experiment immediately
      await expect(worker.runExperiment('branch-2')).rejects.toThrow(
        'Worker is already executing an experiment'
      );

      // Clean up
      slowProcess.emit('close', 0);
      await firstExperiment.catch(() => { }); // Ignore errors
    });
  });

  describe('getters', () => {
    it('should return work directory', () => {
      const config = createTestConfig({ workDir: '/custom/path' });
      const worker = new GpuWorker({
        config,
        logger,
        gpuChecker,
        commandExecutor,
      });

      expect(worker.getWorkDir()).toBe('/custom/path');
    });
  });
});

describe('createGpuWorker factory', () => {
  it('should create worker with options', () => {
    const config = createTestConfig({ gpuId: 1, agentId: 'agent-1' });
    const worker = createGpuWorker({
      config,
      logger: createSilentLogger(),
      gpuChecker: createMockGpuChecker(),
      commandExecutor: createMockCommandExecutor(),
    });

    expect(worker).toBeInstanceOf(GpuWorker);
    expect(worker.getGpuId()).toBe(1);
    expect(worker.getAgentId()).toBe('agent-1');
  });
});

describe('createGpuWorkerFromConfig factory', () => {
  it('should create worker from config only', () => {
    const config = createTestConfig({ gpuId: 2, agentId: 'agent-2' });
    const worker = createGpuWorkerFromConfig(config);

    expect(worker).toBeInstanceOf(GpuWorker);
    expect(worker.getGpuId()).toBe(2);
    expect(worker.getAgentId()).toBe('agent-2');
  });

  it('should create worker with custom logger', () => {
    const config = createTestConfig();
    const logger = createSilentLogger();
    const worker = createGpuWorkerFromConfig(config, logger);

    expect(worker).toBeInstanceOf(GpuWorker);
  });
});

describe('log parsing', () => {
  it('should parse val_bpb from log content', async () => {
    const config = createTestConfig();
    const worker = new GpuWorker({
      config,
      logger: createSilentLogger(),
      gpuChecker: createMockGpuChecker(),
      commandExecutor: createMockCommandExecutor(),
    });

    // Access private method via any cast for testing
    const parsed = (worker as any).parseLogContent('val_bpb: 0.997900\npeak_vram_mb: 44000');

    expect(parsed.valBpb).toBeCloseTo(0.9979, 4);
    expect(parsed.peakVramMb).toBe(44000);
    expect(parsed.crashed).toBe(false);
  });

  it('should detect crash from Traceback', async () => {
    const config = createTestConfig();
    const worker = new GpuWorker({
      config,
      logger: createSilentLogger(),
      gpuChecker: createMockGpuChecker(),
      commandExecutor: createMockCommandExecutor(),
    });

    const logContent = `
Starting training...
Traceback (most recent call last):
  File "train.py", line 100, in <module>
    main()
RuntimeError: CUDA out of memory
`;

    const parsed = (worker as any).parseLogContent(logContent);

    expect(parsed.crashed).toBe(true);
    expect(parsed.stackTrace).toContain('Traceback');
    expect(parsed.stackTrace).toContain('RuntimeError');
  });

  it('should parse VRAM in GB format', async () => {
    const config = createTestConfig();
    const worker = new GpuWorker({
      config,
      logger: createSilentLogger(),
      gpuChecker: createMockGpuChecker(),
      commandExecutor: createMockCommandExecutor(),
    });

    const parsed = (worker as any).parseLogContent('val_bpb: 0.99\npeak_vram: 44.5 GB');

    expect(parsed.peakVramMb).toBeCloseTo(44.5 * 1024, 0);
  });
});
