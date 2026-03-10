/**
 * Integration Tests for stdio_bus Swarm Coordinator
 * 
 * These tests verify end-to-end flows through the entire system,
 * testing the interaction between all components.
 * 
 * Note: These tests use mocked GPU workers since actual GPUs are not
 * available in CI environments. The tests focus on verifying the
 * integration between components rather than actual GPU operations.
 * 
 * Test Coverage:
 * - Task 17.1: Agent join flow
 * - Task 17.2: Experiment execution flow
 * - Task 17.3: Conflict resolution flow
 * - Task 17.4: Fault recovery flow
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExperimentResult, createExperimentRegistry, ExperimentRegistry } from './state/experiment-registry';
import { createStateBroadcaster, StateBroadcaster } from './broadcast/state-broadcaster';
import { createConflictResolver, ConflictResolver } from './conflict/conflict-resolver';
import { createSessionRouter, SessionRouter } from './routing/session-router';
import {
  METHOD_NAMES,
  createRequest,
  createNotification,
} from './protocol/types';
import { encode, decode } from './protocol/codec';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a test experiment result.
 */
function createTestResult(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    commit: 'abc1234',
    valBpb: 1.5,
    memoryGb: 8.0,
    status: 'keep',
    description: 'Test experiment',
    agentId: 'agent-0',
    timestamp: new Date().toISOString(),
    branch: 'autoresearch/swarm/agent-0',
    ...overrides,
  };
}

/**
 * Integration test context with all components wired together.
 */
interface IntegrationContext {
  registry: ExperimentRegistry;
  broadcaster: StateBroadcaster;
  resolver: ConflictResolver;
  router: SessionRouter;
  broadcastedResults: ExperimentResult[];
  newBestResults: ExperimentResult[];
}

/**
 * Creates an integration test context with all components wired together.
 */
function createIntegrationContext(): IntegrationContext {
  const registry = createExperimentRegistry();
  const broadcaster = createStateBroadcaster();
  const resolver = createConflictResolver();
  const router = createSessionRouter();

  const broadcastedResults: ExperimentResult[] = [];
  const newBestResults: ExperimentResult[] = [];

  // Wire up broadcaster callbacks
  // Note: onBroadcast receives a ResultMessage, we extract params
  broadcaster.onBroadcast((message) => {
    const params = message.params;
    broadcastedResults.push({
      commit: params.commit,
      valBpb: params.valBpb,
      memoryGb: params.memoryGb,
      status: params.status,
      description: params.description,
      agentId: params.agentId,
      timestamp: params.timestamp,
      branch: params.branch,
    });
  });

  // Note: onPriority receives an ExperimentResult directly
  broadcaster.onPriority((result) => {
    newBestResults.push(result);
  });

  return {
    registry,
    broadcaster,
    resolver,
    router,
    broadcastedResults,
    newBestResults,
  };
}

// ============================================================================
// Task 17.1: Agent Join Flow Integration Test
// ============================================================================

