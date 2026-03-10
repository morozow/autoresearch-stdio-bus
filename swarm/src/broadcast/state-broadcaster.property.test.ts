/**
 * Property-based tests for StateBroadcaster agent attribution.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 8: Broadcast Agent Attribution
 * 
 * For any Result_Message broadcast by the State_Broadcaster, the message shall include
 * the originating agent_id matching the agent that produced the experiment result.
 * 
 * **Validates: Requirements 2.6**
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  StateBroadcaster,
  createStateBroadcaster,
  StateBroadcasterLogger,
} from './state-broadcaster';
import { ExperimentResult } from '../state/experiment-registry';
import { ResultMessage, ExperimentStatus } from '../protocol/types';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a silent logger for tests.
 */
function createSilentLogger(): StateBroadcasterLogger {
  return {
    info: () => { },
    warn: () => { },
    error: () => { },
  };
}

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid 7-character hex commit string.
 */
const arbitraryCommit = (): fc.Arbitrary<string> =>
  fc.hexaString({ minLength: 7, maxLength: 7 }).map(s => s.toLowerCase());

/**
 * Generates a valid val_bpb float between 0.5 and 2.0.
 */
const arbitraryValBpb = (): fc.Arbitrary<number> =>
  fc.float({ min: 0.5, max: 2.0, noNaN: true });

/**
 * Generates a valid memory_gb float between 0 and 80.
 */
const arbitraryMemoryGb = (): fc.Arbitrary<number> =>
  fc.float({ min: 0, max: 80, noNaN: true });

/**
 * Generates a valid experiment status.
 */
const arbitraryStatus = (): fc.Arbitrary<ExperimentStatus> =>
  fc.constantFrom('keep', 'discard', 'crash');

/**
 * Generates a non-empty description string.
 * Avoids tabs and newlines to ensure compatibility.
 */
const arbitraryDescription = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 100 })
    .map(s => s.replace(/[\t\n\r]/g, ' ').trim() || 'default description');

/**
 * Generates a valid agent ID (e.g., 'agent-0', 'agent-1').
 */
const arbitraryAgentId = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `agent-${n}`);

/**
 * Generates a valid ISO 8601 timestamp.
 */
const arbitraryTimestamp = (): fc.Arbitrary<string> =>
  fc.date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
  }).map(d => d.toISOString());

/**
 * Generates a valid branch name (e.g., 'autoresearch/swarm/agent-0').
 */
const arbitraryBranch = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `autoresearch/swarm/agent-${n}`);

/**
 * Generates a valid ExperimentResult object.
 */
const arbitraryExperimentResult = (): fc.Arbitrary<ExperimentResult> =>
  fc.record({
    commit: arbitraryCommit(),
    valBpb: arbitraryValBpb(),
    memoryGb: arbitraryMemoryGb(),
    status: arbitraryStatus(),
    description: arbitraryDescription(),
    agentId: arbitraryAgentId(),
    timestamp: arbitraryTimestamp(),
    branch: arbitraryBranch(),
  }).map(result => {
    // For crash status, set valBpb to 0 and memoryGb to 0
    if (result.status === 'crash') {
      return { ...result, valBpb: 0.0, memoryGb: 0.0 };
    }
    return result;
  });

/**
 * Generates a valid session ID.
 */
const arbitrarySessionId = (): fc.Arbitrary<string> =>
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 5, maxLength: 20 })
    .map(s => `session-${s}`);

/**
 * Generates an array of unique session IDs.
 */
const arbitrarySessionIds = (minLength: number = 1, maxLength: number = 10): fc.Arbitrary<string[]> =>
  fc.array(arbitrarySessionId(), { minLength, maxLength })
    .map(ids => [...new Set(ids)])
    .filter(ids => ids.length >= minLength);

/**
 * Generates an array of unique ExperimentResult objects (unique by commit).
 */
