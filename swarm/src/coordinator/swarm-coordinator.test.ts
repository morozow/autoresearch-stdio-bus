/**
 * Unit tests for SwarmCoordinator stdio_bus integration.
 * 
 * Tests the NDJSON message handling, routing, and JSON-RPC method dispatch.
 * 
 * Validates: Requirements 1.1, 1.5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SwarmCoordinator,
  createSwarmCoordinator,
  SwarmCoordinatorOptions,
  HotReloadResult,
} from './swarm-coordinator';
import { createExperimentRegistry, ExperimentResult } from '../state/experiment-registry';
import { createStateBroadcaster } from '../broadcast/state-broadcaster';
import { createConflictResolver } from '../conflict/conflict-resolver';
import { createSessionRouter } from '../routing/session-router';
import {
  encode,
  decode,
} from '../protocol/codec';
import {
  JsonRpcMessage,
  METHOD_NAMES,
  createRequest,
  createNotification,
  ExperimentResultParams,
} from '../protocol/types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test SwarmCoordinator with mocked dependencies.
 */
function createTestCoordinator(options: Partial<SwarmCoordinatorOptions> = {}): {
  coordinator: SwarmCoordinator;
  output: string[];
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const output: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const coordinator = createSwarmCoordinator({
    logger,
    fileLogger: logger,
    experimentRegistry: createExperimentRegistry({ resultsPath: '/tmp/test-results.tsv' }),
    stateBroadcaster: createStateBroadcaster(),
    conflictResolver: createConflictResolver(),
    sessionRouter: createSessionRouter(),
    ...options,
  });

  // Capture output
  coordinator.setOutputWriter((data: string) => {
    output.push(data);
  });

  return { coordinator, output, logger };
}

/**
 * Parses NDJSON output into messages.
 */
function parseOutput(output: string[]): JsonRpcMessage[] {
  return output.map(line => decode(line)).filter((m): m is JsonRpcMessage => m !== null);
}

// ============================================================================
// Tests
// ============================================================================

describe('SwarmCoordinator stdio_bus Integration', () => {
  describe('initializeMessageHandler', () => {
    it('should initialize the NDJSON parser', () => {
      const { coordinator, logger } = createTestCoordinator();

      coordinator.initializeMessageHandler();

      expect(logger.info).toHaveBeenCalledWith('Message handler initialized');
    });

    it('should auto-initialize when processing data', () => {
      const { coordinator, output } = createTestCoordinator();

      // Process a valid message without explicit initialization
      const request = createRequest('test-1', METHOD_NAMES.SWARM_STATUS);
      coordinator.processIncomingData(encode(request));

      // Should have processed and responded
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe('processIncomingData', () => {
    it('should parse and handle valid NDJSON messages', async () => {
      const { coordinator, output } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      const request = createRequest('req-1', METHOD_NAMES.SWARM_STATUS);
      coordinator.processIncomingData(encode(request));

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(output.length).toBe(1);
      const response = decode(output[0]!);
      expect(response).not.toBeNull();
      expect((response as any).id).toBe('req-1');
      expect((response as any).result).toBeDefined();
    });

    it('should handle multiple messages in sequence', async () => {
      const { coordinator, output } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      const request1 = createRequest('req-1', METHOD_NAMES.SWARM_STATUS);
      const request2 = createRequest('req-2', METHOD_NAMES.SWARM_STATUS);

      coordinator.processIncomingData(encode(request1));
      coordinator.processIncomingData(encode(request2));

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(output.length).toBe(2);
    });

    it('should handle partial messages across multiple writes', async () => {
      const { coordinator, output } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      const request = createRequest('req-1', METHOD_NAMES.SWARM_STATUS);
      const encoded = encode(request);

      // Split the message
      const mid = Math.floor(encoded.length / 2);
      coordinator.processIncomingData(encoded.substring(0, mid));
      coordinator.processIncomingData(encoded.substring(mid));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(output.length).toBe(1);
    });

    it('should continue processing after parse errors', async () => {
      const { coordinator, output, logger } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      // Send invalid JSON followed by valid message
      coordinator.processIncomingData('invalid json\n');

      const request = createRequest('req-1', METHOD_NAMES.SWARM_STATUS);
      coordinator.processIncomingData(encode(request));

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have logged error but still processed valid message
      expect(logger.error).toHaveBeenCalled();
      expect(output.length).toBe(1);
    });
  });

  describe('handleIncomingMessage - swarm.status', () => {
    it('should respond with swarm status', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('status-1', METHOD_NAMES.SWARM_STATUS);
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('status-1');
      expect(response.result).toBeDefined();
      expect(response.result.activeAgents).toBeDefined();
      expect(response.result.totalExperiments).toBeDefined();
      expect(response.result.bestValBpb).toBeDefined();
      expect(response.result.experimentsPerHour).toBeDefined();
      expect(response.result.uptime).toBeDefined();
      expect(response.result.gpuUtilization).toBeDefined();
    });
  });

  describe('handleIncomingMessage - swarm.sync', () => {
    it('should respond with sync state', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('sync-1', METHOD_NAMES.SWARM_SYNC);
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('sync-1');
      expect(response.result).toBeDefined();
      expect(response.result.bestValBpb).toBeDefined();
      expect(response.result.totalExperiments).toBeDefined();
      expect(response.result.activeAgents).toBeDefined();
      expect(response.result.recentResults).toBeDefined();
    });
  });

  describe('handleIncomingMessage - swarm.pause', () => {
    it('should pause the swarm', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('pause-1', METHOD_NAMES.SWARM_PAUSE);
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('pause-1');
      expect(response.result.paused).toBe(true);
      expect(coordinator.getIsPaused()).toBe(true);
    });
  });

  describe('handleIncomingMessage - swarm.resume', () => {
    it('should resume the swarm', async () => {
      const { coordinator, output } = createTestCoordinator();

      // First pause
      await coordinator.pause();
      expect(coordinator.getIsPaused()).toBe(true);

      // Then resume via message
      const request = createRequest('resume-1', METHOD_NAMES.SWARM_RESUME);
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('resume-1');
      expect(response.result.resumed).toBe(true);
      expect(coordinator.getIsPaused()).toBe(false);
    });
  });

  describe('handleIncomingMessage - swarm.history', () => {
    it('should respond with experiment history', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('history-1', METHOD_NAMES.SWARM_HISTORY, { limit: 10 });
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('history-1');
      expect(response.result).toBeDefined();
      expect(response.result.experiments).toBeDefined();
      expect(response.result.totalCount).toBeDefined();
    });
  });

  describe('handleIncomingMessage - lock.acquire', () => {
    it('should acquire lock for agent', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('lock-1', METHOD_NAMES.LOCK_ACQUIRE, { agentId: 'agent-0' });
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('lock-1');
      expect(response.result).toBeDefined();
      expect(response.result.granted).toBe(true);
      expect(response.result.branch).toContain('agent-0');
    });

    it('should return error for missing agentId', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('lock-2', METHOD_NAMES.LOCK_ACQUIRE, {});
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('lock-2');
      expect(response.error).toBeDefined();
    });
  });

  describe('handleIncomingMessage - experiment.result notification', () => {
    it('should record experiment result', async () => {
      const { coordinator, logger } = createTestCoordinator();

      const params: ExperimentResultParams = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 40.0,
        status: 'keep',
        description: 'Test experiment',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };

      const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, params);
      await coordinator.handleIncomingMessage(notification);

      // Should have logged the recording
      expect(logger.info).toHaveBeenCalledWith(
        'Recorded and broadcast experiment result',
        expect.objectContaining({
          commit: 'abc1234',
          valBpb: 0.95,
          status: 'keep',
          agentId: 'agent-0',
        })
      );

      // Verify it was recorded
      const registry = coordinator.getExperimentRegistry();
      expect(registry.getTotalExperiments()).toBe(1);
    });
  });

  describe('handleIncomingMessage - unknown method', () => {
    it('should return method not found error for unknown request', async () => {
      const { coordinator, output } = createTestCoordinator();

      const request = createRequest('unknown-1', 'unknown.method');
      await coordinator.handleIncomingMessage(request);

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.id).toBe('unknown-1');
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601); // Method not found
    });

    it('should log warning for unknown notification', async () => {
      const { coordinator, logger } = createTestCoordinator();

      const notification = createNotification('unknown.notification');
      await coordinator.handleIncomingMessage(notification);

      expect(logger.warn).toHaveBeenCalledWith(
        'Unknown notification method',
        { method: 'unknown.notification' }
      );
    });
  });

  describe('sendMessage', () => {
    it('should encode and write message to output', () => {
      const { coordinator, output } = createTestCoordinator();

      const message = createRequest('test-1', 'test.method');
      coordinator.sendMessage(message);

      expect(output.length).toBe(1);
      const decoded = decode(output[0]!);
      expect(decoded).toEqual(message);
    });
  });

  describe('sendSuccessResponse', () => {
    it('should send properly formatted success response', () => {
      const { coordinator, output } = createTestCoordinator();

      coordinator.sendSuccessResponse('req-1', { data: 'test' });

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.result).toEqual({ data: 'test' });
    });
  });

  describe('sendErrorResponse', () => {
    it('should send properly formatted error response', () => {
      const { coordinator, output } = createTestCoordinator();

      coordinator.sendErrorResponse('req-1', -32600, 'Invalid request');

      expect(output.length).toBe(1);
      const response = decode(output[0]!) as any;
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toBe('Invalid request');
    });
  });

  describe('flushParser', () => {
    it('should process remaining buffered data', async () => {
      const { coordinator, output } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      // Send partial message without newline
      const request = createRequest('req-1', METHOD_NAMES.SWARM_STATUS);
      const encoded = JSON.stringify(request); // No newline
      coordinator.processIncomingData(encoded);

      // No output yet (waiting for newline)
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(output.length).toBe(0);

      // Flush to process remaining data
      coordinator.flushParser();

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(output.length).toBe(1);
    });
  });

  describe('clear', () => {
    it('should reset the NDJSON parser', () => {
      const { coordinator, logger } = createTestCoordinator();
      coordinator.initializeMessageHandler();

      coordinator.clear();

      expect(logger.info).toHaveBeenCalledWith('SwarmCoordinator cleared');
    });
  });

  describe('routeMessage', () => {
    it('should route message through session router', async () => {
      const { coordinator } = createTestCoordinator();
      const sessionRouter = coordinator.getSessionRouter();

      // Set up a session
      const sessionId = sessionRouter.assignSession('agent-0', 0);

      // Register a handler
      const receivedMessages: any[] = [];
      sessionRouter.registerHandler(sessionId, async (routedMessage) => {
        receivedMessages.push(routedMessage);
      });

      // Route a message
      const message = createNotification('test.message');
      await coordinator.routeMessage(message, sessionId);

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].message).toEqual(message);
    });
  });

  describe('broadcastMessage', () => {
    it('should broadcast message to all sessions', async () => {
      const { coordinator } = createTestCoordinator();
      const sessionRouter = coordinator.getSessionRouter();

      // Set up multiple sessions
      const session1 = sessionRouter.assignSession('agent-0', 0);
      const session2 = sessionRouter.assignSession('agent-1', 1);

      // Register handlers
      const received1: any[] = [];
      const received2: any[] = [];
      sessionRouter.registerHandler(session1, async (msg) => received1.push(msg));
      sessionRouter.registerHandler(session2, async (msg) => received2.push(msg));

      // Broadcast a message
      const message = createNotification('broadcast.test');
      await coordinator.broadcastMessage(message);

      expect(received1.length).toBe(1);
      expect(received2.length).toBe(1);
    });

    it('should exclude specified session from broadcast', async () => {
      const { coordinator } = createTestCoordinator();
      const sessionRouter = coordinator.getSessionRouter();

      // Set up multiple sessions
      const session1 = sessionRouter.assignSession('agent-0', 0);
      const session2 = sessionRouter.assignSession('agent-1', 1);

      // Register handlers
      const received1: any[] = [];
      const received2: any[] = [];
      sessionRouter.registerHandler(session1, async (msg) => received1.push(msg));
      sessionRouter.registerHandler(session2, async (msg) => received2.push(msg));

      // Broadcast excluding session1
      const message = createNotification('broadcast.test');
      await coordinator.broadcastMessage(message, session1);

      expect(received1.length).toBe(0);
      expect(received2.length).toBe(1);
    });
  });
});


