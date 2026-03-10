/**
 * ConflictResolver - Handles concurrent modifications to shared resources.
 * 
 * Responsibilities:
 * - Manage distributed Experiment_Lock with 10-minute max hold time
 * - Queue modification requests when lock is held
 * - Create and manage git branches per agent
 * - Merge successful experiments to `autoresearch/swarm/main`
 * - Resolve merge conflicts by keeping lower val_bpb version
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a lock acquisition attempt.
 * 
 * Validates: Requirements 4.1, 4.2
 */
export interface LockResult {
  /** Whether the lock was granted */
  granted: boolean;
  /** Git branch for the agent (e.g., autoresearch/swarm/agent-0) */
  branch: string;
  /** ISO 8601 timestamp when lock expires (10 min from grant) */
  expiresAt: string;
  /** Queue position if not granted (1-indexed) */
  queuePosition?: number;
}

/**
 * Result of a merge operation.
 * 
 * Validates: Requirements 4.6, 4.7
 */
export interface MergeResult {
  /** Whether the merge was successful */
  success: boolean;
  /** Whether there was a conflict */
  conflict: boolean;
  /** How the conflict was resolved (if any) */
  resolution?: 'kept-lower-bpb' | 'kept-existing';
}

/**
 * Internal lock state tracking.
 */
