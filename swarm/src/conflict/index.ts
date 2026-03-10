/**
 * Conflict resolution module for swarm coordination.
 * 
 * Exports:
 * - ConflictResolver: Manages distributed locking and git operations
 * - Types: LockResult, MergeResult, ConflictResolverOptions
 * - Factory: createConflictResolver
 */

export {
  ConflictResolver,
  createConflictResolver,
  type LockResult,
  type MergeResult,
  type ConflictResolverLogger,
  type ConflictResolverOptions,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_BRANCH_PREFIX,
  MAIN_BRANCH,
  defaultConflictResolverLogger,
} from './conflict-resolver';
