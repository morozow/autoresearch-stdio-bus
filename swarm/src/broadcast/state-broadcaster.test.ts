/**
 * Unit tests for StateBroadcaster.
 * 
 * Tests the core functionality of the StateBroadcaster class including:
 * - Subscribe/unsubscribe for sessions
 * - Broadcast Result_Messages to all subscribers
 * - Priority notifications for new best val_bpb
 * - Backpressure handling
 * 
 * Validates: Requirements 2.1, 2.6, 5.6
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StateBroadcaster,
  createStateBroadcaster,
  StateBroadcasterLogger,
  DEFAULT_MAX_PENDING_MESSAGES,
  DEFAULT_BROADCAST_TIMEOUT_MS,
} from './state-broadcaster';
import { ExperimentResult, SwarmState } from '../state/experiment-registry';
import { ResultMessage } from '../protocol/types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock logger for testing.
 */
function createMockLogger(): StateBroadcasterLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Creates a sample experiment result for testing.
 */
function createSampleResult(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    commit: 'a1b2c3d',
    valBpb: 0.997900,
    memoryGb: 44.0,
    status: 'keep',
    description: 'increase LR to 0.04',
    agentId: 'agent-0',
    timestamp: '2025-01-15T10:30:00Z',
    branch: 'autoresearch/swarm/agent-0',
    ...overrides,
  };
}

/**
 * Creates a sample swarm state for testing.
 */