// ============================================================================
// Hot-Reload Tests
// ============================================================================

describe('SwarmCoordinator Hot-Reload Support', () => {
  /**
   * Creates a mock SwarmConfig for testing.
   */
  function createTestConfig(gpuIds: number[]): any {
    return {
      pools: [
        {
          id: 'gpu-worker',
          command: 'node',
          args: ['./worker.js'],
          instances: gpuIds.length,
        },
      ],
      swarm: {
        gpuIds,
        agentModel: 'test-model',
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
    };
  }

  /**
   * Creates a coordinator with mocked worker spawning.
   */
  function createHotReloadTestCoordinator(): {
    coordinator: SwarmCoordinator;
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    spawnedWorkers: string[];
    stoppedWorkers: string[];
  } {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const spawnedWorkers: string[] = [];
    const stoppedWorkers: string[] = [];

    // Create coordinator with mocked dependencies
    const experimentRegistry = createExperimentRegistry({ resultsPath: '/tmp/test-results.tsv' });
    const stateBroadcaster = createStateBroadcaster();
    const conflictResolver = createConflictResolver();
    const sessionRouter = createSessionRouter();

    // Mock the registry methods to avoid file operations
    vi.spyOn(experimentRegistry, 'restore').mockResolvedValue();
    vi.spyOn(experimentRegistry, 'persist').mockResolvedValue();
    vi.spyOn(experimentRegistry, 'registerAgent').mockImplementation(() => { });
    vi.spyOn(experimentRegistry, 'unregisterAgent').mockImplementation(() => { });

    const coordinator = createSwarmCoordinator({
      logger,
      fileLogger: logger,
      experimentRegistry,
      stateBroadcaster,
      conflictResolver,
      sessionRouter,
    });

    // Mock the internal spawnWorker and stopWorker methods by intercepting start
    // We'll use a custom approach to track spawned/stopped workers
    const originalStart = coordinator.start.bind(coordinator);
    const originalReload = coordinator.reload.bind(coordinator);

    return { coordinator, logger, spawnedWorkers, stoppedWorkers };
  }

  describe('reload() - when not running', () => {
    it('should start the coordinator with new config', async () => {
      const { coordinator, logger } = createTestCoordinator();
      const config = createTestConfig([0, 1]);

      // Mock the start method to avoid actual worker spawning
      const startSpy = vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();

      const result = await coordinator.reload(config);

      expect(result.success).toBe(true);
      expect(result.added).toContain('agent-0');
      expect(result.added).toContain('agent-1');
      expect(result.removed).toHaveLength(0);
      expect(result.preserved).toHaveLength(0);
    });
  });

  describe('reload() - adding agents', () => {
    it('should add new workers for new GPU IDs', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers to simulate started state
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
      });

      // Mock spawnWorker for new workers
      const spawnWorkerSpy = vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);

      // Reload with additional GPUs
      const newConfig = createTestConfig([0, 1, 2, 3]);
      const result = await coordinator.reload(newConfig);

      expect(result.success).toBe(true);
      expect(result.added).toContain('agent-2');
      expect(result.added).toContain('agent-3');
      expect(result.preserved).toContain('agent-0');
      expect(result.preserved).toContain('agent-1');
      expect(result.removed).toHaveLength(0);

      // Verify spawnWorker was called for new GPUs
      expect(spawnWorkerSpy).toHaveBeenCalledWith('agent-2', 2, newConfig);
      expect(spawnWorkerSpy).toHaveBeenCalledWith('agent-3', 3, newConfig);
    });
  });

  describe('reload() - removing agents', () => {
    it('should remove workers for GPUs no longer in config', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 1, 2, 3]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers to simulate started state
      for (let i = 0; i < 4; i++) {
        (coordinator as any).workers.set(`agent-${i}`, {
          worker: { stop: vi.fn().mockResolvedValue(undefined) },
          agentId: `agent-${i}`,
          gpuId: i,
          isExecuting: false,
          currentExperiment: null,
        });
      }

      // Mock stopWorker
      const stopWorkerSpy = vi.spyOn(coordinator as any, 'stopWorker').mockResolvedValue(undefined);

      // Reload with fewer GPUs
      const newConfig = createTestConfig([0, 1]);
      const result = await coordinator.reload(newConfig);

      expect(result.success).toBe(true);
      expect(result.removed).toContain('agent-2');
      expect(result.removed).toContain('agent-3');
      expect(result.preserved).toContain('agent-0');
      expect(result.preserved).toContain('agent-1');
      expect(result.added).toHaveLength(0);

      // Verify stopWorker was called for removed GPUs
      expect(stopWorkerSpy).toHaveBeenCalledWith('agent-2');
      expect(stopWorkerSpy).toHaveBeenCalledWith('agent-3');
    });
  });

  describe('reload() - preserving agent state', () => {
    it('should preserve existing agent state during reload', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers with execution state
      const worker0 = {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
      };
      const worker1 = {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
      };
      (coordinator as any).workers.set('agent-0', worker0);
      (coordinator as any).workers.set('agent-1', worker1);

      // Reload with same GPUs (no changes to workers)
      const newConfig = createTestConfig([0, 1]);
      const result = await coordinator.reload(newConfig);

      expect(result.success).toBe(true);
      expect(result.preserved).toContain('agent-0');
      expect(result.preserved).toContain('agent-1');
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);

      // Verify worker state was preserved
      const preservedWorker0 = (coordinator as any).workers.get('agent-0');
      expect(preservedWorker0.isExecuting).toBe(true);
      expect(preservedWorker0.currentExperiment).toBe('abc1234');

      // Verify logger recorded state preservation
      expect(logger.info).toHaveBeenCalledWith(
        'Preserving worker state during hot-reload',
        expect.objectContaining({
          agentId: 'agent-0',
          gpuId: 0,
          isExecuting: true,
          currentExperiment: 'abc1234',
        })
      );
    });

    it('should not restart workers that remain in config', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 1, 2]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers
      const stopFns: ReturnType<typeof vi.fn>[] = [];
      for (let i = 0; i < 3; i++) {
        const stopFn = vi.fn().mockResolvedValue(undefined);
        stopFns.push(stopFn);
        (coordinator as any).workers.set(`agent-${i}`, {
          worker: { stop: stopFn },
          agentId: `agent-${i}`,
          gpuId: i,
          isExecuting: false,
          currentExperiment: null,
        });
      }

      // Mock spawnWorker and stopWorker
      const spawnWorkerSpy = vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);
      const stopWorkerSpy = vi.spyOn(coordinator as any, 'stopWorker').mockImplementation(async (agentId: string) => {
        (coordinator as any).workers.delete(agentId);
      });

      // Reload with one GPU removed and one added
      const newConfig = createTestConfig([0, 1, 3]); // Remove GPU 2, add GPU 3
      const result = await coordinator.reload(newConfig);

      expect(result.success).toBe(true);
      expect(result.preserved).toContain('agent-0');
      expect(result.preserved).toContain('agent-1');
      expect(result.removed).toContain('agent-2');
      expect(result.added).toContain('agent-3');

      // Verify only agent-2 was stopped
      expect(stopWorkerSpy).toHaveBeenCalledTimes(1);
      expect(stopWorkerSpy).toHaveBeenCalledWith('agent-2');

      // Verify only agent-3 was spawned
      expect(spawnWorkerSpy).toHaveBeenCalledTimes(1);
      expect(spawnWorkerSpy).toHaveBeenCalledWith('agent-3', 3, newConfig);
    });
  });

  describe('reload() - mixed operations', () => {
    it('should handle simultaneous add and remove operations', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 2, 4]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers
      for (const gpuId of [0, 2, 4]) {
        (coordinator as any).workers.set(`agent-${gpuId}`, {
          worker: { stop: vi.fn().mockResolvedValue(undefined) },
          agentId: `agent-${gpuId}`,
          gpuId,
          isExecuting: false,
          currentExperiment: null,
        });
      }

      // Mock spawnWorker and stopWorker
      vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);
      vi.spyOn(coordinator as any, 'stopWorker').mockImplementation(async (agentId: string) => {
        (coordinator as any).workers.delete(agentId);
      });

      // Reload with different GPU set
      const newConfig = createTestConfig([0, 1, 3]); // Keep 0, remove 2 and 4, add 1 and 3
      const result = await coordinator.reload(newConfig);

      expect(result.success).toBe(true);
      expect(result.preserved).toEqual(['agent-0']);
      expect(result.removed.sort()).toEqual(['agent-2', 'agent-4']);
      expect(result.added.sort()).toEqual(['agent-1', 'agent-3']);
    });
  });

  describe('reload() - logging', () => {
    it('should log hot-reload operations to file logger', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with initial config
      const initialConfig = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(initialConfig);

      // Manually add workers
      for (let i = 0; i < 2; i++) {
        (coordinator as any).workers.set(`agent-${i}`, {
          worker: { stop: vi.fn().mockResolvedValue(undefined) },
          agentId: `agent-${i}`,
          gpuId: i,
          isExecuting: false,
          currentExperiment: null,
        });
      }

      vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);
      vi.spyOn(coordinator as any, 'stopWorker').mockImplementation(async (agentId: string) => {
        (coordinator as any).workers.delete(agentId);
      });

      // Reload with changes
      const newConfig = createTestConfig([0, 2]); // Keep 0, remove 1, add 2
      await coordinator.reload(newConfig);

      // Verify file logger was called with hot-reload info
      expect(logger.info).toHaveBeenCalledWith(
        'Hot-reloading configuration',
        expect.objectContaining({
          newGpuIds: [0, 2],
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        'Hot-reload complete',
        expect.objectContaining({
          activeWorkers: expect.any(Number),
          added: expect.any(Array),
          removed: expect.any(Array),
          preserved: expect.any(Array),
        })
      );
    });
  });
});