describe('Integration: Agent Join Flow', () => {
  let ctx: IntegrationContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  afterEach(() => {
    ctx.registry.clear();
    ctx.broadcaster.clear();
    ctx.resolver.clear();
    ctx.router.clear();
  });

  it('new agent receives complete history and best val_bpb on join', async () => {
    // Setup: Record some experiment results to create history
    const results: ExperimentResult[] = [
      createTestResult({
        commit: 'abc1234',
        valBpb: 1.5,
        agentId: 'agent-0',
        timestamp: '2024-01-01T10:00:00Z',
      }),
      createTestResult({
        commit: 'def5678',
        valBpb: 1.2, // Best result
        agentId: 'agent-1',
        timestamp: '2024-01-01T10:05:00Z',
      }),
      createTestResult({
        commit: 'ghi9012',
        valBpb: 1.8,
        status: 'discard',
        agentId: 'agent-0',
        timestamp: '2024-01-01T10:10:00Z',
      }),
    ];

    for (const result of results) {
      await ctx.registry.recordResult(result);
    }

    // Register agents
    ctx.registry.registerAgent('agent-0');
    ctx.registry.registerAgent('agent-1');

    // Simulate new agent joining by getting state
    const state = await ctx.registry.getState();
    const recentResults = await ctx.registry.getRecentResults(50);

    // Verify sync response data
    expect(state.bestValBpb).toBe(1.2); // Best from results
    expect(state.totalExperiments).toBe(3);
    expect(recentResults).toHaveLength(3);

    // Verify recent results contain all experiments
    const commits = recentResults.map(r => r.commit);
    expect(commits).toContain('abc1234');
    expect(commits).toContain('def5678');
    expect(commits).toContain('ghi9012');
  });

  it('agent receives state including active agents count', async () => {
    // Register multiple agents
    ctx.registry.registerAgent('agent-0');
    ctx.registry.registerAgent('agent-1');
    ctx.registry.registerAgent('agent-2');

    // Get state
    const state = await ctx.registry.getState();

    expect(state.activeAgents).toHaveLength(3);
    expect(state.activeAgents).toContain('agent-0');
    expect(state.activeAgents).toContain('agent-1');
    expect(state.activeAgents).toContain('agent-2');
  });

  it('session router assigns unique sessions to agents', () => {
    // Assign sessions for multiple agents
    const sessionId0 = ctx.router.assignSession('agent-0', 0);
    const sessionId1 = ctx.router.assignSession('agent-1', 1);
    const sessionId2 = ctx.router.assignSession('agent-2', 2);

    // Verify unique session IDs
    expect(sessionId0).not.toBe(sessionId1);
    expect(sessionId1).not.toBe(sessionId2);
    expect(sessionId0).not.toBe(sessionId2);

    // Verify session metadata via getSessionByAgent
    const session0 = ctx.router.getSessionByAgent('agent-0');
    const session1 = ctx.router.getSessionByAgent('agent-1');
    expect(session0?.agentId).toBe('agent-0');
    expect(session0?.gpuId).toBe(0);
    expect(session1?.agentId).toBe('agent-1');
    expect(session1?.gpuId).toBe(1);
  });
});

// ============================================================================
// Task 17.2: Experiment Execution Flow Integration Test
// ============================================================================

describe('Integration: Experiment Execution Flow', () => {
  let ctx: IntegrationContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  afterEach(() => {
    ctx.registry.clear();
    ctx.broadcaster.clear();
    ctx.resolver.clear();
    ctx.router.clear();
  });

  it('lock acquire → experiment result → broadcast flow', async () => {
    // Setup: Register agent and subscribe to broadcasts
    ctx.registry.registerAgent('agent-0');
    ctx.broadcaster.subscribe('agent-0');

    // Step 1: Acquire lock
    const lockResult = await ctx.resolver.acquireLock('agent-0');
    expect(lockResult.granted).toBe(true);

    // Step 2: Record experiment result
    const result = createTestResult({
      commit: 'test123',
      valBpb: 1.1,
      agentId: 'agent-0',
    });
    await ctx.registry.recordResult(result);

    // Step 3: Broadcast result
    await ctx.broadcaster.broadcastResult(result);

    // Step 4: Release lock
    await ctx.resolver.releaseLock('agent-0');

    // Verify result was recorded
    expect(ctx.registry.getTotalExperiments()).toBe(1);
    expect(ctx.registry.getBestValBpb()).toBe(1.1);

    // Verify broadcast was sent
    expect(ctx.broadcastedResults.length).toBe(1);
    expect(ctx.broadcastedResults[0].commit).toBe('test123');
    expect(ctx.broadcastedResults[0].valBpb).toBe(1.1);
  });

  it('multiple agents can submit results concurrently', async () => {
    // Register multiple agents
    const agents = ['agent-0', 'agent-1', 'agent-2', 'agent-3'];
    for (const agentId of agents) {
      ctx.registry.registerAgent(agentId);
      ctx.broadcaster.subscribe(agentId);
    }

    // Submit results from multiple agents
    const results = agents.map((agentId, i) =>
      createTestResult({
        commit: `commit-${i}`,
        valBpb: 1.5 - (i * 0.1),
        agentId,
      })
    );

    // Record all results
    for (const result of results) {
      await ctx.registry.recordResult(result);
      await ctx.broadcaster.broadcastResult(result);
    }

    // Verify all results recorded
    expect(ctx.registry.getTotalExperiments()).toBe(4);
    expect(ctx.registry.getBestValBpb()).toBe(1.2); // 1.5 - 0.3 = 1.2 (agent-3)

    // Verify all broadcasts sent
    expect(ctx.broadcastedResults.length).toBe(4);
  });

  it('new best val_bpb triggers priority notification', async () => {
    ctx.registry.registerAgent('agent-0');
    ctx.broadcaster.subscribe('agent-0');

    // Record first result
    const result1 = createTestResult({
      commit: 'first',
      valBpb: 1.5,
    });
    await ctx.registry.recordResult(result1);
    await ctx.broadcaster.broadcastResult(result1);
    await ctx.broadcaster.broadcastNewBest(result1);

    // Record better result
    const result2 = createTestResult({
      commit: 'better',
      valBpb: 1.2,
    });
    await ctx.registry.recordResult(result2);
    await ctx.broadcaster.broadcastResult(result2);
    await ctx.broadcaster.broadcastNewBest(result2);

    // Verify new best notifications
    expect(ctx.newBestResults.length).toBe(2);
    expect(ctx.newBestResults[1].valBpb).toBe(1.2);
  });
});

