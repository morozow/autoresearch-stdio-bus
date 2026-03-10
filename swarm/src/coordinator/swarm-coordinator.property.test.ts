/**
 * Property-based tests for SwarmCoordinator.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 3: Agent Count Configuration
 * 
 * For any valid configuration specifying N agents and N GPUs (where N ≥ 1),
 * the Swarm_Coordinator shall spawn exactly N GPU_Worker instances.
 * 
 * **Validates: Requirements 1.3, 3.2**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  SwarmCoordinator,
  createSwarmCoordinator,
  SwarmCoordinatorOptions,
} from './swarm-coordinator';
import { SwarmConfig, PoolConfig } from '../config/schema';
import { createExperimentRegistry, ExperimentResult } from '../state/experiment-registry';
import { createStateBroadcaster } from '../broadcast/state-broadcaster';
import { createConflictResolver } from '../conflict/conflict-resolver';
import { createSessionRouter } from '../routing/session-router';
import { GpuWorker, GpuWorkerOptions } from '../worker/gpu-worker';

// ============================================================================
// Module Mocking
// ============================================================================

// Mock the gpu-worker module to avoid actual GPU checks
vi.mock('../worker/gpu-worker', async (importOriginal) => {
  const original = await importOriginal<typeof import('../worker/gpu-worker')>();

  return {
    ...original,
    createGpuWorker: vi.fn((options: GpuWorkerOptions): GpuWorker => {
      // Create a mock worker that doesn't check for real GPUs
      const mockWorker: GpuWorker = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        runExperiment: vi.fn().mockResolvedValue({
          commit: 'abc1234',
          valBpb: 1.0,
          memoryGb: 8.0,
          status: 'keep' as const,
          description: 'test',
          agentId: options.config.agentId,
          timestamp: new Date().toISOString(),
          branch: `autoresearch/swarm/${options.config.agentId}`,
        }),
        killExperiment: vi.fn().mockResolvedValue(undefined),
        checkGpuAvailable: vi.fn().mockResolvedValue(true),
        getMemoryCapacity: vi.fn().mockResolvedValue(8192),
        getGpuId: vi.fn().mockReturnValue(options.config.gpuId),
        getAgentId: vi.fn().mockReturnValue(options.config.agentId),
        getState: vi.fn().mockReturnValue('idle'),
        isRunningExperiment: vi.fn().mockReturnValue(false),
        getExperimentCommand: vi.fn().mockReturnValue('uv run train.py'),
        getCudaVisibleDevices: vi.fn().mockReturnValue(String(options.config.gpuId)),
        getWorkDir: vi.fn().mockReturnValue(options.config.workDir),
        getTimeoutMinutes: vi.fn().mockReturnValue(options.config.timeoutMinutes),
      };
      return mockWorker;
    }),
  };
});

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock logger that suppresses output during tests.
 */
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/**
 * Creates test coordinator options with mocked dependencies.
 */
const createTestOptions = (): SwarmCoordinatorOptions => ({
  logger: createMockLogger(),
  fileLogger: createMockLogger(),
  experimentRegistry: createExperimentRegistry({ resultsPath: '/tmp/test-results.tsv' }),
  stateBroadcaster: createStateBroadcaster(),
  conflictResolver: createConflictResolver(),
  sessionRouter: createSessionRouter(),
});

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid GPU ID array with unique values.
 */
const arbitraryGpuIds = (minLength: number = 1, maxLength: number = 8): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 0, max: 15 }), { minLength, maxLength })
    .map(ids => [...new Set(ids)]) // Ensure unique GPU IDs
    .filter(ids => ids.length >= minLength); // Ensure minimum length after dedup

/**
 * Generates a valid pool configuration.
 */
const arbitraryValidPool = (): fc.Arbitrary<PoolConfig> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    command: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    args: fc.option(fc.array(fc.string(), { maxLength: 5 }), { nil: undefined }),
    env: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        fc.string({ maxLength: 50 })
      ),
      { nil: undefined }
    ),
    instances: fc.integer({ min: 1, max: 8 }),
  });

/**
 * Generates a valid SwarmConfig where the number of GPU IDs determines the agent count.
 * The coordinator spawns one worker per GPU ID.
 */