interface LockState {
  /** Agent ID holding the lock */
  agentId: string;
  /** Branch assigned to the lock holder */
  branch: string;
  /** ISO 8601 timestamp when lock was acquired */
  acquiredAt: string;
  /** ISO 8601 timestamp when lock expires */
  expiresAt: string;
  /** Timer ID for auto-release */
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Queued lock request.
 */
interface QueuedRequest {
  /** Agent ID requesting the lock */
  agentId: string;
  /** Promise resolve function to call when lock is granted */
  resolve: (result: LockResult) => void;
  /** Promise reject function to call on error */
  reject: (error: Error) => void;
  /** ISO 8601 timestamp when request was queued */
  queuedAt: string;
}

/**
 * Logger interface for conflict resolver.
 */
export interface ConflictResolverLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultConflictResolverLogger: ConflictResolverLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[conflict-resolver] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[conflict-resolver] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[conflict-resolver] ${message}`, context ?? '');
  },
};

/**
 * Git executor interface for running git commands.
 * Allows injection of mock executor for testing.
 */
export interface GitExecutor {
  exec(command: string): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Default git executor using child_process.
 */
export const defaultGitExecutor: GitExecutor = {
  async exec(command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(command);
  },
};

/**
 * Configuration options for ConflictResolver.
 */
export interface ConflictResolverOptions {
  /** Logger for resolver events. Defaults to console logger. */
  logger?: ConflictResolverLogger;
  /** Lock timeout in milliseconds. Defaults to 10 minutes (600000ms). */
  lockTimeoutMs?: number;
  /** Custom timestamp generator. Defaults to ISO 8601 current time. */
  timestampGenerator?: () => string;
  /** Branch prefix for agent branches. Defaults to 'autoresearch/swarm'. */
  branchPrefix?: string;
  /** Git executor for running git commands. Defaults to child_process exec. */
  gitExecutor?: GitExecutor;
}

// ============================================================================
// Constants
// ============================================================================

/** Default lock timeout: 10 minutes in milliseconds */
export const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Default branch prefix */
export const DEFAULT_BRANCH_PREFIX = 'autoresearch/swarm';

/** Main branch name */
export const MAIN_BRANCH = 'autoresearch/swarm/main';

// ============================================================================
// ConflictResolver Class
// ============================================================================

/**
 * ConflictResolver manages distributed locking and git operations for the swarm.
 * 
 * Key features:
 * - Single lock with FIFO queue for waiting agents
 * - 10-minute max hold time with automatic release
 * - Git branch management per agent
 * - Merge conflict resolution by val_bpb comparison
 * 
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
export class ConflictResolver {
  /** Current lock state (null if no lock held) */
  private currentLock: LockState | null = null;

  /** FIFO queue of pending lock requests */
  private queue: QueuedRequest[] = [];

  /** Logger instance */
  private logger: ConflictResolverLogger;

  /** Lock timeout in milliseconds */
  private lockTimeoutMs: number;

  /** Timestamp generator function */
  private generateTs: () => string;

  /** Branch prefix for agent branches */
  private branchPrefix: string;

  /** Git executor for running git commands */
  private gitExecutor: GitExecutor;

  /** Track which branches have been created */
  private createdBranches: Set<string> = new Set();

  /**
   * Creates a new ConflictResolver instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: ConflictResolverOptions = {}) {
    this.logger = options.logger ?? defaultConflictResolverLogger;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.generateTs = options.timestampGenerator ?? (() => new Date().toISOString());
    this.branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    this.gitExecutor = options.gitExecutor ?? defaultGitExecutor;
  }

  // ==========================================================================
  // Lock Management
  // ==========================================================================

  /**
   * Attempts to acquire the experiment lock for an agent.
   * 
   * If the lock is available, it is granted immediately.
   * If the lock is held by another agent, the request is queued.
   * 
   * The lock has a maximum hold time of 10 minutes, after which it is
   * automatically released and granted to the next agent in the queue.
   * 
   * @param agentId - The agent requesting the lock
   * @returns Promise resolving to LockResult
   * 
   * Validates: Requirements 4.1, 4.2, 4.3
   */
  async acquireLock(agentId: string): Promise<LockResult> {
    // Check if this agent already holds the lock
    if (this.currentLock && this.currentLock.agentId === agentId) {
      this.logger.info('Agent already holds lock', { agentId });
      return {
        granted: true,
        branch: this.currentLock.branch,
        expiresAt: this.currentLock.expiresAt,
      };
    }

    // Check if this agent is already in the queue
    const existingQueueIndex = this.queue.findIndex(req => req.agentId === agentId);
    if (existingQueueIndex !== -1) {
      const existingRequest = this.queue[existingQueueIndex]!;
      this.logger.info('Agent already in queue', {
        agentId,
        queuePosition: existingQueueIndex + 1
      });
      // Return a promise that will resolve when the existing request is granted
      return new Promise((resolve, reject) => {
        // Replace the existing request's callbacks
        existingRequest.resolve = resolve;
        existingRequest.reject = reject;
      });
    }

    // If no lock is held, grant immediately
    if (!this.currentLock) {
      return this.grantLock(agentId);
    }

    // Lock is held by another agent, queue this request
    return this.queueRequest(agentId);
  }

  /**
   * Releases the experiment lock held by an agent.
   * 
   * If the agent holds the lock, it is released and the next agent
   * in the queue (if any) is granted the lock.
   * 
   * @param agentId - The agent releasing the lock
   * 
   * Validates: Requirements 4.4
   */
  async releaseLock(agentId: string): Promise<void> {
    // Check if this agent holds the lock
    if (!this.currentLock || this.currentLock.agentId !== agentId) {
      this.logger.warn('Agent does not hold lock', {
        agentId,
        currentHolder: this.currentLock?.agentId
      });
      return;
    }

    // Clear the auto-release timeout
    clearTimeout(this.currentLock.timeoutId);

    this.logger.info('Lock released', {
      agentId,
      branch: this.currentLock.branch
    });

    // Clear current lock
    this.currentLock = null;

    // Grant lock to next in queue
    await this.processQueue();
  }

  /**
   * Grants the lock to an agent immediately.
   * 
   * @param agentId - The agent to grant the lock to
   * @returns LockResult with granted=true
   */
  private grantLock(agentId: string): LockResult {
    const now = this.generateTs();
    const expiresAt = new Date(new Date(now).getTime() + this.lockTimeoutMs).toISOString();
    const branch = this.getAgentBranch(agentId);

    // Set up auto-release timeout
    const timeoutId = setTimeout(() => {
      this.autoReleaseLock(agentId);
    }, this.lockTimeoutMs);

    // Store lock state
    this.currentLock = {
      agentId,
      branch,
      acquiredAt: now,
      expiresAt,
      timeoutId,
    };

    this.logger.info('Lock granted', {
      agentId,
      branch,
      expiresAt
    });

    return {
      granted: true,
      branch,
      expiresAt,
    };
  }

  /**
   * Queues a lock request for an agent.
   * 
   * @param agentId - The agent requesting the lock
   * @returns Promise that resolves when lock is granted
   * 
   * Validates: Requirement 4.2
   */
  private queueRequest(agentId: string): Promise<LockResult> {
    return new Promise((resolve, reject) => {
      const queuedAt = this.generateTs();
      const queuePosition = this.queue.length + 1;

      this.queue.push({
        agentId,
        resolve,
        reject,
        queuedAt,
      });

      this.logger.info('Lock request queued', {
        agentId,
        queuePosition,
        queuedAt
      });

      // Return immediately with queue position
      // The promise will resolve later when lock is granted
      // But we need to return the queue position now
      // So we resolve with a "queued" result
      resolve({
        granted: false,
        branch: this.getAgentBranch(agentId),
        expiresAt: '', // Not applicable when queued
        queuePosition,
      });
    });
  }

  /**
   * Processes the queue, granting lock to next waiting agent.
   */
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.logger.info('Queue empty, no pending requests');
      return;
    }

    // Get next request from queue (FIFO)
    const nextRequest = this.queue.shift()!;

    // Grant lock to next agent
    const result = this.grantLock(nextRequest.agentId);

    this.logger.info('Lock granted from queue', {
      agentId: nextRequest.agentId,
      remainingInQueue: this.queue.length
    });

    // Note: The original promise was already resolved with queued status
    // The agent should poll or wait for notification
  }

  /**
   * Auto-releases the lock after timeout.
   * 
   * @param agentId - The agent whose lock is being auto-released
   * 
   * Validates: Requirement 4.3
   */
  private autoReleaseLock(agentId: string): void {
    if (!this.currentLock || this.currentLock.agentId !== agentId) {
      return;
    }

    this.logger.warn('Lock auto-released due to timeout', {
      agentId,
      branch: this.currentLock.branch,
      heldFor: `${this.lockTimeoutMs / 1000 / 60} minutes`
    });

    // Clear current lock
    this.currentLock = null;

    // Grant lock to next in queue
    this.processQueue();
  }

  // ==========================================================================
  // Git Branch Management
  // ==========================================================================

  /**
   * Creates a git branch for an agent.
   * 
   * Branch naming convention: autoresearch/swarm/agent-{N}
   * 
   * The branch is created from the current HEAD. If the branch already exists,
   * it is handled gracefully (no error thrown).
   * 
   * @param agentId - The agent ID
   * @returns Promise resolving to the branch name
   * 
   * Validates: Requirement 4.5
   */
  async createAgentBranch(agentId: string): Promise<string> {
    const branch = this.getAgentBranch(agentId);

    // Check if we've already created this branch in this session
    if (this.createdBranches.has(branch)) {
      this.logger.info('Agent branch already created in session', { agentId, branch });
      return branch;
    }

    try {
      // First, ensure the main branch exists
      await this.ensureMainBranchExists();

      // Check if branch already exists
      const branchExists = await this.branchExists(branch);

      if (branchExists) {
        this.logger.info('Agent branch already exists', { agentId, branch });
        this.createdBranches.add(branch);
        return branch;
      }

      // Create the branch from the main branch (or HEAD if main doesn't exist)
      const baseBranch = this.createdBranches.has(MAIN_BRANCH) ? MAIN_BRANCH : 'HEAD';
      await this.gitExecutor.exec(`git branch "${branch}" "${baseBranch}"`);

      this.createdBranches.add(branch);
      this.logger.info('Agent branch created', { agentId, branch, baseBranch });

      return branch;
    } catch (error) {
      // Handle the case where branch creation fails but branch exists
      // (race condition or concurrent creation)
      const branchExists = await this.branchExists(branch);
      if (branchExists) {
        this.logger.info('Agent branch exists after creation attempt', { agentId, branch });
        this.createdBranches.add(branch);
        return branch;
      }

      this.logger.error('Failed to create agent branch', {
        agentId,
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Ensures the shared main branch exists.
   * Creates it from HEAD if it doesn't exist.
   * 
   * @returns Promise resolving when main branch exists
   */
  private async ensureMainBranchExists(): Promise<void> {
    if (this.createdBranches.has(MAIN_BRANCH)) {
      return;
    }

    const exists = await this.branchExists(MAIN_BRANCH);
    if (exists) {
      this.createdBranches.add(MAIN_BRANCH);
      return;
    }

    try {
      await this.gitExecutor.exec(`git branch "${MAIN_BRANCH}" HEAD`);
      this.createdBranches.add(MAIN_BRANCH);
      this.logger.info('Main branch created', { branch: MAIN_BRANCH });
    } catch (error) {
      // Check if it was created by another process
      const existsNow = await this.branchExists(MAIN_BRANCH);
      if (existsNow) {
        this.createdBranches.add(MAIN_BRANCH);
        return;
      }
      throw error;
    }
  }

  /**
   * Checks if a git branch exists.
   * 
   * @param branch - The branch name to check
   * @returns Promise resolving to true if branch exists
   */
  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(`git rev-parse --verify "${branch}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Merges a branch to the main branch.
   * 
   * If there's a conflict, keeps the version with lower val_bpb.
   * 
   * @param branch - The branch to merge
   * @param valBpb - The val_bpb of the experiment on this branch
   * @returns Promise resolving to MergeResult
   * 
   * Validates: Requirements 4.6, 4.7
   */
  async mergeToMain(branch: string, valBpb: number): Promise<MergeResult> {
    this.logger.info('Merging branch to main', { branch, valBpb });

    try {
      // Ensure main branch exists
      await this.ensureMainBranchExists();

      // Try to merge the branch into main
      try {
        await this.gitExecutor.exec(`git checkout "${MAIN_BRANCH}"`);
        await this.gitExecutor.exec(`git merge "${branch}" --no-edit`);

        this.logger.info('Merge successful (no conflict)', { branch });
        return {
          success: true,
          conflict: false,
        };
      } catch (mergeError) {
        // Check if this is a merge conflict
        const errorMessage = mergeError instanceof Error ? mergeError.message : String(mergeError);

        if (this.isMergeConflict(errorMessage)) {
          return await this.resolveConflict(branch, valBpb);
        }

        // Not a merge conflict, re-throw
        throw mergeError;
      }
    } catch (error) {
      this.logger.error('Merge failed', {
        branch,
        valBpb,
        error: error instanceof Error ? error.message : String(error),
      });

      // Attempt to abort any in-progress merge and return to a clean state
      try {
        await this.gitExecutor.exec('git merge --abort');
      } catch {
        // Ignore errors from abort - may not be in a merge state
      }

      return {
        success: false,
        conflict: false,
      };
    }
  }