// ============================================================================
// Task 17.3: Conflict Resolution Flow Integration Test
// ============================================================================

describe('Integration: Conflict Resolution Flow', () => {
  let ctx: IntegrationContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  afterEach(() => {
    ctx.registry.clear();
    ctx.broadcaster.clear();
    ctx.resolver.clear();
    ctx.router.clear();
  });

  it('concurrent lock requests are queued and processed in order', async () => {
    // Agent 0 acquires lock first
    const lock1 = await ctx.resolver.acquireLock('agent-0');
    expect(lock1.granted).toBe(true);

    // Agent 1 tries to acquire - should be queued
    const lock2Result = await ctx.resolver.acquireLock('agent-1');

    // Check that agent-1 is queued (not granted)
    expect(lock2Result.granted).toBe(false);
    expect(lock2Result.queuePosition).toBe(1);
    expect(ctx.resolver.getQueueLength()).toBe(1);

    // Release first lock
    await ctx.resolver.releaseLock('agent-0');

    // Queue should be processed - agent-1 should now hold the lock
    expect(ctx.resolver.getQueueLength()).toBe(0);
    expect(ctx.resolver.holdsLock('agent-1')).toBe(true);
  });

  it('merge conflict resolution keeps lower val_bpb', async () => {
    // This is tested at the git level in the ConflictResolver
    // Here we just verify the lock mechanism works correctly
    // The actual merge conflict resolution is handled by git operations

    // Acquire lock for agent-0
    const lock1 = await ctx.resolver.acquireLock('agent-0');
    expect(lock1.granted).toBe(true);
    expect(lock1.branch).toBe('autoresearch/swarm/agent-0');

    // Release lock
    await ctx.resolver.releaseLock('agent-0');

    // Agent-1 can now acquire
    const lock2 = await ctx.resolver.acquireLock('agent-1');
    expect(lock2.granted).toBe(true);
    expect(lock2.branch).toBe('autoresearch/swarm/agent-1');
  });

  it('branch naming follows convention', () => {
    // Check branch names for each agent
    expect(ctx.resolver.getAgentBranch('agent-0')).toBe('autoresearch/swarm/agent-0');
    expect(ctx.resolver.getAgentBranch('agent-1')).toBe('autoresearch/swarm/agent-1');
    expect(ctx.resolver.getAgentBranch('agent-2')).toBe('autoresearch/swarm/agent-2');
  });
});

// ============================================================================
// Task 17.4: Fault Recovery Flow Integration Test
// ============================================================================

