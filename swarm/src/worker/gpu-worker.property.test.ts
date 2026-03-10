/**
 * Property-based tests for GPU assignment correctness.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 9: GPU Assignment Correctness
 * 
 * For any GPU_Worker started with GPU ID N, the worker shall set CUDA_VISIBLE_DEVICES=N
 * for all experiment executions.
 * 
 * **Validates: Requirements 3.1**
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  GpuWorker,
  createGpuWorker,
  GpuWorkerConfig,
  GpuWorkerLogger,
  CommandExecutor,
  GpuChecker,
} from './gpu-worker';
import { ChildProcess, EventEmitter } from 'events';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a silent logger for tests.
 */
function createSilentLogger(): GpuWorkerLogger {
  return {
    info: () => { },
    warn: () => { },
    error: () => { },
  };
}

/**
 * Creates a mock GPU checker that always reports GPU as available.
 */
function createMockGpuChecker(available: boolean = true, memoryMb: number = 24000): GpuChecker {
  return {
    async checkAvailable(_gpuId: number): Promise<boolean> {
      return available;
    },
    async getMemoryCapacity(_gpuId: number): Promise<number> {
      return memoryMb;
    },
  };
}

/**
 * Captured spawn call information.
 */
interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  cwd: string | undefined;
}

/**
 * Creates a mock command executor that captures spawn calls.
 */
function createMockCommandExecutor(spawnCalls: SpawnCall[]): CommandExecutor {
  return {
    async exec(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
      // Mock git rev-parse for commit hash
      if (command.includes('git rev-parse')) {
        return { stdout: 'abc1234\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
      // Capture the spawn call
      spawnCalls.push({
        command,
        args,
        env: options?.env,
        cwd: options?.cwd,
      });

      // Create a mock ChildProcess
      const mockProcess = new EventEmitter() as ChildProcess;
      mockProcess.stdout = new EventEmitter() as any;
      mockProcess.stderr = new EventEmitter() as any;
      mockProcess.pid = 12345;
      mockProcess.killed = false;
      mockProcess.kill = () => {
        mockProcess.killed = true;
        return true;
      };

      // Simulate immediate successful completion
      setImmediate(() => {
        mockProcess.emit('close', 0);
      });

      return mockProcess;
    },
  };
}

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid GPU ID (0-15, typical range for multi-GPU systems).
 */
const arbitraryGpuId = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 15 });

/**
 * Generates a valid agent ID (e.g., 'agent-0', 'agent-1').
 */
const arbitraryAgentId = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `agent-${n}`);

/**
 * Generates a valid working directory path.
 */
const arbitraryWorkDir = (): fc.Arbitrary<string> =>
  fc.constantFrom('/tmp/experiment', '/home/user/autoresearch', '/workspace/train');

/**
 * Generates a valid timeout in minutes (1-30).
 */
const arbitraryTimeoutMinutes = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max: 30 });

/**
 * Generates a valid GpuWorkerConfig.
 */
const arbitraryGpuWorkerConfig = (): fc.Arbitrary<GpuWorkerConfig> =>
  fc.record({
    gpuId: arbitraryGpuId(),
    agentId: arbitraryAgentId(),
    workDir: arbitraryWorkDir(),
    timeoutMinutes: arbitraryTimeoutMinutes(),
  });

/**
 * Generates a valid branch name.
 */
const arbitraryBranch = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `autoresearch/swarm/agent-${n}`);

/**
 * Generates a pair of different GPU IDs for testing GPU ID changes.
 */