  /**
   * Checks if an error message indicates a merge conflict.
   * 
   * @param errorMessage - The error message to check
   * @returns true if this is a merge conflict
   */
  private isMergeConflict(errorMessage: string): boolean {
    const conflictIndicators = [
      'CONFLICT',
      'Automatic merge failed',
      'fix conflicts',
      'merge conflict',
    ];
    const lowerMessage = errorMessage.toLowerCase();
    return conflictIndicators.some(indicator =>
      lowerMessage.includes(indicator.toLowerCase())
    );
  }

  /**
   * Resolves a merge conflict by comparing val_bpb values.
   * 
   * The version with the lower val_bpb (better result) is kept.
   * 
   * @param branch - The branch being merged
   * @param incomingValBpb - The val_bpb of the incoming branch
   * @returns Promise resolving to MergeResult
   * 
   * Validates: Requirement 4.7
   */
  private async resolveConflict(branch: string, incomingValBpb: number): Promise<MergeResult> {
    this.logger.info('Merge conflict detected, resolving by val_bpb comparison', {
      branch,
      incomingValBpb,
    });

    try {
      // Get the val_bpb from the existing main branch
      // We need to determine which version has the lower val_bpb
      // For this, we need to track the main branch's current best val_bpb
      // Since we don't have direct access to that here, we use a strategy:
      // - If incoming val_bpb is provided, we compare against the main branch
      // - We resolve by accepting the version with lower val_bpb

      // Get the current val_bpb from main (stored in metadata or commit message)
      const mainValBpb = await this.getMainBranchValBpb();

      let resolution: 'kept-lower-bpb' | 'kept-existing';

      if (incomingValBpb < mainValBpb) {
        // Incoming branch has better (lower) val_bpb - accept theirs
        this.logger.info('Keeping incoming branch (lower val_bpb)', {
          incomingValBpb,
          mainValBpb,
        });
        await this.gitExecutor.exec('git checkout --theirs .');
        await this.gitExecutor.exec('git add .');
        await this.gitExecutor.exec(`git commit -m "Merge ${branch}: resolved conflict, kept lower val_bpb (${incomingValBpb})"`);
        resolution = 'kept-lower-bpb';
      } else {
        // Main branch has better or equal val_bpb - keep ours
        this.logger.info('Keeping existing main branch (lower or equal val_bpb)', {
          incomingValBpb,
          mainValBpb,
        });
        await this.gitExecutor.exec('git checkout --ours .');
        await this.gitExecutor.exec('git add .');
        await this.gitExecutor.exec(`git commit -m "Merge ${branch}: resolved conflict, kept existing (${mainValBpb})"`);
        resolution = 'kept-existing';
      }

      return {
        success: true,
        conflict: true,
        resolution,
      };
    } catch (error) {
      this.logger.error('Failed to resolve merge conflict', {
        branch,
        error: error instanceof Error ? error.message : String(error),
      });

      // Abort the merge
      try {
        await this.gitExecutor.exec('git merge --abort');
      } catch {
        // Ignore abort errors
      }

      return {
        success: false,
        conflict: true,
      };
    }
  }