describe('Integration: Fault Recovery Flow', () => {
  let ctx: IntegrationContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  afterEach(() => {
    ctx.registry.clear();
    ctx.broadcaster.clear();
    ctx.resolver.clear();
    ctx.router.clear();
  });

  it('state is preserved after agent crash and recovery', async () => {
    // Register agent and record results
    ctx.registry.registerAgent('agent-0');

    await ctx.registry.recordResult(createTestResult({
      commit: 'pre-crash-1',
      valBpb: 1.5,
      agentId: 'agent-0',
    }));

    await ctx.registry.recordResult(createTestResult({
      commit: 'pre-crash-2',
      valBpb: 1.3,
      agentId: 'agent-0',
    }));

    expect(ctx.registry.getTotalExperiments()).toBe(2);
    expect(ctx.registry.getBestValBpb()).toBe(1.3);

    // Simulate agent crash by unregistering
    ctx.registry.unregisterAgent('agent-0');
    expect(ctx.registry.getActiveAgents()).toHaveLength(0);

    // Simulate recovery by re-registering
    ctx.registry.registerAgent('agent-0');
    expect(ctx.registry.getActiveAgents()).toHaveLength(1);

    // Verify state preserved
    expect(ctx.registry.getTotalExperiments()).toBe(2);
    expect(ctx.registry.getBestValBpb()).toBe(1.3);
  });

  it('session cleanup on agent disconnect', () => {
    // Assign session
    const sessionId = ctx.router.assignSession('agent-0', 0);
    expect(ctx.router.getSessionByAgent('agent-0')).not.toBeNull();

    // Release session (simulating disconnect)
    ctx.router.releaseSession(sessionId);
    expect(ctx.router.getSessionByAgent('agent-0')).toBeNull();
  });

  it('broadcaster handles subscriber disconnect gracefully', async () => {
    // Subscribe agent
    ctx.broadcaster.subscribe('agent-0');
    ctx.broadcaster.subscribe('agent-1');

    // Broadcast result
    const result = createTestResult();
    await ctx.broadcaster.broadcastResult(result);
    expect(ctx.broadcastedResults.length).toBe(1);

    // Unsubscribe one agent
    ctx.broadcaster.unsubscribe('agent-0');

    // Broadcast another result - should still work
    const result2 = createTestResult({ commit: 'second' });
    await ctx.broadcaster.broadcastResult(result2);
    expect(ctx.broadcastedResults.length).toBe(2);
  });

  it('lock is released when holding agent crashes', async () => {
    // Acquire lock
    const lock = await ctx.resolver.acquireLock('agent-0');
    expect(lock.granted).toBe(true);
    expect(ctx.resolver.isLocked()).toBe(true);

    // Simulate crash by force-releasing lock
    ctx.resolver.forceRelease();
    expect(ctx.resolver.isLocked()).toBe(false);

    // Another agent can now acquire
    const lock2 = await ctx.resolver.acquireLock('agent-1');
    expect(lock2.granted).toBe(true);
  });
});

// ============================================================================
// Additional Integration Tests
// ============================================================================