const arbitraryGpuIdPair = (): fc.Arbitrary<{ initial: number; updated: number }> =>
  fc.record({
    initial: arbitraryGpuId(),
    updated: arbitraryGpuId(),
  }).filter(pair => pair.initial !== pair.updated);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 9: GPU Assignment Correctness', () => {
  // --------------------------------------------------------------------------
  // Property 9.1: CUDA_VISIBLE_DEVICES matches the assigned GPU ID
  // --------------------------------------------------------------------------
  describe('CUDA_VISIBLE_DEVICES matches the assigned GPU ID', () => {
    it('for any GPU ID N, getCudaVisibleDevices() should return string N', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const cudaVisibleDevices = worker.getCudaVisibleDevices();

          // CUDA_VISIBLE_DEVICES should be the string representation of the GPU ID
          expect(cudaVisibleDevices).toBe(String(config.gpuId));

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, getGpuId() should return N', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const gpuId = worker.getGpuId();

          // GPU ID should match the configured value
          expect(gpuId).toBe(config.gpuId);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, CUDA_VISIBLE_DEVICES should equal String(getGpuId())', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const cudaVisibleDevices = worker.getCudaVisibleDevices();
          const gpuId = worker.getGpuId();

          // CUDA_VISIBLE_DEVICES should be the string representation of GPU ID
          expect(cudaVisibleDevices).toBe(String(gpuId));

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 9.2: GPU ID is correctly set on worker start
  // --------------------------------------------------------------------------
  describe('GPU ID is correctly set on worker start', () => {
    it('for any GPU ID N, after start(N, agentId), getGpuId() should return N', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          async (gpuId, agentId, workDir) => {
            const worker = createGpuWorker({
              config: {
                gpuId: 0, // Initial value, will be overridden
                agentId: 'initial-agent',
                workDir,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
            });

            await worker.start(gpuId, agentId);

            // After start, GPU ID should be the one passed to start()
            expect(worker.getGpuId()).toBe(gpuId);
            expect(worker.getCudaVisibleDevices()).toBe(String(gpuId));

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any initial GPU ID and updated GPU ID, start() should update the GPU ID', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIdPair(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          async (gpuIds, agentId, workDir) => {
            const worker = createGpuWorker({
              config: {
                gpuId: gpuIds.initial,
                agentId,
                workDir,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
            });

            // Initially should have the initial GPU ID
            expect(worker.getGpuId()).toBe(gpuIds.initial);

            // Start with updated GPU ID
            await worker.start(gpuIds.updated, agentId);

            // After start, should have the updated GPU ID
            expect(worker.getGpuId()).toBe(gpuIds.updated);
            expect(worker.getCudaVisibleDevices()).toBe(String(gpuIds.updated));

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, start() without gpuId parameter should preserve the configured GPU ID', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryGpuWorkerConfig(), async (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          // Start without overriding GPU ID
          await worker.start();

          // GPU ID should remain as configured
          expect(worker.getGpuId()).toBe(config.gpuId);
          expect(worker.getCudaVisibleDevices()).toBe(String(config.gpuId));

          await worker.stop();

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 9.3: Environment variable is passed to spawned processes
  // --------------------------------------------------------------------------
  describe('environment variable is passed to spawned processes', () => {
    it('for any GPU ID N, runExperiment() should spawn process with CUDA_VISIBLE_DEVICES=N', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const spawnCalls: SpawnCall[] = [];
            const mockExecutor = createMockCommandExecutor(spawnCalls);

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: mockExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();
            await worker.runExperiment(branch);
            await worker.stop();

            // Verify spawn was called
            expect(spawnCalls.length).toBeGreaterThan(0);

            // Find the experiment spawn call (sh -c "uv run train.py...")
            const experimentCall = spawnCalls.find(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentCall).toBeDefined();

            // Verify CUDA_VISIBLE_DEVICES is set correctly
            expect(experimentCall!.env).toBeDefined();
            expect(experimentCall!.env!.CUDA_VISIBLE_DEVICES).toBe(String(config.gpuId));

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, the spawned process env should have CUDA_VISIBLE_DEVICES exactly equal to N (not N-1 or N+1)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          arbitraryBranch(),
          async (gpuId, agentId, workDir, branch) => {
            const spawnCalls: SpawnCall[] = [];
            const mockExecutor = createMockCommandExecutor(spawnCalls);

            const worker = createGpuWorker({
              config: { gpuId, agentId, workDir },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: mockExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();
            await worker.runExperiment(branch);
            await worker.stop();

            // Find the experiment spawn call
            const experimentCall = spawnCalls.find(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentCall).toBeDefined();

            // Verify CUDA_VISIBLE_DEVICES is exactly the GPU ID
            const cudaEnv = experimentCall!.env!.CUDA_VISIBLE_DEVICES;
            expect(cudaEnv).toBe(String(gpuId));
            expect(cudaEnv).not.toBe(String(gpuId - 1));
            expect(cudaEnv).not.toBe(String(gpuId + 1));

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any sequence of experiments on the same worker, all should use the same CUDA_VISIBLE_DEVICES', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          fc.array(arbitraryBranch(), { minLength: 2, maxLength: 5 }),
          async (config, branches) => {
            const spawnCalls: SpawnCall[] = [];
            const mockExecutor = createMockCommandExecutor(spawnCalls);

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: mockExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Run multiple experiments sequentially
            for (const branch of branches) {
              await worker.runExperiment(branch);
            }

            await worker.stop();

            // Find all experiment spawn calls
            const experimentCalls = spawnCalls.filter(
              call => call.command === 'sh' && call.args.includes('-c')
            );

            // Should have one spawn call per experiment
            expect(experimentCalls.length).toBe(branches.length);

            // All should have the same CUDA_VISIBLE_DEVICES
            for (const call of experimentCalls) {
              expect(call.env).toBeDefined();
              expect(call.env!.CUDA_VISIBLE_DEVICES).toBe(String(config.gpuId));
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 9.4: GPU ID consistency across worker lifecycle
  // --------------------------------------------------------------------------
  describe('GPU ID consistency across worker lifecycle', () => {
    it('for any GPU ID N, the GPU ID should remain consistent before and after start()', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryGpuWorkerConfig(), async (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          // Before start
          const gpuIdBefore = worker.getGpuId();
          const cudaBefore = worker.getCudaVisibleDevices();

          await worker.start();

          // After start
          const gpuIdAfter = worker.getGpuId();
          const cudaAfter = worker.getCudaVisibleDevices();

          // Should be consistent
          expect(gpuIdBefore).toBe(gpuIdAfter);
          expect(cudaBefore).toBe(cudaAfter);
          expect(gpuIdBefore).toBe(config.gpuId);

          await worker.stop();

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, the GPU ID should remain consistent after stop()', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryGpuWorkerConfig(), async (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          await worker.start();

          const gpuIdBeforeStop = worker.getGpuId();
          const cudaBeforeStop = worker.getCudaVisibleDevices();

          await worker.stop();

          const gpuIdAfterStop = worker.getGpuId();
          const cudaAfterStop = worker.getCudaVisibleDevices();

          // Should be consistent
          expect(gpuIdBeforeStop).toBe(gpuIdAfterStop);
          expect(cudaBeforeStop).toBe(cudaAfterStop);
          expect(gpuIdAfterStop).toBe(config.gpuId);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, the GPU ID should remain consistent after running experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const spawnCalls: SpawnCall[] = [];
            const mockExecutor = createMockCommandExecutor(spawnCalls);

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: mockExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            const gpuIdBeforeExperiment = worker.getGpuId();

            await worker.runExperiment(branch);

            const gpuIdAfterExperiment = worker.getGpuId();

            // Should be consistent
            expect(gpuIdBeforeExperiment).toBe(gpuIdAfterExperiment);
            expect(gpuIdAfterExperiment).toBe(config.gpuId);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 9.5: CUDA_VISIBLE_DEVICES is a valid string representation
  // --------------------------------------------------------------------------
  describe('CUDA_VISIBLE_DEVICES is a valid string representation', () => {
    it('for any GPU ID N, CUDA_VISIBLE_DEVICES should be a non-empty string', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const cudaVisibleDevices = worker.getCudaVisibleDevices();

          expect(typeof cudaVisibleDevices).toBe('string');
          expect(cudaVisibleDevices.length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, CUDA_VISIBLE_DEVICES should be parseable back to N', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const cudaVisibleDevices = worker.getCudaVisibleDevices();
          const parsedGpuId = parseInt(cudaVisibleDevices, 10);

          expect(parsedGpuId).toBe(config.gpuId);
          expect(isNaN(parsedGpuId)).toBe(false);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any GPU ID N, CUDA_VISIBLE_DEVICES should not have leading zeros (except for 0)', () => {
      fc.assert(
        fc.property(arbitraryGpuWorkerConfig(), (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          const cudaVisibleDevices = worker.getCudaVisibleDevices();

          // Should not have leading zeros (except for "0" itself)
          if (config.gpuId === 0) {
            expect(cudaVisibleDevices).toBe('0');
          } else {
            expect(cudaVisibleDevices[0]).not.toBe('0');
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});

// ============================================================================
// Property 10: Worker Exclusivity
// ============================================================================

describe('Property 10: Worker Exclusivity', () => {
  /**
   * **Validates: Requirements 3.6**
   * 
   * For any GPU_Worker currently executing an experiment, the Swarm_Coordinator
   * shall not assign additional experiments to that worker until the current
   * experiment completes or times out.
   */

  /**
   * Creates a mock command executor with delayed completion for testing concurrency.
   * The experiment will not complete until resolveExperiment() is called.
   */
  function createDelayedMockCommandExecutor(): {
    executor: CommandExecutor;
    resolveExperiment: () => void;
    spawnCalls: SpawnCall[];
  } {
    const spawnCalls: SpawnCall[] = [];
    let resolveCallback: (() => void) | null = null;

    const executor: CommandExecutor = {
      async exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
        if (command.includes('git rev-parse')) {
          return { stdout: 'abc1234\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
        spawnCalls.push({
          command,
          args,
          env: options?.env,
          cwd: options?.cwd,
        });

        const mockProcess = new EventEmitter() as ChildProcess;
        mockProcess.stdout = new EventEmitter() as any;
        mockProcess.stderr = new EventEmitter() as any;
        mockProcess.pid = 12345;
        mockProcess.killed = false;
        mockProcess.kill = () => {
          mockProcess.killed = true;
          // Emit close when killed
          setImmediate(() => mockProcess.emit('close', -1));
          return true;
        };

        // Store the resolve callback - experiment completes when resolveExperiment() is called
        resolveCallback = () => {
          mockProcess.emit('close', 0);
        };

        return mockProcess;
      },
    };

    return {
      executor,
      resolveExperiment: () => {
        if (resolveCallback) {
          resolveCallback();
          resolveCallback = null;
        }
      },
      spawnCalls,
    };
  }

  // --------------------------------------------------------------------------
  // Property 10.1: Worker rejects concurrent experiment requests
  // --------------------------------------------------------------------------
  describe('Worker rejects concurrent experiment requests', () => {
    it('for any worker executing an experiment, calling runExperiment() again should throw an error', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          arbitraryBranch(),
          async (config, branch1, branch2) => {
            const { executor, resolveExperiment } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start first experiment (will not complete until we resolve it)
            const firstExperimentPromise = worker.runExperiment(branch1);

            // Give the first experiment time to start
            await new Promise(resolve => setImmediate(resolve));

            // Try to start second experiment while first is running
            let errorThrown = false;
            let errorMessage = '';
            try {
              await worker.runExperiment(branch2);
            } catch (error) {
              errorThrown = true;
              errorMessage = error instanceof Error ? error.message : String(error);
            }

            // Should have thrown an error
            expect(errorThrown).toBe(true);
            expect(errorMessage).toContain('already executing');

            // Complete the first experiment
            resolveExperiment();
            await firstExperimentPromise;

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any N concurrent experiment requests, only the first should succeed and N-1 should fail', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          fc.array(arbitraryBranch(), { minLength: 2, maxLength: 5 }),
          async (config, branches) => {
            const { executor, resolveExperiment } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start first experiment
            const firstExperimentPromise = worker.runExperiment(branches[0]);

            // Give the first experiment time to start
            await new Promise(resolve => setImmediate(resolve));

            // Try to start remaining experiments concurrently
            const remainingBranches = branches.slice(1);
            const results = await Promise.allSettled(
              remainingBranches.map(branch => worker.runExperiment(branch))
            );

            // All remaining experiments should have been rejected
            const rejectedCount = results.filter(r => r.status === 'rejected').length;
            expect(rejectedCount).toBe(remainingBranches.length);

            // Complete the first experiment
            resolveExperiment();
            await firstExperimentPromise;

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 10.2: isRunningExperiment() returns true during execution
  // --------------------------------------------------------------------------
  describe('isRunningExperiment() returns true during execution', () => {
    it('for any worker, isRunningExperiment() should be false before starting an experiment', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryGpuWorkerConfig(), async (config) => {
          const worker = createGpuWorker({
            config,
            logger: createSilentLogger(),
            gpuChecker: createMockGpuChecker(),
          });

          // Before start
          expect(worker.isRunningExperiment()).toBe(false);

          await worker.start();

          // After start but before experiment
          expect(worker.isRunningExperiment()).toBe(false);

          await worker.stop();

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('for any worker executing an experiment, isRunningExperiment() should return true', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor, resolveExperiment } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Before experiment
            expect(worker.isRunningExperiment()).toBe(false);

            // Start experiment
            const experimentPromise = worker.runExperiment(branch);

            // Give the experiment time to start
            await new Promise(resolve => setImmediate(resolve));

            // During experiment
            expect(worker.isRunningExperiment()).toBe(true);

            // Complete the experiment
            resolveExperiment();
            await experimentPromise;

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any worker, isRunningExperiment() should return false after experiment completes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor, resolveExperiment } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start and complete experiment
            const experimentPromise = worker.runExperiment(branch);
            await new Promise(resolve => setImmediate(resolve));

            expect(worker.isRunningExperiment()).toBe(true);

            resolveExperiment();
            await experimentPromise;

            // After experiment completes
            expect(worker.isRunningExperiment()).toBe(false);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 10.3: Only one experiment can run at a time per worker
  // --------------------------------------------------------------------------
  describe('Only one experiment can run at a time per worker', () => {
    it('for any worker, the number of concurrent experiments should never exceed 1', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          fc.array(arbitraryBranch(), { minLength: 3, maxLength: 6 }),
          async (config, branches) => {
            const { executor, resolveExperiment, spawnCalls } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Try to start all experiments concurrently
            const experimentPromises = branches.map(async (branch, index) => {
              try {
                if (index === 0) {
                  // First experiment should succeed
                  const result = await worker.runExperiment(branch);
                  return { success: true, result };
                } else {
                  // Give first experiment time to start
                  await new Promise(resolve => setImmediate(resolve));
                  const result = await worker.runExperiment(branch);
                  return { success: true, result };
                }
              } catch (error) {
                return { success: false, error };
              }
            });

            // Resolve the first experiment after a short delay
            setTimeout(() => resolveExperiment(), 10);

            await Promise.allSettled(experimentPromises);

            // Only one experiment spawn should have occurred
            const experimentSpawns = spawnCalls.filter(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentSpawns.length).toBe(1);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 10.4: After experiment completes, new experiments can be started
  // --------------------------------------------------------------------------
  describe('After experiment completes, new experiments can be started', () => {
    it('for any sequence of experiments, each should be able to run after the previous completes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          fc.array(arbitraryBranch(), { minLength: 2, maxLength: 4 }),
          async (config, branches) => {
            const spawnCalls: SpawnCall[] = [];
            const mockExecutor = createMockCommandExecutor(spawnCalls);

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: mockExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Run experiments sequentially
            for (const branch of branches) {
              expect(worker.isRunningExperiment()).toBe(false);
              await worker.runExperiment(branch);
              expect(worker.isRunningExperiment()).toBe(false);
            }

            // All experiments should have been spawned
            const experimentSpawns = spawnCalls.filter(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentSpawns.length).toBe(branches.length);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any worker, after an experiment fails, a new experiment can be started', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          arbitraryBranch(),
          async (config, branch1, branch2) => {
            let callCount = 0;
            const spawnCalls: SpawnCall[] = [];

            // Create executor where first experiment fails
            const failingExecutor: CommandExecutor = {
              async exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
                if (command.includes('git rev-parse')) {
                  return { stdout: 'abc1234\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
              },
              spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
                spawnCalls.push({
                  command,
                  args,
                  env: options?.env,
                  cwd: options?.cwd,
                });

                callCount++;
                const mockProcess = new EventEmitter() as ChildProcess;
                mockProcess.stdout = new EventEmitter() as any;
                mockProcess.stderr = new EventEmitter() as any;
                mockProcess.pid = 12345;
                mockProcess.killed = false;
                mockProcess.kill = () => {
                  mockProcess.killed = true;
                  return true;
                };

                // First call fails, second succeeds
                const exitCode = callCount === 1 ? 1 : 0;
                setImmediate(() => mockProcess.emit('close', exitCode));

                return mockProcess;
              },
            };

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: failingExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // First experiment (will fail)
            const result1 = await worker.runExperiment(branch1);
            expect(result1.status).toBe('crash');
            expect(worker.isRunningExperiment()).toBe(false);

            // Second experiment should be able to start
            const result2 = await worker.runExperiment(branch2);
            expect(worker.isRunningExperiment()).toBe(false);

            // Both experiments should have been spawned
            const experimentSpawns = spawnCalls.filter(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentSpawns.length).toBe(2);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any worker, after an experiment times out, a new experiment can be started', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig().map(config => ({
            ...config,
            timeoutMinutes: 0.001, // Very short timeout (60ms)
          })),
          arbitraryBranch(),
          arbitraryBranch(),
          async (config, branch1, branch2) => {
            const spawnCalls: SpawnCall[] = [];

            // Create executor that never completes (will timeout)
            const hangingExecutor: CommandExecutor = {
              async exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
                if (command.includes('git rev-parse')) {
                  return { stdout: 'abc1234\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
              },
              spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
                spawnCalls.push({
                  command,
                  args,
                  env: options?.env,
                  cwd: options?.cwd,
                });

                const mockProcess = new EventEmitter() as ChildProcess;
                mockProcess.stdout = new EventEmitter() as any;
                mockProcess.stderr = new EventEmitter() as any;
                mockProcess.pid = 12345;
                mockProcess.killed = false;
                mockProcess.kill = () => {
                  mockProcess.killed = true;
                  // Emit close when killed (by timeout)
                  setImmediate(() => mockProcess.emit('close', -1));
                  return true;
                };

                // Never emit close - will be killed by timeout

                return mockProcess;
              },
            };

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: hangingExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // First experiment (will timeout)
            const result1 = await worker.runExperiment(branch1);
            expect(result1.status).toBe('crash');
            expect(result1.description).toContain('timed out');
            expect(worker.isRunningExperiment()).toBe(false);

            // Second experiment should be able to start
            const result2 = await worker.runExperiment(branch2);
            expect(worker.isRunningExperiment()).toBe(false);

            // Both experiments should have been spawned
            const experimentSpawns = spawnCalls.filter(
              call => call.command === 'sh' && call.args.includes('-c')
            );
            expect(experimentSpawns.length).toBe(2);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 10.5: Error message is descriptive when rejecting concurrent requests
  // --------------------------------------------------------------------------
  describe('Error message is descriptive when rejecting concurrent requests', () => {
    it('for any concurrent experiment request, the error message should indicate the worker is busy', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          arbitraryBranch(),
          async (config, branch1, branch2) => {
            const { executor, resolveExperiment } = createDelayedMockCommandExecutor();

            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start first experiment
            const firstExperimentPromise = worker.runExperiment(branch1);
            await new Promise(resolve => setImmediate(resolve));

            // Try to start second experiment
            let errorMessage = '';
            try {
              await worker.runExperiment(branch2);
            } catch (error) {
              errorMessage = error instanceof Error ? error.message : String(error);
            }

            // Error message should be descriptive
            expect(errorMessage.toLowerCase()).toMatch(/already|executing|running|busy/);

            // Complete the first experiment
            resolveExperiment();
            await firstExperimentPromise;

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 30: Experiment Timeout
// ============================================================================

describe('Property 30: Experiment Timeout', () => {
  /**
   * **Validates: Requirements 9.5**
   * 
   * For any experiment that exceeds 10 minutes of execution time, the GPU_Worker
   * shall terminate the process and report a result with status "crash".
   */

  /**
   * Creates a mock command executor that never completes (for timeout testing).
   * Returns a function to manually trigger process completion if needed.
   */
  function createNeverCompletingExecutor(): {
    executor: CommandExecutor;
    spawnCalls: SpawnCall[];
    mockProcesses: Array<{ process: ChildProcess; emitClose: (code: number) => void }>;
    killCalls: Array<{ signal: string | number }>;
  } {
    const spawnCalls: SpawnCall[] = [];
    const mockProcesses: Array<{ process: ChildProcess; emitClose: (code: number) => void }> = [];
    const killCalls: Array<{ signal: string | number }> = [];

    const executor: CommandExecutor = {
      async exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
        if (command.includes('git rev-parse')) {
          return { stdout: 'abc1234\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
        spawnCalls.push({
          command,
          args,
          env: options?.env,
          cwd: options?.cwd,
        });

        const mockProcess = new EventEmitter() as ChildProcess;
        mockProcess.stdout = new EventEmitter() as any;
        mockProcess.stderr = new EventEmitter() as any;
        mockProcess.pid = 12345 + mockProcesses.length;
        mockProcess.killed = false;
        mockProcess.kill = (signal?: string | number) => {
          killCalls.push({ signal: signal ?? 'SIGTERM' });
          mockProcess.killed = true;
          // Emit close when killed (simulating process termination)
          setImmediate(() => mockProcess.emit('close', -1));
          return true;
        };

        const emitClose = (code: number) => {
          mockProcess.emit('close', code);
        };

        mockProcesses.push({ process: mockProcess, emitClose });

        // Never emit close - process hangs until killed

        return mockProcess;
      },
    };

    return { executor, spawnCalls, mockProcesses, killCalls };
  }

  // --------------------------------------------------------------------------
  // Property 30.1: Experiment is terminated after timeout
  // --------------------------------------------------------------------------
  describe('Experiment is terminated after timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('for any experiment exceeding the timeout, the process should be killed', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          arbitraryBranch(),
          async (gpuId, agentId, workDir, branch) => {
            const { executor, killCalls } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                gpuId,
                agentId,
                workDir,
                timeoutMinutes: 10, // Default 10 minutes
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout (10 minutes = 600000ms)
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            await experimentPromise;

            // Process should have been killed
            expect(killCalls.length).toBeGreaterThan(0);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any configurable timeout, the process should be killed after that duration', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          arbitraryBranch(),
          fc.integer({ min: 1, max: 30 }), // Timeout in minutes
          async (gpuId, agentId, workDir, branch, timeoutMinutes) => {
            const { executor, killCalls } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                gpuId,
                agentId,
                workDir,
                timeoutMinutes,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time just before timeout - process should NOT be killed yet
            await vi.advanceTimersByTimeAsync(timeoutMinutes * 60 * 1000 - 1000);
            expect(killCalls.length).toBe(0);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(2000);

            // Wait for the experiment to complete
            await experimentPromise;

            // Process should have been killed
            expect(killCalls.length).toBeGreaterThan(0);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 30.2: Result status is 'crash' when timeout occurs
  // --------------------------------------------------------------------------
  describe('Result status is crash when timeout occurs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('for any experiment that times out, the result status should be crash', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Result status should be 'crash'
            expect(result.status).toBe('crash');

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any experiment that times out, the result val_bpb should be 0', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Result val_bpb should be 0 for crash
            expect(result.valBpb).toBe(0);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any experiment that times out, the result description should indicate timeout', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Result description should mention timeout
            expect(result.description.toLowerCase()).toContain('timed out');

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 30.3: Process is killed when timeout is reached
  // --------------------------------------------------------------------------
  describe('Process is killed when timeout is reached', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('for any timeout, the kill signal should be sent to the process', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor, killCalls } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            await experimentPromise;

            // Kill should have been called with SIGTERM first
            expect(killCalls.length).toBeGreaterThan(0);
            expect(killCalls[0].signal).toBe('SIGTERM');

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for any timeout, the worker should no longer be running an experiment after timeout', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const { executor } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

            // Wait for the experiment to complete
            await experimentPromise;

            // Worker should no longer be running an experiment
            expect(worker.isRunningExperiment()).toBe(false);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 30.4: Timeout is configurable via timeoutMinutes
  // --------------------------------------------------------------------------
  describe('Timeout is configurable via timeoutMinutes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('for any timeoutMinutes value, getTimeoutMinutes() should return that value', () => {
      fc.assert(
        fc.property(
          arbitraryGpuWorkerConfig(),
          (config) => {
            const worker = createGpuWorker({
              config,
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
            });

            expect(worker.getTimeoutMinutes()).toBe(config.timeoutMinutes);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for default config without timeoutMinutes, getTimeoutMinutes() should return 10', () => {
      fc.assert(
        fc.property(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          (gpuId, agentId, workDir) => {
            const worker = createGpuWorker({
              config: {
                gpuId,
                agentId,
                workDir,
                // No timeoutMinutes specified
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
            });

            // Default should be 10 minutes
            expect(worker.getTimeoutMinutes()).toBe(10);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any short timeout, experiment should timeout at that duration', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          arbitraryBranch(),
          fc.integer({ min: 1, max: 5 }), // Short timeout 1-5 minutes
          async (gpuId, agentId, workDir, branch, timeoutMinutes) => {
            const { executor, killCalls } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                gpuId,
                agentId,
                workDir,
                timeoutMinutes,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time to just before timeout - should NOT timeout yet
            await vi.advanceTimersByTimeAsync(timeoutMinutes * 60 * 1000 - 500);
            expect(killCalls.length).toBe(0);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(1000);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Should have timed out
            expect(result.status).toBe('crash');
            expect(killCalls.length).toBeGreaterThan(0);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });

    it('for any long timeout, experiment should not timeout before that duration', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuId(),
          arbitraryAgentId(),
          arbitraryWorkDir(),
          arbitraryBranch(),
          fc.integer({ min: 15, max: 30 }), // Long timeout 15-30 minutes
          async (gpuId, agentId, workDir, branch, timeoutMinutes) => {
            const { executor, killCalls, mockProcesses } = createNeverCompletingExecutor();

            const worker = createGpuWorker({
              config: {
                gpuId,
                agentId,
                workDir,
                timeoutMinutes,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: executor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment (will hang)
            const experimentPromise = worker.runExperiment(branch);

            // Advance time to 10 minutes (default timeout) - should NOT timeout
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            expect(killCalls.length).toBe(0);

            // Advance time to just before the configured timeout - should still NOT timeout
            await vi.advanceTimersByTimeAsync((timeoutMinutes - 10) * 60 * 1000 - 500);
            expect(killCalls.length).toBe(0);

            // Advance time past the timeout
            await vi.advanceTimersByTimeAsync(1000);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Should have timed out now
            expect(result.status).toBe('crash');
            expect(killCalls.length).toBeGreaterThan(0);

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 30.5: Experiment completing before timeout should not crash
  // --------------------------------------------------------------------------
  describe('Experiment completing before timeout should not crash', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('for any experiment completing before timeout, status should not be crash due to timeout', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuWorkerConfig(),
          arbitraryBranch(),
          async (config, branch) => {
            const spawnCalls: SpawnCall[] = [];

            // Create executor that completes quickly
            const quickExecutor: CommandExecutor = {
              async exec(command: string, _options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
                if (command.includes('git rev-parse')) {
                  return { stdout: 'abc1234\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
              },
              spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
                spawnCalls.push({
                  command,
                  args,
                  env: options?.env,
                  cwd: options?.cwd,
                });

                const mockProcess = new EventEmitter() as ChildProcess;
                mockProcess.stdout = new EventEmitter() as any;
                mockProcess.stderr = new EventEmitter() as any;
                mockProcess.pid = 12345;
                mockProcess.killed = false;
                mockProcess.kill = () => {
                  mockProcess.killed = true;
                  return true;
                };

                // Complete successfully after a short delay
                setTimeout(() => {
                  mockProcess.emit('close', 0);
                }, 100);

                return mockProcess;
              },
            };

            const worker = createGpuWorker({
              config: {
                ...config,
                timeoutMinutes: 10,
              },
              logger: createSilentLogger(),
              gpuChecker: createMockGpuChecker(),
              commandExecutor: quickExecutor,
              timestampGenerator: () => new Date().toISOString(),
            });

            await worker.start();

            // Start experiment
            const experimentPromise = worker.runExperiment(branch);

            // Advance time to let the experiment complete (100ms)
            await vi.advanceTimersByTimeAsync(200);

            // Wait for the experiment to complete
            const result = await experimentPromise;

            // Result should not be a timeout crash
            // (it might be crash for other reasons like missing run.log, but not timeout)
            if (result.status === 'crash') {
              expect(result.description.toLowerCase()).not.toContain('timed out');
            }

            await worker.stop();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

// Import vi for fake timers
import { vi, afterEach } from 'vitest';