// ============================================================================
// Crash Recovery Tests
// ============================================================================

describe('SwarmCoordinator Crash Recovery', () => {
  /**
   * Creates a mock SwarmConfig for testing.
   */
  function createTestConfig(gpuIds: number[]): any {
    return {
      pools: [
        {
          id: 'gpu-worker',
          command: 'node',
          args: ['./worker.js'],
          instances: gpuIds.length,
        },
      ],
      swarm: {
        gpuIds,
        agentModel: 'test-model',
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
    };
  }

  describe('handleWorkerCrash', () => {
    it('should detect worker crash and schedule recovery', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });

      // Set a short recovery delay for testing
      coordinator.setCrashRecoveryDelay(10);

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', 1, new Error('Test crash'));

      // Verify crash was logged
      expect(logger.error).toHaveBeenCalledWith(
        'Worker crashed',
        expect.objectContaining({
          agentId: 'agent-0',
          gpuId: 0,
          exitCode: 1,
          wasExecuting: true,
          currentExperiment: 'abc1234',
        })
      );

      // Verify recovery was scheduled
      expect(coordinator.getPendingCrashRecoveryCount()).toBe(1);
      expect(coordinator.isWorkerRecovering('agent-0')).toBe(true);

      // Clean up
      coordinator.clear();
    });

    it('should preserve previous state for restoration', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker with execution state
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'def5678',
        crashCount: 0,
        isRecovering: false,
        lastState: { branch: 'autoresearch/swarm/agent-0' },
      });

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', -1);

      // Verify state was preserved
      const workerState = (coordinator as any).workers.get('agent-0');
      expect(workerState.lastState).toEqual({
        isExecuting: true,
        currentExperiment: 'def5678',
        branch: 'autoresearch/swarm/agent-0',
      });

      // Clean up
      coordinator.clear();
    });

    it('should increment crash count on each crash', async () => {
      const { coordinator } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // First crash
      coordinator.handleWorkerCrash('agent-0', 1);
      expect(coordinator.getWorkerCrashCount('agent-0')).toBe(1);

      // Reset recovery state for second crash
      const workerState = (coordinator as any).workers.get('agent-0');
      workerState.isRecovering = false;

      // Second crash
      coordinator.handleWorkerCrash('agent-0', 1);
      expect(coordinator.getWorkerCrashCount('agent-0')).toBe(2);

      // Clean up
      coordinator.clear();
    });

    it('should not handle crash if already recovering', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker that is already recovering
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 1,
        isRecovering: true,
      });

      // Try to handle another crash
      coordinator.handleWorkerCrash('agent-0', 1);

      // Verify it was skipped
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping crash recovery: already recovering or swarm stopping',
        expect.objectContaining({
          agentId: 'agent-0',
          isRecovering: true,
        })
      );

      // Clean up
      coordinator.clear();
    });

    it('should not handle crash if swarm is not running', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Don't start the coordinator - it's not running

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Try to handle crash
      coordinator.handleWorkerCrash('agent-0', 1);

      // Verify it was skipped (swarm not running)
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping crash recovery: already recovering or swarm stopping',
        expect.objectContaining({
          agentId: 'agent-0',
          isRunning: false,
        })
      );

      // Clean up
      coordinator.clear();
    });
  });

  describe('executeCrashRecovery', () => {
    it('should restart worker within 60 seconds', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });

      // Mock spawnWorker
      const spawnWorkerSpy = vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);

      // Set a very short recovery delay for testing
      coordinator.setCrashRecoveryDelay(10);

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', 1);

      // Wait for recovery to execute
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify worker was respawned with previous state
      expect(spawnWorkerSpy).toHaveBeenCalledWith(
        'agent-0',
        0,
        config,
        expect.objectContaining({
          isExecuting: true,
          currentExperiment: 'abc1234',
        })
      );

      // Verify recovery completed
      expect(logger.info).toHaveBeenCalledWith(
        'Crash recovery completed',
        expect.objectContaining({
          agentId: 'agent-0',
          gpuId: 0,
        })
      );

      // Clean up
      coordinator.clear();
    });

    it('should restore previous state on restart', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker with state
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'xyz9999',
        crashCount: 0,
        isRecovering: false,
        lastState: { branch: 'autoresearch/swarm/agent-0' },
      });

      // Mock spawnWorker to capture the previous state
      let capturedPreviousState: any = null;
      vi.spyOn(coordinator as any, 'spawnWorker').mockImplementation(
        async (_agentId: string, _gpuId: number, _config: any, previousState: any) => {
          capturedPreviousState = previousState;
          // Simulate worker being added
          (coordinator as any).workers.set('agent-0', {
            worker: { stop: vi.fn().mockResolvedValue(undefined) },
            agentId: 'agent-0',
            gpuId: 0,
            isExecuting: false,
            currentExperiment: null,
            crashCount: 0,
            isRecovering: false,
            lastState: previousState,
          });
        }
      );

      // Set a very short recovery delay
      coordinator.setCrashRecoveryDelay(10);

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', 1);

      // Wait for recovery
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify previous state was passed
      expect(capturedPreviousState).toEqual({
        isExecuting: true,
        currentExperiment: 'xyz9999',
        branch: 'autoresearch/swarm/agent-0',
      });

      // Clean up
      coordinator.clear();
    });
  });

  describe('cancelCrashRecovery', () => {
    it('should cancel pending crash recovery', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Set a longer recovery delay
      coordinator.setCrashRecoveryDelay(1000);

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', 1);
      expect(coordinator.getPendingCrashRecoveryCount()).toBe(1);

      // Cancel recovery
      coordinator.cancelCrashRecovery('agent-0');
      expect(coordinator.getPendingCrashRecoveryCount()).toBe(0);

      // Verify cancellation was logged
      expect(logger.info).toHaveBeenCalledWith(
        'Cancelled crash recovery',
        { agentId: 'agent-0' }
      );

      // Clean up
      coordinator.clear();
    });
  });

  describe('stop() with pending recoveries', () => {
    it('should cancel all pending crash recoveries on stop', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      vi.spyOn(coordinator.getExperimentRegistry(), 'persist').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers
      for (let i = 0; i < 2; i++) {
        (coordinator as any).workers.set(`agent-${i}`, {
          worker: { stop: vi.fn().mockResolvedValue(undefined) },
          agentId: `agent-${i}`,
          gpuId: i,
          isExecuting: false,
          currentExperiment: null,
          crashCount: 0,
          isRecovering: false,
        });
      }

      // Set a longer recovery delay
      coordinator.setCrashRecoveryDelay(10000);

      // Handle crashes for both workers
      coordinator.handleWorkerCrash('agent-0', 1);
      coordinator.handleWorkerCrash('agent-1', 1);
      expect(coordinator.getPendingCrashRecoveryCount()).toBe(2);

      // Stop coordinator
      await coordinator.stop();

      // Verify all recoveries were cancelled
      expect(coordinator.getPendingCrashRecoveryCount()).toBe(0);

      // Clean up
      coordinator.clear();
    });
  });

  describe('crash tracking', () => {
    it('should track last crash time', async () => {
      const { coordinator } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add a worker
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      const beforeCrash = Date.now();

      // Handle crash
      coordinator.handleWorkerCrash('agent-0', 1);

      const afterCrash = Date.now();
      const lastCrashTime = coordinator.getWorkerLastCrashTime('agent-0');

      expect(lastCrashTime).toBeDefined();
      expect(lastCrashTime).toBeGreaterThanOrEqual(beforeCrash);
      expect(lastCrashTime).toBeLessThanOrEqual(afterCrash);

      // Clean up
      coordinator.clear();
    });

    it('should return undefined for non-existent worker', () => {
      const { coordinator } = createTestCoordinator();

      expect(coordinator.getWorkerCrashCount('non-existent')).toBe(0);
      expect(coordinator.isWorkerRecovering('non-existent')).toBe(false);
      expect(coordinator.getWorkerLastCrashTime('non-existent')).toBeUndefined();
    });
  });
});