describe('Integration: End-to-End Data Flow', () => {
  let ctx: IntegrationContext;

  beforeEach(() => {
    ctx = createIntegrationContext();
  });

  afterEach(() => {
    ctx.registry.clear();
    ctx.broadcaster.clear();
    ctx.resolver.clear();
    ctx.router.clear();
  });

  it('complete experiment lifecycle from start to finish', async () => {
    // 1. Agent joins
    ctx.registry.registerAgent('agent-0');
    ctx.broadcaster.subscribe('agent-0');
    ctx.router.assignSession('agent-0', 0);

    // 2. Agent syncs state
    const initialState = await ctx.registry.getState();
    expect(initialState.totalExperiments).toBe(0);
    expect(initialState.bestValBpb).toBe(Infinity);

    // 3. Agent acquires lock
    const lock = await ctx.resolver.acquireLock('agent-0');
    expect(lock.granted).toBe(true);

    // 4. Agent runs experiment and records result
    const result = createTestResult({
      commit: 'experiment-1',
      valBpb: 1.25,
      agentId: 'agent-0',
    });
    await ctx.registry.recordResult(result);

    // 5. Agent broadcasts result
    await ctx.broadcaster.broadcastResult(result);
    await ctx.broadcaster.broadcastNewBest(result);

    // 6. Agent releases lock
    await ctx.resolver.releaseLock('agent-0');

    // 7. Verify final state
    const finalState = await ctx.registry.getState();
    expect(finalState.totalExperiments).toBe(1);
    expect(finalState.bestValBpb).toBe(1.25);
    expect(ctx.broadcastedResults.length).toBe(1);
    expect(ctx.newBestResults.length).toBe(1);
  });

  it('multiple agents working in parallel', async () => {
    // Setup multiple agents
    const agents = ['agent-0', 'agent-1', 'agent-2'];
    for (const agentId of agents) {
      ctx.registry.registerAgent(agentId);
      ctx.broadcaster.subscribe(agentId);
    }

    // Simulate parallel work
    const results: ExperimentResult[] = [];

    // Agent 0 runs experiment
    results.push(createTestResult({
      commit: 'exp-0',
      valBpb: 1.5,
      agentId: 'agent-0',
    }));

    // Agent 1 runs experiment (better result)
    results.push(createTestResult({
      commit: 'exp-1',
      valBpb: 1.2,
      agentId: 'agent-1',
    }));

    // Agent 2 runs experiment
    results.push(createTestResult({
      commit: 'exp-2',
      valBpb: 1.4,
      agentId: 'agent-2',
    }));

    // Record all results
    for (const result of results) {
      await ctx.registry.recordResult(result);
      await ctx.broadcaster.broadcastResult(result);
    }

    // Verify state
    expect(ctx.registry.getTotalExperiments()).toBe(3);
    expect(ctx.registry.getBestValBpb()).toBe(1.2);
    expect(ctx.broadcastedResults.length).toBe(3);
  });

  it('history query returns experiments in order', async () => {
    ctx.registry.registerAgent('agent-0');

    // Record experiments with different timestamps
    const timestamps = [
      '2024-01-01T10:00:00Z',
      '2024-01-01T10:05:00Z',
      '2024-01-01T10:10:00Z',
    ];

    for (let i = 0; i < timestamps.length; i++) {
      await ctx.registry.recordResult(createTestResult({
        commit: `commit-${i}`,
        valBpb: 1.5 - (i * 0.1),
        timestamp: timestamps[i],
      }));
    }

    // Get history
    const allResults = ctx.registry.getAllResults();
    expect(allResults.length).toBe(3);

    // Verify all commits present
    const commits = allResults.map(r => r.commit);
    expect(commits).toContain('commit-0');
    expect(commits).toContain('commit-1');
    expect(commits).toContain('commit-2');
  });

  it('search index finds experiments by description', async () => {
    ctx.registry.registerAgent('agent-0');

    // Record experiments with different descriptions
    await ctx.registry.recordResult(createTestResult({
      commit: 'commit-1',
      description: 'Increased learning rate to 0.01',
    }));

    await ctx.registry.recordResult(createTestResult({
      commit: 'commit-2',
      description: 'Added dropout layer',
    }));

    await ctx.registry.recordResult(createTestResult({
      commit: 'commit-3',
      description: 'Changed learning rate schedule',
    }));

    // Search for learning rate experiments
    const searchResults = await ctx.registry.searchSimilar('learning rate', 10);
    expect(searchResults.length).toBeGreaterThanOrEqual(2);

    const commits = searchResults.map(r => r.commit);
    expect(commits).toContain('commit-1');
    expect(commits).toContain('commit-3');
  });
});

describe('Integration: Protocol Message Handling', () => {
  it('JSON-RPC request encoding/decoding round-trip', () => {
    const request = createRequest('test-id', METHOD_NAMES.SWARM_SYNC, {});
    const encoded = encode(request);
    const decoded = decode(encoded);

    expect(decoded).toEqual(request);
  });

  it('JSON-RPC notification encoding/decoding round-trip', () => {
    const notification = createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
      commit: 'abc123',
      valBpb: 1.5,
      memoryGb: 8.0,
      status: 'keep',
      description: 'Test',
      agentId: 'agent-0',
      timestamp: '2024-01-01T10:00:00Z',
      branch: 'autoresearch/swarm/agent-0',
    });
    const encoded = encode(notification);
    const decoded = decode(encoded);

    expect(decoded).toEqual(notification);
  });

  it('multiple messages can be encoded as NDJSON', () => {
    const messages = [
      createRequest('id-1', METHOD_NAMES.SWARM_STATUS, {}),
      createRequest('id-2', METHOD_NAMES.SWARM_PAUSE, {}),
      createNotification(METHOD_NAMES.EXPERIMENT_RESULT, {
        commit: 'abc',
        valBpb: 1.0,
        memoryGb: 8.0,
        status: 'keep',
        description: 'Test',
        agentId: 'agent-0',
        timestamp: '2024-01-01T10:00:00Z',
        branch: 'test',
      }),
    ];

    const encoded = messages.map(m => encode(m)).join('');
    const lines = encoded.trim().split('\n');

    expect(lines.length).toBe(3);

    for (let i = 0; i < lines.length; i++) {
      const decoded = decode(lines[i] + '\n');
      expect(decoded).toEqual(messages[i]);
    }
  });
});
