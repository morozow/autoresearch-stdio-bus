/**
 * Unit tests for ConflictResolver.
 * 
 * Tests the distributed lock mechanism with FIFO queuing and auto-release.
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConflictResolver,
  createConflictResolver,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_BRANCH_PREFIX,
} from './conflict-resolver';

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    resolver = createConflictResolver({ logger: mockLogger });
  });

  afterEach(() => {
    resolver.clear();
    vi.useRealTimers();
  });

  describe('acquireLock', () => {
    it('should grant lock immediately when no lock is held', async () => {
      const result = await resolver.acquireLock('agent-0');

      expect(result.granted).toBe(true);
      expect(result.branch).toBe(`${DEFAULT_BRANCH_PREFIX}/agent-0`);
      expect(result.expiresAt).toBeDefined();
      expect(result.queuePosition).toBeUndefined();
    });

    it('should return correct branch name for agent', async () => {
      const result = await resolver.acquireLock('agent-5');

      expect(result.branch).toBe('autoresearch/swarm/agent-5');
    });

    it('should set expiration time 10 minutes from now', async () => {
      const now = new Date('2025-01-15T10:00:00Z');
      vi.setSystemTime(now);

      const result = await resolver.acquireLock('agent-0');

      const expiresAt = new Date(result.expiresAt);
      const expectedExpiry = new Date('2025-01-15T10:10:00Z');
      expect(expiresAt.getTime()).toBe(expectedExpiry.getTime());
    });

    it('should queue request when lock is held by another agent', async () => {
      // First agent acquires lock
      await resolver.acquireLock('agent-0');

      // Second agent tries to acquire
      const result = await resolver.acquireLock('agent-1');

      expect(result.granted).toBe(false);
      expect(result.queuePosition).toBe(1);
      expect(result.branch).toBe(`${DEFAULT_BRANCH_PREFIX}/agent-1`);
    });

    it('should maintain FIFO order in queue', async () => {
      // First agent acquires lock
      await resolver.acquireLock('agent-0');

      // Queue multiple agents
      const result1 = await resolver.acquireLock('agent-1');
      const result2 = await resolver.acquireLock('agent-2');
      const result3 = await resolver.acquireLock('agent-3');

      expect(result1.queuePosition).toBe(1);
      expect(result2.queuePosition).toBe(2);
      expect(result3.queuePosition).toBe(3);
    });

    it('should return existing lock if agent already holds it', async () => {
      const result1 = await resolver.acquireLock('agent-0');
      const result2 = await resolver.acquireLock('agent-0');

      expect(result1.granted).toBe(true);
      expect(result2.granted).toBe(true);
      expect(result1.branch).toBe(result2.branch);
    });
  });

  describe('releaseLock', () => {
    it('should release lock when called by holder', async () => {
      await resolver.acquireLock('agent-0');
      expect(resolver.isLocked()).toBe(true);

      await resolver.releaseLock('agent-0');
      expect(resolver.isLocked()).toBe(false);
    });

    it('should do nothing when called by non-holder', async () => {
      await resolver.acquireLock('agent-0');

      await resolver.releaseLock('agent-1');

      expect(resolver.isLocked()).toBe(true);
      expect(resolver.getCurrentLockHolder()).toBe('agent-0');
    });

    it('should grant lock to next in queue after release', async () => {
      // Agent 0 acquires lock
      await resolver.acquireLock('agent-0');

      // Agent 1 queues
      await resolver.acquireLock('agent-1');
      expect(resolver.getQueueLength()).toBe(1);

      // Agent 0 releases
      await resolver.releaseLock('agent-0');

      // Agent 1 should now hold the lock
      expect(resolver.getCurrentLockHolder()).toBe('agent-1');
      expect(resolver.getQueueLength()).toBe(0);
    });

    it('should process queue in FIFO order', async () => {
      // Agent 0 acquires lock
      await resolver.acquireLock('agent-0');

      // Queue agents 1, 2, 3
      await resolver.acquireLock('agent-1');
      await resolver.acquireLock('agent-2');
      await resolver.acquireLock('agent-3');

      // Release and check order
      await resolver.releaseLock('agent-0');
      expect(resolver.getCurrentLockHolder()).toBe('agent-1');

      await resolver.releaseLock('agent-1');
      expect(resolver.getCurrentLockHolder()).toBe('agent-2');

      await resolver.releaseLock('agent-2');
      expect(resolver.getCurrentLockHolder()).toBe('agent-3');
    });

    it('should release lock within 1 second (immediate)', async () => {
      await resolver.acquireLock('agent-0');

      const startTime = Date.now();
      await resolver.releaseLock('agent-0');
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(resolver.isLocked()).toBe(false);
    });
  });

  describe('auto-release after timeout', () => {
    it('should auto-release lock after 10 minutes', async () => {
      await resolver.acquireLock('agent-0');
      expect(resolver.isLocked()).toBe(true);

      // Advance time by 10 minutes
      vi.advanceTimersByTime(DEFAULT_LOCK_TIMEOUT_MS);

      expect(resolver.isLocked()).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Lock auto-released due to timeout',
        expect.objectContaining({ agentId: 'agent-0' })
      );
    });

    it('should grant lock to next in queue after auto-release', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.acquireLock('agent-1');

      // Advance time by 10 minutes
      vi.advanceTimersByTime(DEFAULT_LOCK_TIMEOUT_MS);

      expect(resolver.getCurrentLockHolder()).toBe('agent-1');
    });

    it('should not auto-release if lock was manually released', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.releaseLock('agent-0');

      // Advance time by 10 minutes
      vi.advanceTimersByTime(DEFAULT_LOCK_TIMEOUT_MS);

      // Should not have logged another auto-release
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Lock auto-released due to timeout',
        expect.anything()
      );
    });

    it('should use custom timeout when configured', async () => {
      const customTimeout = 5 * 60 * 1000; // 5 minutes
      const customResolver = createConflictResolver({
        logger: mockLogger,
        lockTimeoutMs: customTimeout,
      });

      await customResolver.acquireLock('agent-0');

      // Advance by 5 minutes
      vi.advanceTimersByTime(customTimeout);

      expect(customResolver.isLocked()).toBe(false);
      customResolver.clear();
    });
  });

  describe('branch naming', () => {
    it('should use correct branch naming convention', () => {
      expect(resolver.getAgentBranch('agent-0')).toBe('autoresearch/swarm/agent-0');
      expect(resolver.getAgentBranch('agent-1')).toBe('autoresearch/swarm/agent-1');
      expect(resolver.getAgentBranch('agent-99')).toBe('autoresearch/swarm/agent-99');
    });

    it('should use custom branch prefix when configured', () => {
      const customResolver = createConflictResolver({
        branchPrefix: 'custom/prefix',
      });

      expect(customResolver.getAgentBranch('agent-0')).toBe('custom/prefix/agent-0');
      customResolver.clear();
    });
  });

  describe('utility methods', () => {
    it('should report correct lock state', async () => {
      expect(resolver.getLockState()).toBeNull();

      await resolver.acquireLock('agent-0');

      const state = resolver.getLockState();
      expect(state).not.toBeNull();
      expect(state?.agentId).toBe('agent-0');
      expect(state?.branch).toBe('autoresearch/swarm/agent-0');
      expect(state?.expiresAt).toBeDefined();
    });

    it('should report correct queue positions', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.acquireLock('agent-1');
      await resolver.acquireLock('agent-2');

      const positions = resolver.getQueuePositions();
      expect(positions.get('agent-1')).toBe(1);
      expect(positions.get('agent-2')).toBe(2);
      expect(positions.has('agent-0')).toBe(false); // Lock holder not in queue
    });

    it('should correctly check if agent holds lock', async () => {
      await resolver.acquireLock('agent-0');

      expect(resolver.holdsLock('agent-0')).toBe(true);
      expect(resolver.holdsLock('agent-1')).toBe(false);
    });

    it('should correctly report queue position for agent', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.acquireLock('agent-1');
      await resolver.acquireLock('agent-2');

      expect(resolver.getQueuePosition('agent-0')).toBe(0); // Not in queue
      expect(resolver.getQueuePosition('agent-1')).toBe(1);
      expect(resolver.getQueuePosition('agent-2')).toBe(2);
      expect(resolver.getQueuePosition('agent-3')).toBe(0); // Not in queue
    });

    it('should calculate remaining lock time correctly', async () => {
      const now = new Date('2025-01-15T10:00:00Z');
      vi.setSystemTime(now);

      await resolver.acquireLock('agent-0');

      // Advance 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);

      const remaining = resolver.getLockTimeRemaining();
      // Should be approximately 5 minutes remaining
      expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(remaining).toBeGreaterThan(4 * 60 * 1000);
    });
  });

  describe('clear and forceRelease', () => {
    it('should clear all state', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.acquireLock('agent-1');

      resolver.clear();

      expect(resolver.isLocked()).toBe(false);
      expect(resolver.getQueueLength()).toBe(0);
    });

    it('should force release current lock', async () => {
      await resolver.acquireLock('agent-0');
      await resolver.acquireLock('agent-1');

      resolver.forceRelease();

      expect(resolver.getCurrentLockHolder()).toBe('agent-1');
    });
  });

  describe('createAgentBranch', () => {
    let mockGitExecutor: {
      exec: ReturnType<typeof vi.fn>;
    };
    let resolverWithGit: ConflictResolver;

    beforeEach(() => {
      mockGitExecutor = {
        exec: vi.fn(),
      };
      resolverWithGit = createConflictResolver({
        logger: mockLogger,
        gitExecutor: mockGitExecutor,
      });
    });

    afterEach(() => {
      resolverWithGit.clear();
    });

    it('should return correct branch name', async () => {
      // Mock: main branch doesn't exist, agent branch doesn't exist
      mockGitExecutor.exec
        .mockRejectedValueOnce(new Error('branch not found')) // main branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create main branch
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // create agent branch

      const branch = await resolverWithGit.createAgentBranch('agent-0');
      expect(branch).toBe('autoresearch/swarm/agent-0');
    });

    it('should create main branch if it does not exist', async () => {
      // Mock: main branch doesn't exist
      mockGitExecutor.exec
        .mockRejectedValueOnce(new Error('branch not found')) // main branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create main branch
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // create agent branch

      await resolverWithGit.createAgentBranch('agent-0');

      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git branch "autoresearch/swarm/main" HEAD'
      );
    });

    it('should create agent branch from main branch', async () => {
      // Mock: main branch exists, agent branch doesn't exist
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // create agent branch

      await resolverWithGit.createAgentBranch('agent-0');

      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git branch "autoresearch/swarm/agent-0" "autoresearch/swarm/main"'
      );
    });

    it('should handle branch already exists gracefully', async () => {
      // Mock: main branch exists, agent branch exists
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: 'def456', stderr: '' }); // agent branch exists

      const branch = await resolverWithGit.createAgentBranch('agent-0');

      expect(branch).toBe('autoresearch/swarm/agent-0');
      // Should not try to create the branch
      expect(mockGitExecutor.exec).toHaveBeenCalledTimes(2);
    });

    it('should cache created branches and not recreate them', async () => {
      // Mock: main branch exists, agent branch doesn't exist first time
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // create agent branch

      // First call creates the branch
      await resolverWithGit.createAgentBranch('agent-0');

      // Reset mock to track second call
      mockGitExecutor.exec.mockClear();

      // Second call should use cache
      const branch = await resolverWithGit.createAgentBranch('agent-0');

      expect(branch).toBe('autoresearch/swarm/agent-0');
      // Should not have called exec at all (cached)
      expect(mockGitExecutor.exec).toHaveBeenCalledTimes(0);
    });

    it('should handle race condition where branch is created by another process', async () => {
      // Mock: main branch exists, agent branch doesn't exist, but creation fails
      // because another process created it
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockRejectedValueOnce(new Error('branch already exists')) // create fails
        .mockResolvedValueOnce({ stdout: 'def456', stderr: '' }); // branch now exists

      const branch = await resolverWithGit.createAgentBranch('agent-0');

      expect(branch).toBe('autoresearch/swarm/agent-0');
    });

    it('should throw error if branch creation fails and branch does not exist', async () => {
      // Mock: main branch exists, agent branch doesn't exist, creation fails
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockRejectedValueOnce(new Error('branch not found')) // agent branch check
        .mockRejectedValueOnce(new Error('git error')) // create fails
        .mockRejectedValueOnce(new Error('branch not found')); // still doesn't exist

      await expect(resolverWithGit.createAgentBranch('agent-0')).rejects.toThrow('git error');
    });

    it('should use correct branch naming convention for different agent IDs', async () => {
      // Mock: main branch exists, agent branches don't exist
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockRejectedValueOnce(new Error('branch not found')) // agent-5 check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // create agent-5

      const branch = await resolverWithGit.createAgentBranch('agent-5');

      expect(branch).toBe('autoresearch/swarm/agent-5');
      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git branch "autoresearch/swarm/agent-5" "autoresearch/swarm/main"'
      );
    });
  });

  describe('mergeToMain', () => {
    let mockGitExecutor: {
      exec: ReturnType<typeof vi.fn>;
    };
    let resolverWithGit: ConflictResolver;

    beforeEach(() => {
      mockGitExecutor = {
        exec: vi.fn(),
      };
      resolverWithGit = createConflictResolver({
        logger: mockLogger,
        gitExecutor: mockGitExecutor,
      });
    });

    afterEach(() => {
      resolverWithGit.clear();
    });

    it('should merge successfully when no conflict occurs', async () => {
      // Mock: main branch exists, checkout succeeds, merge succeeds
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists check
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge succeeds

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(result.success).toBe(true);
      expect(result.conflict).toBe(false);
      expect(result.resolution).toBeUndefined();
    });

    it('should checkout main branch before merging', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge succeeds

      await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git checkout "autoresearch/swarm/main"'
      );
    });

    it('should merge the specified branch', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge succeeds

      await resolverWithGit.mergeToMain('autoresearch/swarm/agent-5', 0.99);

      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git merge "autoresearch/swarm/agent-5" --no-edit'
      );
    });

    it('should resolve conflict by keeping lower val_bpb (incoming wins)', async () => {
      // Mock: merge fails with conflict, incoming has lower val_bpb
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT: Automatic merge failed')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'Merge: val_bpb: 1.0', stderr: '' }) // get main val_bpb
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --theirs
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.85);

      expect(result.success).toBe(true);
      expect(result.conflict).toBe(true);
      expect(result.resolution).toBe('kept-lower-bpb');
    });

    it('should resolve conflict by keeping existing (main wins)', async () => {
      // Mock: merge fails with conflict, main has lower val_bpb
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT: Automatic merge failed')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'Merge: val_bpb: 0.80', stderr: '' }) // get main val_bpb
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --ours
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.95);

      expect(result.success).toBe(true);
      expect(result.conflict).toBe(true);
      expect(result.resolution).toBe('kept-existing');
    });

    it('should keep incoming when main has no val_bpb (Infinity)', async () => {
      // Mock: merge fails with conflict, main has no val_bpb in commit message
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT: Automatic merge failed')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'Initial commit', stderr: '' }) // no val_bpb in message
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --theirs
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(result.success).toBe(true);
      expect(result.conflict).toBe(true);
      expect(result.resolution).toBe('kept-lower-bpb');
    });

    it('should detect various conflict message formats', async () => {
      const conflictMessages = [
        'CONFLICT (content): Merge conflict in train.py',
        'Automatic merge failed; fix conflicts and then commit',
        'error: merge conflict in file.txt',
      ];

      for (const conflictMsg of conflictMessages) {
        // Create a fresh resolver for each iteration to avoid cache issues
        const freshResolver = createConflictResolver({
          logger: mockLogger,
          gitExecutor: mockGitExecutor,
        });

        mockGitExecutor.exec.mockReset();
        mockGitExecutor.exec
          .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
          .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
          .mockRejectedValueOnce(new Error(conflictMsg)) // merge conflict
          .mockResolvedValueOnce({ stdout: 'val_bpb: 1.0', stderr: '' }) // get main val_bpb
          .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --theirs
          .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
          .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

        const result = await freshResolver.mergeToMain('autoresearch/swarm/agent-0', 0.85);

        expect(result.conflict).toBe(true);
        expect(result.success).toBe(true);

        freshResolver.clear();
      }
    });

    it('should return failure when merge fails for non-conflict reason', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('fatal: not a git repository')); // non-conflict error

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(false);
    });

    it('should abort merge on failure', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('fatal: not a git repository')) // non-conflict error
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge --abort

      await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(mockGitExecutor.exec).toHaveBeenCalledWith('git merge --abort');
    });

    it('should handle abort failure gracefully', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('fatal: not a git repository')) // non-conflict error
        .mockRejectedValueOnce(new Error('fatal: There is no merge to abort')); // abort fails

      // Should not throw
      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(result.success).toBe(false);
    });

    it('should create main branch if it does not exist before merge', async () => {
      mockGitExecutor.exec
        .mockRejectedValueOnce(new Error('branch not found')) // main branch doesn't exist
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // create main branch
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge succeeds

      await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(mockGitExecutor.exec).toHaveBeenCalledWith(
        'git branch "autoresearch/swarm/main" HEAD'
      );
    });

    it('should parse val_bpb from commit message with colon format', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'Experiment result: val_bpb: 0.993200', stderr: '' }) // get main val_bpb
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --ours
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      // Incoming 0.995 > main 0.993200, so keep existing
      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.995);

      expect(result.resolution).toBe('kept-existing');
    });

    it('should parse val_bpb from commit message with parentheses format', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'Merge agent-1: resolved conflict, kept lower val_bpb (0.990)', stderr: '' }) // get main val_bpb
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --theirs
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      // Incoming 0.985 < main 0.990, so keep incoming
      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.985);

      expect(result.resolution).toBe('kept-lower-bpb');
    });

    it('should handle equal val_bpb by keeping existing', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'val_bpb: 0.99', stderr: '' }) // get main val_bpb
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout --ours
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git commit

      // Equal val_bpb, keep existing
      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(result.resolution).toBe('kept-existing');
    });

    it('should return failure when conflict resolution fails', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockRejectedValueOnce(new Error('CONFLICT')) // merge conflict
        .mockResolvedValueOnce({ stdout: 'val_bpb: 1.0', stderr: '' }) // get main val_bpb
        .mockRejectedValueOnce(new Error('checkout failed')) // checkout --theirs fails
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge --abort

      const result = await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.85);

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
    });

    it('should log merge operations', async () => {
      mockGitExecutor.exec
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // main branch exists
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // checkout main
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // merge succeeds

      await resolverWithGit.mergeToMain('autoresearch/swarm/agent-0', 0.99);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Merging branch to main',
        expect.objectContaining({ branch: 'autoresearch/swarm/agent-0', valBpb: 0.99 })
      );
    });
  });
});

describe('createConflictResolver factory', () => {
  it('should create resolver with default options', () => {
    const resolver = createConflictResolver();
    expect(resolver).toBeInstanceOf(ConflictResolver);
    resolver.clear();
  });

  it('should create resolver with custom options', () => {
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const resolver = createConflictResolver({
      logger: customLogger,
      lockTimeoutMs: 5000,
      branchPrefix: 'test/prefix',
    });

    expect(resolver.getAgentBranch('agent-0')).toBe('test/prefix/agent-0');
    resolver.clear();
  });
});