// ============================================================================
// GPU Failover Tests
// ============================================================================

describe('SwarmCoordinator GPU Failover', () => {
  /**
   * Creates a mock SwarmConfig for testing.
   */
  function createTestConfig(gpuIds: number[]): any {
    return {
      pools: [
        {
          id: 'gpu-worker',
          command: 'node',
          args: ['./worker.js'],
          instances: gpuIds.length,
        },
      ],
      swarm: {
        gpuIds,
        agentModel: 'test-model',
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
    };
  }

  describe('detectUnavailableGpus', () => {
    it('should return empty array when all GPUs are available', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers with mock GPU availability
      for (let i = 0; i < 3; i++) {
        (coordinator as any).workers.set(`agent-${i}`, {
          worker: {
            stop: vi.fn().mockResolvedValue(undefined),
            checkGpuAvailable: vi.fn().mockResolvedValue(true),
          },
          agentId: `agent-${i}`,
          gpuId: i,
          isExecuting: false,
          currentExperiment: null,
          crashCount: 0,
          isRecovering: false,
        });
      }

      const unavailable = await coordinator.detectUnavailableGpus();

      expect(unavailable).toEqual([]);

      // Clean up
      coordinator.clear();
    });

    it('should detect unavailable GPUs', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers - GPU 1 is unavailable
      (coordinator as any).workers.set('agent-0', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(false), // Unavailable
        },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-2', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-2',
        gpuId: 2,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      const unavailable = await coordinator.detectUnavailableGpus();

      expect(unavailable).toEqual([1]);
      expect(logger.warn).toHaveBeenCalledWith(
        'GPU unavailable detected',
        expect.objectContaining({ agentId: 'agent-1', gpuId: 1 })
      );

      // Clean up
      coordinator.clear();
    });

    it('should treat GPU check errors as unavailable', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers - GPU 1 throws error on check
      (coordinator as any).workers.set('agent-0', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockRejectedValue(new Error('GPU check failed')),
        },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      const unavailable = await coordinator.detectUnavailableGpus();

      expect(unavailable).toEqual([1]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to check GPU availability',
        expect.objectContaining({
          agentId: 'agent-1',
          gpuId: 1,
          error: 'GPU check failed',
        })
      );

      // Clean up
      coordinator.clear();
    });
  });

  describe('getAvailableGpus', () => {
    it('should return GPUs that are not executing or recovering', async () => {
      const { coordinator } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2, 3]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers with different states
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn() },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn() },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: true, // Executing
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-2', {
        worker: { stop: vi.fn() },
        agentId: 'agent-2',
        gpuId: 2,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: true, // Recovering
      });
      (coordinator as any).workers.set('agent-3', {
        worker: { stop: vi.fn() },
        agentId: 'agent-3',
        gpuId: 3,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      const available = coordinator.getAvailableGpus();

      // Only GPUs 0 and 3 should be available
      expect(available.sort()).toEqual([0, 3]);

      // Clean up
      coordinator.clear();
    });

    it('should return empty array when all GPUs are busy', async () => {
      const { coordinator } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // All workers are executing
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn() },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn() },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: true,
        currentExperiment: 'def5678',
        crashCount: 0,
        isRecovering: false,
      });

      const available = coordinator.getAvailableGpus();

      expect(available).toEqual([]);

      // Clean up
      coordinator.clear();
    });
  });

  describe('redistributeWork', () => {
    it('should redistribute work from unavailable GPU to available GPU', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually add workers
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true, // Has pending work
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
        lastState: { branch: 'autoresearch/swarm/agent-0' },
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false, // Available
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-2', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-2',
        gpuId: 2,
        isExecuting: false, // Available
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Mock stopWorker and spawnWorker
      vi.spyOn(coordinator as any, 'stopWorker').mockResolvedValue(undefined);
      vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);

      // Redistribute work from GPU 0 (unavailable) to an available GPU
      const newGpuId = await coordinator.redistributeWork(0);

      // Should have redistributed to GPU 1 or 2 (first available)
      expect(newGpuId).toBe(1);

      expect(logger.info).toHaveBeenCalledWith(
        'Work redistributed successfully',
        expect.objectContaining({
          affectedAgentId: 'agent-0',
          fromGpuId: 0,
          toGpuId: 1,
        })
      );

      // Clean up
      coordinator.clear();
    });

    it('should return null when no available GPUs', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // All workers are executing
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: true,
        currentExperiment: 'def5678',
        crashCount: 0,
        isRecovering: false,
      });

      // Try to redistribute from GPU 0
      const newGpuId = await coordinator.redistributeWork(0);

      expect(newGpuId).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'No available GPUs for work redistribution',
        expect.objectContaining({
          unavailableGpuId: 0,
          affectedAgentId: 'agent-0',
        })
      );

      // Clean up
      coordinator.clear();
    });

    it('should return null for non-existent GPU', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Add workers
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn() },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Try to redistribute from non-existent GPU
      const newGpuId = await coordinator.redistributeWork(99);

      expect(newGpuId).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'No worker found for unavailable GPU',
        { gpuId: 99 }
      );

      // Clean up
      coordinator.clear();
    });

    it('should preserve pending work state during redistribution', async () => {
      const { coordinator } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Worker with pending work
      (coordinator as any).workers.set('agent-0', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
        lastState: { branch: 'autoresearch/swarm/agent-0' },
      });
      (coordinator as any).workers.set('agent-1', {
        worker: { stop: vi.fn().mockResolvedValue(undefined) },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Mock stopWorker
      vi.spyOn(coordinator as any, 'stopWorker').mockResolvedValue(undefined);

      // Capture the previous state passed to spawnWorker
      let capturedPreviousState: any = null;
      vi.spyOn(coordinator as any, 'spawnWorker').mockImplementation(
        async (agentId: string, gpuId: number, config: any, previousState: any) => {
          capturedPreviousState = previousState;
        }
      );

      await coordinator.redistributeWork(0);

      // Verify previous state was preserved
      expect(capturedPreviousState).toEqual({
        isExecuting: true,
        currentExperiment: 'abc1234',
        branch: 'autoresearch/swarm/agent-0',
      });

      // Clean up
      coordinator.clear();
    });
  });

  describe('handleGpuFailover', () => {
    it('should detect and redistribute work for all unavailable GPUs', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2, 3]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // GPUs 0 and 2 are unavailable, GPUs 1 and 3 are available
      (coordinator as any).workers.set('agent-0', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(false), // Unavailable
        },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-2', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(false), // Unavailable
        },
        agentId: 'agent-2',
        gpuId: 2,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-3', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-3',
        gpuId: 3,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Mock stopWorker and spawnWorker
      vi.spyOn(coordinator as any, 'stopWorker').mockResolvedValue(undefined);
      vi.spyOn(coordinator as any, 'spawnWorker').mockResolvedValue(undefined);

      const result = await coordinator.handleGpuFailover();

      expect(result.unavailableGpus.sort()).toEqual([0, 2]);
      expect(result.redistributions.length).toBe(2);

      // Verify redistributions
      const redistribution0 = result.redistributions.find(r => r.fromGpuId === 0);
      const redistribution2 = result.redistributions.find(r => r.fromGpuId === 2);

      expect(redistribution0).toBeDefined();
      expect(redistribution0?.agentId).toBe('agent-0');
      expect(redistribution0?.toGpuId).not.toBeNull();

      expect(redistribution2).toBeDefined();
      expect(redistribution2?.agentId).toBe('agent-2');

      expect(logger.info).toHaveBeenCalledWith(
        'GPU failover completed',
        expect.objectContaining({
          unavailableGpus: expect.arrayContaining([0, 2]),
        })
      );

      // Clean up
      coordinator.clear();
    });

    it('should return empty result when all GPUs are available', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // All GPUs available
      (coordinator as any).workers.set('agent-0', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      const result = await coordinator.handleGpuFailover();

      expect(result.unavailableGpus).toEqual([]);
      expect(result.redistributions).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith('No unavailable GPUs detected');

      // Clean up
      coordinator.clear();
    });

    it('should handle partial redistribution when not enough available GPUs', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start coordinator
      const config = createTestConfig([0, 1, 2]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // GPUs 0 and 1 are unavailable, only GPU 2 is available
      (coordinator as any).workers.set('agent-0', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(false),
        },
        agentId: 'agent-0',
        gpuId: 0,
        isExecuting: true,
        currentExperiment: 'abc1234',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-1', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(false),
        },
        agentId: 'agent-1',
        gpuId: 1,
        isExecuting: true,
        currentExperiment: 'def5678',
        crashCount: 0,
        isRecovering: false,
      });
      (coordinator as any).workers.set('agent-2', {
        worker: {
          stop: vi.fn().mockResolvedValue(undefined),
          checkGpuAvailable: vi.fn().mockResolvedValue(true),
        },
        agentId: 'agent-2',
        gpuId: 2,
        isExecuting: false,
        currentExperiment: null,
        crashCount: 0,
        isRecovering: false,
      });

      // Mock stopWorker to actually remove the worker from the map
      vi.spyOn(coordinator as any, 'stopWorker').mockImplementation(async (agentId: string) => {
        (coordinator as any).workers.delete(agentId);
      });

      // Mock spawnWorker to add the worker back on the new GPU
      // This simulates the real behavior where the worker is moved to a new GPU
      vi.spyOn(coordinator as any, 'spawnWorker').mockImplementation(
        async (agentId: string, gpuId: number) => {
          (coordinator as any).workers.set(agentId, {
            worker: { stop: vi.fn().mockResolvedValue(undefined) },
            agentId,
            gpuId,
            isExecuting: true, // Mark as executing since it has pending work
            currentExperiment: null,
            crashCount: 0,
            isRecovering: false,
          });
        }
      );

      const result = await coordinator.handleGpuFailover();

      expect(result.unavailableGpus.sort()).toEqual([0, 1]);
      expect(result.redistributions.length).toBe(2);

      // First redistribution should succeed (to GPU 2)
      // Second redistribution should fail (no more available GPUs since GPU 2 is now busy)
      const successfulRedistributions = result.redistributions.filter(r => r.toGpuId !== null);
      const failedRedistributions = result.redistributions.filter(r => r.toGpuId === null);

      expect(successfulRedistributions.length).toBe(1);
      expect(failedRedistributions.length).toBe(1);

      // Clean up
      coordinator.clear();
    });
  });
});