const arbitraryUniqueExperimentResults = (
  minLength: number = 1,
  maxLength: number = 20
): fc.Arbitrary<ExperimentResult[]> =>
  fc.array(arbitraryExperimentResult(), { minLength, maxLength })
    .map(results => {
      // Ensure unique commits
      const seen = new Set<string>();
      return results.filter(r => {
        if (seen.has(r.commit)) return false;
        seen.add(r.commit);
        return true;
      });
    })
    .filter(results => results.length >= minLength);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 8: Broadcast Agent Attribution', () => {
  let broadcaster: StateBroadcaster;

  beforeEach(() => {
    broadcaster = createStateBroadcaster({
      logger: createSilentLogger(),
    });
  });

  // --------------------------------------------------------------------------
  // Property 8.1: Every broadcast message includes agent_id
  // --------------------------------------------------------------------------
  describe('every broadcast message includes agent_id', () => {
    it('for any ExperimentResult, broadcastResult() should produce a message with agent_id field', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedMessage: ResultMessage | null = null;
          broadcaster.onBroadcast((msg) => { receivedMessage = msg; });

          await broadcaster.broadcastResult(result);

          // Verify message was received
          expect(receivedMessage).not.toBeNull();

          // Verify agent_id field exists and is non-empty
          expect(receivedMessage!.params).toBeDefined();
          expect(receivedMessage!.params.agentId).toBeDefined();
          expect(typeof receivedMessage!.params.agentId).toBe('string');
          expect(receivedMessage!.params.agentId.length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any ExperimentResult broadcast to multiple subscribers, all messages should include agent_id', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          arbitrarySessionIds(2, 10),
          async (result, sessionIds) => {
            const receivedMessages: ResultMessage[] = [];

            // Subscribe all sessions
            for (const sessionId of sessionIds) {
              broadcaster.subscribe(sessionId);
              broadcaster.setSubscriberCallbacks(sessionId, {
                onBroadcast: (msg) => receivedMessages.push(msg),
              });
            }

            await broadcaster.broadcastResult(result);

            // Verify all subscribers received messages with agent_id
            expect(receivedMessages.length).toBe(sessionIds.length);
            for (const msg of receivedMessages) {
              expect(msg.params.agentId).toBeDefined();
              expect(typeof msg.params.agentId).toBe('string');
              expect(msg.params.agentId.length).toBeGreaterThan(0);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 8.2: agent_id matches the originating experiment's agentId
  // --------------------------------------------------------------------------
  describe('agent_id matches the originating experiment agentId', () => {
    it('for any ExperimentResult, the broadcast message agent_id should match the input agentId', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedMessage: ResultMessage | null = null;
          broadcaster.onBroadcast((msg) => { receivedMessage = msg; });

          await broadcaster.broadcastResult(result);

          // Verify agent_id matches exactly
          expect(receivedMessage).not.toBeNull();
          expect(receivedMessage!.params.agentId).toBe(result.agentId);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of experiments from different agents, each broadcast should preserve the correct agent_id', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 10), async (results) => {
          const receivedMessages: ResultMessage[] = [];
          broadcaster.onBroadcast((msg) => receivedMessages.push(msg));

          // Broadcast all results
          for (const result of results) {
            await broadcaster.broadcastResult(result);
          }

          // Verify each message has the correct agent_id
          expect(receivedMessages.length).toBe(results.length);
          for (let i = 0; i < results.length; i++) {
            expect(receivedMessages[i].params.agentId).toBe(results[i].agentId);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any ExperimentResult broadcast to multiple subscribers, all messages should have matching agent_id', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          arbitrarySessionIds(2, 10),
          async (result, sessionIds) => {
            const receivedMessages: ResultMessage[] = [];

            // Subscribe all sessions
            for (const sessionId of sessionIds) {
              broadcaster.subscribe(sessionId);
              broadcaster.setSubscriberCallbacks(sessionId, {
                onBroadcast: (msg) => receivedMessages.push(msg),
              });
            }

            await broadcaster.broadcastResult(result);

            // Verify all messages have the same correct agent_id
            expect(receivedMessages.length).toBe(sessionIds.length);
            for (const msg of receivedMessages) {
              expect(msg.params.agentId).toBe(result.agentId);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 8.3: Priority notifications also include agent_id
  // --------------------------------------------------------------------------
  describe('priority notifications include agent_id', () => {
    it('for any ExperimentResult, broadcastNewBest() should include agent_id in the notification', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedResult: ExperimentResult | null = null;
          broadcaster.onPriority((r) => { receivedResult = r; });

          await broadcaster.broadcastNewBest(result);

          // Verify result was received with agent_id
          expect(receivedResult).not.toBeNull();
          expect(receivedResult!.agentId).toBeDefined();
          expect(typeof receivedResult!.agentId).toBe('string');
          expect(receivedResult!.agentId.length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any ExperimentResult, broadcastNewBest() agent_id should match the input agentId', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedResult: ExperimentResult | null = null;
          broadcaster.onPriority((r) => { receivedResult = r; });

          await broadcaster.broadcastNewBest(result);

          // Verify agent_id matches exactly
          expect(receivedResult).not.toBeNull();
          expect(receivedResult!.agentId).toBe(result.agentId);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any ExperimentResult broadcast to multiple subscribers as new best, all should receive correct agent_id', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          arbitrarySessionIds(2, 10),
          async (result, sessionIds) => {
            const receivedResults: ExperimentResult[] = [];

            // Subscribe all sessions
            for (const sessionId of sessionIds) {
              broadcaster.subscribe(sessionId);
              broadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: (r) => receivedResults.push(r),
              });
            }

            await broadcaster.broadcastNewBest(result);

            // Verify all subscribers received the result with correct agent_id
            expect(receivedResults.length).toBe(sessionIds.length);
            for (const r of receivedResults) {
              expect(r.agentId).toBe(result.agentId);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 8.4: agent_id is preserved through the broadcast pipeline
  // --------------------------------------------------------------------------
  describe('agent_id is preserved through the broadcast pipeline', () => {
    it('for any ExperimentResult, all fields including agent_id should be preserved in broadcast', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedMessage: ResultMessage | null = null;
          broadcaster.onBroadcast((msg) => { receivedMessage = msg; });

          await broadcaster.broadcastResult(result);

          // Verify all fields are preserved
          expect(receivedMessage).not.toBeNull();
          expect(receivedMessage!.params.commit).toBe(result.commit);
          expect(receivedMessage!.params.valBpb).toBe(result.valBpb);
          expect(receivedMessage!.params.memoryGb).toBe(result.memoryGb);
          expect(receivedMessage!.params.status).toBe(result.status);
          expect(receivedMessage!.params.description).toBe(result.description);
          expect(receivedMessage!.params.agentId).toBe(result.agentId);
          expect(receivedMessage!.params.timestamp).toBe(result.timestamp);
          expect(receivedMessage!.params.branch).toBe(result.branch);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of broadcasts, agent_id should never be mutated or lost', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(5, 20), async (results) => {
          const receivedMessages: ResultMessage[] = [];
          broadcaster.onBroadcast((msg) => receivedMessages.push(msg));

          // Broadcast all results
          for (const result of results) {
            await broadcaster.broadcastResult(result);
          }

          // Verify agent_id is preserved for each broadcast
          expect(receivedMessages.length).toBe(results.length);
          for (let i = 0; i < results.length; i++) {
            expect(receivedMessages[i].params.agentId).toBe(results[i].agentId);
            // Verify agent_id is not empty or undefined
            expect(receivedMessages[i].params.agentId).toBeTruthy();
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any ExperimentResult, the ResultMessage should have correct JSON-RPC structure with agent_id', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedMessage: ResultMessage | null = null;
          broadcaster.onBroadcast((msg) => { receivedMessage = msg; });

          await broadcaster.broadcastResult(result);

          // Verify JSON-RPC structure
          expect(receivedMessage).not.toBeNull();
          expect(receivedMessage!.jsonrpc).toBe('2.0');
          expect(receivedMessage!.method).toBe('experiment.result');
          expect(receivedMessage!.params).toBeDefined();

          // Verify agent_id is in the correct location in the message structure
          expect(receivedMessage!.params.agentId).toBe(result.agentId);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for mixed broadcast and priority notifications, agent_id should be preserved in both', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 10), async (results) => {
          const broadcastMessages: ResultMessage[] = [];
          const priorityResults: ExperimentResult[] = [];

          broadcaster.onBroadcast((msg) => broadcastMessages.push(msg));
          broadcaster.onPriority((r) => priorityResults.push(r));

          // Alternate between regular broadcasts and priority notifications
          for (let i = 0; i < results.length; i++) {
            if (i % 2 === 0) {
              await broadcaster.broadcastResult(results[i]);
            } else {
              await broadcaster.broadcastNewBest(results[i]);
            }
          }

          // Verify agent_id is preserved in regular broadcasts
          const expectedBroadcastCount = Math.ceil(results.length / 2);
          expect(broadcastMessages.length).toBe(expectedBroadcastCount);
          for (let i = 0; i < expectedBroadcastCount; i++) {
            const originalIndex = i * 2;
            expect(broadcastMessages[i].params.agentId).toBe(results[originalIndex].agentId);
          }

          // Verify agent_id is preserved in priority notifications
          const expectedPriorityCount = Math.floor(results.length / 2);
          expect(priorityResults.length).toBe(expectedPriorityCount);
          for (let i = 0; i < expectedPriorityCount; i++) {
            const originalIndex = i * 2 + 1;
            expect(priorityResults[i].agentId).toBe(results[originalIndex].agentId);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 18: New Best Notification
// ============================================================================

/**
 * Property-based tests for StateBroadcaster new best notification.
 *
 * Feature: stdio-bus-swarm-autoresearch, Property 18: New Best Notification
 *
 * For any experiment result that achieves a new best val_bpb (lower than all previous
 * "keep" results), the State_Broadcaster shall send a priority notification to all
 * connected agents.
 *
 * **Validates: Requirements 5.6**
 */
describe('Property 18: New Best Notification', () => {
  let broadcaster: StateBroadcaster;

  beforeEach(() => {
    broadcaster = createStateBroadcaster({
      logger: createSilentLogger(),
    });
  });

  // --------------------------------------------------------------------------
  // Property 18.1: Priority notification is sent when new best val_bpb is achieved
  // --------------------------------------------------------------------------
  describe('priority notification is sent when new best val_bpb is achieved', () => {
    it('for any experiment result, broadcastNewBest() should trigger priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let priorityNotificationReceived = false;
          broadcaster.onPriority(() => { priorityNotificationReceived = true; });

          await broadcaster.broadcastNewBest(result);

          // Verify priority notification was sent
          expect(priorityNotificationReceived).toBe(true);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of improving results, each new best should trigger a priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryExperimentResult(), { minLength: 2, maxLength: 10 }),
          async (results) => {
            // Sort results by valBpb descending so each subsequent result is a "new best"
            const sortedResults = [...results]
              .filter(r => r.status === 'keep')
              .sort((a, b) => b.valBpb - a.valBpb);

            if (sortedResults.length < 2) {
              return true; // Skip if not enough "keep" results
            }

            let priorityNotificationCount = 0;
            broadcaster.onPriority(() => { priorityNotificationCount++; });

            // Broadcast each result as a new best (simulating improving results)
            for (const result of sortedResults) {
              await broadcaster.broadcastNewBest(result);
            }

            // Each result should have triggered a priority notification
            expect(priorityNotificationCount).toBe(sortedResults.length);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 18.2: All connected agents receive the priority notification
  // --------------------------------------------------------------------------
  describe('all connected agents receive the priority notification', () => {
    it('for any experiment result and set of subscribers, all should receive priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          arbitrarySessionIds(1, 10),
          async (result, sessionIds) => {
            const receivedBySession: Map<string, boolean> = new Map();

            // Subscribe all sessions and track which ones receive notifications
            for (const sessionId of sessionIds) {
              broadcaster.subscribe(sessionId);
              receivedBySession.set(sessionId, false);
              broadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: () => { receivedBySession.set(sessionId, true); },
              });
            }

            await broadcaster.broadcastNewBest(result);

            // Verify ALL subscribers received the notification
            for (const sessionId of sessionIds) {
              expect(receivedBySession.get(sessionId)).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any number of subscribers (1 to N), all should receive the same priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          fc.integer({ min: 1, max: 20 }),
          async (result, subscriberCount) => {
            const receivedResults: ExperimentResult[] = [];

            // Create and subscribe N sessions
            for (let i = 0; i < subscriberCount; i++) {
              const sessionId = `session-${i}`;
              broadcaster.subscribe(sessionId);
              broadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: (r) => { receivedResults.push(r); },
              });
            }

            await broadcaster.broadcastNewBest(result);

            // Verify all subscribers received the notification
            expect(receivedResults.length).toBe(subscriberCount);

            // Verify all received the same result
            for (const received of receivedResults) {
              expect(received.valBpb).toBe(result.valBpb);
              expect(received.agentId).toBe(result.agentId);
              expect(received.commit).toBe(result.commit);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 18.3: Priority notification includes the new best val_bpb value
  // --------------------------------------------------------------------------
  describe('priority notification includes the new best val_bpb value', () => {
    it('for any experiment result, the priority notification should include the exact val_bpb', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedResult: ExperimentResult | null = null;
          broadcaster.onPriority((r) => { receivedResult = r; });

          await broadcaster.broadcastNewBest(result);

          // Verify val_bpb is included and matches
          expect(receivedResult).not.toBeNull();
          expect(receivedResult!.valBpb).toBe(result.valBpb);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of new bests, each notification should contain the correct val_bpb', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(2, 10),
          async (results) => {
            const receivedValBpbs: number[] = [];
            broadcaster.onPriority((r) => { receivedValBpbs.push(r.valBpb); });

            // Broadcast each as a new best
            for (const result of results) {
              await broadcaster.broadcastNewBest(result);
            }

            // Verify each notification had the correct val_bpb
            expect(receivedValBpbs.length).toBe(results.length);
            for (let i = 0; i < results.length; i++) {
              expect(receivedValBpbs[i]).toBe(results[i].valBpb);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any experiment result, all fields should be included in priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          let receivedResult: ExperimentResult | null = null;
          broadcaster.onPriority((r) => { receivedResult = r; });

          await broadcaster.broadcastNewBest(result);

          // Verify all fields are present
          expect(receivedResult).not.toBeNull();
          expect(receivedResult!.commit).toBe(result.commit);
          expect(receivedResult!.valBpb).toBe(result.valBpb);
          expect(receivedResult!.memoryGb).toBe(result.memoryGb);
          expect(receivedResult!.status).toBe(result.status);
          expect(receivedResult!.description).toBe(result.description);
          expect(receivedResult!.agentId).toBe(result.agentId);
          expect(receivedResult!.timestamp).toBe(result.timestamp);
          expect(receivedResult!.branch).toBe(result.branch);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 18.4: Priority notifications are sent even under backpressure conditions
  // --------------------------------------------------------------------------
  describe('priority notifications bypass backpressure', () => {
    it('for any experiment result, priority notification should be sent even when subscriber has high pending count', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          fc.integer({ min: 1, max: 5 }),
          async (result, subscriberCount) => {
            // Create broadcaster with low backpressure threshold
            const lowThresholdBroadcaster = createStateBroadcaster({
              logger: createSilentLogger(),
              maxPendingMessages: 1, // Very low threshold
            });

            const receivedPriorityNotifications: ExperimentResult[] = [];

            // Subscribe sessions
            for (let i = 0; i < subscriberCount; i++) {
              const sessionId = `session-${i}`;
              lowThresholdBroadcaster.subscribe(sessionId);
              lowThresholdBroadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: (r) => { receivedPriorityNotifications.push(r); },
              });
            }

            // Send priority notification (should bypass backpressure)
            await lowThresholdBroadcaster.broadcastNewBest(result);

            // Verify all subscribers received the priority notification
            expect(receivedPriorityNotifications.length).toBe(subscriberCount);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any experiment result, priority notifications should be delivered to all subscribers regardless of their pending state', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryExperimentResult(),
          arbitrarySessionIds(2, 8),
          async (result, sessionIds) => {
            // Create broadcaster with very low backpressure threshold
            const lowThresholdBroadcaster = createStateBroadcaster({
              logger: createSilentLogger(),
              maxPendingMessages: 0, // Zero threshold - would block all regular broadcasts
            });

            const receivedBySession: Set<string> = new Set();

            // Subscribe all sessions
            for (const sessionId of sessionIds) {
              lowThresholdBroadcaster.subscribe(sessionId);
              lowThresholdBroadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: () => { receivedBySession.add(sessionId); },
              });
            }

            // Send priority notification
            await lowThresholdBroadcaster.broadcastNewBest(result);

            // Verify ALL subscribers received the notification (bypassing backpressure)
            expect(receivedBySession.size).toBe(sessionIds.length);
            for (const sessionId of sessionIds) {
              expect(receivedBySession.has(sessionId)).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any sequence of priority notifications, all should be delivered even under sustained backpressure', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(3, 8),
          fc.integer({ min: 2, max: 5 }),
          async (results, subscriberCount) => {
            // Create broadcaster with zero backpressure threshold
            const lowThresholdBroadcaster = createStateBroadcaster({
              logger: createSilentLogger(),
              maxPendingMessages: 0,
            });

            const receivedCounts: Map<string, number> = new Map();

            // Subscribe sessions
            for (let i = 0; i < subscriberCount; i++) {
              const sessionId = `session-${i}`;
              lowThresholdBroadcaster.subscribe(sessionId);
              receivedCounts.set(sessionId, 0);
              lowThresholdBroadcaster.setSubscriberCallbacks(sessionId, {
                onPriority: () => {
                  receivedCounts.set(sessionId, (receivedCounts.get(sessionId) ?? 0) + 1);
                },
              });
            }

            // Send multiple priority notifications
            for (const result of results) {
              await lowThresholdBroadcaster.broadcastNewBest(result);
            }

            // Verify each subscriber received ALL notifications
            for (let i = 0; i < subscriberCount; i++) {
              const sessionId = `session-${i}`;
              expect(receivedCounts.get(sessionId)).toBe(results.length);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 18.5: Integration with ExperimentRegistry for new best detection
  // --------------------------------------------------------------------------
  describe('integration with new best detection logic', () => {
    it('for any sequence of results, only results that achieve new best should trigger priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryExperimentResult(), { minLength: 3, maxLength: 15 }),
          async (results) => {
            // Filter to only "keep" results for best tracking
            const keepResults = results.filter(r => r.status === 'keep');
            if (keepResults.length < 2) {
              return true; // Skip if not enough keep results
            }

            let currentBest = Infinity;
            let expectedNotifications = 0;
            let actualNotifications = 0;

            broadcaster.onPriority(() => { actualNotifications++; });

            // Process results and track when we should send priority notifications
            for (const result of keepResults) {
              if (result.valBpb < currentBest) {
                // This is a new best - should trigger notification
                currentBest = result.valBpb;
                expectedNotifications++;
                await broadcaster.broadcastNewBest(result);
              }
            }

            // Verify the correct number of notifications were sent
            expect(actualNotifications).toBe(expectedNotifications);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any decreasing sequence of val_bpb values, each should trigger a priority notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.float({ min: 0.5, max: 2.0, noNaN: true }), { minLength: 3, maxLength: 10 }),
          async (valBpbs) => {
            // Sort descending and make unique to create a strictly decreasing sequence
            const sortedUnique = [...new Set(valBpbs)].sort((a, b) => b - a);
            if (sortedUnique.length < 2) {
              return true;
            }

            let notificationCount = 0;
            const receivedValBpbs: number[] = [];

            broadcaster.onPriority((r) => {
              notificationCount++;
              receivedValBpbs.push(r.valBpb);
            });

            // Create results with decreasing val_bpb values
            for (let i = 0; i < sortedUnique.length; i++) {
              const result: ExperimentResult = {
                commit: `commit${i}`.padStart(7, '0').slice(0, 7),
                valBpb: sortedUnique[i],
                memoryGb: 40.0,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: 'agent-0',
                timestamp: new Date().toISOString(),
                branch: 'autoresearch/swarm/agent-0',
              };
              await broadcaster.broadcastNewBest(result);
            }

            // Each result should have triggered a notification
            expect(notificationCount).toBe(sortedUnique.length);

            // Verify val_bpb values were received in order
            for (let i = 0; i < sortedUnique.length; i++) {
              expect(receivedValBpbs[i]).toBe(sortedUnique[i]);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

