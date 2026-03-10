/**
 * Property-based tests for ConflictResolver.
 * 
 * Feature: stdio-bus-swarm-autoresearch
 * 
 * Property 11: Lock Acquisition Requirement
 * For any modification to train.py, the Conflict_Resolver shall have granted
 * an Experiment_Lock to the requesting agent before the modification is allowed.
 * **Validates: Requirements 4.1**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  ConflictResolver,
  createConflictResolver,
  type LockResult,
  type ConflictResolverLogger,
  type GitExecutor,
  MAIN_BRANCH,
} from './conflict-resolver';

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/** Generates a valid agent ID. */
const arbitraryAgentId = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 1, maxLength: 20 }
  ).filter(s => s.trim().length > 0 && /^[a-z0-9]/.test(s));

/** Generates a sequence of unique agent IDs. */
const arbitraryUniqueAgentIds = (minLength: number = 1, maxLength: number = 20): fc.Arbitrary<string[]> =>
  fc.array(arbitraryAgentId(), { minLength, maxLength })
    .map(ids => [...new Set(ids)])
    .filter(ids => ids.length >= minLength);

/** Generates a modification action type. */
type ModificationAction = 'modify_train_py' | 'commit_changes' | 'run_experiment';
const arbitraryModificationAction = (): fc.Arbitrary<ModificationAction> =>
  fc.constantFrom('modify_train_py', 'commit_changes', 'run_experiment');

// ============================================================================
// Silent Logger for Tests
// ============================================================================

const silentLogger: ConflictResolverLogger = {
  info: () => { },
  warn: () => { },
  error: () => { },
};

// ============================================================================
// Modification Tracker
// ============================================================================

/**
 * Tracks modifications and validates lock requirements.
 * 
 * This simulates a system where modifications are only allowed
 * when the agent holds a valid lock.
 */
class ModificationTracker {
  private resolver: ConflictResolver;
  private grantedLocks: Map<string, LockResult> = new Map();

  constructor(resolver: ConflictResolver) {
    this.resolver = resolver;
  }

  /**
   * Attempts to acquire a lock for an agent.
   * Returns the lock result.
   */
  async acquireLock(agentId: string): Promise<LockResult> {
    const result = await this.resolver.acquireLock(agentId);
    // Store the result regardless of granted status
    this.grantedLocks.set(agentId, result);
    return result;
  }

  /**
   * Releases a lock for an agent.
   */
  async releaseLock(agentId: string): Promise<void> {
    await this.resolver.releaseLock(agentId);
    this.grantedLocks.delete(agentId);
  }

  /**
   * Checks if an agent can perform a modification.
   * According to Property 11, the agent must have a granted lock.
   */
  canModify(agentId: string): { allowed: boolean; reason: string } {
    const lockResult = this.grantedLocks.get(agentId);

    // Check if agent has acquired a lock
    if (!lockResult) {
      return { allowed: false, reason: 'No lock acquired' };
    }

    // Check if the lock was granted (not just queued)
    if (!lockResult.granted) {
      return { allowed: false, reason: 'Lock was not granted (queued)' };
    }

    // Check if agent actually holds the lock in the resolver
    if (!this.resolver.holdsLock(agentId)) {
      return { allowed: false, reason: 'Agent does not hold lock in resolver' };
    }

    return { allowed: true, reason: 'Lock granted and held' };
  }

  /**
   * Updates the lock state for an agent after queue processing.
   */
  updateLockState(agentId: string): void {
    if (this.resolver.holdsLock(agentId)) {
      const state = this.resolver.getLockState();
      if (state && state.agentId === agentId) {
        this.grantedLocks.set(agentId, {
          granted: true,
          branch: state.branch,
          expiresAt: state.expiresAt,
        });
      }
    }
  }
}

// ============================================================================
// Property 11: Lock Acquisition Requirement
// ============================================================================