function createSampleState(overrides: Partial<SwarmState> = {}): SwarmState {
  return {
    bestValBpb: 0.993200,
    totalExperiments: 47,
    activeAgents: ['agent-0', 'agent-1', 'agent-2'],
    recentResults: [createSampleResult()],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('StateBroadcaster', () => {
  let broadcaster: StateBroadcaster;
  let mockLogger: StateBroadcasterLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    broadcaster = new StateBroadcaster({ logger: mockLogger });
  });

  describe('subscription management', () => {
    it('should subscribe a session', () => {
      broadcaster.subscribe('session-1');

      expect(broadcaster.isSubscribed('session-1')).toBe(true);
      expect(broadcaster.getSubscriberCount()).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Session subscribed', { sessionId: 'session-1' });
    });

    it('should not duplicate subscriptions', () => {
      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-1');

      expect(broadcaster.getSubscriberCount()).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Session already subscribed', { sessionId: 'session-1' });
    });

    it('should unsubscribe a session', () => {
      broadcaster.subscribe('session-1');
      broadcaster.unsubscribe('session-1');

      expect(broadcaster.isSubscribed('session-1')).toBe(false);
      expect(broadcaster.getSubscriberCount()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Session unsubscribed', { sessionId: 'session-1' });
    });

    it('should handle unsubscribe for non-existent session', () => {
      broadcaster.unsubscribe('non-existent');

      expect(mockLogger.warn).toHaveBeenCalledWith('Session not subscribed', { sessionId: 'non-existent' });
    });

    it('should return all subscribers', () => {
      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.subscribe('session-3');

      const subscribers = broadcaster.getSubscribers();
      expect(subscribers).toHaveLength(3);
      expect(subscribers).toContain('session-1');
      expect(subscribers).toContain('session-2');
      expect(subscribers).toContain('session-3');
    });

    it('should handle multiple subscribe/unsubscribe operations', () => {
      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.unsubscribe('session-1');
      broadcaster.subscribe('session-3');
      broadcaster.unsubscribe('session-2');

      expect(broadcaster.getSubscriberCount()).toBe(1);
      expect(broadcaster.isSubscribed('session-3')).toBe(true);
      expect(broadcaster.isSubscribed('session-1')).toBe(false);
      expect(broadcaster.isSubscribed('session-2')).toBe(false);
    });
  });

  describe('broadcastResult', () => {
    it('should broadcast result to all subscribers', async () => {
      const receivedMessages: ResultMessage[] = [];
      const callback = (msg: ResultMessage) => receivedMessages.push(msg);

      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.setSubscriberCallbacks('session-1', { onBroadcast: callback });
      broadcaster.setSubscriberCallbacks('session-2', { onBroadcast: callback });

      const result = createSampleResult();
      await broadcaster.broadcastResult(result);

      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0].params.agentId).toBe('agent-0');
      expect(receivedMessages[0].params.commit).toBe('a1b2c3d');
    });

    it('should include agent_id in broadcast', async () => {
      let receivedMessage: ResultMessage | null = null;
      const callback = (msg: ResultMessage) => { receivedMessage = msg; };

      broadcaster.subscribe('session-1');
      broadcaster.setSubscriberCallbacks('session-1', { onBroadcast: callback });

      const result = createSampleResult({ agentId: 'agent-5' });
      await broadcaster.broadcastResult(result);

      expect(receivedMessage).not.toBeNull();
      expect(receivedMessage!.params.agentId).toBe('agent-5');
    });

    it('should call global broadcast callback', async () => {
      const globalMessages: ResultMessage[] = [];
      broadcaster.onBroadcast((msg) => globalMessages.push(msg));

      const result = createSampleResult();
      await broadcaster.broadcastResult(result);

      expect(globalMessages).toHaveLength(1);
      expect(globalMessages[0].method).toBe('experiment.result');
    });

    it('should handle broadcast with no subscribers', async () => {
      const result = createSampleResult();
      await broadcaster.broadcastResult(result);

      expect(mockLogger.info).toHaveBeenCalledWith('Broadcasting result', expect.objectContaining({
        subscriberCount: 0,
      }));
    });

    it('should handle subscriber callback errors gracefully', async () => {
      broadcaster.subscribe('session-1');
      broadcaster.setSubscriberCallbacks('session-1', {
        onBroadcast: () => { throw new Error('Callback error'); },
      });

      const result = createSampleResult();
      await broadcaster.broadcastResult(result);

      expect(mockLogger.error).toHaveBeenCalledWith('Subscriber broadcast error', expect.objectContaining({
        sessionId: 'session-1',
      }));
    });

    it('should create valid ResultMessage format', async () => {
      let receivedMessage: ResultMessage | null = null;
      broadcaster.onBroadcast((msg) => { receivedMessage = msg; });

      const result = createSampleResult();
      await broadcaster.broadcastResult(result);

      expect(receivedMessage).not.toBeNull();
      expect(receivedMessage!.jsonrpc).toBe('2.0');
      expect(receivedMessage!.method).toBe('experiment.result');
      expect(receivedMessage!.params).toEqual({
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        memoryGb: 44.0,
        status: 'keep',
        description: 'increase LR to 0.04',
        agentId: 'agent-0',
        timestamp: '2025-01-15T10:30:00Z',
        branch: 'autoresearch/swarm/agent-0',
      });
    });
  });

  describe('broadcastNewBest', () => {
    it('should broadcast priority notification to all subscribers', async () => {
      const receivedResults: ExperimentResult[] = [];
      const callback = (result: ExperimentResult) => receivedResults.push(result);

      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.setSubscriberCallbacks('session-1', { onPriority: callback });
      broadcaster.setSubscriberCallbacks('session-2', { onPriority: callback });

      const result = createSampleResult({ valBpb: 0.985 });
      await broadcaster.broadcastNewBest(result);

      expect(receivedResults).toHaveLength(2);
      expect(receivedResults[0].valBpb).toBe(0.985);
    });

    it('should call global priority callback', async () => {
      const priorityResults: ExperimentResult[] = [];
      broadcaster.onPriority((result) => priorityResults.push(result));

      const result = createSampleResult({ valBpb: 0.980 });
      await broadcaster.broadcastNewBest(result);

      expect(priorityResults).toHaveLength(1);
      expect(priorityResults[0].valBpb).toBe(0.980);
    });

    it('should include agent_id in priority notification', async () => {
      let receivedResult: ExperimentResult | null = null;
      broadcaster.onPriority((result) => { receivedResult = result; });

      const result = createSampleResult({ agentId: 'agent-3' });
      await broadcaster.broadcastNewBest(result);

      expect(receivedResult).not.toBeNull();
      expect(receivedResult!.agentId).toBe('agent-3');
    });

    it('should log priority broadcast', async () => {
      const result = createSampleResult({ valBpb: 0.975 });
      await broadcaster.broadcastNewBest(result);

      expect(mockLogger.info).toHaveBeenCalledWith('Broadcasting new best val_bpb', expect.objectContaining({
        valBpb: 0.975,
      }));
    });
  });

  describe('broadcastSync', () => {
    it('should broadcast sync to all subscribers', async () => {
      const receivedStates: SwarmState[] = [];
      const callback = (state: SwarmState) => receivedStates.push(state);

      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.setSubscriberCallbacks('session-1', { onSync: callback });
      broadcaster.setSubscriberCallbacks('session-2', { onSync: callback });

      const state = createSampleState();
      await broadcaster.broadcastSync(state);

      expect(receivedStates).toHaveLength(2);
      expect(receivedStates[0].bestValBpb).toBe(0.993200);
    });

    it('should call global sync callback', async () => {
      const syncStates: SwarmState[] = [];
      broadcaster.onSync((state) => syncStates.push(state));

      const state = createSampleState();
      await broadcaster.broadcastSync(state);

      expect(syncStates).toHaveLength(1);
      expect(syncStates[0].totalExperiments).toBe(47);
    });

    it('should log sync broadcast', async () => {
      const state = createSampleState();
      await broadcaster.broadcastSync(state);

      expect(mockLogger.info).toHaveBeenCalledWith('Broadcasting sync', expect.objectContaining({
        bestValBpb: 0.993200,
        totalExperiments: 47,
      }));
    });
  });

  describe('backpressure handling', () => {
    it('should track pending count for subscribers', async () => {
      broadcaster.subscribe('session-1');

      expect(broadcaster.getPendingCount('session-1')).toBe(0);
    });

    it('should return 0 for non-existent subscriber pending count', () => {
      expect(broadcaster.getPendingCount('non-existent')).toBe(0);
    });

    it('should skip broadcast when backpressure limit reached', async () => {
      // Create broadcaster with low backpressure limit
      const lowLimitBroadcaster = new StateBroadcaster({
        logger: mockLogger,
        maxPendingMessages: 1,
      });

      let callCount = 0;
      const slowCallback = async (msg: ResultMessage) => {
        callCount++;
        // Simulate slow processing
        await new Promise(resolve => setTimeout(resolve, 100));
      };

      lowLimitBroadcaster.subscribe('session-1');
      lowLimitBroadcaster.setSubscriberCallbacks('session-1', { onBroadcast: slowCallback });

      // First broadcast should work
      const result1 = createSampleResult({ commit: 'commit1' });
      const promise1 = lowLimitBroadcaster.broadcastResult(result1);

      // Second broadcast should be skipped due to backpressure
      const result2 = createSampleResult({ commit: 'commit2' });
      await lowLimitBroadcaster.broadcastResult(result2);

      await promise1;

      // Should have logged backpressure warning
      expect(mockLogger.warn).toHaveBeenCalledWith('Subscriber backpressure, skipping broadcast', expect.any(Object));
    });
  });

  describe('callback registration', () => {
    it('should warn when setting callbacks for non-subscribed session', () => {
      broadcaster.setSubscriberCallbacks('non-existent', { onBroadcast: () => { } });

      expect(mockLogger.warn).toHaveBeenCalledWith('Cannot set callbacks for non-subscribed session', {
        sessionId: 'non-existent',
      });
    });

    it('should allow setting multiple callbacks', async () => {
      let broadcastCalled = false;
      let priorityCalled = false;
      let syncCalled = false;

      broadcaster.subscribe('session-1');
      broadcaster.setSubscriberCallbacks('session-1', {
        onBroadcast: () => { broadcastCalled = true; },
        onPriority: () => { priorityCalled = true; },
        onSync: () => { syncCalled = true; },
      });

      await broadcaster.broadcastResult(createSampleResult());
      await broadcaster.broadcastNewBest(createSampleResult());
      await broadcaster.broadcastSync(createSampleState());

      expect(broadcastCalled).toBe(true);
      expect(priorityCalled).toBe(true);
      expect(syncCalled).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear all subscribers', () => {
      broadcaster.subscribe('session-1');
      broadcaster.subscribe('session-2');
      broadcaster.clear();

      expect(broadcaster.getSubscriberCount()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('StateBroadcaster cleared');
    });

    it('should clear global callbacks', async () => {
      let callbackCalled = false;
      broadcaster.onBroadcast(() => { callbackCalled = true; });
      broadcaster.clear();

      await broadcaster.broadcastResult(createSampleResult());

      expect(callbackCalled).toBe(false);
    });
  });
});

describe('createStateBroadcaster factory', () => {
  it('should create broadcaster with default options', () => {
    const broadcaster = createStateBroadcaster();

    expect(broadcaster).toBeInstanceOf(StateBroadcaster);
  });

  it('should create broadcaster with custom options', () => {
    const mockLogger = createMockLogger();
    const broadcaster = createStateBroadcaster({
      logger: mockLogger,
      maxPendingMessages: 50,
      broadcastTimeoutMs: 500,
    });

    expect(broadcaster).toBeInstanceOf(StateBroadcaster);
  });

  it('should use custom timestamp generator', () => {
    const fixedTimestamp = '2025-01-01T00:00:00Z';
    const broadcaster = createStateBroadcaster({
      timestampGenerator: () => fixedTimestamp,
    });

    broadcaster.subscribe('session-1');
    // The timestamp is used internally for subscribedAt
    expect(broadcaster.isSubscribed('session-1')).toBe(true);
  });
});

describe('constants', () => {
  it('should have correct default max pending messages', () => {
    expect(DEFAULT_MAX_PENDING_MESSAGES).toBe(100);
  });

  it('should have correct default broadcast timeout', () => {
    expect(DEFAULT_BROADCAST_TIMEOUT_MS).toBe(1000);
  });
});