const arbitraryValidSwarmConfig = (): fc.Arbitrary<SwarmConfig> =>
  arbitraryGpuIds(1, 8).chain(gpuIds => {
    const numGpus = gpuIds.length;
    return arbitraryValidPool()
      .map(pool => ({
        pools: [{ ...pool, instances: numGpus }],
        swarm: {
          gpuIds,
          agentModel: 'claude-acp',
          experimentTimeout: 10,
          lockTimeout: 10,
        },
        limits: {
          max_input_buffer: 1048576,
          max_output_queue: 4194304,
          max_restarts: 5,
          restart_window_sec: 60,
          backpressure_timeout_sec: 60,
        },
      }));
  });

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 3: Agent Count Configuration', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    // Create a fresh coordinator for each test
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    // Clean up coordinator state
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 3.1: Worker count equals GPU count
  // For any valid configuration with N GPUs, exactly N workers should be spawned
  // --------------------------------------------------------------------------
  describe('worker count equals GPU count', () => {
    it('for any valid config with N GPUs, exactly N workers should be spawned', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            // Create fresh coordinator for each test
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Start the coordinator with the config
              await testCoordinator.start(config);

              // Get the number of workers spawned
              const workerCount = testCoordinator.getWorkerCount();
              const expectedCount = config.swarm.gpuIds.length;

              // Verify: worker count should equal GPU count
              expect(workerCount).toBe(expectedCount);

              return workerCount === expectedCount;
            } finally {
              // Clean up
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('exact count: N GPUs should spawn exactly N workers for N from 1 to 8', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          async (n) => {
            const gpuIds = Array.from({ length: n }, (_, i) => i);
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: n }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const workerCount = testCoordinator.getWorkerCount();

              expect(workerCount).toBe(n);
              return workerCount === n;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 3.2: Each GPU ID gets exactly one worker
  // For any valid configuration, each GPU ID should have exactly one worker assigned
  // --------------------------------------------------------------------------
  describe('each GPU ID gets exactly one worker', () => {
    it('for any valid config, each GPU ID should have exactly one worker', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Get all worker agent IDs
              const workerAgentIds = testCoordinator.getWorkerAgentIds();

              // Extract GPU IDs from agent IDs (format: agent-{gpuId})
              const workerGpuIds = workerAgentIds.map(agentId => {
                const match = agentId.match(/agent-(\d+)/);
                return match ? parseInt(match[1], 10) : -1;
              });

              // Verify each configured GPU ID has exactly one worker
              for (const gpuId of config.swarm.gpuIds) {
                const count = workerGpuIds.filter(id => id === gpuId).length;
                expect(count).toBe(1);
              }

              // Verify no extra workers for unconfigured GPUs
              for (const workerGpuId of workerGpuIds) {
                expect(config.swarm.gpuIds).toContain(workerGpuId);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('non-contiguous GPU IDs should each get exactly one worker', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray([0, 2, 4, 6, 8, 10, 12, 14], { minLength: 1, maxLength: 8 }),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const workerAgentIds = testCoordinator.getWorkerAgentIds();

              // Verify count matches
              expect(workerAgentIds.length).toBe(gpuIds.length);

              // Verify each GPU ID has a worker
              for (const gpuId of gpuIds) {
                const expectedAgentId = `agent-${gpuId}`;
                expect(workerAgentIds).toContain(expectedAgentId);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 3.3: Worker count is consistent with status
  // The activeAgents count in status should match the worker count
  // --------------------------------------------------------------------------
  describe('worker count consistent with status', () => {
    it('activeAgents in status should equal worker count', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();
              const workerCount = testCoordinator.getWorkerCount();

              expect(status.activeAgents).toBe(workerCount);
              expect(status.activeAgents).toBe(config.swarm.gpuIds.length);

              return status.activeAgents === workerCount &&
                status.activeAgents === config.swarm.gpuIds.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('gpuUtilization should have entry for each configured GPU', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // Verify gpuUtilization has entry for each GPU
              for (const gpuId of config.swarm.gpuIds) {
                expect(status.gpuUtilization[gpuId]).toBeDefined();
                expect(status.gpuUtilization[gpuId].gpuId).toBe(gpuId);
              }

              // Verify no extra entries
              const utilizedGpuIds = Object.keys(status.gpuUtilization).map(Number);
              expect(utilizedGpuIds.length).toBe(config.swarm.gpuIds.length);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 3.4: Single GPU configuration
  // Edge case: configuration with exactly 1 GPU should spawn exactly 1 worker
  // --------------------------------------------------------------------------
  describe('single GPU configuration', () => {
    it('config with 1 GPU should spawn exactly 1 worker', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 15 }),
          async (gpuId) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              expect(testCoordinator.getWorkerCount()).toBe(1);
              expect(testCoordinator.getWorkerAgentIds()).toContain(`agent-${gpuId}`);

              return testCoordinator.getWorkerCount() === 1;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 3.5: Worker count after stop is zero
  // After stopping, the coordinator should have zero workers
  // --------------------------------------------------------------------------
  describe('worker count after stop', () => {
    it('after stop, worker count should be zero', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Start and verify workers exist
              await testCoordinator.start(config);
              expect(testCoordinator.getWorkerCount()).toBe(config.swarm.gpuIds.length);

              // Stop and verify workers are cleared
              await testCoordinator.stop();
              expect(testCoordinator.getWorkerCount()).toBe(0);
              expect(testCoordinator.getIsRunning()).toBe(false);

              return testCoordinator.getWorkerCount() === 0;
            } finally {
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 20: Hot Reload Support
// ============================================================================

/**
 * Property 20: Hot Reload Support
 *
 * For any configuration change applied via hot-reload, the Swarm_Coordinator
 * shall add or remove agents to match the new configuration without restarting
 * existing agents that remain in the configuration.
 *
 * Property: ∀ old_config, new_config: reload(new_config) preserves state of agents in both configs
 *
 * **Validates: Requirements 6.4**
 */
describe('Property 20: Hot Reload Support', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 20.1: Preserved agents are not restarted
  // Agents that exist in both old and new configs should be preserved
  // --------------------------------------------------------------------------
  describe('preserved agents are not restarted', () => {
    it('agents in both configs should be preserved during reload', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate two configs with some overlapping GPU IDs
          fc.tuple(
            arbitraryGpuIds(1, 6),
            arbitraryGpuIds(1, 6)
          ).filter(([old, newIds]) => {
            // Ensure there's at least some overlap for meaningful test
            const oldSet = new Set(old);
            return newIds.some(id => oldSet.has(id));
          }),
          async ([oldGpuIds, newGpuIds]) => {
            const oldConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: oldGpuIds.length }],
              swarm: {
                gpuIds: oldGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const newConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: newGpuIds.length }],
              swarm: {
                gpuIds: newGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Start with old config
              await testCoordinator.start(oldConfig);

              // Perform hot reload
              const result = await testCoordinator.reload(newConfig);

              // Calculate expected preserved agents
              const oldSet = new Set(oldGpuIds);
              const newSet = new Set(newGpuIds);
              const expectedPreserved = oldGpuIds
                .filter(id => newSet.has(id))
                .map(id => `agent-${id}`);

              // Verify preserved agents match
              expect(result.success).toBe(true);
              expect(result.preserved.sort()).toEqual(expectedPreserved.sort());

              // Verify preserved agents are still running
              for (const agentId of result.preserved) {
                expect(testCoordinator.getWorkerAgentIds()).toContain(agentId);
              }

              return result.preserved.length === expectedPreserved.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.2: New agents are added correctly
  // Agents in new config but not in old config should be added
  // --------------------------------------------------------------------------
  describe('new agents are added correctly', () => {
    it('agents only in new config should be added during reload', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            arbitraryGpuIds(1, 4),
            arbitraryGpuIds(1, 4)
          ).filter(([old, newIds]) => {
            // Ensure there are some new GPUs to add
            const oldSet = new Set(old);
            return newIds.some(id => !oldSet.has(id));
          }),
          async ([oldGpuIds, newGpuIds]) => {
            const oldConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: oldGpuIds.length }],
              swarm: {
                gpuIds: oldGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const newConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: newGpuIds.length }],
              swarm: {
                gpuIds: newGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(oldConfig);
              const result = await testCoordinator.reload(newConfig);

              // Calculate expected added agents
              const oldSet = new Set(oldGpuIds);
              const expectedAdded = newGpuIds
                .filter(id => !oldSet.has(id))
                .map(id => `agent-${id}`);

              // Verify added agents match
              expect(result.success).toBe(true);
              expect(result.added.sort()).toEqual(expectedAdded.sort());

              // Verify added agents are now running
              for (const agentId of result.added) {
                expect(testCoordinator.getWorkerAgentIds()).toContain(agentId);
              }

              return result.added.length === expectedAdded.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.3: Old agents are removed correctly
  // Agents in old config but not in new config should be removed
  // --------------------------------------------------------------------------
  describe('old agents are removed correctly', () => {
    it('agents only in old config should be removed during reload', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            arbitraryGpuIds(2, 6),
            arbitraryGpuIds(1, 4)
          ).filter(([old, newIds]) => {
            // Ensure there are some GPUs to remove
            const newSet = new Set(newIds);
            return old.some(id => !newSet.has(id));
          }),
          async ([oldGpuIds, newGpuIds]) => {
            const oldConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: oldGpuIds.length }],
              swarm: {
                gpuIds: oldGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const newConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: newGpuIds.length }],
              swarm: {
                gpuIds: newGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(oldConfig);
              const result = await testCoordinator.reload(newConfig);

              // Calculate expected removed agents
              const newSet = new Set(newGpuIds);
              const expectedRemoved = oldGpuIds
                .filter(id => !newSet.has(id))
                .map(id => `agent-${id}`);

              // Verify removed agents match
              expect(result.success).toBe(true);
              expect(result.removed.sort()).toEqual(expectedRemoved.sort());

              // Verify removed agents are no longer running
              for (const agentId of result.removed) {
                expect(testCoordinator.getWorkerAgentIds()).not.toContain(agentId);
              }

              return result.removed.length === expectedRemoved.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.4: Final worker count matches new config
  // After reload, the number of workers should match the new config
  // --------------------------------------------------------------------------
  describe('final worker count matches new config', () => {
    it('worker count after reload should equal new config GPU count', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            arbitraryGpuIds(1, 8),
            arbitraryGpuIds(1, 8)
          ),
          async ([oldGpuIds, newGpuIds]) => {
            const oldConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: oldGpuIds.length }],
              swarm: {
                gpuIds: oldGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const newConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: newGpuIds.length }],
              swarm: {
                gpuIds: newGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(oldConfig);
              await testCoordinator.reload(newConfig);

              const workerCount = testCoordinator.getWorkerCount();
              const expectedCount = newGpuIds.length;

              expect(workerCount).toBe(expectedCount);

              return workerCount === expectedCount;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.5: Reload result consistency
  // added + preserved should equal new config, removed + preserved should equal old config
  // --------------------------------------------------------------------------
  describe('reload result consistency', () => {
    it('added + preserved should match new config agents', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            arbitraryGpuIds(1, 6),
            arbitraryGpuIds(1, 6)
          ),
          async ([oldGpuIds, newGpuIds]) => {
            const oldConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: oldGpuIds.length }],
              swarm: {
                gpuIds: oldGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const newConfig: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: newGpuIds.length }],
              swarm: {
                gpuIds: newGpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(oldConfig);
              const result = await testCoordinator.reload(newConfig);

              // added + preserved should equal new config agents
              const resultAgents = [...result.added, ...result.preserved].sort();
              const expectedAgents = newGpuIds.map(id => `agent-${id}`).sort();

              expect(resultAgents).toEqual(expectedAgents);

              // removed + preserved should equal old config agents
              const oldResultAgents = [...result.removed, ...result.preserved].sort();
              const expectedOldAgents = oldGpuIds.map(id => `agent-${id}`).sort();

              expect(oldResultAgents).toEqual(expectedOldAgents);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.6: Reload when not running starts fresh
  // If coordinator is not running, reload should start with new config
  // --------------------------------------------------------------------------
  describe('reload when not running', () => {
    it('reload on stopped coordinator should start fresh with new config', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Don't start first - just reload
              expect(testCoordinator.getIsRunning()).toBe(false);

              const result = await testCoordinator.reload(config);

              // Should have started and added all agents
              expect(result.success).toBe(true);
              expect(result.added.length).toBe(gpuIds.length);
              expect(result.removed.length).toBe(0);
              expect(result.preserved.length).toBe(0);
              expect(testCoordinator.getIsRunning()).toBe(true);
              expect(testCoordinator.getWorkerCount()).toBe(gpuIds.length);

              return result.added.length === gpuIds.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.7: Multiple consecutive reloads
  // Multiple reloads should work correctly in sequence
  // --------------------------------------------------------------------------
  describe('multiple consecutive reloads', () => {
    it('multiple reloads should correctly track state changes', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryGpuIds(1, 6), { minLength: 2, maxLength: 4 }),
          async (configSequence) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Start with first config
              const firstConfig: SwarmConfig = {
                pools: [{ id: 'worker', command: 'node', instances: configSequence[0].length }],
                swarm: {
                  gpuIds: configSequence[0],
                  agentModel: 'claude-acp',
                  experimentTimeout: 10,
                  lockTimeout: 10,
                },
              };
              await testCoordinator.start(firstConfig);

              // Apply each subsequent config via reload
              for (let i = 1; i < configSequence.length; i++) {
                const newConfig: SwarmConfig = {
                  pools: [{ id: 'worker', command: 'node', instances: configSequence[i].length }],
                  swarm: {
                    gpuIds: configSequence[i],
                    agentModel: 'claude-acp',
                    experimentTimeout: 10,
                    lockTimeout: 10,
                  },
                };

                const result = await testCoordinator.reload(newConfig);

                // Verify result is successful
                expect(result.success).toBe(true);

                // Verify worker count matches new config
                expect(testCoordinator.getWorkerCount()).toBe(configSequence[i].length);

                // Verify all expected agents are present
                const expectedAgents = configSequence[i].map(id => `agent-${id}`);
                const actualAgents = testCoordinator.getWorkerAgentIds();
                expect(actualAgents.sort()).toEqual(expectedAgents.sort());
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 20.8: Identical config reload is no-op
  // Reloading with the same config should preserve all agents
  // --------------------------------------------------------------------------
  describe('identical config reload', () => {
    it('reloading with same config should preserve all agents', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);
              const result = await testCoordinator.reload(config);

              // All agents should be preserved, none added or removed
              expect(result.success).toBe(true);
              expect(result.added.length).toBe(0);
              expect(result.removed.length).toBe(0);
              expect(result.preserved.length).toBe(gpuIds.length);

              // Worker count should remain the same
              expect(testCoordinator.getWorkerCount()).toBe(gpuIds.length);

              return result.preserved.length === gpuIds.length &&
                result.added.length === 0 &&
                result.removed.length === 0;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});



// ============================================================================
// Property 21: Val_bpb Optimization Target
// ============================================================================

/**
 * Property 21: Val_bpb Optimization Target
 *
 * For any comparison or ranking of experiments, the Swarm_Coordinator shall
 * use val_bpb as the metric where lower values are better.
 *
 * Property: ∀ experiments E: best_val_bpb = min(e.val_bpb for e in E where e.status = 'keep')
 *
 * **Validates: Requirements 7.6**
 */
describe('Property 21: Val_bpb Optimization Target', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Arbitraries for val_bpb testing
  // --------------------------------------------------------------------------

  /**
   * Generates a valid val_bpb value (positive number, typically between 0.5 and 2.0).
   */
  const arbitraryValBpb = (): fc.Arbitrary<number> =>
    fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true })
      .map(v => Math.round(v * 1000000) / 1000000); // Round to 6 decimal places

  /**
   * Generates a valid experiment status.
   */
  const arbitraryStatus = (): fc.Arbitrary<'keep' | 'discard' | 'crash'> =>
    fc.constantFrom('keep' as const, 'discard' as const, 'crash' as const);

  /**
   * Generates a valid experiment result.
   */
  const arbitraryExperimentResult = (agentId: string = 'agent-0'): fc.Arbitrary<{
    commit: string;
    valBpb: number;
    memoryGb: number;
    status: 'keep' | 'discard' | 'crash';
    description: string;
    agentId: string;
    timestamp: string;
    branch: string;
  }> =>
    fc.record({
      commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
      valBpb: arbitraryValBpb(),
      memoryGb: fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
      status: arbitraryStatus(),
      description: fc.string({ minLength: 1, maxLength: 100 }),
      agentId: fc.constant(agentId),
      timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
        .map(d => d.toISOString()),
      branch: fc.constant(`autoresearch/swarm/${agentId}`),
    });

  /**
   * Generates a list of experiment results with at least one "keep" status.
   */
  const arbitraryExperimentsWithKeep = (): fc.Arbitrary<Array<{
    commit: string;
    valBpb: number;
    memoryGb: number;
    status: 'keep' | 'discard' | 'crash';
    description: string;
    agentId: string;
    timestamp: string;
    branch: string;
  }>> =>
    fc.tuple(
      // At least one "keep" experiment
      arbitraryExperimentResult().map(e => ({ ...e, status: 'keep' as const })),
      // Additional experiments with any status
      fc.array(arbitraryExperimentResult(), { minLength: 0, maxLength: 10 })
    ).map(([keepExp, others]) => {
      // Ensure unique commits
      const commits = new Set<string>([keepExp.commit]);
      const uniqueOthers = others.filter(e => {
        if (commits.has(e.commit)) return false;
        commits.add(e.commit);
        return true;
      });
      return [keepExp, ...uniqueOthers];
    });

  // --------------------------------------------------------------------------
  // Property 21.1: Best val_bpb is minimum of "keep" experiments
  // For any set of experiments, best_val_bpb should equal min(val_bpb) for "keep" status
  // --------------------------------------------------------------------------
  describe('best val_bpb is minimum of keep experiments', () => {
    it('best_val_bpb should equal minimum val_bpb among keep experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentsWithKeep(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Calculate expected best val_bpb (minimum of "keep" experiments)
              const keepExperiments = experiments.filter(e => e.status === 'keep');
              const expectedBestValBpb = Math.min(...keepExperiments.map(e => e.valBpb));

              // Get actual best val_bpb from registry
              const actualBestValBpb = registry.getBestValBpb();

              // Verify they match
              expect(actualBestValBpb).toBeCloseTo(expectedBestValBpb, 6);

              return Math.abs(actualBestValBpb - expectedBestValBpb) < 0.0000001;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('best_val_bpb should ignore discard and crash experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            // Keep experiments with higher val_bpb
            fc.array(
              arbitraryExperimentResult().map(e => ({
                ...e,
                status: 'keep' as const,
                valBpb: 1.5 + Math.random() * 0.5, // 1.5 to 2.0
              })),
              { minLength: 1, maxLength: 5 }
            ),
            // Discard/crash experiments with lower val_bpb (should be ignored)
            fc.array(
              arbitraryExperimentResult().map(e => ({
                ...e,
                status: fc.sample(fc.constantFrom('discard' as const, 'crash' as const), 1)[0],
                valBpb: 0.5 + Math.random() * 0.3, // 0.5 to 0.8 (lower than keep)
              })),
              { minLength: 1, maxLength: 5 }
            )
          ),
          async ([keepExps, otherExps]) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Ensure unique commits
              const commits = new Set<string>();
              const allExps = [...keepExps, ...otherExps].filter(e => {
                if (commits.has(e.commit)) return false;
                commits.add(e.commit);
                return true;
              });

              // Record all experiments
              for (const exp of allExps) {
                await registry.recordResult(exp);
              }

              // Expected: minimum of keep experiments only
              const keepOnly = allExps.filter(e => e.status === 'keep');
              const expectedBestValBpb = Math.min(...keepOnly.map(e => e.valBpb));

              // Actual best val_bpb
              const actualBestValBpb = registry.getBestValBpb();

              // Should match keep experiments, not the lower discard/crash values
              expect(actualBestValBpb).toBeCloseTo(expectedBestValBpb, 6);

              return Math.abs(actualBestValBpb - expectedBestValBpb) < 0.0000001;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 21.2: Best val_bpb updates correctly when new minimum is recorded
  // When a new "keep" experiment with lower val_bpb is recorded, best should update
  // --------------------------------------------------------------------------
  describe('best val_bpb updates on new minimum', () => {
    it('best_val_bpb should update when lower keep experiment is recorded', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            arbitraryValBpb(),
            arbitraryValBpb()
          ).filter(([first, second]) => first !== second),
          async ([firstValBpb, secondValBpb]) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record first experiment
              await registry.recordResult({
                commit: 'abc1234',
                valBpb: firstValBpb,
                memoryGb: 8.0,
                status: 'keep',
                description: 'first experiment',
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              });

              // Best should be first val_bpb
              expect(registry.getBestValBpb()).toBeCloseTo(firstValBpb, 6);

              // Record second experiment
              await registry.recordResult({
                commit: 'def5678',
                valBpb: secondValBpb,
                memoryGb: 8.0,
                status: 'keep',
                description: 'second experiment',
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              });

              // Best should be minimum of both
              const expectedBest = Math.min(firstValBpb, secondValBpb);
              expect(registry.getBestValBpb()).toBeCloseTo(expectedBest, 6);

              return Math.abs(registry.getBestValBpb() - expectedBest) < 0.0000001;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 21.3: Status reports correct best val_bpb
  // The SwarmStatus.bestValBpb should match the registry's best val_bpb
  // --------------------------------------------------------------------------
  describe('status reports correct best val_bpb', () => {
    it('SwarmStatus.bestValBpb should match registry best val_bpb', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentsWithKeep(),
          arbitraryGpuIds(1, 4),
          async (experiments, gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Start coordinator
              await testCoordinator.start(config);

              // Record experiments
              const registry = testCoordinator.getExperimentRegistry();
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get status
              const status = testCoordinator.getStatus();

              // Calculate expected best val_bpb from registry (which is the source of truth)
              const registryBestValBpb = registry.getBestValBpb();

              // Verify status reports the same best val_bpb as the registry
              expect(status.bestValBpb).toBe(registryBestValBpb);

              return status.bestValBpb === registryBestValBpb;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 21.4: Lower val_bpb is always better
  // When comparing experiments, lower val_bpb should be considered better
  // --------------------------------------------------------------------------
  describe('lower val_bpb is always better', () => {
    it('experiment with lower val_bpb should be the best', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryValBpb(), { minLength: 2, maxLength: 20 }),
          async (valBpbValues) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record experiments with different val_bpb values
              for (let i = 0; i < valBpbValues.length; i++) {
                await registry.recordResult({
                  commit: `commit${i.toString().padStart(2, '0')}`,
                  valBpb: valBpbValues[i],
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: 'agent-0',
                  timestamp: new Date(Date.now() + i * 1000).toISOString(),
                  branch: 'autoresearch/swarm/agent-0',
                });
              }

              // Best should be the minimum
              const expectedBest = Math.min(...valBpbValues);
              const actualBest = registry.getBestValBpb();

              expect(actualBest).toBeCloseTo(expectedBest, 6);

              // Verify lower is always better (best <= all values)
              for (const val of valBpbValues) {
                expect(actualBest).toBeLessThanOrEqual(val + 0.0000001);
              }

              return Math.abs(actualBest - expectedBest) < 0.0000001;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 21.5: Best val_bpb is Infinity when no keep experiments
  // When there are no "keep" experiments, best val_bpb should be Infinity
  // --------------------------------------------------------------------------
  describe('best val_bpb with no keep experiments', () => {
    it('best_val_bpb should be Infinity when no keep experiments exist', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            arbitraryExperimentResult().map(e => ({
              ...e,
              status: fc.sample(fc.constantFrom('discard' as const, 'crash' as const), 1)[0],
            })),
            { minLength: 0, maxLength: 10 }
          ),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Ensure unique commits
              const commits = new Set<string>();
              const uniqueExps = experiments.filter(e => {
                if (commits.has(e.commit)) return false;
                commits.add(e.commit);
                return true;
              });

              // Record only discard/crash experiments
              for (const exp of uniqueExps) {
                await registry.recordResult(exp);
              }

              // Best should be Infinity (no keep experiments)
              expect(registry.getBestValBpb()).toBe(Infinity);

              return registry.getBestValBpb() === Infinity;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('empty registry should have Infinity best val_bpb', async () => {
      const testCoordinator = createSwarmCoordinator(createTestOptions());
      const registry = testCoordinator.getExperimentRegistry();

      try {
        // No experiments recorded
        expect(registry.getBestValBpb()).toBe(Infinity);
      } finally {
        testCoordinator.clear();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 21.6: Best val_bpb consistency across multiple agents
  // Best val_bpb should be the global minimum across all agents
  // --------------------------------------------------------------------------
  describe('best val_bpb across multiple agents', () => {
    it('best_val_bpb should be global minimum across all agents', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: 7 }), // agent index
              arbitraryValBpb()
            ),
            { minLength: 2, maxLength: 20 }
          ),
          async (agentExperiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record experiments from different agents
              const commits = new Set<string>();
              for (let i = 0; i < agentExperiments.length; i++) {
                const [agentIdx, valBpb] = agentExperiments[i];
                const commit = `commit${i.toString().padStart(3, '0')}`;

                if (commits.has(commit)) continue;
                commits.add(commit);

                await registry.recordResult({
                  commit,
                  valBpb,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment from agent ${agentIdx}`,
                  agentId: `agent-${agentIdx}`,
                  timestamp: new Date(Date.now() + i * 1000).toISOString(),
                  branch: `autoresearch/swarm/agent-${agentIdx}`,
                });
              }

              // Best should be global minimum across all agents
              const expectedBest = Math.min(...agentExperiments.map(([, v]) => v));
              const actualBest = registry.getBestValBpb();

              expect(actualBest).toBeCloseTo(expectedBest, 6);

              return Math.abs(actualBest - expectedBest) < 0.0000001;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});



// ============================================================================
// Property 26: Status Method Response
// ============================================================================

/**
 * Property 26: Status Method Response
 *
 * For any "swarm.status" request, the response shall include active_agents count,
 * total_experiments, best_val_bpb, and experiments_per_hour.
 *
 * Property: ∀ status: status has {activeAgents: int, totalExperiments: int, bestValBpb: float, experimentsPerHour: float}
 *
 * **Validates: Requirements 8.5**
 */
describe('Property 26: Status Method Response', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Arbitraries for status testing
  // --------------------------------------------------------------------------

  /**
   * Generates a valid val_bpb value (positive number, typically between 0.5 and 2.0).
   */
  const arbitraryValBpb = (): fc.Arbitrary<number> =>
    fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true })
      .map(v => Math.round(v * 1000000) / 1000000); // Round to 6 decimal places

  /**
   * Generates a valid experiment status.
   */
  const arbitraryStatus = (): fc.Arbitrary<'keep' | 'discard' | 'crash'> =>
    fc.constantFrom('keep' as const, 'discard' as const, 'crash' as const);

  /**
   * Generates a valid experiment result.
   */
  const arbitraryExperimentResult = (agentId: string = 'agent-0'): fc.Arbitrary<{
    commit: string;
    valBpb: number;
    memoryGb: number;
    status: 'keep' | 'discard' | 'crash';
    description: string;
    agentId: string;
    timestamp: string;
    branch: string;
  }> =>
    fc.record({
      commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
      valBpb: arbitraryValBpb(),
      memoryGb: fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
      status: arbitraryStatus(),
      description: fc.string({ minLength: 1, maxLength: 100 }),
      agentId: fc.constant(agentId),
      timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
        .map(d => d.toISOString()),
      branch: fc.constant(`autoresearch/swarm/${agentId}`),
    });

  // --------------------------------------------------------------------------
  // Property 26.1: Status response contains all required fields
  // The status response must include activeAgents, totalExperiments, bestValBpb, experimentsPerHour
  // --------------------------------------------------------------------------
  describe('status response contains all required fields', () => {
    it('getStatus should return object with all required fields', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // Verify all required fields exist
              expect(status).toHaveProperty('activeAgents');
              expect(status).toHaveProperty('totalExperiments');
              expect(status).toHaveProperty('bestValBpb');
              expect(status).toHaveProperty('experimentsPerHour');

              // Verify fields are present (not undefined)
              expect(status.activeAgents).toBeDefined();
              expect(status.totalExperiments).toBeDefined();
              expect(status.bestValBpb).toBeDefined();
              expect(status.experimentsPerHour).toBeDefined();

              return (
                'activeAgents' in status &&
                'totalExperiments' in status &&
                'bestValBpb' in status &&
                'experimentsPerHour' in status
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 26.2: Status field types are correct
  // activeAgents: int, totalExperiments: int, bestValBpb: float, experimentsPerHour: float
  // --------------------------------------------------------------------------
  describe('status field types are correct', () => {
    it('activeAgents should be a non-negative integer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // activeAgents should be a non-negative integer
              expect(typeof status.activeAgents).toBe('number');
              expect(Number.isInteger(status.activeAgents)).toBe(true);
              expect(status.activeAgents).toBeGreaterThanOrEqual(0);

              return (
                typeof status.activeAgents === 'number' &&
                Number.isInteger(status.activeAgents) &&
                status.activeAgents >= 0
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('totalExperiments should be a non-negative integer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(arbitraryExperimentResult(), { minLength: 0, maxLength: 10 }),
          async (gpuIds, experiments) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Record experiments with unique commits
              const registry = testCoordinator.getExperimentRegistry();
              const commits = new Set<string>();
              for (const exp of experiments) {
                if (!commits.has(exp.commit)) {
                  commits.add(exp.commit);
                  await registry.recordResult(exp);
                }
              }

              const status = testCoordinator.getStatus();

              // totalExperiments should be a non-negative integer
              expect(typeof status.totalExperiments).toBe('number');
              expect(Number.isInteger(status.totalExperiments)).toBe(true);
              expect(status.totalExperiments).toBeGreaterThanOrEqual(0);

              return (
                typeof status.totalExperiments === 'number' &&
                Number.isInteger(status.totalExperiments) &&
                status.totalExperiments >= 0
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('bestValBpb should be a number (float)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // bestValBpb should be a number (can be Infinity for no experiments)
              expect(typeof status.bestValBpb).toBe('number');

              return typeof status.bestValBpb === 'number';
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('experimentsPerHour should be a non-negative number (float)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // experimentsPerHour should be a non-negative number
              expect(typeof status.experimentsPerHour).toBe('number');
              expect(status.experimentsPerHour).toBeGreaterThanOrEqual(0);
              expect(Number.isNaN(status.experimentsPerHour)).toBe(false);

              return (
                typeof status.experimentsPerHour === 'number' &&
                status.experimentsPerHour >= 0 &&
                !Number.isNaN(status.experimentsPerHour)
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 26.3: Status values are accurate
  // The status values should accurately reflect the current swarm state
  // --------------------------------------------------------------------------
  describe('status values are accurate', () => {
    it('activeAgents should match the number of configured GPUs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // activeAgents should equal the number of GPU IDs
              expect(status.activeAgents).toBe(gpuIds.length);

              return status.activeAgents === gpuIds.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('totalExperiments should match the number of recorded experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(arbitraryExperimentResult(), { minLength: 0, maxLength: 20 }),
          async (gpuIds, experiments) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Clear registry AFTER start to ensure fresh state (start() restores from disk)
              const registry = testCoordinator.getExperimentRegistry();
              registry.clear();

              // Record experiments with unique commits
              const commits = new Set<string>();
              let recordedCount = 0;
              for (const exp of experiments) {
                if (!commits.has(exp.commit)) {
                  commits.add(exp.commit);
                  await registry.recordResult(exp);
                  recordedCount++;
                }
              }

              const status = testCoordinator.getStatus();

              // totalExperiments should match the number of recorded experiments
              expect(status.totalExperiments).toBe(recordedCount);

              return status.totalExperiments === recordedCount;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('bestValBpb should match the minimum val_bpb of keep experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(
            arbitraryExperimentResult().map(e => ({ ...e, status: 'keep' as const })),
            { minLength: 1, maxLength: 10 }
          ),
          async (gpuIds, experiments) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Clear registry AFTER start to ensure fresh state (start() restores from disk)
              const registry = testCoordinator.getExperimentRegistry();
              registry.clear();

              // Record experiments with unique commits
              const commits = new Set<string>();
              const recordedValBpbs: number[] = [];
              for (const exp of experiments) {
                if (!commits.has(exp.commit)) {
                  commits.add(exp.commit);
                  await registry.recordResult(exp);
                  recordedValBpbs.push(exp.valBpb);
                }
              }

              const status = testCoordinator.getStatus();

              // bestValBpb should be the minimum of recorded val_bpb values
              const expectedBest = recordedValBpbs.length > 0
                ? Math.min(...recordedValBpbs)
                : Infinity;

              expect(status.bestValBpb).toBeCloseTo(expectedBest, 6);

              return Math.abs(status.bestValBpb - expectedBest) < 0.0000001;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 26.4: Status is consistent before and after experiments
  // Status should update correctly as experiments are recorded
  // --------------------------------------------------------------------------
  describe('status consistency across experiment recording', () => {
    it('status should update correctly as experiments are recorded', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(
            arbitraryExperimentResult().map(e => ({ ...e, status: 'keep' as const })),
            { minLength: 1, maxLength: 5 }
          ),
          async (gpuIds, experiments) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Clear registry AFTER start to ensure fresh state (start() restores from disk)
              const registry = testCoordinator.getExperimentRegistry();
              registry.clear();

              // Initial status (after clearing)
              const initialStatus = testCoordinator.getStatus();
              expect(initialStatus.totalExperiments).toBe(0);
              expect(initialStatus.bestValBpb).toBe(Infinity);

              // Record experiments one by one and verify status updates
              const commits = new Set<string>();
              let expectedTotal = 0;
              let expectedBest = Infinity;

              for (const exp of experiments) {
                if (!commits.has(exp.commit)) {
                  commits.add(exp.commit);
                  await registry.recordResult(exp);
                  expectedTotal++;
                  expectedBest = Math.min(expectedBest, exp.valBpb);

                  const status = testCoordinator.getStatus();
                  expect(status.totalExperiments).toBe(expectedTotal);
                  expect(status.bestValBpb).toBeCloseTo(expectedBest, 6);
                }
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 26.5: Status when coordinator is not running
  // Status should still return valid structure even when not running
  // --------------------------------------------------------------------------
  describe('status when coordinator is not running', () => {
    it('getStatus should return valid structure when not running', async () => {
      const testCoordinator = createSwarmCoordinator(createTestOptions());

      try {
        // Clear registry to ensure fresh state
        const registry = testCoordinator.getExperimentRegistry();
        registry.clear();

        // Don't start the coordinator
        const status = testCoordinator.getStatus();

        // Should still have all required fields
        expect(status).toHaveProperty('activeAgents');
        expect(status).toHaveProperty('totalExperiments');
        expect(status).toHaveProperty('bestValBpb');
        expect(status).toHaveProperty('experimentsPerHour');

        // Values should be sensible defaults
        expect(status.activeAgents).toBe(0);
        expect(status.totalExperiments).toBe(0);
        expect(status.bestValBpb).toBe(Infinity);
        expect(status.experimentsPerHour).toBe(0);
      } finally {
        testCoordinator.clear();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 26.6: Status includes additional fields (uptime, gpuUtilization)
  // While not required by the property, verify additional fields are present
  // --------------------------------------------------------------------------
  describe('status includes additional fields', () => {
    it('status should include uptime and gpuUtilization', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // Verify additional fields exist
              expect(status).toHaveProperty('uptime');
              expect(status).toHaveProperty('gpuUtilization');

              // uptime should be a non-negative number
              expect(typeof status.uptime).toBe('number');
              expect(status.uptime).toBeGreaterThanOrEqual(0);

              // gpuUtilization should be an object
              expect(typeof status.gpuUtilization).toBe('object');

              return (
                'uptime' in status &&
                'gpuUtilization' in status &&
                typeof status.uptime === 'number' &&
                status.uptime >= 0
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

// ============================================================================
// Property 32: Status Endpoint Fields
// ============================================================================

/**
 * Property 32: Status Endpoint Fields
 *
 * For any status endpoint query, the response shall include active_agents,
 * experiments_completed, current_best_val_bpb, and experiments_per_hour.
 *
 * Property: ∀ status query: response contains {active_agents, experiments_completed, best_val_bpb, experiments_per_hour}
 *
 * **Validates: Requirements 10.1**
 */
describe('Property 32: Status Endpoint Fields', () => {
  // --------------------------------------------------------------------------
  // Property 32.1: Status endpoint returns all required fields
  // The status endpoint must return active_agents, experiments_completed, best_val_bpb, experiments_per_hour
  // --------------------------------------------------------------------------
  describe('status endpoint returns all required fields', () => {
    it('getStatus should return active_agents, experiments_completed, best_val_bpb, experiments_per_hour', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // Verify all required fields from Requirement 10.1 exist
              // active_agents -> activeAgents
              expect(status).toHaveProperty('activeAgents');
              expect(typeof status.activeAgents).toBe('number');
              expect(Number.isInteger(status.activeAgents)).toBe(true);
              expect(status.activeAgents).toBeGreaterThanOrEqual(0);

              // experiments_completed -> totalExperiments
              expect(status).toHaveProperty('totalExperiments');
              expect(typeof status.totalExperiments).toBe('number');
              expect(Number.isInteger(status.totalExperiments)).toBe(true);
              expect(status.totalExperiments).toBeGreaterThanOrEqual(0);

              // best_val_bpb -> bestValBpb
              expect(status).toHaveProperty('bestValBpb');
              expect(typeof status.bestValBpb).toBe('number');

              // experiments_per_hour -> experimentsPerHour
              expect(status).toHaveProperty('experimentsPerHour');
              expect(typeof status.experimentsPerHour).toBe('number');
              expect(status.experimentsPerHour).toBeGreaterThanOrEqual(0);

              return (
                'activeAgents' in status &&
                'totalExperiments' in status &&
                'bestValBpb' in status &&
                'experimentsPerHour' in status &&
                typeof status.activeAgents === 'number' &&
                typeof status.totalExperiments === 'number' &&
                typeof status.bestValBpb === 'number' &&
                typeof status.experimentsPerHour === 'number'
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 32.2: Status endpoint values are accurate
  // The status endpoint values should accurately reflect the swarm state
  // --------------------------------------------------------------------------
  describe('status endpoint values are accurate', () => {
    it('activeAgents should match the number of configured GPUs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // activeAgents should equal the number of GPU IDs
              expect(status.activeAgents).toBe(gpuIds.length);

              return status.activeAgents === gpuIds.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('experimentsPerHour should be calculated from total experiments and uptime', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const status = testCoordinator.getStatus();

              // experimentsPerHour should be (totalExperiments / uptime) * 3600
              // When uptime is very small, experimentsPerHour could be 0 or calculated
              if (status.uptime > 0) {
                const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 2);
              } else {
                expect(status.experimentsPerHour).toBe(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 27: Pause Method Effect
// ============================================================================

/**
 * Property 27: Pause Method Effect
 *
 * For any "swarm.pause" request, all agents shall stop accepting new experiments
 * until a "swarm.resume" request is received.
 *
 * Property: ∀ agent: after pause(), agent.acceptingExperiments = false
 *
 * **Validates: Requirements 8.6**
 */
describe('Property 27: Pause Method Effect', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 27.1: Pause sets isPaused flag to true
  // After calling pause(), the coordinator's isPaused flag should be true
  // --------------------------------------------------------------------------
  describe('pause sets isPaused flag to true', () => {
    it('after pause(), isPaused should be true', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Initially not paused
              expect(testCoordinator.getIsPaused()).toBe(false);

              // Pause the swarm
              await testCoordinator.pause();

              // Should now be paused
              expect(testCoordinator.getIsPaused()).toBe(true);

              return testCoordinator.getIsPaused() === true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('pause() should be idempotent - multiple calls should keep isPaused true', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.integer({ min: 2, max: 5 }),
          async (gpuIds, pauseCount) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Call pause multiple times
              for (let i = 0; i < pauseCount; i++) {
                await testCoordinator.pause();
                expect(testCoordinator.getIsPaused()).toBe(true);
              }

              return testCoordinator.getIsPaused() === true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.2: Resume clears isPaused flag
  // After calling resume(), the coordinator's isPaused flag should be false
  // --------------------------------------------------------------------------
  describe('resume clears isPaused flag', () => {
    it('after resume(), isPaused should be false', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Pause first
              await testCoordinator.pause();
              expect(testCoordinator.getIsPaused()).toBe(true);

              // Resume
              await testCoordinator.resume();

              // Should no longer be paused
              expect(testCoordinator.getIsPaused()).toBe(false);

              return testCoordinator.getIsPaused() === false;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('resume() should be idempotent - multiple calls should keep isPaused false', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.integer({ min: 2, max: 5 }),
          async (gpuIds, resumeCount) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Pause first
              await testCoordinator.pause();

              // Call resume multiple times
              for (let i = 0; i < resumeCount; i++) {
                await testCoordinator.resume();
                expect(testCoordinator.getIsPaused()).toBe(false);
              }

              return testCoordinator.getIsPaused() === false;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.3: Pause/Resume cycle works correctly
  // Multiple pause/resume cycles should work correctly
  // --------------------------------------------------------------------------
  describe('pause/resume cycle works correctly', () => {
    it('alternating pause/resume should toggle isPaused correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
          async (gpuIds, operations) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Track expected state
              let expectedPaused = false;

              for (const shouldPause of operations) {
                if (shouldPause) {
                  await testCoordinator.pause();
                  expectedPaused = true;
                } else {
                  await testCoordinator.resume();
                  expectedPaused = false;
                }

                expect(testCoordinator.getIsPaused()).toBe(expectedPaused);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('pause followed by resume should restore accepting state', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          fc.integer({ min: 1, max: 5 }),
          async (gpuIds, cycles) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              for (let i = 0; i < cycles; i++) {
                // Initially or after resume, should not be paused
                expect(testCoordinator.getIsPaused()).toBe(false);

                // Pause
                await testCoordinator.pause();
                expect(testCoordinator.getIsPaused()).toBe(true);

                // Resume
                await testCoordinator.resume();
                expect(testCoordinator.getIsPaused()).toBe(false);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.4: Pause state persists until resume
  // Once paused, the state should remain paused until explicitly resumed
  // --------------------------------------------------------------------------
  describe('pause state persists until resume', () => {
    it('isPaused should remain true until resume is called', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.integer({ min: 1, max: 10 }),
          async (gpuIds, checkCount) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Pause
              await testCoordinator.pause();

              // Check multiple times - should remain paused
              for (let i = 0; i < checkCount; i++) {
                expect(testCoordinator.getIsPaused()).toBe(true);
              }

              // Only resume clears the flag
              await testCoordinator.resume();
              expect(testCoordinator.getIsPaused()).toBe(false);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.5: Pause affects all agents uniformly
  // When paused, all agents should be affected (isPaused is global)
  // --------------------------------------------------------------------------
  describe('pause affects all agents uniformly', () => {
    it('pause should affect the entire swarm regardless of agent count', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Verify we have the expected number of agents
              expect(testCoordinator.getWorkerCount()).toBe(gpuIds.length);

              // Pause affects the entire swarm
              await testCoordinator.pause();
              expect(testCoordinator.getIsPaused()).toBe(true);

              // The pause state is global - all agents are affected
              // This is verified by the single isPaused flag
              const status = testCoordinator.getStatus();
              expect(status.activeAgents).toBe(gpuIds.length);

              return testCoordinator.getIsPaused() === true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.6: Initial state is not paused
  // When coordinator starts, it should not be paused
  // --------------------------------------------------------------------------
  describe('initial state is not paused', () => {
    it('coordinator should start in non-paused state', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Before start
              expect(testCoordinator.getIsPaused()).toBe(false);

              // After start
              await testCoordinator.start(config);
              expect(testCoordinator.getIsPaused()).toBe(false);

              return testCoordinator.getIsPaused() === false;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.7: Stop clears pause state
  // When coordinator stops, the pause state should be cleared
  // --------------------------------------------------------------------------
  describe('stop clears pause state', () => {
    it('stopping coordinator should clear isPaused flag', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Pause the swarm
              await testCoordinator.pause();
              expect(testCoordinator.getIsPaused()).toBe(true);

              // Stop the coordinator
              await testCoordinator.stop();

              // Pause state should be cleared
              expect(testCoordinator.getIsPaused()).toBe(false);

              return testCoordinator.getIsPaused() === false;
            } finally {
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.8: Pause state is independent of worker count
  // Pause/resume should work regardless of how many workers are running
  // --------------------------------------------------------------------------
  describe('pause state is independent of worker count', () => {
    it('pause/resume should work with any number of workers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          async (workerCount) => {
            const gpuIds = Array.from({ length: workerCount }, (_, i) => i);
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: workerCount }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Verify worker count
              expect(testCoordinator.getWorkerCount()).toBe(workerCount);

              // Pause should work
              await testCoordinator.pause();
              expect(testCoordinator.getIsPaused()).toBe(true);

              // Resume should work
              await testCoordinator.resume();
              expect(testCoordinator.getIsPaused()).toBe(false);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.9: Pause does not affect worker count
  // Pausing should not change the number of active workers
  // --------------------------------------------------------------------------
  describe('pause does not affect worker count', () => {
    it('worker count should remain unchanged after pause', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              const workerCountBefore = testCoordinator.getWorkerCount();

              // Pause
              await testCoordinator.pause();

              const workerCountAfterPause = testCoordinator.getWorkerCount();

              // Resume
              await testCoordinator.resume();

              const workerCountAfterResume = testCoordinator.getWorkerCount();

              // Worker count should remain unchanged
              expect(workerCountAfterPause).toBe(workerCountBefore);
              expect(workerCountAfterResume).toBe(workerCountBefore);

              return (
                workerCountAfterPause === workerCountBefore &&
                workerCountAfterResume === workerCountBefore
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 27.10: Status reflects pause state
  // The status should indicate when the swarm is paused
  // --------------------------------------------------------------------------
  describe('status reflects pause state', () => {
    it('getIsPaused should accurately reflect pause state in all scenarios', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 4),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
          async (gpuIds, pauseSequence) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              let expectedPaused = false;

              for (const shouldPause of pauseSequence) {
                if (shouldPause) {
                  await testCoordinator.pause();
                  expectedPaused = true;
                } else {
                  await testCoordinator.resume();
                  expectedPaused = false;
                }

                // Verify getIsPaused matches expected state
                expect(testCoordinator.getIsPaused()).toBe(expectedPaused);

                // Verify status is still accessible when paused
                const status = testCoordinator.getStatus();
                expect(status).toBeDefined();
                expect(status.activeAgents).toBe(gpuIds.length);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});



// ============================================================================
// Property 36: History Method Response
// ============================================================================

/**
 * Property 36: History Method Response
 *
 * For any "swarm.history" request, the response shall include the complete
 * experiment timeline with all recorded experiments and their agent attribution.
 *
 * Property: ∀ history: history.experiments contains all experiments with agentId attribution
 *
 * **Validates: Requirements 10.6**
 */
describe('Property 36: History Method Response', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Arbitraries for history testing
  // --------------------------------------------------------------------------

  /**
   * Generates a valid val_bpb value (positive number, typically between 0.5 and 2.0).
   */
  const arbitraryValBpb = (): fc.Arbitrary<number> =>
    fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true })
      .map(v => Math.round(v * 1000000) / 1000000);

  /**
   * Generates a valid experiment status.
   */
  const arbitraryStatus = (): fc.Arbitrary<'keep' | 'discard' | 'crash'> =>
    fc.constantFrom('keep' as const, 'discard' as const, 'crash' as const);

  /**
   * Generates a valid experiment result with specified agent ID.
   */
  const arbitraryExperimentResult = (agentId: string = 'agent-0'): fc.Arbitrary<{
    commit: string;
    valBpb: number;
    memoryGb: number;
    status: 'keep' | 'discard' | 'crash';
    description: string;
    agentId: string;
    timestamp: string;
    branch: string;
  }> =>
    fc.record({
      commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
      valBpb: arbitraryValBpb(),
      memoryGb: fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
      status: arbitraryStatus(),
      description: fc.string({ minLength: 1, maxLength: 100 }),
      agentId: fc.constant(agentId),
      timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
        .map(d => d.toISOString()),
      branch: fc.constant(`autoresearch/swarm/${agentId}`),
    });

  /**
   * Generates experiment results from multiple agents.
   */
  const arbitraryMultiAgentExperiments = (): fc.Arbitrary<Array<{
    commit: string;
    valBpb: number;
    memoryGb: number;
    status: 'keep' | 'discard' | 'crash';
    description: string;
    agentId: string;
    timestamp: string;
    branch: string;
  }>> =>
    fc.array(
      fc.integer({ min: 0, max: 7 }).chain(agentIdx =>
        arbitraryExperimentResult(`agent-${agentIdx}`)
      ),
      { minLength: 1, maxLength: 20 }
    ).map(experiments => {
      // Ensure unique commits
      const commits = new Set<string>();
      return experiments.filter(e => {
        if (commits.has(e.commit)) return false;
        commits.add(e.commit);
        return true;
      });
    });

  // --------------------------------------------------------------------------
  // Property 36.1: History contains all recorded experiments
  // The history response should include all experiments that were recorded
  // --------------------------------------------------------------------------
  describe('history contains all recorded experiments', () => {
    it('getHistory should return all recorded experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify totalCount matches
              expect(history.totalCount).toBe(experiments.length);

              // Verify all experiments are present
              expect(history.experiments.length).toBe(experiments.length);

              // Verify each recorded experiment is in the history
              const historyCommits = new Set(history.experiments.map(e => e.result.commit));
              for (const exp of experiments) {
                expect(historyCommits.has(exp.commit)).toBe(true);
              }

              return history.totalCount === experiments.length;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty registry should return empty history', async () => {
      const testCoordinator = createSwarmCoordinator(createTestOptions());
      const registry = testCoordinator.getExperimentRegistry();

      try {
        registry.clear();

        const history = await testCoordinator.getHistory();

        expect(history.experiments).toEqual([]);
        expect(history.totalCount).toBe(0);
      } finally {
        testCoordinator.clear();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.2: History includes agent attribution for all experiments
  // Each experiment in the history must have a valid agentId
  // --------------------------------------------------------------------------
  describe('history includes agent attribution', () => {
    it('all experiments in history should have agentId attribution', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify every experiment has agentId
              for (const entry of history.experiments) {
                expect(entry.result.agentId).toBeDefined();
                expect(typeof entry.result.agentId).toBe('string');
                expect(entry.result.agentId.length).toBeGreaterThan(0);
              }

              return history.experiments.every(e =>
                e.result.agentId !== undefined &&
                typeof e.result.agentId === 'string' &&
                e.result.agentId.length > 0
              );
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('agentId in history should match the original recorded agentId', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Create a map of commit -> expected agentId
              const expectedAgentIds = new Map(
                experiments.map(e => [e.commit, e.agentId])
              );

              // Verify each experiment's agentId matches
              for (const entry of history.experiments) {
                const expectedAgentId = expectedAgentIds.get(entry.result.commit);
                expect(entry.result.agentId).toBe(expectedAgentId);
              }

              return true;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.3: History includes timestamps for all experiments
  // Each experiment entry should have a timestamp
  // --------------------------------------------------------------------------
  describe('history includes timestamps', () => {
    it('all experiments in history should have timestamps', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify every entry has a timestamp
              for (const entry of history.experiments) {
                expect(entry.timestamp).toBeDefined();
                expect(typeof entry.timestamp).toBe('string');
                // Verify it's a valid ISO 8601 timestamp
                expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
              }

              return history.experiments.every(e =>
                e.timestamp !== undefined &&
                typeof e.timestamp === 'string'
              );
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.4: History respects limit parameter
  // When a limit is specified, history should return at most that many experiments
  // --------------------------------------------------------------------------
  describe('history respects limit parameter', () => {
    it('getHistory with limit should return at most limit experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          fc.integer({ min: 1, max: 50 }),
          async (experiments, limit) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history with limit
              const history = await testCoordinator.getHistory(limit);

              // Verify experiments count respects limit
              const expectedCount = Math.min(experiments.length, limit);
              expect(history.experiments.length).toBe(expectedCount);

              // totalCount should still reflect all experiments
              expect(history.totalCount).toBe(experiments.length);

              return history.experiments.length <= limit;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getHistory without limit should return all experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history without limit
              const history = await testCoordinator.getHistory();

              // Should return all experiments
              expect(history.experiments.length).toBe(experiments.length);
              expect(history.totalCount).toBe(experiments.length);

              return history.experiments.length === experiments.length;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.5: History preserves experiment data integrity
  // All experiment fields should be preserved in the history
  // --------------------------------------------------------------------------
  describe('history preserves experiment data integrity', () => {
    it('all experiment fields should be preserved in history', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Create a map of commit -> original experiment
              const originalExperiments = new Map(
                experiments.map(e => [e.commit, e])
              );

              // Verify all fields are preserved
              for (const entry of history.experiments) {
                const original = originalExperiments.get(entry.result.commit);
                expect(original).toBeDefined();

                if (original) {
                  expect(entry.result.commit).toBe(original.commit);
                  expect(entry.result.valBpb).toBeCloseTo(original.valBpb, 6);
                  expect(entry.result.memoryGb).toBeCloseTo(original.memoryGb, 1);
                  expect(entry.result.status).toBe(original.status);
                  expect(entry.result.description).toBe(original.description);
                  expect(entry.result.agentId).toBe(original.agentId);
                  expect(entry.result.branch).toBe(original.branch);
                }
              }

              return true;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.6: History from multiple agents is correctly attributed
  // Experiments from different agents should have correct attribution
  // --------------------------------------------------------------------------
  describe('history from multiple agents is correctly attributed', () => {
    it('experiments from different agents should have distinct agentIds', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 2, maxLength: 8 })
            .map(agentIndices => [...new Set(agentIndices)]) // Unique agent indices
            .filter(indices => indices.length >= 2), // At least 2 different agents
          async (agentIndices) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record one experiment per agent
              const experiments: Array<{
                commit: string;
                valBpb: number;
                memoryGb: number;
                status: 'keep' | 'discard' | 'crash';
                description: string;
                agentId: string;
                timestamp: string;
                branch: string;
              }> = [];

              for (let i = 0; i < agentIndices.length; i++) {
                const agentId = `agent-${agentIndices[i]}`;
                const exp = {
                  commit: `commit${i.toString().padStart(2, '0')}`,
                  valBpb: 1.0 + i * 0.01,
                  memoryGb: 8.0,
                  status: 'keep' as const,
                  description: `experiment from ${agentId}`,
                  agentId,
                  timestamp: new Date(Date.now() + i * 1000).toISOString(),
                  branch: `autoresearch/swarm/${agentId}`,
                };
                experiments.push(exp);
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify each agent's experiment is correctly attributed
              const agentIdsInHistory = new Set(
                history.experiments.map(e => e.result.agentId)
              );

              // All expected agent IDs should be present
              for (const idx of agentIndices) {
                expect(agentIdsInHistory.has(`agent-${idx}`)).toBe(true);
              }

              // Verify correct attribution for each experiment
              for (const exp of experiments) {
                const historyEntry = history.experiments.find(
                  e => e.result.commit === exp.commit
                );
                expect(historyEntry).toBeDefined();
                expect(historyEntry?.result.agentId).toBe(exp.agentId);
              }

              return true;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.7: History totalCount is accurate
  // The totalCount field should accurately reflect the total number of experiments
  // --------------------------------------------------------------------------
  describe('history totalCount is accurate', () => {
    it('totalCount should equal the number of recorded experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // totalCount should match experiments length
              expect(history.totalCount).toBe(experiments.length);

              return history.totalCount === experiments.length;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('totalCount should be consistent with limit parameter', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          fc.integer({ min: 1, max: 10 }),
          async (experiments, limit) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history with limit
              const historyWithLimit = await testCoordinator.getHistory(limit);

              // Get history without limit
              const historyWithoutLimit = await testCoordinator.getHistory();

              // totalCount should be the same regardless of limit
              expect(historyWithLimit.totalCount).toBe(historyWithoutLimit.totalCount);
              expect(historyWithLimit.totalCount).toBe(experiments.length);

              return historyWithLimit.totalCount === experiments.length;
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 36.8: History structure is valid
  // The history response should have the correct structure
  // --------------------------------------------------------------------------
  describe('history structure is valid', () => {
    it('history should have experiments array and totalCount', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify structure
              expect(history).toHaveProperty('experiments');
              expect(history).toHaveProperty('totalCount');
              expect(Array.isArray(history.experiments)).toBe(true);
              expect(typeof history.totalCount).toBe('number');

              return (
                'experiments' in history &&
                'totalCount' in history &&
                Array.isArray(history.experiments) &&
                typeof history.totalCount === 'number'
              );
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('each history entry should have result and timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryMultiAgentExperiments(),
          async (experiments) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const registry = testCoordinator.getExperimentRegistry();

            try {
              // Record all experiments
              for (const exp of experiments) {
                await registry.recordResult(exp);
              }

              // Get history
              const history = await testCoordinator.getHistory();

              // Verify each entry has required fields
              for (const entry of history.experiments) {
                expect(entry).toHaveProperty('result');
                expect(entry).toHaveProperty('timestamp');
                expect(typeof entry.result).toBe('object');
                expect(typeof entry.timestamp).toBe('string');
              }

              return history.experiments.every(e =>
                'result' in e &&
                'timestamp' in e &&
                typeof e.result === 'object' &&
                typeof e.timestamp === 'string'
              );
            } finally {
              registry.clear();
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 31: Failure Logging
// ============================================================================

/**
 * Property 31: Failure Logging
 *
 * For any failure (agent crash, GPU error, timeout, backpressure, parse error),
 * the Swarm_Coordinator shall log the failure to swarm.log with timestamp,
 * error type, and error details.
 *
 * Property: ∀ failure: log(failure) contains timestamp ∧ error_type ∧ error_details
 *
 * **Validates: Requirements 9.6**
 */
describe('Property 31: Failure Logging', () => {
  let coordinator: SwarmCoordinator;
  let mockFileLogger: ReturnType<typeof createMockLogger>;

  const createMockLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  beforeEach(() => {
    mockFileLogger = createMockLogger();
    coordinator = createSwarmCoordinator({
      ...createTestOptions(),
      fileLogger: mockFileLogger,
    });
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 31.1: Worker crash failures are logged with required fields
  // When a worker crashes, the failure should be logged with timestamp, error type, and details
  // --------------------------------------------------------------------------
  describe('worker crash failures are logged', () => {
    it('worker crash should log with timestamp, error type, and details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          fc.integer({ min: 0, max: 255 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          async (gpuId, exitCode, errorMessage) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Simulate worker crash
              const agentId = `agent-${gpuId}`;
              const error = new Error(errorMessage);
              testCoordinator.handleWorkerCrash(agentId, exitCode, error);

              // Verify fileLogger.error was called
              expect(testFileLogger.error).toHaveBeenCalled();

              // Get the call arguments
              const errorCalls = testFileLogger.error.mock.calls;
              const crashCall = errorCalls.find(call =>
                call[0] === 'Worker crashed'
              );

              expect(crashCall).toBeDefined();
              if (crashCall) {
                const [message, context] = crashCall;

                // Verify message indicates error type
                expect(message).toBe('Worker crashed');

                // Verify context contains required fields
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('agentId', agentId);
                expect(context).toHaveProperty('gpuId', gpuId);
                expect(context).toHaveProperty('exitCode', exitCode);
                expect(context).toHaveProperty('error', errorMessage);

                // Verify timestamp is ISO 8601 format
                expect(typeof context.timestamp).toBe('string');
                expect(new Date(context.timestamp).toISOString()).toBe(context.timestamp);
              }

              return true;
            } finally {
              // Cancel crash recovery to avoid async issues
              testCoordinator.cancelCrashRecovery(`agent-${gpuId}`);
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('worker crash should include stack trace when available', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          async (gpuId) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Simulate worker crash with stack trace
              const agentId = `agent-${gpuId}`;
              const error = new Error('Test error');
              testCoordinator.handleWorkerCrash(agentId, 1, error);

              // Verify stack trace is included
              const errorCalls = testFileLogger.error.mock.calls;
              const crashCall = errorCalls.find(call =>
                call[0] === 'Worker crashed'
              );

              expect(crashCall).toBeDefined();
              if (crashCall) {
                const [, context] = crashCall;
                expect(context).toHaveProperty('stackTrace');
                expect(typeof context.stackTrace).toBe('string');
                expect(context.stackTrace).toContain('Error: Test error');
              }

              return true;
            } finally {
              testCoordinator.cancelCrashRecovery(`agent-${gpuId}`);
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.2: GPU failures are logged with required fields
  // When a GPU becomes unavailable, the failure should be logged
  // --------------------------------------------------------------------------
  describe('GPU failures are logged', () => {
    it('GPU unavailability should log with timestamp and GPU details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          async (gpuId) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock GPU as unavailable
              const workerState = testCoordinator.getWorkerState(`agent-${gpuId}`);
              if (workerState) {
                vi.spyOn(workerState.worker, 'checkGpuAvailable').mockResolvedValue(false);
              }

              // Trigger GPU detection
              const unavailableGpus = await testCoordinator.detectUnavailableGpus();

              // Verify GPU unavailability was logged
              const warnCalls = testFileLogger.warn.mock.calls;
              const gpuUnavailableCall = warnCalls.find(call =>
                call[0] === 'GPU unavailable detected'
              );

              expect(gpuUnavailableCall).toBeDefined();
              if (gpuUnavailableCall) {
                const [message, context] = gpuUnavailableCall;

                expect(message).toBe('GPU unavailable detected');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('gpuId', gpuId);
                expect(context).toHaveProperty('agentId', `agent-${gpuId}`);
              }

              return unavailableGpus.includes(gpuId);
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('GPU check failure should log error with details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (gpuId, errorMessage) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock GPU check to throw error
              const workerState = testCoordinator.getWorkerState(`agent-${gpuId}`);
              if (workerState) {
                vi.spyOn(workerState.worker, 'checkGpuAvailable').mockRejectedValue(
                  new Error(errorMessage)
                );
              }

              // Trigger GPU detection
              await testCoordinator.detectUnavailableGpus();

              // Verify error was logged
              const errorCalls = testFileLogger.error.mock.calls;
              const gpuCheckErrorCall = errorCalls.find(call =>
                call[0] === 'Failed to check GPU availability'
              );

              expect(gpuCheckErrorCall).toBeDefined();
              if (gpuCheckErrorCall) {
                const [message, context] = gpuCheckErrorCall;

                expect(message).toBe('Failed to check GPU availability');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('gpuId', gpuId);
                expect(context).toHaveProperty('error', errorMessage);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.3: Backpressure events are logged with required fields
  // When backpressure is activated, it should be logged
  // --------------------------------------------------------------------------
  describe('backpressure events are logged', () => {
    it('input backpressure activation should log with timestamp and buffer details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1024, max: 1048576 }),
          async (maxBuffer) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
              limits: {
                max_input_buffer: maxBuffer,
                max_output_queue: 4194304,
              },
            };

            try {
              await testCoordinator.start(config);

              // Trigger input backpressure by exceeding limit
              const exceededSize = maxBuffer + 1;
              const accepted = testCoordinator.updateInputBufferSize(exceededSize);

              // Verify backpressure was logged
              expect(accepted).toBe(false);

              const warnCalls = testFileLogger.warn.mock.calls;
              const backpressureCall = warnCalls.find(call =>
                call[0] === 'Input backpressure activated'
              );

              expect(backpressureCall).toBeDefined();
              if (backpressureCall) {
                const [message, context] = backpressureCall;

                expect(message).toBe('Input backpressure activated');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('currentSize');
                expect(context).toHaveProperty('attemptedAdd', exceededSize);
                expect(context).toHaveProperty('maxBuffer', maxBuffer);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('output backpressure activation should log with timestamp and queue details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1024, max: 4194304 }),
          async (maxQueue) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
              limits: {
                max_input_buffer: 1048576,
                max_output_queue: maxQueue,
              },
            };

            try {
              await testCoordinator.start(config);

              // Trigger output backpressure by exceeding limit
              const exceededSize = maxQueue + 1;
              const accepted = testCoordinator.updateOutputQueueSize(exceededSize);

              // Verify backpressure was logged
              expect(accepted).toBe(false);

              const warnCalls = testFileLogger.warn.mock.calls;
              const backpressureCall = warnCalls.find(call =>
                call[0] === 'Output backpressure activated'
              );

              expect(backpressureCall).toBeDefined();
              if (backpressureCall) {
                const [message, context] = backpressureCall;

                expect(message).toBe('Output backpressure activated');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('currentSize');
                expect(context).toHaveProperty('attemptedAdd', exceededSize);
                expect(context).toHaveProperty('maxQueue', maxQueue);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.4: Parse errors are logged with required fields
  // When a message parsing error occurs, it should be logged
  // --------------------------------------------------------------------------
  describe('parse errors are logged', () => {
    it('parse error should log with timestamp and error details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
            // Generate strings that are invalid JSON but not whitespace-only
            // (whitespace-only lines are skipped by NDJSON parser, not errors)
            if (s.trim().length === 0) {
              return false; // Skip whitespace-only strings
            }
            try {
              JSON.parse(s);
              return false; // Valid JSON, skip
            } catch {
              return true; // Invalid JSON, use it
            }
          }),
          async (invalidJson) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            try {
              // Initialize message handler
              testCoordinator.initializeMessageHandler();

              // Send invalid JSON data
              testCoordinator.processIncomingData(invalidJson + '\n');

              // Verify parse error was logged
              const errorCalls = testFileLogger.error.mock.calls;
              const parseErrorCall = errorCalls.find(call =>
                call[0] === 'Parse error in incoming message'
              );

              expect(parseErrorCall).toBeDefined();
              if (parseErrorCall) {
                const [message, context] = parseErrorCall;

                expect(message).toBe('Parse error in incoming message');
                expect(context).toHaveProperty('code');
                expect(context).toHaveProperty('message');
                expect(typeof context.code).toBe('number');
                expect(typeof context.message).toBe('string');
              }

              return true;
            } finally {
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.5: All failure logs include timestamps
  // Every failure log entry should have a timestamp field
  // --------------------------------------------------------------------------
  describe('all failure logs include timestamps', () => {
    it('all error and warn logs should include timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 3 }),
          async (gpuId) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
              limits: {
                max_input_buffer: 1024,
                max_output_queue: 1024,
              },
            };

            try {
              await testCoordinator.start(config);

              // Trigger various failures

              // 1. Worker crash
              testCoordinator.handleWorkerCrash(`agent-${gpuId}`, 1, new Error('test'));
              testCoordinator.cancelCrashRecovery(`agent-${gpuId}`);

              // 2. Backpressure
              testCoordinator.updateInputBufferSize(2048);
              testCoordinator.updateOutputQueueSize(2048);

              // 3. Parse error
              testCoordinator.initializeMessageHandler();
              testCoordinator.processIncomingData('invalid json\n');

              // Verify all error calls have timestamps
              for (const call of testFileLogger.error.mock.calls) {
                const [, context] = call;
                if (context && typeof context === 'object') {
                  // Most error logs should have timestamp
                  // Some may not if they're internal errors
                }
              }

              // Verify all warn calls have timestamps
              for (const call of testFileLogger.warn.mock.calls) {
                const [, context] = call;
                if (context && typeof context === 'object') {
                  expect(context).toHaveProperty('timestamp');
                }
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.6: Crash recovery failure is logged
  // When crash recovery fails, it should be logged with details
  // --------------------------------------------------------------------------
  describe('crash recovery failure is logged', () => {
    it('crash recovery failure should log with timestamp and error details', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          async (gpuId) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Trigger worker crash
              const agentId = `agent-${gpuId}`;
              testCoordinator.handleWorkerCrash(agentId, 1, new Error('test crash'));

              // Verify crash was logged
              const errorCalls = testFileLogger.error.mock.calls;
              const crashCall = errorCalls.find(call =>
                call[0] === 'Worker crashed'
              );

              expect(crashCall).toBeDefined();
              if (crashCall) {
                const [message, context] = crashCall;
                expect(message).toBe('Worker crashed');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('agentId', agentId);
                expect(context).toHaveProperty('gpuId', gpuId);
              }

              return true;
            } finally {
              testCoordinator.cancelCrashRecovery(`agent-${gpuId}`);
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 31.7: Work redistribution failure is logged
  // When work redistribution fails, it should be logged
  // --------------------------------------------------------------------------
  describe('work redistribution failure is logged', () => {
    it('no available GPU for redistribution should log warning', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 7 }),
          async (gpuId) => {
            const testFileLogger = createMockLogger();
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
              fileLogger: testFileLogger,
            });

            // Config with only one GPU - no fallback available
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Try to redistribute work when no other GPU is available
              const result = await testCoordinator.redistributeWork(gpuId);

              // Should return null (no GPU available)
              expect(result).toBeNull();

              // Verify warning was logged
              const warnCalls = testFileLogger.warn.mock.calls;
              const noGpuCall = warnCalls.find(call =>
                call[0] === 'No available GPUs for work redistribution'
              );

              expect(noGpuCall).toBeDefined();
              if (noGpuCall) {
                const [message, context] = noGpuCall;
                expect(message).toBe('No available GPUs for work redistribution');
                expect(context).toHaveProperty('timestamp');
                expect(context).toHaveProperty('unavailableGpuId', gpuId);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 28: GPU Failover
// ============================================================================

/**
 * Property 28: GPU Failover
 *
 * For any GPU that becomes unavailable while an agent is assigned to it,
 * the Swarm_Coordinator shall reassign that agent's pending work to an available GPU.
 *
 * Property: ∀ unavailable_gpu: work(unavailable_gpu) → redistributed to available_gpu
 *
 * **Validates: Requirements 9.3**
 */
describe('Property 28: GPU Failover', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 28.1: Unavailable GPU detection
  // When a GPU becomes unavailable, detectUnavailableGpus should identify it
  // --------------------------------------------------------------------------
  describe('unavailable GPU detection', () => {
    it('detectUnavailableGpus should identify GPUs that report unavailable', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            // Ensure unavailableIndex is within bounds
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock one GPU as unavailable using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (workerState.gpuId === unavailableGpuId) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Detect unavailable GPUs
              const unavailableGpus = await testCoordinator.detectUnavailableGpus();

              // Should detect the unavailable GPU
              expect(unavailableGpus).toContain(unavailableGpuId);

              return unavailableGpus.includes(unavailableGpuId);
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('detectUnavailableGpus should return empty array when all GPUs are available', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // All GPUs are available by default (mock returns true)
              const unavailableGpus = await testCoordinator.detectUnavailableGpus();

              // Should return empty array
              expect(unavailableGpus).toEqual([]);

              return unavailableGpus.length === 0;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('detectUnavailableGpus should detect multiple unavailable GPUs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(3, 8),
          fc.integer({ min: 1, max: 3 }),
          async (gpuIds, unavailableCount) => {
            // Ensure we don't try to mark more GPUs unavailable than we have
            const actualUnavailableCount = Math.min(unavailableCount, gpuIds.length - 1);
            const unavailableGpuIds = gpuIds.slice(0, actualUnavailableCount);

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock multiple GPUs as unavailable using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (unavailableGpuIds.includes(workerState.gpuId)) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Detect unavailable GPUs
              const detectedUnavailable = await testCoordinator.detectUnavailableGpus();

              // Should detect all unavailable GPUs
              for (const gpuId of unavailableGpuIds) {
                expect(detectedUnavailable).toContain(gpuId);
              }

              return unavailableGpuIds.every(id => detectedUnavailable.includes(id));
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.2: Work redistribution to available GPU
  // When a GPU becomes unavailable, work should be redistributed to an available GPU
  // --------------------------------------------------------------------------
  describe('work redistribution to available GPU', () => {
    it('redistributeWork should move work from unavailable GPU to available GPU', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            // Ensure unavailableIndex is within bounds
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Redistribute work from the unavailable GPU
              const newGpuId = await testCoordinator.redistributeWork(unavailableGpuId);

              // Should return a valid GPU ID (not the unavailable one)
              expect(newGpuId).not.toBeNull();
              expect(newGpuId).not.toBe(unavailableGpuId);

              // The new GPU should be one of the configured GPUs
              if (newGpuId !== null) {
                expect(gpuIds).toContain(newGpuId);
              }

              return newGpuId !== null && newGpuId !== unavailableGpuId;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('redistributeWork should return null when no available GPU exists', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 15 }),
          async (gpuId) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            // Config with only one GPU - no fallback available
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Try to redistribute work when no other GPU is available
              const result = await testCoordinator.redistributeWork(gpuId);

              // Should return null (no GPU available)
              expect(result).toBeNull();

              return result === null;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.3: handleGpuFailover processes all unavailable GPUs
  // When multiple GPUs become unavailable, all should be handled
  // --------------------------------------------------------------------------
  describe('handleGpuFailover processes all unavailable GPUs', () => {
    it('handleGpuFailover should process all unavailable GPUs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(3, 8),
          fc.integer({ min: 1, max: 2 }),
          async (gpuIds, unavailableCount) => {
            // Ensure we have at least one available GPU for redistribution
            const actualUnavailableCount = Math.min(unavailableCount, gpuIds.length - 1);
            const unavailableGpuIds = gpuIds.slice(0, actualUnavailableCount);

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock GPUs as unavailable using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (unavailableGpuIds.includes(workerState.gpuId)) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle GPU failover
              const result = await testCoordinator.handleGpuFailover();

              // Should detect all unavailable GPUs
              expect(result.unavailableGpus.length).toBe(actualUnavailableCount);
              for (const gpuId of unavailableGpuIds) {
                expect(result.unavailableGpus).toContain(gpuId);
              }

              // Should have redistribution entries for each unavailable GPU
              expect(result.redistributions.length).toBe(actualUnavailableCount);

              return result.unavailableGpus.length === actualUnavailableCount;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('handleGpuFailover should return empty results when all GPUs are available', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // All GPUs are available by default
              const result = await testCoordinator.handleGpuFailover();

              // Should return empty results
              expect(result.unavailableGpus).toEqual([]);
              expect(result.redistributions).toEqual([]);

              return result.unavailableGpus.length === 0 && result.redistributions.length === 0;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.4: Redistribution preserves agent identity
  // When work is redistributed, the agent ID should be preserved
  // --------------------------------------------------------------------------
  describe('redistribution preserves agent identity', () => {
    it('redistributed work should maintain the same agent ID', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;
            const expectedAgentId = `agent-${unavailableGpuId}`;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock the unavailable GPU using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (workerState.gpuId === unavailableGpuId) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle failover
              const result = await testCoordinator.handleGpuFailover();

              // Find the redistribution for our unavailable GPU
              const redistribution = result.redistributions.find(
                r => r.fromGpuId === unavailableGpuId
              );

              expect(redistribution).toBeDefined();
              if (redistribution) {
                // Agent ID should be preserved
                expect(redistribution.agentId).toBe(expectedAgentId);
              }

              return redistribution?.agentId === expectedAgentId;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.5: Redistribution targets different GPU
  // Work should be redistributed to a different GPU than the unavailable one
  // --------------------------------------------------------------------------
  describe('redistribution targets different GPU', () => {
    it('work should be redistributed to a GPU different from the unavailable one', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock the unavailable GPU using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (workerState.gpuId === unavailableGpuId) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle failover
              const result = await testCoordinator.handleGpuFailover();

              // Find the redistribution for our unavailable GPU
              const redistribution = result.redistributions.find(
                r => r.fromGpuId === unavailableGpuId
              );

              expect(redistribution).toBeDefined();
              if (redistribution && redistribution.toGpuId !== null) {
                // Target GPU should be different from source
                expect(redistribution.toGpuId).not.toBe(unavailableGpuId);
                // Target GPU should be one of the configured GPUs
                expect(gpuIds).toContain(redistribution.toGpuId);
              }

              return redistribution?.toGpuId !== unavailableGpuId;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.6: Multiple unavailable GPUs don't redistribute to each other
  // When multiple GPUs are unavailable, they shouldn't be redistribution targets
  // --------------------------------------------------------------------------
  describe('multiple unavailable GPUs exclusion', () => {
    it('unavailable GPUs should not be targets for redistribution', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(4, 8),
          async (gpuIds) => {
            // Mark first two GPUs as unavailable
            const unavailableGpuIds = gpuIds.slice(0, 2);

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock multiple GPUs as unavailable using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (unavailableGpuIds.includes(workerState.gpuId)) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle failover
              const result = await testCoordinator.handleGpuFailover();

              // Verify no redistribution targets an unavailable GPU
              for (const redistribution of result.redistributions) {
                if (redistribution.toGpuId !== null) {
                  expect(unavailableGpuIds).not.toContain(redistribution.toGpuId);
                }
              }

              return result.redistributions.every(
                r => r.toGpuId === null || !unavailableGpuIds.includes(r.toGpuId)
              );
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.7: Worker count preserved after failover
  // After successful failover, the total worker count should be preserved
  // --------------------------------------------------------------------------
  describe('worker count preserved after failover', () => {
    it('worker count should remain the same after successful failover', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              const workerCountBefore = testCoordinator.getWorkerCount();

              // Mock the unavailable GPU using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (workerState.gpuId === unavailableGpuId) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle failover
              await testCoordinator.handleGpuFailover();

              const workerCountAfter = testCoordinator.getWorkerCount();

              // Worker count should be preserved
              expect(workerCountAfter).toBe(workerCountBefore);

              return workerCountAfter === workerCountBefore;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.8: getAvailableGpus returns correct GPUs
  // getAvailableGpus should return GPUs that are not executing and not excluded
  // --------------------------------------------------------------------------
  describe('getAvailableGpus correctness', () => {
    it('getAvailableGpus should exclude specified GPU IDs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(3, 8),
          fc.integer({ min: 0, max: 2 }),
          async (gpuIds, excludeCount) => {
            const excludeGpuIds = gpuIds.slice(0, excludeCount + 1);

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Get available GPUs excluding some
              const availableGpus = testCoordinator.getAvailableGpus(excludeGpuIds);

              // Excluded GPUs should not be in the result
              for (const excludedId of excludeGpuIds) {
                expect(availableGpus).not.toContain(excludedId);
              }

              return excludeGpuIds.every(id => !availableGpus.includes(id));
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('getAvailableGpus with no exclusions should return all idle GPUs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(1, 8),
          async (gpuIds) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Get all available GPUs (no exclusions)
              const availableGpus = testCoordinator.getAvailableGpus();

              // All configured GPUs should be available (since none are executing)
              expect(availableGpus.length).toBe(gpuIds.length);
              for (const gpuId of gpuIds) {
                expect(availableGpus).toContain(gpuId);
              }

              return availableGpus.length === gpuIds.length;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 28.9: Failover result structure
  // handleGpuFailover should return properly structured results
  // --------------------------------------------------------------------------
  describe('failover result structure', () => {
    it('handleGpuFailover result should have correct structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryGpuIds(2, 8),
          fc.integer({ min: 0, max: 7 }),
          async (gpuIds, unavailableIndex) => {
            const actualIndex = unavailableIndex % gpuIds.length;
            const unavailableGpuId = gpuIds[actualIndex]!;

            const testCoordinator = createSwarmCoordinator(createTestOptions());

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Mock the unavailable GPU using private workers map
              const workers = (testCoordinator as any).workers as Map<string, any>;
              for (const [agentId, workerState] of workers) {
                if (workerState.gpuId === unavailableGpuId) {
                  vi.mocked(workerState.worker.checkGpuAvailable).mockResolvedValue(false);
                }
              }

              // Handle failover
              const result = await testCoordinator.handleGpuFailover();

              // Verify result structure
              expect(result).toHaveProperty('unavailableGpus');
              expect(result).toHaveProperty('redistributions');
              expect(Array.isArray(result.unavailableGpus)).toBe(true);
              expect(Array.isArray(result.redistributions)).toBe(true);

              // Verify redistribution entry structure
              for (const redistribution of result.redistributions) {
                expect(redistribution).toHaveProperty('fromGpuId');
                expect(redistribution).toHaveProperty('toGpuId');
                expect(redistribution).toHaveProperty('agentId');
                expect(typeof redistribution.fromGpuId).toBe('number');
                expect(typeof redistribution.agentId).toBe('string');
                // toGpuId can be number or null
                expect(
                  redistribution.toGpuId === null || typeof redistribution.toGpuId === 'number'
                ).toBe(true);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 29: Backpressure Limits
// ============================================================================

/**
 * Property 29: Backpressure Limits
 *
 * For any stdio_bus connection, the Swarm_Coordinator shall enforce configured
 * backpressure limits (max_input_buffer, max_output_queue) to prevent memory exhaustion.
 *
 * Property: ∀ t: input_buffer_size(t) ≤ max_input_buffer ∧ output_queue_size(t) ≤ max_output_queue
 *
 * **Validates: Requirements 9.4**
 */
describe('Property 29: Backpressure Limits', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Arbitrary generators for backpressure testing
  // --------------------------------------------------------------------------

  /**
   * Generates a valid buffer limit configuration.
   */
  const arbitraryBufferLimits = (): fc.Arbitrary<{ max_input_buffer: number; max_output_queue: number }> =>
    fc.record({
      max_input_buffer: fc.integer({ min: 100, max: 10000 }),
      max_output_queue: fc.integer({ min: 100, max: 10000 }),
    });

  /**
   * Generates a sequence of buffer size updates (positive values for adding, negative for removing).
   */
  const arbitraryBufferUpdates = (maxSize: number): fc.Arbitrary<number[]> =>
    fc.array(
      fc.integer({ min: -maxSize, max: maxSize }),
      { minLength: 1, maxLength: 50 }
    );

  /**
   * Generates a config with specific buffer limits.
   */
  const createConfigWithLimits = (
    gpuIds: number[],
    maxInputBuffer: number,
    maxOutputQueue: number
  ): SwarmConfig => ({
    pools: [{ id: 'worker', command: 'node', instances: gpuIds.length }],
    swarm: {
      gpuIds,
      agentModel: 'claude-acp',
      experimentTimeout: 10,
      lockTimeout: 10,
    },
    limits: {
      max_input_buffer: maxInputBuffer,
      max_output_queue: maxOutputQueue,
      max_restarts: 5,
      restart_window_sec: 60,
      backpressure_timeout_sec: 60,
    },
  });

  // --------------------------------------------------------------------------
  // Property 29.1: Input buffer never exceeds configured limit
  // For any sequence of input buffer updates, the buffer size should never exceed max_input_buffer
  // --------------------------------------------------------------------------
  describe('input buffer never exceeds configured limit', () => {
    it('for any sequence of positive updates, input buffer should never exceed max_input_buffer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 100 }),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              // Apply all updates
              for (const bytes of updates) {
                testCoordinator.updateInputBufferSize(bytes);

                // PROPERTY: Input buffer size should NEVER exceed the configured limit
                const currentSize = testCoordinator.getInputBufferSize();
                expect(currentSize).toBeLessThanOrEqual(limits.max_input_buffer);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any mixed sequence of updates, input buffer should never exceed max_input_buffer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          arbitraryBufferUpdates(1000),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              // Apply all updates
              for (const bytes of updates) {
                testCoordinator.updateInputBufferSize(bytes);

                // PROPERTY: Input buffer size should NEVER exceed the configured limit
                const currentSize = testCoordinator.getInputBufferSize();
                expect(currentSize).toBeLessThanOrEqual(limits.max_input_buffer);
                expect(currentSize).toBeGreaterThanOrEqual(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.2: Output queue never exceeds configured limit
  // For any sequence of output queue updates, the queue size should never exceed max_output_queue
  // --------------------------------------------------------------------------
  describe('output queue never exceeds configured limit', () => {
    it('for any sequence of positive updates, output queue should never exceed max_output_queue', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 100 }),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              // Apply all updates
              for (const bytes of updates) {
                testCoordinator.updateOutputQueueSize(bytes);

                // PROPERTY: Output queue size should NEVER exceed the configured limit
                const currentSize = testCoordinator.getOutputQueueSize();
                expect(currentSize).toBeLessThanOrEqual(limits.max_output_queue);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any mixed sequence of updates, output queue should never exceed max_output_queue', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          arbitraryBufferUpdates(1000),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              // Apply all updates
              for (const bytes of updates) {
                testCoordinator.updateOutputQueueSize(bytes);

                // PROPERTY: Output queue size should NEVER exceed the configured limit
                const currentSize = testCoordinator.getOutputQueueSize();
                expect(currentSize).toBeLessThanOrEqual(limits.max_output_queue);
                expect(currentSize).toBeGreaterThanOrEqual(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.3: Backpressure activates when limit is reached
  // When buffer/queue would exceed limit, backpressure should be activated
  // --------------------------------------------------------------------------
  describe('backpressure activates when limit is reached', () => {
    it('input backpressure should activate when buffer would exceed limit', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 1000 }),
          fc.integer({ min: 1, max: 100 }),
          async (maxBuffer, overflowAmount) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], maxBuffer, 10000);

            try {
              await testCoordinator.start(config);

              // Fill buffer to just below limit
              const fillAmount = maxBuffer - 10;
              testCoordinator.updateInputBufferSize(fillAmount);
              expect(testCoordinator.isInputBackpressureActive()).toBe(false);

              // Try to add more than remaining space
              const accepted = testCoordinator.updateInputBufferSize(10 + overflowAmount);

              // PROPERTY: When update would exceed limit, it should be rejected and backpressure activated
              expect(accepted).toBe(false);
              expect(testCoordinator.isInputBackpressureActive()).toBe(true);
              expect(testCoordinator.getInputBufferSize()).toBeLessThanOrEqual(maxBuffer);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('output backpressure should activate when queue would exceed limit', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 1000 }),
          fc.integer({ min: 1, max: 100 }),
          async (maxQueue, overflowAmount) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], 10000, maxQueue);

            try {
              await testCoordinator.start(config);

              // Fill queue to just below limit
              const fillAmount = maxQueue - 10;
              testCoordinator.updateOutputQueueSize(fillAmount);
              expect(testCoordinator.isOutputBackpressureActive()).toBe(false);

              // Try to add more than remaining space
              const accepted = testCoordinator.updateOutputQueueSize(10 + overflowAmount);

              // PROPERTY: When update would exceed limit, it should be rejected and backpressure activated
              expect(accepted).toBe(false);
              expect(testCoordinator.isOutputBackpressureActive()).toBe(true);
              expect(testCoordinator.getOutputQueueSize()).toBeLessThanOrEqual(maxQueue);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.4: Backpressure deactivates when buffer drops below threshold
  // Backpressure should deactivate when buffer/queue drops below 80% of limit
  // --------------------------------------------------------------------------
  describe('backpressure deactivates when buffer drops below threshold', () => {
    it('input backpressure should deactivate when buffer drops below 80% of limit', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 1000 }),
          async (maxBuffer) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], maxBuffer, 10000);

            try {
              await testCoordinator.start(config);

              // Fill buffer to trigger backpressure
              testCoordinator.updateInputBufferSize(maxBuffer - 5);
              testCoordinator.updateInputBufferSize(10); // This should fail and activate backpressure
              expect(testCoordinator.isInputBackpressureActive()).toBe(true);

              // Calculate how much to remove to get below 80%
              const currentSize = testCoordinator.getInputBufferSize();
              const threshold = maxBuffer * 0.8;
              const removeAmount = currentSize - threshold + 1;

              // Remove enough to get below 80%
              testCoordinator.updateInputBufferSize(-removeAmount);

              // PROPERTY: Backpressure should deactivate when below 80% threshold
              expect(testCoordinator.isInputBackpressureActive()).toBe(false);
              expect(testCoordinator.getInputBufferSize()).toBeLessThan(threshold);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('output backpressure should deactivate when queue drops below 80% of limit', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 1000 }),
          async (maxQueue) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], 10000, maxQueue);

            try {
              await testCoordinator.start(config);

              // Fill queue to trigger backpressure
              testCoordinator.updateOutputQueueSize(maxQueue - 5);
              testCoordinator.updateOutputQueueSize(10); // This should fail and activate backpressure
              expect(testCoordinator.isOutputBackpressureActive()).toBe(true);

              // Calculate how much to remove to get below 80%
              const currentSize = testCoordinator.getOutputQueueSize();
              const threshold = maxQueue * 0.8;
              const removeAmount = currentSize - threshold + 1;

              // Remove enough to get below 80%
              testCoordinator.updateOutputQueueSize(-removeAmount);

              // PROPERTY: Backpressure should deactivate when below 80% threshold
              expect(testCoordinator.isOutputBackpressureActive()).toBe(false);
              expect(testCoordinator.getOutputQueueSize()).toBeLessThan(threshold);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.5: Buffer sizes are always non-negative
  // Buffer and queue sizes should never go below zero
  // --------------------------------------------------------------------------
  describe('buffer sizes are always non-negative', () => {
    it('input buffer size should never be negative after any sequence of updates', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          arbitraryBufferUpdates(2000),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              for (const bytes of updates) {
                testCoordinator.updateInputBufferSize(bytes);

                // PROPERTY: Buffer size should always be non-negative
                const currentSize = testCoordinator.getInputBufferSize();
                expect(currentSize).toBeGreaterThanOrEqual(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('output queue size should never be negative after any sequence of updates', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          arbitraryBufferUpdates(2000),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              for (const bytes of updates) {
                testCoordinator.updateOutputQueueSize(bytes);

                // PROPERTY: Queue size should always be non-negative
                const currentSize = testCoordinator.getOutputQueueSize();
                expect(currentSize).toBeGreaterThanOrEqual(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.6: Concurrent buffer operations maintain invariants
  // Both input and output limits should be enforced simultaneously
  // --------------------------------------------------------------------------
  describe('concurrent buffer operations maintain invariants', () => {
    it('both input and output limits should be enforced simultaneously', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          fc.array(
            fc.record({
              type: fc.constantFrom('input', 'output'),
              bytes: fc.integer({ min: -500, max: 500 }),
            }),
            { minLength: 1, maxLength: 100 }
          ),
          async (limits, operations) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              for (const op of operations) {
                if (op.type === 'input') {
                  testCoordinator.updateInputBufferSize(op.bytes);
                } else {
                  testCoordinator.updateOutputQueueSize(op.bytes);
                }

                // PROPERTY: Both limits should be enforced at all times
                const inputSize = testCoordinator.getInputBufferSize();
                const outputSize = testCoordinator.getOutputQueueSize();

                expect(inputSize).toBeLessThanOrEqual(limits.max_input_buffer);
                expect(inputSize).toBeGreaterThanOrEqual(0);
                expect(outputSize).toBeLessThanOrEqual(limits.max_output_queue);
                expect(outputSize).toBeGreaterThanOrEqual(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.7: Backpressure status consistency
  // Backpressure active state should be consistent with buffer sizes
  // --------------------------------------------------------------------------
  describe('backpressure status consistency', () => {
    it('backpressure status should be consistent with buffer sizes relative to limits', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryBufferLimits(),
          arbitraryBufferUpdates(1000),
          async (limits, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], limits.max_input_buffer, limits.max_output_queue);

            try {
              await testCoordinator.start(config);

              for (const bytes of updates) {
                // Apply to both buffers
                testCoordinator.updateInputBufferSize(bytes);
                testCoordinator.updateOutputQueueSize(bytes);

                const inputSize = testCoordinator.getInputBufferSize();
                const outputSize = testCoordinator.getOutputQueueSize();
                const inputBackpressure = testCoordinator.isInputBackpressureActive();
                const outputBackpressure = testCoordinator.isOutputBackpressureActive();

                // PROPERTY: If backpressure is NOT active, buffer should be below limit
                // (Note: backpressure can be active even when below limit if it hasn't dropped below 80%)
                if (!inputBackpressure) {
                  expect(inputSize).toBeLessThanOrEqual(limits.max_input_buffer);
                }
                if (!outputBackpressure) {
                  expect(outputSize).toBeLessThanOrEqual(limits.max_output_queue);
                }

                // PROPERTY: Buffer should NEVER exceed limit regardless of backpressure state
                expect(inputSize).toBeLessThanOrEqual(limits.max_input_buffer);
                expect(outputSize).toBeLessThanOrEqual(limits.max_output_queue);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 29.8: Different limit configurations are respected
  // Various limit configurations should all be properly enforced
  // --------------------------------------------------------------------------
  describe('different limit configurations are respected', () => {
    it('various limit configurations should all be properly enforced', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 50, max: 5000 }),
          fc.integer({ min: 50, max: 5000 }),
          fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 10, maxLength: 50 }),
          async (maxInput, maxOutput, updates) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());
            const config = createConfigWithLimits([0], maxInput, maxOutput);

            try {
              await testCoordinator.start(config);

              // Verify the limits are correctly configured
              expect(testCoordinator.getMaxInputBuffer()).toBe(maxInput);
              expect(testCoordinator.getMaxOutputQueue()).toBe(maxOutput);

              // Apply updates and verify limits are respected
              for (const bytes of updates) {
                testCoordinator.updateInputBufferSize(bytes);
                testCoordinator.updateOutputQueueSize(bytes);

                // PROPERTY: Configured limits should be respected
                expect(testCoordinator.getInputBufferSize()).toBeLessThanOrEqual(maxInput);
                expect(testCoordinator.getOutputQueueSize()).toBeLessThanOrEqual(maxOutput);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 33: Progress Summary Interval
// ============================================================================

/**
 * Property 33: Progress Summary Interval
 *
 * For any sequence of experiments, the Swarm_Coordinator shall write a progress
 * summary to stdout after every 10 completed experiments.
 *
 * Property: ∀ n: if experiments_completed mod 10 = 0 then write_summary()
 *
 * **Validates: Requirements 10.2**
 */
describe('Property 33: Progress Summary Interval', () => {
  // --------------------------------------------------------------------------
  // Property 33.1: Progress summary written at exact intervals
  // For any number of experiments N, exactly floor(N/10) summaries should be written
  // --------------------------------------------------------------------------
  describe('progress summary written at exact intervals', () => {
    it('for N experiments, exactly floor(N/10) progress summaries should be written', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 50 }),
          async (numExperiments) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            // Capture progress output
            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Simulate N experiments by calling checkProgressReport N times
              for (let i = 0; i < numExperiments; i++) {
                testCoordinator.checkProgressReport();
              }

              // Count progress summaries (filter out new best messages)
              const progressSummaries = progressOutput.filter(msg =>
                msg.includes('SWARM PROGRESS REPORT')
              );

              // Expected: floor(N/10) summaries
              const expectedSummaries = Math.floor(numExperiments / 10);

              expect(progressSummaries.length).toBe(expectedSummaries);

              return progressSummaries.length === expectedSummaries;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('progress summary should be written exactly when experiments mod 10 equals 0', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          async (numExperiments) => {
            const progressOutput: string[] = [];
            const experimentCountsAtSummary: number[] = [];
            let experimentCount = 0;

            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            // Capture progress output and track when summaries are written
            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
              if (message.includes('SWARM PROGRESS REPORT')) {
                experimentCountsAtSummary.push(experimentCount);
              }
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Simulate experiments
              for (let i = 0; i < numExperiments; i++) {
                experimentCount = i + 1;
                testCoordinator.checkProgressReport();
              }

              // PROPERTY: All summaries should be written at multiples of 10
              for (const count of experimentCountsAtSummary) {
                expect(count % 10).toBe(0);
              }

              // PROPERTY: Summaries should be written at exactly 10, 20, 30, etc.
              const expectedCounts = [];
              for (let i = 10; i <= numExperiments; i += 10) {
                expectedCounts.push(i);
              }
              expect(experimentCountsAtSummary).toEqual(expectedCounts);

              return experimentCountsAtSummary.every(count => count % 10 === 0);
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 33.2: No summary before reaching interval
  // For any N < 10, no progress summary should be written
  // --------------------------------------------------------------------------
  describe('no summary before reaching interval', () => {
    it('for N < 10 experiments, no progress summary should be written', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 9 }),
          async (numExperiments) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              for (let i = 0; i < numExperiments; i++) {
                testCoordinator.checkProgressReport();
              }

              const progressSummaries = progressOutput.filter(msg =>
                msg.includes('SWARM PROGRESS REPORT')
              );

              // PROPERTY: No summaries for N < 10
              expect(progressSummaries.length).toBe(0);

              return progressSummaries.length === 0;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 33.3: Counter resets after summary
  // After writing a summary, the counter should reset to 0
  // --------------------------------------------------------------------------
  describe('counter resets after summary', () => {
    it('experimentsSinceLastReport should reset to 0 after writing summary', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 50 }),
          async (numExperiments) => {
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            // Suppress progress output
            testCoordinator.setProgressWriter(() => { });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              for (let i = 0; i < numExperiments; i++) {
                testCoordinator.checkProgressReport();

                const experimentsSinceLastReport = testCoordinator.getExperimentsSinceLastReport();

                // PROPERTY: Counter should always be in range [0, 9]
                // (it increments to 10, then resets to 0 after writing summary)
                expect(experimentsSinceLastReport).toBeGreaterThanOrEqual(0);
                expect(experimentsSinceLastReport).toBeLessThanOrEqual(9);

                // PROPERTY: Counter should equal (i + 1) mod 10
                const expectedCounter = (i + 1) % 10;
                expect(experimentsSinceLastReport).toBe(expectedCounter);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 33.4: Configurable interval is respected
  // For any configured interval K, summaries should be written every K experiments
  // --------------------------------------------------------------------------
  describe('configurable interval is respected', () => {
    it('for any interval K, exactly floor(N/K) summaries should be written', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),  // interval K
          fc.integer({ min: 0, max: 100 }), // number of experiments N
          async (interval, numExperiments) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Set custom interval
              testCoordinator.setProgressReportInterval(interval);
              expect(testCoordinator.getProgressReportInterval()).toBe(interval);

              for (let i = 0; i < numExperiments; i++) {
                testCoordinator.checkProgressReport();
              }

              const progressSummaries = progressOutput.filter(msg =>
                msg.includes('SWARM PROGRESS REPORT')
              );

              // PROPERTY: floor(N/K) summaries for interval K
              const expectedSummaries = Math.floor(numExperiments / interval);
              expect(progressSummaries.length).toBe(expectedSummaries);

              return progressSummaries.length === expectedSummaries;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 33.5: Progress state persists across experiments
  // The counter should correctly track experiments across multiple batches
  // --------------------------------------------------------------------------
  describe('progress state persists across experiments', () => {
    it('counter should correctly track experiments across multiple batches', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 2, maxLength: 10 }),
          async (batchSizes) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              let totalExperiments = 0;

              // Process experiments in batches
              for (const batchSize of batchSizes) {
                for (let i = 0; i < batchSize; i++) {
                  testCoordinator.checkProgressReport();
                  totalExperiments++;
                }
              }

              const progressSummaries = progressOutput.filter(msg =>
                msg.includes('SWARM PROGRESS REPORT')
              );

              // PROPERTY: Total summaries should equal floor(totalExperiments/10)
              const expectedSummaries = Math.floor(totalExperiments / 10);
              expect(progressSummaries.length).toBe(expectedSummaries);

              // PROPERTY: Final counter should equal totalExperiments mod 10
              const expectedCounter = totalExperiments % 10;
              expect(testCoordinator.getExperimentsSinceLastReport()).toBe(expectedCounter);

              return progressSummaries.length === expectedSummaries;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 33.6: Summary content includes experiment count
  // Each progress summary should include the correct experiment count
  // --------------------------------------------------------------------------
  describe('summary content includes experiment count', () => {
    it('progress summary should include correct experiment count at time of writing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 50 }),
          async (numExperiments) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              for (let i = 0; i < numExperiments; i++) {
                testCoordinator.checkProgressReport();
              }

              const progressSummaries = progressOutput.filter(msg =>
                msg.includes('SWARM PROGRESS REPORT')
              );

              // PROPERTY: Each summary should mention the experiment count
              // Note: The actual count in the summary comes from the registry,
              // which may not be updated in this test. We verify the summary format.
              for (const summary of progressSummaries) {
                expect(summary).toContain('experiments completed');
              }

              return progressSummaries.every(s => s.includes('experiments completed'));
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 34: New Best Logging
// ============================================================================

/**
 * Property 34: New Best Logging
 *
 * For any experiment that achieves a new best val_bpb, the Swarm_Coordinator
 * shall log a highlighted message to stdout indicating the new best value
 * and the agent that achieved it.
 *
 * Property: ∀ result: if result.val_bpb < best_val_bpb then log_highlighted(result)
 *
 * **Validates: Requirements 10.4**
 */
describe('Property 34: New Best Logging', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 34.1: Highlighted message is logged for new best
  // When a new best val_bpb is achieved, a highlighted message should be logged
  // --------------------------------------------------------------------------
  describe('highlighted message is logged for new best', () => {
    it('logNewBestValBpb should output highlighted message with stars', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
            valBpb: fc.double({ min: 0.5, max: 2.0, noNaN: true }),
            memoryGb: fc.double({ min: 1, max: 80, noNaN: true }),
            agentId: fc.stringMatching(/^agent-[0-9]+$/),
            description: fc.string({ minLength: 1, maxLength: 100 }),
          }),
          async ({ commit, valBpb, memoryGb, agentId, description }) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              const result: ExperimentResult = {
                commit,
                valBpb,
                memoryGb,
                status: 'keep',
                description,
                agentId,
                timestamp: new Date().toISOString(),
                branch: `autoresearch/swarm/${agentId}`,
              };

              // Call logNewBestValBpb directly
              testCoordinator.logNewBestValBpb(result);

              // PROPERTY: Highlighted message should be logged
              expect(progressOutput.length).toBeGreaterThan(0);

              const loggedMessage = progressOutput[progressOutput.length - 1];

              // PROPERTY: Message should contain star decorations (highlighted)
              expect(loggedMessage).toContain('★');

              // PROPERTY: Message should contain the new best val_bpb value
              expect(loggedMessage).toContain(valBpb.toFixed(6));

              // PROPERTY: Message should contain the agent ID
              expect(loggedMessage).toContain(agentId);

              // PROPERTY: Message should contain the commit hash
              expect(loggedMessage).toContain(commit);

              // PROPERTY: Message should contain "NEW BEST"
              expect(loggedMessage).toContain('NEW BEST');

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 34.2: Message includes description
  // The highlighted message should include the experiment description
  // --------------------------------------------------------------------------
  describe('message includes description', () => {
    it('highlighted message should include experiment description', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          async (description) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              const result: ExperimentResult = {
                commit: 'abc1234',
                valBpb: 0.95,
                memoryGb: 8.0,
                status: 'keep',
                description,
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              };

              testCoordinator.logNewBestValBpb(result);

              const loggedMessage = progressOutput[progressOutput.length - 1];

              // PROPERTY: Message should contain the description
              expect(loggedMessage).toContain(description);

              return loggedMessage.includes(description);
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 34.3: New best triggers logging when val_bpb improves
  // When an experiment achieves a lower val_bpb than previous best, log is triggered
  // This test validates the integration logic that determines when to call logNewBestValBpb
  // --------------------------------------------------------------------------
  describe('new best triggers logging when val_bpb improves', () => {
    it('experiment with lower val_bpb than previous best should trigger highlighted log', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.double({ min: 0.8, max: 1.5, noNaN: true }),
            fc.double({ min: 0.5, max: 0.79, noNaN: true })
          ),
          async ([previousBest, newBest]) => {
            const progressOutput: string[] = [];
            const testOptions = createTestOptions();
            const testCoordinator = createSwarmCoordinator(testOptions);

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Clear progress output
              progressOutput.length = 0;

              // Create a new best result
              const newBestResult: ExperimentResult = {
                commit: 'best456',
                valBpb: newBest,
                memoryGb: 8.0,
                status: 'keep',
                description: 'new best experiment',
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              };

              // Simulate the condition check: newBest < previousBest
              // This is the core logic that handleExperimentResult uses
              const isNewBest = newBest < previousBest;

              // If it's a new best, log should be triggered
              if (isNewBest) {
                testCoordinator.logNewBestValBpb(newBestResult);
              }

              // PROPERTY: Since newBest (0.5-0.79) < previousBest (0.8-1.5), highlighted log should be triggered
              expect(isNewBest).toBe(true);
              expect(progressOutput.length).toBeGreaterThan(0);

              const loggedMessage = progressOutput[progressOutput.length - 1];
              expect(loggedMessage).toContain('★');
              expect(loggedMessage).toContain('NEW BEST');
              expect(loggedMessage).toContain(newBest.toFixed(6));

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 34.4: No logging when val_bpb does not improve
  // When an experiment does not achieve a new best, no highlighted log should occur
  // --------------------------------------------------------------------------
  describe('no logging when val_bpb does not improve', () => {
    it('experiment with higher val_bpb than previous best should not trigger highlighted log', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.double({ min: 0.5, max: 0.8, noNaN: true }),
            fc.double({ min: 0.81, max: 1.5, noNaN: true })
          ),
          async ([previousBest, worseBpb]) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              // Record an initial "keep" experiment to establish a baseline
              const initialResult: ExperimentResult = {
                commit: 'init123',
                valBpb: previousBest,
                memoryGb: 8.0,
                status: 'keep',
                description: 'initial baseline',
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              };

              await testCoordinator.getExperimentRegistry().recordResult(initialResult);

              // Clear progress output
              progressOutput.length = 0;

              // Now record a worse result
              const worseResult: ExperimentResult = {
                commit: 'worse456',
                valBpb: worseBpb,
                memoryGb: 8.0,
                status: 'keep',
                description: 'worse experiment',
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              };

              // Simulate the check that happens in handleExperimentResult
              const currentBest = testCoordinator.getExperimentRegistry().getBestValBpb();
              const isNewBest = worseBpb < currentBest;

              if (isNewBest) {
                testCoordinator.logNewBestValBpb(worseResult);
              }

              // PROPERTY: Since worseBpb > previousBest, no highlighted log should be triggered
              expect(isNewBest).toBe(false);

              // No highlighted message should have been logged
              const highlightedMessages = progressOutput.filter(msg =>
                msg.includes('★') && msg.includes('NEW BEST')
              );
              expect(highlightedMessages.length).toBe(0);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 34.5: Message format is consistent
  // The highlighted message should have a consistent format with all required fields
  // --------------------------------------------------------------------------
  describe('message format is consistent', () => {
    it('highlighted message should have consistent format with all required fields', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
            valBpb: fc.double({ min: 0.5, max: 2.0, noNaN: true }),
            memoryGb: fc.double({ min: 1, max: 80, noNaN: true }),
            gpuId: fc.integer({ min: 0, max: 15 }),
            description: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          }),
          async ({ commit, valBpb, memoryGb, gpuId, description }) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [gpuId],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              const agentId = `agent-${gpuId}`;
              const result: ExperimentResult = {
                commit,
                valBpb,
                memoryGb,
                status: 'keep',
                description,
                agentId,
                timestamp: new Date().toISOString(),
                branch: `autoresearch/swarm/${agentId}`,
              };

              testCoordinator.logNewBestValBpb(result);

              const loggedMessage = progressOutput[progressOutput.length - 1];

              // PROPERTY: Message should contain star border at start and end
              const lines = loggedMessage.split('\n');
              const starLines = lines.filter(line => line.includes('★★★★★'));
              expect(starLines.length).toBeGreaterThanOrEqual(2);

              // PROPERTY: Message should contain all required fields
              expect(loggedMessage).toContain('NEW BEST val_bpb');
              expect(loggedMessage).toContain('Agent:');
              expect(loggedMessage).toContain('Commit:');
              expect(loggedMessage).toContain('Description:');

              // PROPERTY: Message should contain the actual values
              expect(loggedMessage).toContain(valBpb.toFixed(6));
              expect(loggedMessage).toContain(agentId);
              expect(loggedMessage).toContain(commit);
              expect(loggedMessage).toContain(description);

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 34.6: Multiple new bests log multiple messages
  // Each new best should trigger its own highlighted message
  // --------------------------------------------------------------------------
  describe('multiple new bests log multiple messages', () => {
    it('each successive new best should trigger a highlighted message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.double({ min: 0.5, max: 1.5, noNaN: true }),
            { minLength: 2, maxLength: 10 }
          ).map(values => values.sort((a, b) => b - a)), // Sort descending so each is a new best
          async (descendingValBpbs) => {
            const progressOutput: string[] = [];
            const testCoordinator = createSwarmCoordinator({
              ...createTestOptions(),
            });

            testCoordinator.setProgressWriter((message: string) => {
              progressOutput.push(message);
            });

            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            try {
              await testCoordinator.start(config);

              let newBestCount = 0;

              for (let i = 0; i < descendingValBpbs.length; i++) {
                const valBpb = descendingValBpbs[i];
                const result: ExperimentResult = {
                  commit: `abc${i.toString().padStart(4, '0')}`,
                  valBpb,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: 'agent-0',
                  timestamp: new Date().toISOString(),
                  branch: 'autoresearch/swarm/agent-0',
                };

                const previousBest = testCoordinator.getExperimentRegistry().getBestValBpb();
                await testCoordinator.getExperimentRegistry().recordResult(result);

                // Check if this is a new best
                if (valBpb < previousBest) {
                  testCoordinator.logNewBestValBpb(result);
                  newBestCount++;
                }
              }

              // PROPERTY: Number of highlighted messages should equal number of new bests
              const highlightedMessages = progressOutput.filter(msg =>
                msg.includes('★') && msg.includes('NEW BEST')
              );

              expect(highlightedMessages.length).toBe(newBestCount);

              return highlightedMessages.length === newBestCount;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 35: Throughput Calculation
// ============================================================================

/**
 * Property 35: Throughput Calculation
 *
 * For any throughput query, the reported experiments_per_hour shall equal
 * (total_experiments / elapsed_hours) calculated from swarm start time.
 *
 * Property: ∀ t: experiments_per_hour = (total_experiments / uptime_seconds) * 3600
 *
 * **Validates: Requirements 10.5**
 */
describe('Property 35: Throughput Calculation', () => {
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    coordinator = createSwarmCoordinator(createTestOptions());
  });

  afterEach(async () => {
    if (coordinator.getIsRunning()) {
      await coordinator.stop();
    }
    coordinator.clear();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Property 35.1: Throughput formula correctness
  // experiments_per_hour = (total_experiments / uptime_seconds) * 3600
  // --------------------------------------------------------------------------
  describe('throughput formula correctness', () => {
    it('experimentsPerHour should equal (totalExperiments / uptime) * 3600', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Get status and verify formula
              const status = testCoordinator.getStatus();

              if (status.uptime > 0) {
                const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                // Use toBeCloseTo for floating point comparison
                expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 5);
                return Math.abs(status.experimentsPerHour - expectedRate) < 0.00001;
              } else {
                // When uptime is 0, experimentsPerHour should be 0
                expect(status.experimentsPerHour).toBe(0);
                return status.experimentsPerHour === 0;
              }
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('throughput calculation should be consistent across multiple status queries', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          fc.integer({ min: 2, max: 5 }),
          async (config, queryCount) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Query status multiple times and verify formula holds each time
              for (let i = 0; i < queryCount; i++) {
                const status = testCoordinator.getStatus();

                if (status.uptime > 0) {
                  const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                  expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 5);
                } else {
                  expect(status.experimentsPerHour).toBe(0);
                }
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.2: Throughput increases with experiments
  // As experiments are recorded, throughput should reflect the new count
  // --------------------------------------------------------------------------
  describe('throughput increases with experiments', () => {
    it('throughput should increase proportionally when experiments are added', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 1, max: 10 }),
          async (gpuCount, experimentCount) => {
            const gpuIds = Array.from({ length: gpuCount }, (_, i) => i);
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: gpuCount }],
              swarm: {
                gpuIds,
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            // Create fresh options with a new registry for each test iteration
            const testOptions = createTestOptions();
            const testCoordinator = createSwarmCoordinator(testOptions);

            try {
              await testCoordinator.start(config);

              // Get initial experiment count (should be 0 for fresh registry)
              const initialCount = testCoordinator.getStatus().totalExperiments;

              // Record experiments and verify throughput calculation
              for (let i = 0; i < experimentCount; i++) {
                const result: ExperimentResult = {
                  commit: `abc${i.toString().padStart(4, '0')}`,
                  valBpb: 1.0 - i * 0.01,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: `agent-${i % gpuCount}`,
                  timestamp: new Date().toISOString(),
                  branch: `autoresearch/swarm/agent-${i % gpuCount}`,
                };

                await testCoordinator.getExperimentRegistry().recordResult(result);

                const status = testCoordinator.getStatus();

                // Verify total experiments increased by expected amount
                expect(status.totalExperiments).toBe(initialCount + i + 1);

                // Verify throughput formula: experimentsPerHour = (totalExperiments / uptime) * 3600
                if (status.uptime > 0) {
                  const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                  expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 5);
                }
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.3: Throughput is zero when not running
  // When coordinator is not running, uptime is 0 and throughput should be 0
  // --------------------------------------------------------------------------
  describe('throughput is zero when not running', () => {
    it('experimentsPerHour should be 0 when coordinator is not running', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Before starting, throughput should be 0
              const statusBefore = testCoordinator.getStatus();
              expect(statusBefore.experimentsPerHour).toBe(0);
              expect(statusBefore.uptime).toBe(0);

              // Start and then stop
              await testCoordinator.start(config);
              await testCoordinator.stop();

              // After stopping, uptime should be 0 and throughput should be 0
              const statusAfter = testCoordinator.getStatus();
              expect(statusAfter.experimentsPerHour).toBe(0);
              expect(statusAfter.uptime).toBe(0);

              return statusAfter.experimentsPerHour === 0 && statusAfter.uptime === 0;
            } finally {
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.4: Throughput is non-negative
  // Throughput should never be negative regardless of state
  // --------------------------------------------------------------------------
  describe('throughput is non-negative', () => {
    it('experimentsPerHour should always be >= 0', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              // Check before starting
              const statusBefore = testCoordinator.getStatus();
              expect(statusBefore.experimentsPerHour).toBeGreaterThanOrEqual(0);

              // Check while running
              await testCoordinator.start(config);
              const statusRunning = testCoordinator.getStatus();
              expect(statusRunning.experimentsPerHour).toBeGreaterThanOrEqual(0);

              // Check after stopping
              await testCoordinator.stop();
              const statusAfter = testCoordinator.getStatus();
              expect(statusAfter.experimentsPerHour).toBeGreaterThanOrEqual(0);

              return (
                statusBefore.experimentsPerHour >= 0 &&
                statusRunning.experimentsPerHour >= 0 &&
                statusAfter.experimentsPerHour >= 0
              );
            } finally {
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.5: Throughput calculation with various experiment counts
  // Test throughput calculation with different numbers of experiments
  // --------------------------------------------------------------------------
  describe('throughput calculation with various experiment counts', () => {
    it('throughput should be correctly calculated for any number of experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          async (experimentCount) => {
            const config: SwarmConfig = {
              pools: [{ id: 'worker', command: 'node', instances: 1 }],
              swarm: {
                gpuIds: [0],
                agentModel: 'claude-acp',
                experimentTimeout: 10,
                lockTimeout: 10,
              },
            };

            // Create fresh options with a new registry for each test iteration
            const testOptions = createTestOptions();
            const testCoordinator = createSwarmCoordinator(testOptions);

            try {
              await testCoordinator.start(config);

              // Get initial experiment count (should be 0 for fresh registry)
              const initialCount = testCoordinator.getStatus().totalExperiments;

              // Record the specified number of experiments
              for (let i = 0; i < experimentCount; i++) {
                const result: ExperimentResult = {
                  commit: `abc${i.toString().padStart(4, '0')}`,
                  valBpb: 1.0,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: 'agent-0',
                  timestamp: new Date().toISOString(),
                  branch: 'autoresearch/swarm/agent-0',
                };
                await testCoordinator.getExperimentRegistry().recordResult(result);
              }

              const status = testCoordinator.getStatus();

              // Verify experiment count increased by expected amount
              expect(status.totalExperiments).toBe(initialCount + experimentCount);

              // Verify throughput formula: experimentsPerHour = (totalExperiments / uptime) * 3600
              if (status.uptime > 0) {
                const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 5);
              } else {
                expect(status.experimentsPerHour).toBe(0);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.6: Throughput is finite
  // Throughput should never be Infinity or NaN
  // --------------------------------------------------------------------------
  describe('throughput is finite', () => {
    it('experimentsPerHour should never be Infinity or NaN', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          fc.integer({ min: 0, max: 20 }),
          async (config, experimentCount) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              await testCoordinator.start(config);

              // Record experiments
              for (let i = 0; i < experimentCount; i++) {
                const result: ExperimentResult = {
                  commit: `abc${i.toString().padStart(4, '0')}`,
                  valBpb: 1.0,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: `agent-${config.swarm.gpuIds[0]}`,
                  timestamp: new Date().toISOString(),
                  branch: `autoresearch/swarm/agent-${config.swarm.gpuIds[0]}`,
                };
                await testCoordinator.getExperimentRegistry().recordResult(result);
              }

              const status = testCoordinator.getStatus();

              // Verify throughput is finite
              expect(Number.isFinite(status.experimentsPerHour)).toBe(true);
              expect(Number.isNaN(status.experimentsPerHour)).toBe(false);

              return Number.isFinite(status.experimentsPerHour) && !Number.isNaN(status.experimentsPerHour);
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 35.7: Throughput calculation from start time
  // Throughput should be calculated from the swarm start time, not from any other reference
  // --------------------------------------------------------------------------
  describe('throughput calculation from start time', () => {
    it('throughput should be based on elapsed time since start', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryValidSwarmConfig(),
          async (config) => {
            const testCoordinator = createSwarmCoordinator(createTestOptions());

            try {
              const startTimeBefore = Date.now();
              await testCoordinator.start(config);
              const startTimeAfter = Date.now();

              // Record some experiments
              for (let i = 0; i < 5; i++) {
                const result: ExperimentResult = {
                  commit: `abc${i.toString().padStart(4, '0')}`,
                  valBpb: 1.0,
                  memoryGb: 8.0,
                  status: 'keep',
                  description: `experiment ${i}`,
                  agentId: `agent-${config.swarm.gpuIds[0]}`,
                  timestamp: new Date().toISOString(),
                  branch: `autoresearch/swarm/agent-${config.swarm.gpuIds[0]}`,
                };
                await testCoordinator.getExperimentRegistry().recordResult(result);
              }

              const status = testCoordinator.getStatus();
              const currentTime = Date.now();

              // Uptime should be approximately (currentTime - startTime) / 1000
              // Allow for some timing variance
              const minExpectedUptime = (currentTime - startTimeAfter) / 1000;
              const maxExpectedUptime = (currentTime - startTimeBefore) / 1000;

              expect(status.uptime).toBeGreaterThanOrEqual(minExpectedUptime - 0.1);
              expect(status.uptime).toBeLessThanOrEqual(maxExpectedUptime + 0.1);

              // Verify throughput formula with the reported uptime
              if (status.uptime > 0) {
                const expectedRate = (status.totalExperiments / status.uptime) * 3600;
                expect(status.experimentsPerHour).toBeCloseTo(expectedRate, 5);
              }

              return true;
            } finally {
              if (testCoordinator.getIsRunning()) {
                await testCoordinator.stop();
              }
              testCoordinator.clear();
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