describe('Property 11: Lock Acquisition Requirement', () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = createConflictResolver({ logger: silentLogger });
  });

  afterEach(() => {
    resolver.clear();
  });

  describe('modifications require granted lock', () => {
    it('any agent attempting modification must have acquired a granted lock', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), arbitraryModificationAction(), (agentId, _action) => {
          const tracker = new ModificationTracker(resolver);

          // Attempt modification without lock - should not be allowed
          const canModifyWithoutLock = tracker.canModify(agentId);

          // Clean up for next iteration
          resolver.clear();

          return !canModifyWithoutLock.allowed;
        }),
        { numRuns: 100 }
      );
    });

    it('agent with granted lock can perform modifications', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryModificationAction(), async (agentId, _action) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // Acquire lock first
          const lockResult = await tracker.acquireLock(agentId);

          // If lock was granted, modification should be allowed
          const canModify = tracker.canModify(agentId);

          // Clean up
          testResolver.clear();

          // Lock should be granted (first agent) and modification allowed
          return lockResult.granted && canModify.allowed;
        }),
        { numRuns: 100 }
      );
    });

    it('agent with queued lock cannot perform modifications', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 2),
          arbitraryModificationAction(),
          async (agentIds, _action) => {
            // Create fresh resolver for each test
            const testResolver = createConflictResolver({ logger: silentLogger });
            const tracker = new ModificationTracker(testResolver);
            const [firstAgent, secondAgent] = agentIds;

            // First agent acquires lock
            const firstLock = await tracker.acquireLock(firstAgent);

            // Second agent tries to acquire - should be queued
            const secondLock = await tracker.acquireLock(secondAgent);

            // Second agent should not be able to modify (queued, not granted)
            const canModify = tracker.canModify(secondAgent);

            // Clean up
            testResolver.clear();

            return firstLock.granted &&
              !secondLock.granted &&
              secondLock.queuePosition !== undefined &&
              !canModify.allowed;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('lock must be granted before modification', () => {
    it('for any sequence of agents, only lock holder can modify', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            // Create fresh resolver for each test
            const testResolver = createConflictResolver({ logger: silentLogger });
            const tracker = new ModificationTracker(testResolver);

            // All agents try to acquire lock
            const lockResults: Map<string, LockResult> = new Map();
            for (const agentId of agentIds) {
              const result = await tracker.acquireLock(agentId);
              lockResults.set(agentId, result);
            }

            // Only the first agent should have a granted lock
            const firstAgent = agentIds[0]!;
            const firstLock = lockResults.get(firstAgent)!;

            // First agent should be able to modify
            const canFirstModify = tracker.canModify(firstAgent);
            if (!firstLock.granted || !canFirstModify.allowed) {
              testResolver.clear();
              return false;
            }

            // All other agents should NOT be able to modify
            for (let i = 1; i < agentIds.length; i++) {
              const agentId = agentIds[i]!;
              const canModify = tracker.canModify(agentId);
              if (canModify.allowed) {
                testResolver.clear();
                return false;
              }
            }

            // Clean up
            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lock grant status determines modification permission', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // Before acquiring lock
          const beforeLock = tracker.canModify(agentId);
          if (beforeLock.allowed) {
            testResolver.clear();
            return false;
          }

          // After acquiring lock
          const lockResult = await tracker.acquireLock(agentId);
          const afterLock = tracker.canModify(agentId);

          // Clean up
          testResolver.clear();

          // Permission should match grant status
          return afterLock.allowed === lockResult.granted;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('lock release revokes modification permission', () => {
    it('releasing lock prevents further modifications', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryModificationAction(), async (agentId, _action) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // Acquire lock
          const lockResult = await tracker.acquireLock(agentId);
          if (!lockResult.granted) {
            testResolver.clear();
            return true; // Skip if not granted
          }

          // Should be able to modify
          const canModifyBefore = tracker.canModify(agentId);
          if (!canModifyBefore.allowed) {
            testResolver.clear();
            return false;
          }

          // Release lock
          await tracker.releaseLock(agentId);

          // Should NOT be able to modify after release
          const canModifyAfter = tracker.canModify(agentId);

          // Clean up
          testResolver.clear();

          return !canModifyAfter.allowed;
        }),
        { numRuns: 100 }
      );
    });

    it('next agent in queue can modify after lock transfer', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 5), async (agentIds) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // All agents try to acquire lock
          for (const agentId of agentIds) {
            await tracker.acquireLock(agentId);
          }

          // First agent holds lock
          const firstAgent = agentIds[0]!;
          const canFirstModify = tracker.canModify(firstAgent);
          if (!canFirstModify.allowed) {
            testResolver.clear();
            return false;
          }

          // Release first agent's lock
          await tracker.releaseLock(firstAgent);

          // First agent can no longer modify
          const canFirstModifyAfter = tracker.canModify(firstAgent);
          if (canFirstModifyAfter.allowed) {
            testResolver.clear();
            return false;
          }

          // If there was a second agent, they should now hold the lock
          if (agentIds.length > 1) {
            const secondAgent = agentIds[1]!;
            // Update tracker state after queue processing
            tracker.updateLockState(secondAgent);
            const canSecondModify = tracker.canModify(secondAgent);

            testResolver.clear();
            return canSecondModify.allowed;
          }

          testResolver.clear();
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('concurrent modification attempts', () => {
    it('only one agent can have modification permission at a time', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(3, 10), async (agentIds) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // All agents try to acquire lock
          for (const agentId of agentIds) {
            await tracker.acquireLock(agentId);
          }

          // Count how many agents can modify
          let canModifyCount = 0;
          for (const agentId of agentIds) {
            if (tracker.canModify(agentId).allowed) {
              canModifyCount++;
            }
          }

          // Clean up
          testResolver.clear();

          // Exactly one agent should be able to modify
          return canModifyCount === 1;
        }),
        { numRuns: 100 }
      );
    });

    it('modification permission is exclusive', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 2),
          async (agentIds) => {
            // Create fresh resolver for each test
            const testResolver = createConflictResolver({ logger: silentLogger });
            const tracker = new ModificationTracker(testResolver);
            const [agent1, agent2] = agentIds;

            // Both agents try to acquire lock
            await tracker.acquireLock(agent1);
            await tracker.acquireLock(agent2);

            const can1Modify = tracker.canModify(agent1);
            const can2Modify = tracker.canModify(agent2);

            // Clean up
            testResolver.clear();

            // Exactly one should be able to modify (XOR)
            return (can1Modify.allowed && !can2Modify.allowed) ||
              (!can1Modify.allowed && can2Modify.allowed);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('lock acquisition is prerequisite for modification', () => {
    it('attempting modification without lock acquisition fails', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueAgentIds(1, 10),
          arbitraryModificationAction(),
          (agentIds, _action) => {
            const tracker = new ModificationTracker(resolver);

            // Try to modify without acquiring lock
            for (const agentId of agentIds) {
              const canModify = tracker.canModify(agentId);
              if (canModify.allowed) {
                resolver.clear();
                return false; // Should not be allowed
              }
            }

            resolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lock acquisition is necessary condition for modification', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          // Create fresh resolver for each test
          const testResolver = createConflictResolver({ logger: silentLogger });
          const tracker = new ModificationTracker(testResolver);

          // Necessary condition: if can modify, then must have lock
          // Contrapositive: if no lock, then cannot modify

          // Without lock
          const canModifyWithoutLock = tracker.canModify(agentId);
          if (canModifyWithoutLock.allowed) {
            testResolver.clear();
            return false;
          }

          // With lock
          const lockResult = await tracker.acquireLock(agentId);
          const canModifyWithLock = tracker.canModify(agentId);

          // Clean up
          testResolver.clear();

          // If lock granted, should be able to modify
          // If lock not granted (queued), should not be able to modify
          return canModifyWithLock.allowed === lockResult.granted;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('granted flag determines modification permission', () => {
    it('granted: true allows modification, granted: false denies', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(1, 5),
          async (agentIds) => {
            // Create fresh resolver for each test
            const testResolver = createConflictResolver({ logger: silentLogger });
            const tracker = new ModificationTracker(testResolver);

            // Acquire locks for all agents
            const results: Array<{ agentId: string; lockResult: LockResult }> = [];
            for (const agentId of agentIds) {
              const lockResult = await tracker.acquireLock(agentId);
              results.push({ agentId, lockResult });
            }

            // Verify: granted flag matches modification permission
            for (const { agentId, lockResult } of results) {
              const canModify = tracker.canModify(agentId);

              if (lockResult.granted && !canModify.allowed) {
                testResolver.clear();
                return false; // Should be allowed if granted
              }
              if (!lockResult.granted && canModify.allowed) {
                testResolver.clear();
                return false; // Should not be allowed if not granted
              }
            }

            // Clean up
            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 12: Lock Queuing Behavior
// ============================================================================

describe('Property 12: Lock Queuing Behavior', () => {
  /**
   * **Validates: Requirements 4.2**
   * 
   * For any lock request when the Experiment_Lock is held by another agent,
   * the Conflict_Resolver shall queue the request and grant the lock in FIFO
   * order after the current holder releases it.
   */

  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = createConflictResolver({ logger: silentLogger });
  });

  afterEach(() => {
    resolver.clear();
  });

  describe('requests are queued when lock is held', () => {
    it('any request when lock is held results in queuing', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...otherAgents] = agentIds;

            // First agent acquires lock
            const firstResult = await testResolver.acquireLock(firstAgent);
            if (!firstResult.granted) {
              testResolver.clear();
              return false;
            }

            // All other agents should be queued
            for (let i = 0; i < otherAgents.length; i++) {
              const agentId = otherAgents[i];
              const result = await testResolver.acquireLock(agentId);

              // Should not be granted
              if (result.granted) {
                testResolver.clear();
                return false;
              }

              // Should have a queue position
              if (result.queuePosition === undefined) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('queue length increases with each queued request', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...otherAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue length should increase with each request
            for (let i = 0; i < otherAgents.length; i++) {
              const expectedQueueLength = i;
              const actualQueueLength = testResolver.getQueueLength();

              if (actualQueueLength !== expectedQueueLength) {
                testResolver.clear();
                return false;
              }

              await testResolver.acquireLock(otherAgents[i]);
            }

            // Final queue length should equal number of other agents
            const finalQueueLength = testResolver.getQueueLength();
            testResolver.clear();
            return finalQueueLength === otherAgents.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('queue positions are assigned correctly (1-indexed)', () => {
    it('queue positions are sequential starting from 1', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...otherAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue other agents and verify positions
            for (let i = 0; i < otherAgents.length; i++) {
              const agentId = otherAgents[i];
              const result = await testResolver.acquireLock(agentId);

              // Queue position should be 1-indexed
              const expectedPosition = i + 1;
              if (result.queuePosition !== expectedPosition) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getQueuePosition returns correct 1-indexed position', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...otherAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue other agents
            for (const agentId of otherAgents) {
              await testResolver.acquireLock(agentId);
            }

            // Verify getQueuePosition returns correct positions
            for (let i = 0; i < otherAgents.length; i++) {
              const agentId = otherAgents[i];
              const expectedPosition = i + 1;
              const actualPosition = testResolver.getQueuePosition(agentId);

              if (actualPosition !== expectedPosition) {
                testResolver.clear();
                return false;
              }
            }

            // Lock holder should not be in queue (position 0)
            if (testResolver.getQueuePosition(firstAgent) !== 0) {
              testResolver.clear();
              return false;
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('FIFO order is maintained', () => {
    it('lock is granted to agents in order they requested', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(3, 8),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...queuedAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue remaining agents
            for (const agentId of queuedAgents) {
              await testResolver.acquireLock(agentId);
            }

            // Release lock and verify FIFO order
            for (let i = 0; i < queuedAgents.length; i++) {
              const expectedNextHolder = queuedAgents[i];

              // Release current lock
              const currentHolder = testResolver.getCurrentLockHolder();
              if (currentHolder) {
                await testResolver.releaseLock(currentHolder);
              }

              // Verify next agent in FIFO order now holds lock
              const newHolder = testResolver.getCurrentLockHolder();
              if (newHolder !== expectedNextHolder) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('queue order matches request order', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 10),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...otherAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue other agents
            for (const agentId of otherAgents) {
              await testResolver.acquireLock(agentId);
            }

            // Verify queue positions match request order
            const positions = testResolver.getQueuePositions();
            for (let i = 0; i < otherAgents.length; i++) {
              const agentId = otherAgents[i];
              const expectedPosition = i + 1;
              const actualPosition = positions.get(agentId);

              if (actualPosition !== expectedPosition) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('lock transfer after release', () => {
    it('next agent in queue receives lock after release', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 5),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, secondAgent, ...rest] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Second agent is queued
            const secondResult = await testResolver.acquireLock(secondAgent);
            if (secondResult.granted || secondResult.queuePosition !== 1) {
              testResolver.clear();
              return false;
            }

            // Queue remaining agents
            for (const agentId of rest) {
              await testResolver.acquireLock(agentId);
            }

            // Release first agent's lock
            await testResolver.releaseLock(firstAgent);

            // Second agent should now hold the lock
            if (!testResolver.holdsLock(secondAgent)) {
              testResolver.clear();
              return false;
            }

            // First agent should no longer hold lock
            if (testResolver.holdsLock(firstAgent)) {
              testResolver.clear();
              return false;
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('queue shrinks after lock transfer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(3, 8),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...queuedAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue remaining agents
            for (const agentId of queuedAgents) {
              await testResolver.acquireLock(agentId);
            }

            const initialQueueLength = testResolver.getQueueLength();
            if (initialQueueLength !== queuedAgents.length) {
              testResolver.clear();
              return false;
            }

            // Release lock - queue should shrink by 1
            await testResolver.releaseLock(firstAgent);

            const newQueueLength = testResolver.getQueueLength();
            if (newQueueLength !== initialQueueLength - 1) {
              testResolver.clear();
              return false;
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('remaining queue positions shift down after transfer', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(4, 8),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, secondAgent, thirdAgent, ...rest] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue second and third agents
            await testResolver.acquireLock(secondAgent);
            await testResolver.acquireLock(thirdAgent);

            // Queue remaining agents
            for (const agentId of rest) {
              await testResolver.acquireLock(agentId);
            }

            // Third agent should be at position 2
            if (testResolver.getQueuePosition(thirdAgent) !== 2) {
              testResolver.clear();
              return false;
            }

            // Release first agent's lock - second agent gets lock
            await testResolver.releaseLock(firstAgent);

            // Third agent should now be at position 1
            if (testResolver.getQueuePosition(thirdAgent) !== 1) {
              testResolver.clear();
              return false;
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('complete queue processing', () => {
    it('all queued agents eventually receive lock in FIFO order', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 6),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const grantOrder: string[] = [];

            // First agent acquires lock
            const firstAgent = agentIds[0]!;
            const firstResult = await testResolver.acquireLock(firstAgent);
            if (firstResult.granted) {
              grantOrder.push(firstAgent);
            }

            // Queue remaining agents
            for (let i = 1; i < agentIds.length; i++) {
              await testResolver.acquireLock(agentIds[i]!);
            }

            // Process entire queue
            while (testResolver.getCurrentLockHolder()) {
              const holder = testResolver.getCurrentLockHolder()!;
              await testResolver.releaseLock(holder);

              const newHolder = testResolver.getCurrentLockHolder();
              if (newHolder) {
                grantOrder.push(newHolder);
              }
            }

            // Verify grant order matches request order
            for (let i = 0; i < agentIds.length; i++) {
              if (grantOrder[i] !== agentIds[i]!) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('queue becomes empty after all agents processed', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 6),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });

            // All agents request lock
            for (const agentId of agentIds) {
              await testResolver.acquireLock(agentId);
            }

            // Process all agents
            while (testResolver.getCurrentLockHolder()) {
              const holder = testResolver.getCurrentLockHolder()!;
              await testResolver.releaseLock(holder);
            }

            // Queue should be empty
            const finalQueueLength = testResolver.getQueueLength();
            testResolver.clear();
            return finalQueueLength === 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('edge cases', () => {
    it('single agent does not get queued', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          async (agentId) => {
            const testResolver = createConflictResolver({ logger: silentLogger });

            const result = await testResolver.acquireLock(agentId);

            // Should be granted immediately, not queued
            const isValid = result.granted &&
              result.queuePosition === undefined &&
              testResolver.getQueueLength() === 0;

            testResolver.clear();
            return isValid;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('same agent requesting twice does not create duplicate queue entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 2),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, secondAgent] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Second agent requests lock - this returns immediately with queued status
            await testResolver.acquireLock(secondAgent);
            const queueLengthAfterFirst = testResolver.getQueueLength();

            // Verify queue length is 1 after first request
            if (queueLengthAfterFirst !== 1) {
              testResolver.clear();
              return false;
            }

            // Second request from same agent - catch the rejection that happens on clear()
            // We only care that queue length doesn't increase
            const secondRequestPromise = testResolver.acquireLock(secondAgent).catch(() => {
              // Expected: clear() will reject this promise
            });

            // Check queue length - should still be 1 (no duplicate)
            const queueLengthAfterSecond = testResolver.getQueueLength();

            // Clean up - this will reject the pending promise
            testResolver.clear();

            // Wait for the promise to settle (it will be rejected by clear())
            await secondRequestPromise;

            return queueLengthAfterFirst === 1 && queueLengthAfterSecond === 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lock holder requesting again returns existing lock', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          async (agentId) => {
            const testResolver = createConflictResolver({ logger: silentLogger });

            // Acquire lock
            const firstResult = await testResolver.acquireLock(agentId);

            // Request again
            const secondResult = await testResolver.acquireLock(agentId);

            // Should return same lock info
            const isValid = firstResult.granted &&
              secondResult.granted &&
              firstResult.branch === secondResult.branch &&
              testResolver.getQueueLength() === 0;

            testResolver.clear();
            return isValid;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 13: Lock Timeout Enforcement
// ============================================================================

describe('Property 13: Lock Timeout Enforcement', () => {
  /**
   * **Validates: Requirements 4.3**
   * 
   * For any Experiment_Lock held for more than 10 minutes, the Conflict_Resolver
   * shall automatically release the lock regardless of experiment completion status.
   */

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('lock has expiration time', () => {
    it('lock result includes expiresAt timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          const result = await testResolver.acquireLock(agentId);

          // Lock should be granted with expiresAt field
          const hasExpiresAt = result.granted &&
            typeof result.expiresAt === 'string' &&
            result.expiresAt.length > 0;

          testResolver.clear();
          return hasExpiresAt;
        }),
        { numRuns: 100 }
      );
    });

    it('expiresAt is a valid ISO 8601 timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          const result = await testResolver.acquireLock(agentId);

          if (!result.granted) {
            testResolver.clear();
            return true; // Skip if not granted
          }

          // Parse the timestamp - should be valid
          const expiresAtDate = new Date(result.expiresAt);
          const isValidDate = !isNaN(expiresAtDate.getTime());

          testResolver.clear();
          return isValidDate;
        }),
        { numRuns: 100 }
      );
    });

    it('expiresAt is approximately 10 minutes from acquisition', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          const result = await testResolver.acquireLock(agentId);

          if (!result.granted) {
            testResolver.clear();
            return true;
          }

          const expiresAtTime = new Date(result.expiresAt).getTime();
          const expectedExpiry = now + 10 * 60 * 1000; // 10 minutes

          // Allow 1 second tolerance for timing
          const isWithinTolerance = Math.abs(expiresAtTime - expectedExpiry) < 1000;

          testResolver.clear();
          return isWithinTolerance;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('lock is automatically released after timeout', () => {
    it('lock is released after 10 minutes regardless of release call', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          const result = await testResolver.acquireLock(agentId);
          if (!result.granted) {
            testResolver.clear();
            return true;
          }

          // Verify lock is held
          if (!testResolver.isLocked()) {
            testResolver.clear();
            return false;
          }

          // Advance time by 10 minutes + 1ms
          vi.advanceTimersByTime(10 * 60 * 1000 + 1);

          // Lock should be automatically released
          const isStillLocked = testResolver.isLocked();

          testResolver.clear();
          return !isStillLocked;
        }),
        { numRuns: 100 }
      );
    });

    it('lock holder changes to null after timeout', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);

          // Verify agent holds lock
          if (testResolver.getCurrentLockHolder() !== agentId) {
            testResolver.clear();
            return false;
          }

          // Advance time past timeout
          vi.advanceTimersByTime(10 * 60 * 1000 + 1);

          // Lock holder should be null (or next in queue)
          const holderAfterTimeout = testResolver.getCurrentLockHolder();

          testResolver.clear();
          // If no queue, holder should be null
          return holderAfterTimeout === null || holderAfterTimeout !== agentId;
        }),
        { numRuns: 100 }
      );
    });

    it('agent no longer holds lock after timeout', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);

          // Verify agent holds lock before timeout
          if (!testResolver.holdsLock(agentId)) {
            testResolver.clear();
            return false;
          }

          // Advance time past timeout
          vi.advanceTimersByTime(10 * 60 * 1000 + 1);

          // Agent should no longer hold lock
          const stillHoldsLock = testResolver.holdsLock(agentId);

          testResolver.clear();
          return !stillHoldsLock;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('next agent in queue gets lock after auto-release', () => {
    it('queued agent receives lock after timeout auto-release', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 5),
          async (agentIds) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, secondAgent, ...rest] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Second agent is queued
            const secondResult = await testResolver.acquireLock(secondAgent);
            if (secondResult.granted) {
              testResolver.clear();
              return false; // Should be queued, not granted
            }

            // Queue remaining agents
            for (const agentId of rest) {
              await testResolver.acquireLock(agentId);
            }

            // Verify first agent holds lock
            if (!testResolver.holdsLock(firstAgent)) {
              testResolver.clear();
              return false;
            }

            // Advance time past timeout (10 minutes + 1ms)
            vi.advanceTimersByTime(10 * 60 * 1000 + 1);

            // Second agent should now hold the lock
            const newHolder = testResolver.getCurrentLockHolder();

            testResolver.clear();
            return newHolder === secondAgent;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('queue is processed in FIFO order after timeout', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(3, 6),
          async (agentIds) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...queuedAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queue remaining agents
            for (const agentId of queuedAgents) {
              await testResolver.acquireLock(agentId);
            }

            // Advance time past timeout
            vi.advanceTimersByTime(10 * 60 * 1000 + 1);

            // First queued agent should now hold lock
            const newHolder = testResolver.getCurrentLockHolder();
            if (newHolder !== queuedAgents[0]) {
              testResolver.clear();
              return false;
            }

            // Queue should have shrunk by 1
            const expectedQueueLength = queuedAgents.length - 1;
            const actualQueueLength = testResolver.getQueueLength();

            testResolver.clear();
            return actualQueueLength === expectedQueueLength;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple timeouts process queue correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(3, 5),
          async (agentIds) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({ logger: silentLogger });
            const grantOrder: string[] = [];

            // All agents request lock
            for (const agentId of agentIds) {
              const result = await testResolver.acquireLock(agentId);
              if (result.granted) {
                grantOrder.push(agentId);
              }
            }

            // Process through timeouts
            for (let i = 1; i < agentIds.length; i++) {
              // Advance time past timeout
              vi.advanceTimersByTime(10 * 60 * 1000 + 1);

              const currentHolder = testResolver.getCurrentLockHolder();
              if (currentHolder) {
                grantOrder.push(currentHolder);
              }
            }

            // Verify FIFO order was maintained
            for (let i = 0; i < agentIds.length; i++) {
              if (grantOrder[i] !== agentIds[i]!) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 50 } // Fewer runs due to complexity
      );
    });
  });

  describe('timeout is enforced regardless of experiment status', () => {
    it('lock times out even without explicit release', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);

          // Simulate experiment in progress (no release call)
          // Just advance time

          // Before timeout - lock should still be held
          vi.advanceTimersByTime(9 * 60 * 1000); // 9 minutes
          if (!testResolver.holdsLock(agentId)) {
            testResolver.clear();
            return false;
          }

          // After timeout - lock should be released
          vi.advanceTimersByTime(1 * 60 * 1000 + 1); // 1 more minute + 1ms
          const stillHoldsLock = testResolver.holdsLock(agentId);

          testResolver.clear();
          return !stillHoldsLock;
        }),
        { numRuns: 100 }
      );
    });

    it('timeout occurs at exactly 10 minutes', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);

          // Just before timeout - lock should still be held
          vi.advanceTimersByTime(10 * 60 * 1000 - 1); // 10 minutes - 1ms
          if (!testResolver.holdsLock(agentId)) {
            testResolver.clear();
            return false;
          }

          // At timeout - lock should be released
          vi.advanceTimersByTime(2); // 2ms more (past the 10 minute mark)
          const stillHoldsLock = testResolver.holdsLock(agentId);

          testResolver.clear();
          return !stillHoldsLock;
        }),
        { numRuns: 100 }
      );
    });

    it('experiment completion status does not affect timeout', async () => {
      // This test verifies that the lock times out regardless of whether
      // the experiment is "in progress", "completed", or "failed"
      // Since we don't track experiment status in the lock, we just verify
      // that the timeout happens unconditionally
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.constantFrom('in_progress', 'completed', 'failed'),
          async (agentId, _experimentStatus) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({ logger: silentLogger });

            await testResolver.acquireLock(agentId);

            // Regardless of experiment status, timeout should occur
            vi.advanceTimersByTime(10 * 60 * 1000 + 1);

            const stillHoldsLock = testResolver.holdsLock(agentId);

            testResolver.clear();
            return !stillHoldsLock;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('configurable timeout', () => {
    it('custom timeout is respected', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.integer({ min: 1000, max: 60000 }), // 1 second to 1 minute
          async (agentId, customTimeoutMs) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({
              logger: silentLogger,
              lockTimeoutMs: customTimeoutMs,
            });

            const result = await testResolver.acquireLock(agentId);
            if (!result.granted) {
              testResolver.clear();
              return true;
            }

            // Verify expiresAt matches custom timeout
            const expiresAtTime = new Date(result.expiresAt).getTime();
            const expectedExpiry = now + customTimeoutMs;
            if (Math.abs(expiresAtTime - expectedExpiry) > 1000) {
              testResolver.clear();
              return false;
            }

            // Before custom timeout - lock should be held
            vi.advanceTimersByTime(customTimeoutMs - 1);
            if (!testResolver.holdsLock(agentId)) {
              testResolver.clear();
              return false;
            }

            // After custom timeout - lock should be released
            vi.advanceTimersByTime(2);
            const stillHoldsLock = testResolver.holdsLock(agentId);

            testResolver.clear();
            return !stillHoldsLock;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('getLockTimeRemaining reflects timeout', () => {
    it('time remaining decreases as time passes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.integer({ min: 1000, max: 300000 }), // 1 second to 5 minutes advance
          async (agentId, advanceMs) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const testResolver = createConflictResolver({ logger: silentLogger });

            await testResolver.acquireLock(agentId);

            const initialRemaining = testResolver.getLockTimeRemaining();
            const expectedInitial = 10 * 60 * 1000; // 10 minutes

            // Initial remaining should be approximately 10 minutes
            if (Math.abs(initialRemaining - expectedInitial) > 1000) {
              testResolver.clear();
              return false;
            }

            // Advance time (but not past timeout)
            const safeAdvance = Math.min(advanceMs, 9 * 60 * 1000);
            vi.advanceTimersByTime(safeAdvance);

            const remainingAfterAdvance = testResolver.getLockTimeRemaining();
            const expectedRemaining = expectedInitial - safeAdvance;

            // Remaining should have decreased
            const isCorrect = Math.abs(remainingAfterAdvance - expectedRemaining) < 1000;

            testResolver.clear();
            return isCorrect;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('time remaining is 0 after timeout', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const now = Date.now();
          vi.setSystemTime(now);

          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);

          // Advance past timeout
          vi.advanceTimersByTime(10 * 60 * 1000 + 1);

          // Time remaining should be 0 (lock released)
          const remaining = testResolver.getLockTimeRemaining();

          testResolver.clear();
          return remaining === 0;
        }),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 14: Branch Naming Convention
// ============================================================================

describe('Property 14: Branch Naming Convention', () => {
  /**
   * **Validates: Requirements 4.5**
   * 
   * For any agent with ID N, the Conflict_Resolver shall create and use a git
   * branch named exactly `autoresearch/swarm/agent-{N}` for that agent's modifications.
   */

  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = createConflictResolver({ logger: silentLogger });
  });

  afterEach(() => {
    resolver.clear();
  });

  describe('getAgentBranch returns correct branch name', () => {
    it('branch name follows pattern autoresearch/swarm/{agentId}', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          const branch = resolver.getAgentBranch(agentId);
          const expectedBranch = `autoresearch/swarm/${agentId}`;

          return branch === expectedBranch;
        }),
        { numRuns: 100 }
      );
    });

    it('branch name uses DEFAULT_BRANCH_PREFIX constant', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          const branch = resolver.getAgentBranch(agentId);

          // Branch should start with the default prefix
          return branch.startsWith('autoresearch/swarm/');
        }),
        { numRuns: 100 }
      );
    });

    it('branch name ends with agent ID', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          const branch = resolver.getAgentBranch(agentId);

          // Branch should end with the agent ID
          return branch.endsWith(`/${agentId}`);
        }),
        { numRuns: 100 }
      );
    });

    it('branch name has exactly three path segments', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          const branch = resolver.getAgentBranch(agentId);
          const segments = branch.split('/');

          // Should be: autoresearch / swarm / {agentId}
          return segments.length === 3 &&
            segments[0] === 'autoresearch' &&
            segments[1] === 'swarm' &&
            segments[2] === agentId;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('lock result includes correct branch name', () => {
    it('lock result branch matches getAgentBranch', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          const lockResult = await testResolver.acquireLock(agentId);
          const expectedBranch = testResolver.getAgentBranch(agentId);

          testResolver.clear();

          // Lock result branch should match getAgentBranch
          return lockResult.branch === expectedBranch;
        }),
        { numRuns: 100 }
      );
    });

    it('lock result branch follows naming convention', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          const lockResult = await testResolver.acquireLock(agentId);
          const expectedPattern = `autoresearch/swarm/${agentId}`;

          testResolver.clear();

          return lockResult.branch === expectedPattern;
        }),
        { numRuns: 100 }
      );
    });

    it('queued lock result also includes correct branch name', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 5),
          async (agentIds) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const [firstAgent, ...queuedAgents] = agentIds;

            // First agent acquires lock
            await testResolver.acquireLock(firstAgent);

            // Queued agents should also get correct branch in result
            for (const agentId of queuedAgents) {
              const result = await testResolver.acquireLock(agentId);
              const expectedBranch = `autoresearch/swarm/${agentId}`;

              if (result.branch !== expectedBranch) {
                testResolver.clear();
                return false;
              }
            }

            testResolver.clear();
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('branch naming is consistent across calls', () => {
    it('same agent always gets same branch name', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.integer({ min: 2, max: 10 }),
          async (agentId, numCalls) => {
            const testResolver = createConflictResolver({ logger: silentLogger });
            const branches: string[] = [];

            // Call getAgentBranch multiple times
            for (let i = 0; i < numCalls; i++) {
              branches.push(testResolver.getAgentBranch(agentId));
            }

            testResolver.clear();

            // All branches should be identical
            const firstBranch = branches[0]!;
            return branches.every(b => b === firstBranch);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('branch name is deterministic based on agent ID', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          // Create two separate resolvers
          const resolver1 = createConflictResolver({ logger: silentLogger });
          const resolver2 = createConflictResolver({ logger: silentLogger });

          const branch1 = resolver1.getAgentBranch(agentId);
          const branch2 = resolver2.getAgentBranch(agentId);

          resolver1.clear();
          resolver2.clear();

          // Same agent ID should produce same branch name
          return branch1 === branch2;
        }),
        { numRuns: 100 }
      );
    });

    it('different agents get different branch names', () => {
      fc.assert(
        fc.property(
          arbitraryUniqueAgentIds(2, 10),
          (agentIds) => {
            const branches = agentIds.map(id => resolver.getAgentBranch(id));
            const uniqueBranches = new Set(branches);

            // Each agent should have a unique branch
            return uniqueBranches.size === agentIds.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('custom branch prefix support', () => {
    it('custom prefix is used in branch name', () => {
      fc.assert(
        fc.property(
          arbitraryAgentId(),
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz/-'.split('')), { minLength: 1, maxLength: 30 })
            .filter(s => !s.startsWith('/') && !s.endsWith('/') && !s.includes('//')),
          (agentId, customPrefix) => {
            const customResolver = createConflictResolver({
              logger: silentLogger,
              branchPrefix: customPrefix,
            });

            const branch = customResolver.getAgentBranch(agentId);
            const expectedBranch = `${customPrefix}/${agentId}`;

            customResolver.clear();

            return branch === expectedBranch;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('default prefix is autoresearch/swarm', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), (agentId) => {
          const defaultResolver = createConflictResolver({ logger: silentLogger });
          const branch = defaultResolver.getAgentBranch(agentId);

          defaultResolver.clear();

          return branch.startsWith('autoresearch/swarm/');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('lock state includes correct branch', () => {
    it('getLockState returns correct branch for lock holder', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          await testResolver.acquireLock(agentId);
          const lockState = testResolver.getLockState();

          if (!lockState) {
            testResolver.clear();
            return false;
          }

          const expectedBranch = `autoresearch/swarm/${agentId}`;

          testResolver.clear();

          return lockState.branch === expectedBranch;
        }),
        { numRuns: 100 }
      );
    });

    it('lock state branch matches lock result branch', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), async (agentId) => {
          const testResolver = createConflictResolver({ logger: silentLogger });

          const lockResult = await testResolver.acquireLock(agentId);
          const lockState = testResolver.getLockState();

          if (!lockState || !lockResult.granted) {
            testResolver.clear();
            return true; // Skip if not applicable
          }

          testResolver.clear();

          return lockState.branch === lockResult.branch;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('branch naming with special agent IDs', () => {
    it('agent-N format produces correct branch', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1000 }),
          (n) => {
            const agentId = `agent-${n}`;
            const branch = resolver.getAgentBranch(agentId);
            const expectedBranch = `autoresearch/swarm/agent-${n}`;

            return branch === expectedBranch;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('numeric agent IDs produce valid branches', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 99999 }).map(n => n.toString()),
          (agentId) => {
            const branch = resolver.getAgentBranch(agentId);
            const expectedBranch = `autoresearch/swarm/${agentId}`;

            return branch === expectedBranch;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('hyphenated agent IDs produce valid branches', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 5 }), { minLength: 2, maxLength: 4 })
            .map(parts => parts.join('-')),
          (agentId) => {
            const branch = resolver.getAgentBranch(agentId);
            const expectedBranch = `autoresearch/swarm/${agentId}`;

            return branch === expectedBranch;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 15: Successful Experiment Merge
// ============================================================================

describe('Property 15: Successful Experiment Merge', () => {
  /**
   * **Validates: Requirements 4.6**
   * 
   * For any experiment with status "keep", the Conflict_Resolver shall merge
   * the changes from the agent's branch to `autoresearch/swarm/main`.
   */

  let resolver: ConflictResolver;

  /** Generates a valid val_bpb value (between 0.5 and 2.0). */
  const arbitraryValBpb = (): fc.Arbitrary<number> =>
    fc.float({ min: 0.5, max: 2.0, noNaN: true });

  /** Generates an experiment status. */
  const arbitraryExperimentStatus = (): fc.Arbitrary<'keep' | 'discard' | 'crash'> =>
    fc.constantFrom('keep', 'discard', 'crash');

  /** Mock GitExecutor that tracks all executed commands. */
  class MockGitExecutor implements GitExecutor {
    public executedCommands: string[] = [];
    public shouldSucceed: boolean = true;
    public shouldConflict: boolean = false;
    public mainBranchValBpb: number = Infinity;

    async exec(command: string): Promise<{ stdout: string; stderr: string }> {
      this.executedCommands.push(command);

      // Handle branch existence check
      if (command.includes('rev-parse --verify')) {
        if (this.shouldSucceed) {
          return { stdout: 'abc1234', stderr: '' };
        }
        throw new Error('Branch not found');
      }

      // Handle branch creation
      if (command.includes('git branch')) {
        return { stdout: '', stderr: '' };
      }

      // Handle checkout
      if (command.includes('git checkout')) {
        return { stdout: '', stderr: '' };
      }

      // Handle merge
      if (command.includes('git merge')) {
        if (this.shouldConflict) {
          throw new Error('CONFLICT (content): Merge conflict in train.py');
        }
        return { stdout: 'Merge successful', stderr: '' };
      }

      // Handle log for val_bpb extraction
      if (command.includes('git log')) {
        return { stdout: `val_bpb: ${this.mainBranchValBpb}`, stderr: '' };
      }

      // Handle conflict resolution commands
      if (command.includes('git checkout --theirs') ||
        command.includes('git checkout --ours') ||
        command.includes('git add') ||
        command.includes('git commit')) {
        return { stdout: '', stderr: '' };
      }

      // Handle merge abort
      if (command.includes('git merge --abort')) {
        return { stdout: '', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }

    reset(): void {
      this.executedCommands = [];
      this.shouldSucceed = true;
      this.shouldConflict = false;
      this.mainBranchValBpb = Infinity;
    }

    /** Check if a merge to main was attempted for the given branch. */
    wasMergeAttempted(branch: string): boolean {
      return this.executedCommands.some(cmd =>
        cmd.includes('git merge') && cmd.includes(`"${branch}"`)
      );
    }

    /** Check if checkout to main branch was performed. */
    wasMainBranchCheckedOut(): boolean {
      return this.executedCommands.some(cmd =>
        cmd.includes('git checkout') && cmd.includes(MAIN_BRANCH)
      );
    }
  }

  beforeEach(() => {
    resolver = createConflictResolver({ logger: silentLogger });
  });

  afterEach(() => {
    resolver.clear();
  });

  describe('mergeToMain is called for "keep" experiments', () => {
    it('mergeToMain returns success for valid branch and val_bpb', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // Merge should succeed
            return result.success === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('mergeToMain targets the main branch (autoresearch/swarm/main)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // Should have checked out the main branch
            return mockGit.wasMainBranchCheckedOut();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('mergeToMain uses the correct branch parameter in merge command', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // Should have attempted merge with the correct branch
            return mockGit.wasMergeAttempted(branch);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('successful merge returns correct result', () => {
    it('successful merge without conflict returns { success: true, conflict: false }', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            mockGit.shouldConflict = false;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            return result.success === true && result.conflict === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('merge result does not include resolution when no conflict', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            mockGit.shouldConflict = false;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // No resolution field when no conflict
            return result.resolution === undefined;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('merge operation sequence is correct', () => {
    it('checkout main branch before merge', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            // Find indices of checkout and merge commands
            const checkoutIndex = mockGit.executedCommands.findIndex(cmd =>
              cmd.includes('git checkout') && cmd.includes(MAIN_BRANCH)
            );
            const mergeIndex = mockGit.executedCommands.findIndex(cmd =>
              cmd.includes('git merge') && cmd.includes(`"${branch}"`)
            );

            testResolver.clear();

            // Checkout should happen before merge
            return checkoutIndex !== -1 && mergeIndex !== -1 && checkoutIndex < mergeIndex;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('merge command includes --no-edit flag', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            // Find merge command
            const mergeCommand = mockGit.executedCommands.find(cmd =>
              cmd.includes('git merge') && cmd.includes(`"${branch}"`)
            );

            testResolver.clear();

            // Merge should include --no-edit flag
            return mergeCommand !== undefined && mergeCommand.includes('--no-edit');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('branch parameter is used correctly', () => {
    it('any valid branch name is passed to merge command', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            // Verify the exact branch was used in merge
            const mergeCommand = mockGit.executedCommands.find(cmd =>
              cmd.includes('git merge')
            );

            testResolver.clear();

            return mergeCommand !== undefined && mergeCommand.includes(`"${branch}"`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('different agents produce different merge commands', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueAgentIds(2, 5),
          arbitraryValBpb(),
          async (agentIds, valBpb) => {
            const mergeCommands: string[] = [];

            for (const agentId of agentIds) {
              const mockGit = new MockGitExecutor();
              const testResolver = createConflictResolver({
                logger: silentLogger,
                gitExecutor: mockGit,
              });

              const branch = testResolver.getAgentBranch(agentId);
              await testResolver.mergeToMain(branch, valBpb);

              const mergeCommand = mockGit.executedCommands.find(cmd =>
                cmd.includes('git merge')
              );
              if (mergeCommand) {
                mergeCommands.push(mergeCommand);
              }

              testResolver.clear();
            }

            // All merge commands should be unique (different branches)
            const uniqueCommands = new Set(mergeCommands);
            return uniqueCommands.size === agentIds.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('MAIN_BRANCH constant is used correctly', () => {
    it('merge always targets MAIN_BRANCH constant value', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            // Verify checkout targets MAIN_BRANCH
            const checkoutCommand = mockGit.executedCommands.find(cmd =>
              cmd.includes('git checkout') && !cmd.includes('--theirs') && !cmd.includes('--ours')
            );

            testResolver.clear();

            return checkoutCommand !== undefined &&
              checkoutCommand.includes(`"${MAIN_BRANCH}"`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('MAIN_BRANCH equals autoresearch/swarm/main', () => {
      // Verify the constant value
      expect(MAIN_BRANCH).toBe('autoresearch/swarm/main');
    });
  });

  describe('merge with various val_bpb values', () => {
    it('merge succeeds regardless of val_bpb value', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.float({ min: 0.0, max: 10.0, noNaN: true }),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // Merge should succeed regardless of val_bpb
            return result.success === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('val_bpb is used for conflict resolution (tested in Property 16)', async () => {
      // This test verifies that val_bpb is passed through correctly
      // Actual conflict resolution is tested in Property 16
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = valBpb + 0.1; // Main has higher (worse) val_bpb

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            // With conflict, should still succeed with resolution
            return result.success === true && result.conflict === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('integration with lock workflow', () => {
    it('merge can be called after lock is acquired', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            // Acquire lock first
            const lockResult = await testResolver.acquireLock(agentId);
            if (!lockResult.granted) {
              testResolver.clear();
              return true; // Skip if not granted
            }

            // Merge using the branch from lock result
            const mergeResult = await testResolver.mergeToMain(lockResult.branch, valBpb);

            testResolver.clear();

            return mergeResult.success === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lock branch matches merge branch', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            // Acquire lock
            const lockResult = await testResolver.acquireLock(agentId);
            if (!lockResult.granted) {
              testResolver.clear();
              return true;
            }

            // Merge using lock branch
            await testResolver.mergeToMain(lockResult.branch, valBpb);

            // Verify merge used the same branch as lock
            const mergeCommand = mockGit.executedCommands.find(cmd =>
              cmd.includes('git merge')
            );

            testResolver.clear();

            return mergeCommand !== undefined &&
              mergeCommand.includes(`"${lockResult.branch}"`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('error handling', () => {
    it('merge failure returns { success: false }', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpb(),
          async (agentId, valBpb) => {
            const mockGit = new MockGitExecutor();
            // Make all git operations fail
            mockGit.exec = async () => {
              throw new Error('Git operation failed');
            };

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            return result.success === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// ============================================================================
// Property 16: Merge Conflict Resolution
// ============================================================================

describe('Property 16: Merge Conflict Resolution', () => {
  /**
   * **Validates: Requirements 4.7**
   * 
   * For any merge conflict between two experiments, the Conflict_Resolver
   * shall keep the version with the lower val_bpb value.
   */

  /** Generates a valid val_bpb value (between 0.5 and 2.0). */
  const arbitraryValBpbP16 = (): fc.Arbitrary<number> =>
    fc.float({ min: 0.5, max: 2.0, noNaN: true });

  /** Generates two distinct val_bpb values for comparison. */
  const arbitraryTwoValBpbs = (): fc.Arbitrary<{ incoming: number; existing: number }> =>
    fc.record({
      incoming: fc.float({ min: 0.5, max: 2.0, noNaN: true }),
      existing: fc.float({ min: 0.5, max: 2.0, noNaN: true }),
    }).filter(({ incoming, existing }) => incoming !== existing);

  /** Mock GitExecutor for conflict resolution testing. */
  class ConflictMockGitExecutor implements GitExecutor {
    public executedCommands: string[] = [];
    public shouldConflict: boolean = true;
    public mainBranchValBpb: number = Infinity;

    async exec(command: string): Promise<{ stdout: string; stderr: string }> {
      this.executedCommands.push(command);

      // Handle branch existence check
      if (command.includes('rev-parse --verify')) {
        return { stdout: 'abc1234', stderr: '' };
      }

      // Handle branch creation
      if (command.includes('git branch')) {
        return { stdout: '', stderr: '' };
      }

      // Handle checkout (non-conflict resolution)
      if (command.includes('git checkout') &&
        !command.includes('--theirs') &&
        !command.includes('--ours')) {
        return { stdout: '', stderr: '' };
      }

      // Handle merge - trigger conflict if configured
      if (command.includes('git merge') && !command.includes('--abort')) {
        if (this.shouldConflict) {
          throw new Error('CONFLICT (content): Merge conflict in train.py');
        }
        return { stdout: 'Merge successful', stderr: '' };
      }

      // Handle log for val_bpb extraction
      if (command.includes('git log')) {
        return { stdout: `val_bpb: ${this.mainBranchValBpb}`, stderr: '' };
      }

      // Handle conflict resolution commands
      if (command.includes('git checkout --theirs') ||
        command.includes('git checkout --ours') ||
        command.includes('git add') ||
        command.includes('git commit')) {
        return { stdout: '', stderr: '' };
      }

      // Handle merge abort
      if (command.includes('git merge --abort')) {
        return { stdout: '', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }

    /** Check if --theirs was used (incoming branch kept). */
    wasTheirsUsed(): boolean {
      return this.executedCommands.some(cmd => cmd.includes('git checkout --theirs'));
    }

    /** Check if --ours was used (existing branch kept). */
    wasOursUsed(): boolean {
      return this.executedCommands.some(cmd => cmd.includes('git checkout --ours'));
    }

    reset(): void {
      this.executedCommands = [];
      this.shouldConflict = true;
      this.mainBranchValBpb = Infinity;
    }
  }

  describe('conflict resolution based on val_bpb comparison', () => {
    it('when incoming val_bpb is lower, incoming version is kept', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryTwoValBpbs(),
          async (agentId, { incoming, existing }) => {
            // Ensure incoming is lower (better)
            const incomingValBpb = Math.min(incoming, existing);
            const existingValBpb = Math.max(incoming, existing);

            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existingValBpb;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incomingValBpb);

            testResolver.clear();

            // Should use --theirs (incoming) since incoming has lower val_bpb
            return result.success === true &&
              result.conflict === true &&
              result.resolution === 'kept-lower-bpb' &&
              mockGit.wasTheirsUsed() &&
              !mockGit.wasOursUsed();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('when existing val_bpb is lower, existing version is kept', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryTwoValBpbs(),
          async (agentId, { incoming, existing }) => {
            // Ensure existing is lower (better)
            const incomingValBpb = Math.max(incoming, existing);
            const existingValBpb = Math.min(incoming, existing);

            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existingValBpb;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incomingValBpb);

            testResolver.clear();

            // Should use --ours (existing) since existing has lower val_bpb
            return result.success === true &&
              result.conflict === true &&
              result.resolution === 'kept-existing' &&
              mockGit.wasOursUsed() &&
              !mockGit.wasTheirsUsed();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('lower val_bpb always wins', () => {
    it('for any two val_bpb values, the lower one is kept', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryTwoValBpbs(),
          async (agentId, { incoming, existing }) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existing;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incoming);

            testResolver.clear();

            // Verify the correct version was kept based on val_bpb comparison
            if (incoming < existing) {
              // Incoming is better - should use --theirs
              return result.success === true &&
                result.conflict === true &&
                result.resolution === 'kept-lower-bpb' &&
                mockGit.wasTheirsUsed();
            } else {
              // Existing is better or equal - should use --ours
              return result.success === true &&
                result.conflict === true &&
                result.resolution === 'kept-existing' &&
                mockGit.wasOursUsed();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('resolution field indicates which version was kept', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryTwoValBpbs(),
          async (agentId, { incoming, existing }) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existing;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incoming);

            testResolver.clear();

            // Resolution field must be present and correct
            if (result.resolution === undefined) {
              return false;
            }

            if (incoming < existing) {
              return result.resolution === 'kept-lower-bpb';
            } else {
              return result.resolution === 'kept-existing';
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('conflict is resolved successfully', () => {
    it('conflict resolution returns success: true, conflict: true', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpbP16(),
          async (agentId, valBpb) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = valBpb + 0.1; // Different from incoming

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, valBpb);

            testResolver.clear();

            return result.success === true && result.conflict === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('conflict resolution always produces a resolution field', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryTwoValBpbs(),
          async (agentId, { incoming, existing }) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existing;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incoming);

            testResolver.clear();

            // Resolution field must be present when conflict occurred
            return result.conflict === true &&
              result.resolution !== undefined &&
              (result.resolution === 'kept-lower-bpb' || result.resolution === 'kept-existing');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('edge cases for val_bpb comparison', () => {
    it('very small differences in val_bpb are handled correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          fc.float({ min: Math.fround(0.9), max: Math.fround(1.1), noNaN: true }),
          async (agentId, baseValBpb) => {
            // Create two values with small difference
            const incoming = baseValBpb;
            const existing = baseValBpb + 0.001;

            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = existing;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incoming);

            testResolver.clear();

            // Incoming is slightly lower, should be kept
            return result.success === true &&
              result.conflict === true &&
              result.resolution === 'kept-lower-bpb' &&
              mockGit.wasTheirsUsed();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('when existing val_bpb is Infinity, incoming always wins', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpbP16(),
          async (agentId, incomingValBpb) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = Infinity; // No previous val_bpb

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            const result = await testResolver.mergeToMain(branch, incomingValBpb);

            testResolver.clear();

            // Any finite value is better than Infinity
            return result.success === true &&
              result.conflict === true &&
              result.resolution === 'kept-lower-bpb' &&
              mockGit.wasTheirsUsed();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('git commands for conflict resolution', () => {
    it('uses git checkout --theirs when incoming wins', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          async (agentId) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = 1.5; // Higher than incoming

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, 1.0); // Lower val_bpb

            testResolver.clear();

            // Should have used --theirs
            return mockGit.wasTheirsUsed() && !mockGit.wasOursUsed();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('uses git checkout --ours when existing wins', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          async (agentId) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = 0.8; // Lower than incoming

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, 1.2); // Higher val_bpb

            testResolver.clear();

            // Should have used --ours
            return mockGit.wasOursUsed() && !mockGit.wasTheirsUsed();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('commits after resolving conflict', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentId(),
          arbitraryValBpbP16(),
          async (agentId, valBpb) => {
            const mockGit = new ConflictMockGitExecutor();
            mockGit.shouldConflict = true;
            mockGit.mainBranchValBpb = valBpb + 0.1;

            const testResolver = createConflictResolver({
              logger: silentLogger,
              gitExecutor: mockGit,
            });

            const branch = testResolver.getAgentBranch(agentId);
            await testResolver.mergeToMain(branch, valBpb);

            // Find checkout and commit commands
            const checkoutIndex = mockGit.executedCommands.findIndex(cmd =>
              cmd.includes('git checkout --theirs') || cmd.includes('git checkout --ours')
            );
            const addIndex = mockGit.executedCommands.findIndex(cmd =>
              cmd.includes('git add')
            );
            const commitIndex = mockGit.executedCommands.findIndex(cmd =>
              cmd.includes('git commit')
            );

            testResolver.clear();

            // Checkout should happen before add, add before commit
            return checkoutIndex !== -1 &&
              addIndex !== -1 &&
              commitIndex !== -1 &&
              checkoutIndex < addIndex &&
              addIndex < commitIndex;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