// ============================================================================
// Backpressure Handling Tests
// ============================================================================

describe('SwarmCoordinator Backpressure Handling', () => {
  /**
   * Creates a test config with specific buffer limits.
   */
  function createConfigWithLimits(maxInputBuffer: number, maxOutputQueue: number): any {
    return {
      pools: [
        {
          id: 'gpu-worker',
          command: 'node',
          args: ['./worker.js'],
          instances: 1,
        },
      ],
      swarm: {
        gpuIds: [0],
        agentModel: 'test-model',
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
    };
  }

  describe('Input Buffer Backpressure', () => {
    it('should track input buffer size', () => {
      const { coordinator } = createTestCoordinator();

      expect(coordinator.getInputBufferSize()).toBe(0);
      expect(coordinator.isInputBackpressureActive()).toBe(false);
    });

    it('should accept data within buffer limit', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config that has 1KB input buffer limit
      const config = createConfigWithLimits(1024, 4096);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process small data (should be accepted)
      const smallData = '{"jsonrpc":"2.0","method":"test"}\n';
      const result = coordinator.processIncomingData(smallData);

      expect(result).toBe(true);
      expect(coordinator.isInputBackpressureActive()).toBe(false);

      coordinator.clear();
    });

    it('should reject data that exceeds buffer limit', async () => {
      const { coordinator, logger } = createTestCoordinator();

      // Start with config that has very small input buffer limit (100 bytes)
      const config = createConfigWithLimits(100, 4096);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process large data (should be rejected)
      const largeData = 'x'.repeat(200) + '\n';
      const result = coordinator.processIncomingData(largeData);

      expect(result).toBe(false);
      expect(coordinator.isInputBackpressureActive()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        'Input backpressure activated',
        expect.any(Object)
      );

      coordinator.clear();
    });

    it('should deactivate backpressure when buffer drops below 80%', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(1000, 4096);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually set buffer to trigger backpressure
      coordinator.updateInputBufferSize(950);
      expect(coordinator.isInputBackpressureActive()).toBe(false);

      // Try to add more - should trigger backpressure
      const accepted = coordinator.updateInputBufferSize(100);
      expect(accepted).toBe(false);
      expect(coordinator.isInputBackpressureActive()).toBe(true);

      // Reduce buffer below 80% (800 bytes)
      coordinator.updateInputBufferSize(-300); // Now at 650 bytes
      expect(coordinator.isInputBackpressureActive()).toBe(false);

      coordinator.clear();
    });
  });

  describe('Output Queue Backpressure', () => {
    it('should track output queue size', () => {
      const { coordinator } = createTestCoordinator();

      expect(coordinator.getOutputQueueSize()).toBe(0);
      expect(coordinator.isOutputBackpressureActive()).toBe(false);
    });

    it('should send messages within queue limit', async () => {
      const { coordinator, output } = createTestCoordinator();

      // Start with config that has 4KB output queue limit
      const config = createConfigWithLimits(1024, 4096);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Send small message (should be sent immediately)
      const message = createRequest('test-1', METHOD_NAMES.SWARM_STATUS);
      const result = coordinator.sendMessage(message);

      expect(result).toBe(true);
      expect(output.length).toBe(1);
      expect(coordinator.isOutputBackpressureActive()).toBe(false);

      coordinator.clear();
    });

    it('should queue messages when output limit is exceeded', async () => {
      const { coordinator, output, logger } = createTestCoordinator();

      // Start with config that has very small output queue limit (50 bytes)
      const config = createConfigWithLimits(1024, 50);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually trigger output backpressure
      coordinator.updateOutputQueueSize(60);
      expect(coordinator.isOutputBackpressureActive()).toBe(true);

      // Try to send message (should be queued)
      const message = createRequest('test-1', METHOD_NAMES.SWARM_STATUS);
      const result = coordinator.sendMessage(message);

      expect(result).toBe(false);
      expect(output.length).toBe(0); // Not sent yet
      expect(coordinator.getPendingOutputCount()).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Message queued due to output backpressure',
        expect.any(Object)
      );

      coordinator.clear();
    });

    it('should flush pending messages when backpressure is relieved', async () => {
      const { coordinator, output } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(1024, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Manually trigger output backpressure
      coordinator.updateOutputQueueSize(90);
      expect(coordinator.isOutputBackpressureActive()).toBe(false);

      // Add more to trigger backpressure
      coordinator.updateOutputQueueSize(20);
      expect(coordinator.isOutputBackpressureActive()).toBe(true);

      // Queue a message
      const message = createRequest('test-1', METHOD_NAMES.SWARM_STATUS);
      coordinator.sendMessage(message);
      expect(coordinator.getPendingOutputCount()).toBe(1);
      expect(output.length).toBe(0);

      // Relieve backpressure (reduce below 80% = 80 bytes)
      coordinator.updateOutputQueueSize(-60); // Now at 50 bytes
      expect(coordinator.isOutputBackpressureActive()).toBe(false);

      // Pending message should have been flushed
      expect(coordinator.getPendingOutputCount()).toBe(0);
      expect(output.length).toBe(1);

      coordinator.clear();
    });
  });

  describe('Backpressure Status', () => {
    it('should return complete backpressure status', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(1024, 4096);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      const status = coordinator.getBackpressureStatus();

      expect(status).toEqual({
        inputBufferSize: 0,
        maxInputBuffer: 1024,
        inputBackpressureActive: false,
        outputQueueSize: 0,
        maxOutputQueue: 4096,
        outputBackpressureActive: false,
        pendingOutputCount: 0,
      });

      coordinator.clear();
    });

    it('should reflect active backpressure in status', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(100, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Trigger both backpressures
      coordinator.updateInputBufferSize(90);
      coordinator.updateInputBufferSize(20); // Should fail and activate backpressure
      coordinator.updateOutputQueueSize(110); // Should fail and activate backpressure

      const status = coordinator.getBackpressureStatus();

      expect(status.inputBackpressureActive).toBe(true);
      expect(status.outputBackpressureActive).toBe(true);

      coordinator.clear();
    });
  });

  describe('Backpressure Reset', () => {
    it('should reset all backpressure state', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(100, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Set up some state
      coordinator.updateInputBufferSize(50);
      coordinator.updateOutputQueueSize(50);

      // Reset
      coordinator.resetBackpressureState();

      expect(coordinator.getInputBufferSize()).toBe(0);
      expect(coordinator.getOutputQueueSize()).toBe(0);
      expect(coordinator.isInputBackpressureActive()).toBe(false);
      expect(coordinator.isOutputBackpressureActive()).toBe(false);
      expect(coordinator.getPendingOutputCount()).toBe(0);

      coordinator.clear();
    });

    it('should reset backpressure state on clear()', async () => {
      const { coordinator } = createTestCoordinator();

      // Start with config
      const config = createConfigWithLimits(100, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Set up some state
      coordinator.updateInputBufferSize(50);
      coordinator.updateOutputQueueSize(50);

      // Clear coordinator
      coordinator.clear();

      expect(coordinator.getInputBufferSize()).toBe(0);
      expect(coordinator.getOutputQueueSize()).toBe(0);
      expect(coordinator.isInputBackpressureActive()).toBe(false);
      expect(coordinator.isOutputBackpressureActive()).toBe(false);
    });
  });

  describe('Default Limits', () => {
    it('should use default limits when config has no limits', () => {
      const { coordinator } = createTestCoordinator();

      // Without starting (no config), should use defaults
      expect(coordinator.getMaxInputBuffer()).toBe(1048576); // 1MB
      expect(coordinator.getMaxOutputQueue()).toBe(4194304); // 4MB
    });
  });

  describe('wouldExceedLimit helpers', () => {
    it('should correctly predict if input limit would be exceeded', async () => {
      const { coordinator } = createTestCoordinator();

      const config = createConfigWithLimits(100, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      coordinator.updateInputBufferSize(50);

      expect(coordinator.wouldExceedInputLimit(40)).toBe(false); // 50 + 40 = 90 < 100
      expect(coordinator.wouldExceedInputLimit(60)).toBe(true);  // 50 + 60 = 110 > 100

      coordinator.clear();
    });

    it('should correctly predict if output limit would be exceeded', async () => {
      const { coordinator } = createTestCoordinator();

      const config = createConfigWithLimits(100, 100);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      coordinator.updateOutputQueueSize(50);

      expect(coordinator.wouldExceedOutputLimit(40)).toBe(false); // 50 + 40 = 90 < 100
      expect(coordinator.wouldExceedOutputLimit(60)).toBe(true);  // 50 + 60 = 110 > 100

      coordinator.clear();
    });
  });
});