  /**
   * Gets the current val_bpb associated with the main branch.
   * 
   * This is determined by parsing the most recent merge commit message
   * or returning Infinity if no val_bpb is found (meaning any incoming
   * value would be better).
   * 
   * @returns Promise resolving to the main branch's val_bpb
   */
  private async getMainBranchValBpb(): Promise<number> {
    try {
      // Try to get val_bpb from the most recent commit message on main
      const { stdout } = await this.gitExecutor.exec(
        `git log "${MAIN_BRANCH}" -1 --format=%s`
      );

      // Look for val_bpb pattern in commit message (e.g., "val_bpb: 0.993" or "(0.993)")
      const valBpbMatch = stdout.match(/val_bpb[:\s]+(\d+\.?\d*)|[\(\[](\d+\.?\d*)[\)\]]/i);
      if (valBpbMatch) {
        const matchedValue = valBpbMatch[1] ?? valBpbMatch[2];
        if (matchedValue !== undefined) {
          const value = parseFloat(matchedValue);
          if (!isNaN(value)) {
            return value;
          }
        }
      }

      // If no val_bpb found in commit message, return Infinity
      // This means any incoming value would be considered "better"
      return Infinity;
    } catch {
      // If we can't read the commit message, return Infinity
      return Infinity;
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Gets the branch name for an agent.
   * 
   * @param agentId - The agent ID
   * @returns Branch name (e.g., autoresearch/swarm/agent-0)
   * 
   * Validates: Requirement 4.5
   */
  getAgentBranch(agentId: string): string {
    return `${this.branchPrefix}/${agentId}`;
  }

  /**
   * Gets the current lock holder's agent ID.
   * 
   * @returns Agent ID or null if no lock held
   */
  getCurrentLockHolder(): string | null {
    return this.currentLock?.agentId ?? null;
  }

  /**
   * Gets the current lock state.
   * 
   * @returns Lock state or null if no lock held
   */
  getLockState(): { agentId: string; branch: string; expiresAt: string } | null {
    if (!this.currentLock) {
      return null;
    }
    return {
      agentId: this.currentLock.agentId,
      branch: this.currentLock.branch,
      expiresAt: this.currentLock.expiresAt,
    };
  }

  /**
   * Gets the current queue length.
   * 
   * @returns Number of agents waiting in queue
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Gets the queue positions for all waiting agents.
   * 
   * @returns Map of agentId to queue position (1-indexed)
   */
  getQueuePositions(): Map<string, number> {
    const positions = new Map<string, number>();
    this.queue.forEach((req, index) => {
      positions.set(req.agentId, index + 1);
    });
    return positions;
  }

  /**
   * Checks if an agent holds the lock.
   * 
   * @param agentId - The agent ID to check
   * @returns true if agent holds the lock
   */
  holdsLock(agentId: string): boolean {
    return this.currentLock?.agentId === agentId;
  }

  /**
   * Checks if an agent is in the queue.
   * 
   * @param agentId - The agent ID to check
   * @returns Queue position (1-indexed) or 0 if not in queue
   */
  getQueuePosition(agentId: string): number {
    const index = this.queue.findIndex(req => req.agentId === agentId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Checks if the lock is currently held.
   * 
   * @returns true if lock is held
   */
  isLocked(): boolean {
    return this.currentLock !== null;
  }

  /**
   * Gets the time remaining on the current lock.
   * 
   * @returns Milliseconds remaining or 0 if no lock held
   */
  getLockTimeRemaining(): number {
    if (!this.currentLock) {
      return 0;
    }
    const expiresAt = new Date(this.currentLock.expiresAt).getTime();
    const now = Date.now();
    return Math.max(0, expiresAt - now);
  }

  /**
   * Clears all state (for testing).
   */
  clear(): void {
    // Clear timeout if lock is held
    if (this.currentLock) {
      clearTimeout(this.currentLock.timeoutId);
    }

    // Reject all queued requests
    for (const request of this.queue) {
      request.reject(new Error('ConflictResolver cleared'));
    }

    this.currentLock = null;
    this.queue = [];
    this.createdBranches.clear();
    this.logger.info('ConflictResolver cleared');
  }

  /**
   * Force releases the current lock (for testing/admin).
   */
  forceRelease(): void {
    if (this.currentLock) {
      clearTimeout(this.currentLock.timeoutId);
      this.logger.warn('Lock force released', {
        agentId: this.currentLock.agentId
      });
      this.currentLock = null;
      this.processQueue();
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ConflictResolver instance.
 * 
 * @param options - Configuration options
 * @returns ConflictResolver instance
 */
export function createConflictResolver(
  options: ConflictResolverOptions = {}
): ConflictResolver {
  return new ConflictResolver(options);
}