describe('SwarmCoordinator Progress Reporting', () => {
  /**
   * Helper to wait for async message processing.
   */
  const waitForProcessing = () => new Promise(resolve => setTimeout(resolve, 10));

  /**
   * Creates a test coordinator with progress writer capture.
   */
  function createProgressTestCoordinator(): {
    coordinator: SwarmCoordinator;
    output: string[];
    progressOutput: string[];
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  } {
    const output: string[] = [];
    const progressOutput: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const coordinator = createSwarmCoordinator({
      logger,
      fileLogger: logger,
      experimentRegistry: createExperimentRegistry({ resultsPath: '/tmp/test-results.tsv' }),
      stateBroadcaster: createStateBroadcaster(),
      conflictResolver: createConflictResolver(),
      sessionRouter: createSessionRouter(),
    });

    // Capture JSON-RPC output
    coordinator.setOutputWriter((data: string) => {
      output.push(data);
    });

    // Capture progress output
    coordinator.setProgressWriter((message: string) => {
      progressOutput.push(message);
    });

    return { coordinator, output, progressOutput, logger };
  }

  function createProgressTestConfig(gpuIds: number[]): any {
    return {
      pools: [
        {
          id: 'gpu-worker',
          command: 'node',
          args: ['./worker.js'],
          instances: gpuIds.length,
        },
      ],
      swarm: {
        gpuIds,
        agentModel: 'test-model',
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
    };
  }

  describe('Progress Summary Interval', () => {
    /**
     * Validates: Requirements 10.2
     * Tests that progress summary is written every 10 experiments.
     */
    it('should write progress summary every 10 experiments', async () => {
      const { coordinator, progressOutput, logger } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 10 experiment results
      for (let i = 0; i < 10; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0 - i * 0.01,
          memoryGb: 44.0,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      // Should have written exactly one progress summary (plus new best messages)
      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(1);
      expect(progressSummaries[0]).toContain('10 experiments completed');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.2
     * Tests that progress summary is written at correct intervals.
     */
    it('should write progress summary at correct intervals', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 25 experiment results
      for (let i = 0; i < 25; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      // Should have written 2 progress summaries (at 10 and 20)
      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(2);
      expect(progressSummaries[0]).toContain('10 experiments completed');
      expect(progressSummaries[1]).toContain('20 experiments completed');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.2
     * Tests that no progress summary is written before 10 experiments.
     */
    it('should not write progress summary before 10 experiments', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 9 experiment results
      for (let i = 0; i < 9; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      // Should not have written any progress summary
      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(0);

      coordinator.clear();
    });

    /**
     * Tests that progress report interval can be configured.
     */
    it('should allow configuring progress report interval', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Set interval to 5
      coordinator.setProgressReportInterval(5);
      expect(coordinator.getProgressReportInterval()).toBe(5);

      // Process 5 experiment results
      for (let i = 0; i < 5; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      // Should have written one progress summary at 5 experiments
      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(1);
      expect(progressSummaries[0]).toContain('5 experiments completed');

      coordinator.clear();
    });
  });

  describe('Progress Summary Content', () => {
    /**
     * Validates: Requirements 10.2
     * Tests that progress summary contains required information.
     */
    it('should include best val_bpb in progress summary', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 10 experiments with varying val_bpb
      for (let i = 0; i < 10; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: i === 5 ? 0.95 : 1.0, // Best at experiment 5
          memoryGb: 44.0,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(1);
      expect(progressSummaries[0]).toContain('Best val_bpb: 0.950000');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.2
     * Tests that progress summary shows N/A when no keep results.
     */
    it('should show N/A for best val_bpb when no keep results', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 10 experiments all with discard status
      for (let i = 0; i < 10; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(1);
      expect(progressSummaries[0]).toContain('Best val_bpb: N/A');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.2
     * Tests that progress summary includes throughput.
     */
    it('should include throughput in progress summary', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 10 experiments
      for (let i = 0; i < 10; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      const progressSummaries = progressOutput.filter(msg => msg.includes('SWARM PROGRESS REPORT'));
      expect(progressSummaries.length).toBe(1);
      expect(progressSummaries[0]).toContain('Throughput:');
      expect(progressSummaries[0]).toContain('experiments/hour');

      coordinator.clear();
    });
  });

  describe('New Best val_bpb Logging', () => {
    /**
     * Validates: Requirements 10.4
     * Tests that highlighted message is logged for new best val_bpb.
     */
    it('should log highlighted message for new best val_bpb', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // First experiment sets the baseline
      const notification1 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0001',
        valBpb: 1.0,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification1));
      await waitForProcessing();

      // Second experiment achieves new best
      const notification2 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0002',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'improved LR',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification2));
      await waitForProcessing();

      // Should have logged highlighted message for new best
      const newBestMessages = progressOutput.filter(msg => msg.includes('NEW BEST val_bpb'));
      expect(newBestMessages.length).toBe(2); // First experiment is also a new best (from Infinity)
      expect(newBestMessages[1]).toContain('0.950000');
      expect(newBestMessages[1]).toContain('agent-0');
      expect(newBestMessages[1]).toContain('abc0002');
      expect(newBestMessages[1]).toContain('improved LR');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.4
     * Tests that highlighted message includes star decorations.
     */
    it('should include star decorations in new best message', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0001',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification));
      await waitForProcessing();

      expect(progressOutput.length).toBe(1);
      expect(progressOutput[0]).toContain('★');
      expect(progressOutput[0]).toContain('🎉');

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.4
     * Tests that no highlighted message for non-keep results.
     */
    it('should not log highlighted message for non-keep results', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // First experiment sets baseline
      const notification1 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0001',
        valBpb: 1.0,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification1));
      await waitForProcessing();

      // Clear progress output after baseline
      progressOutput.length = 0;

      // Discard result with lower val_bpb should not trigger new best
      const notification2 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0002',
        valBpb: 0.5, // Lower but discarded
        memoryGb: 44.0,
        status: 'discard',
        description: 'discarded',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification2));
      await waitForProcessing();

      // Should not have logged new best message
      const newBestMessages = progressOutput.filter(msg => msg.includes('NEW BEST val_bpb'));
      expect(newBestMessages.length).toBe(0);

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.4
     * Tests that no highlighted message when val_bpb is not better.
     */
    it('should not log highlighted message when val_bpb is not better', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // First experiment sets baseline
      const notification1 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0001',
        valBpb: 0.9,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification1));
      await waitForProcessing();

      // Clear progress output after baseline
      progressOutput.length = 0;

      // Keep result with higher val_bpb should not trigger new best
      const notification2 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0002',
        valBpb: 1.0, // Higher (worse)
        memoryGb: 44.0,
        status: 'keep',
        description: 'worse',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification2));
      await waitForProcessing();

      // Should not have logged new best message
      const newBestMessages = progressOutput.filter(msg => msg.includes('NEW BEST val_bpb'));
      expect(newBestMessages.length).toBe(0);

      coordinator.clear();
    });

    /**
     * Validates: Requirements 10.4
     * Tests that equal val_bpb does not trigger new best message.
     */
    it('should not log highlighted message for equal val_bpb', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // First experiment sets baseline
      const notification1 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0001',
        valBpb: 0.9,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification1));
      await waitForProcessing();

      // Clear progress output after baseline
      progressOutput.length = 0;

      // Keep result with equal val_bpb should not trigger new best
      const notification2 = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc0002',
        valBpb: 0.9, // Equal
        memoryGb: 44.0,
        status: 'keep',
        description: 'equal',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      coordinator.processIncomingData(encode(notification2));
      await waitForProcessing();

      // Should not have logged new best message
      const newBestMessages = progressOutput.filter(msg => msg.includes('NEW BEST val_bpb'));
      expect(newBestMessages.length).toBe(0);

      coordinator.clear();
    });
  });

  describe('Progress State Management', () => {
    /**
     * Tests that progress state is reset when coordinator is cleared.
     */
    it('should reset progress state on clear', async () => {
      const { coordinator, progressOutput } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 5 experiments
      for (let i = 0; i < 5; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      expect(coordinator.getExperimentsSinceLastReport()).toBe(5);

      // Clear and restart
      coordinator.clear();
      await coordinator.start(config);

      expect(coordinator.getExperimentsSinceLastReport()).toBe(0);

      coordinator.clear();
    });

    /**
     * Tests that experiments since last report is tracked correctly.
     */
    it('should track experiments since last report', async () => {
      const { coordinator } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      expect(coordinator.getExperimentsSinceLastReport()).toBe(0);

      // Process 3 experiments
      for (let i = 0; i < 3; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      expect(coordinator.getExperimentsSinceLastReport()).toBe(3);

      coordinator.clear();
    });

    /**
     * Tests that counter resets after progress report.
     */
    it('should reset counter after progress report', async () => {
      const { coordinator } = createProgressTestCoordinator();

      const config = createProgressTestConfig([0]);
      vi.spyOn(coordinator as any, 'spawnWorkers').mockResolvedValue(undefined);
      vi.spyOn(coordinator.getExperimentRegistry(), 'restore').mockResolvedValue();
      await coordinator.start(config);

      // Process 10 experiments
      for (let i = 0; i < 10; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      // Counter should be reset after 10 experiments
      expect(coordinator.getExperimentsSinceLastReport()).toBe(0);

      // Process 3 more
      for (let i = 10; i < 13; i++) {
        const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
          commit: `abc${i.toString().padStart(4, '0')}`,
          valBpb: 1.0,
          memoryGb: 44.0,
          status: 'discard',
          description: `experiment ${i}`,
          agentId: 'agent-0',
          timestamp: new Date().toISOString(),
          branch: 'autoresearch/swarm/agent-0',
        });
        coordinator.processIncomingData(encode(notification));
        await waitForProcessing();
      }

      expect(coordinator.getExperimentsSinceLastReport()).toBe(3);

      coordinator.clear();
    });
  });

  describe('Progress Chart Generation', () => {
    it('should have a progress chart generator', () => {
      const { coordinator } = createTestCoordinator();

      const chartGenerator = coordinator.getProgressChartGenerator();
      expect(chartGenerator).toBeDefined();
      expect(typeof chartGenerator.generateChartData).toBe('function');
      expect(typeof chartGenerator.generateSvgChart).toBe('function');
    });

    it('should generate chart data from experiment results', async () => {
      const { coordinator } = createTestCoordinator();

      // Add some experiment results
      const registry = coordinator.getExperimentRegistry();
      await registry.recordResult({
        commit: 'abc1234',
        valBpb: 1.0,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test experiment 1',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });
      await registry.recordResult({
        commit: 'def5678',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test experiment 2',
        agentId: 'agent-1',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-1',
      });

      const chartData = coordinator.getChartData();

      expect(chartData.totalExperiments).toBe(2);
      expect(chartData.dataPoints.length).toBe(2);
      expect(chartData.agents).toContain('agent-0');
      expect(chartData.agents).toContain('agent-1');
      expect(chartData.bestValBpb).toBe(0.95);
    });

    it('should generate SVG chart', async () => {
      const { coordinator } = createTestCoordinator();

      // Add some experiment results
      const registry = coordinator.getExperimentRegistry();
      await registry.recordResult({
        commit: 'abc1234',
        valBpb: 1.0,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test experiment',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      });

      const chartGenerator = coordinator.getProgressChartGenerator();
      const svg = chartGenerator.generateSvgChart(registry.getAllResults());

      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('val_bpb Progress Over Time');
    });
  });
});
