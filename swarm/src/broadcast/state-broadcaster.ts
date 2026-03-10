/**
 * StateBroadcaster - Broadcasts experiment results and state updates to all connected agents.
 * 
 * Responsibilities:
 * - Broadcast Result_Messages to all agents within 1 second
 * - Include originating agent_id in all broadcasts
 * - Send priority notifications for new best val_bpb
 * - Handle backpressure when agents are slow to consume
 * 
 * Validates: Requirements 2.1, 2.6, 5.6
 */

import {
  ResultMessage,
  ExperimentResultParams,
  createResultMessage,
  createNotification,
  JSONRPC_VERSION,
} from '../protocol/types';
import { ExperimentResult, SwarmState } from '../state/experiment-registry';

// ============================================================================
// Types
// ============================================================================

/**
 * Callback type for receiving broadcast messages.
 */
export type BroadcastCallback = (message: ResultMessage) => void;

/**
 * Callback type for receiving priority notifications (new best val_bpb).
 */
export type PriorityCallback = (result: ExperimentResult) => void;

/**
 * Callback type for receiving sync broadcasts.
 */
export type SyncCallback = (state: SwarmState) => void;

/**
 * Subscriber information.
 */
interface Subscriber {
  /** Session ID of the subscriber */
  sessionId: string;
  /** Timestamp when subscribed */
  subscribedAt: string;
  /** Callback for receiving broadcasts */
  onBroadcast?: BroadcastCallback;
  /** Callback for receiving priority notifications */
  onPriority?: PriorityCallback;
  /** Callback for receiving sync broadcasts */
  onSync?: SyncCallback;
  /** Number of pending messages (for backpressure tracking) */
  pendingCount: number;
}

/**
 * Logger interface for state broadcaster.
 */
export interface StateBroadcasterLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultStateBroadcasterLogger: StateBroadcasterLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.error(`[state-broadcaster] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[state-broadcaster] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[state-broadcaster] ${message}`, context ?? '');
  },
};

/**
 * Configuration options for StateBroadcaster.
 */
export interface StateBroadcasterOptions {
  /** Logger for broadcaster events. Defaults to console logger. */
  logger?: StateBroadcasterLogger;
  /** Maximum pending messages per subscriber before backpressure. Defaults to 100. */
  maxPendingMessages?: number;
  /** Custom timestamp generator. Defaults to ISO 8601 current time. */
  timestampGenerator?: () => string;
  /** Broadcast timeout in milliseconds. Defaults to 1000ms (1 second). */
  broadcastTimeoutMs?: number;
}

/**
 * Priority notification message for new best val_bpb.
 */
export interface NewBestNotification {
  jsonrpc: '2.0';
  method: 'swarm.newBest';
  params: {
    valBpb: number;
    agentId: string;
    commit: string;
    timestamp: string;
  };
}

/**
 * Sync broadcast message.
 */
export interface SyncBroadcast {
  jsonrpc: '2.0';
  method: 'swarm.syncBroadcast';
  params: SwarmState;
}

// ============================================================================
// Constants
// ============================================================================

/** Default maximum pending messages per subscriber */
export const DEFAULT_MAX_PENDING_MESSAGES = 100;

/** Default broadcast timeout in milliseconds (1 second) */
export const DEFAULT_BROADCAST_TIMEOUT_MS = 1000;

// ============================================================================
// StateBroadcaster Class
// ============================================================================

/**
 * StateBroadcaster manages broadcasting of experiment results and state updates.
 * 
 * Key features:
 * - Subscribe/unsubscribe for sessions
 * - Broadcast Result_Messages to all subscribers
 * - Priority notifications for new best val_bpb
 * - Backpressure handling for slow consumers
 * 
 * Validates: Requirements 2.1, 2.6, 5.6
 */
export class StateBroadcaster {
  /** Map of session ID to subscriber info */
  private subscribers: Map<string, Subscriber> = new Map();

  /** Global broadcast callback (for all messages) */
  private globalBroadcastCallback?: BroadcastCallback;

  /** Global priority callback (for new best notifications) */
  private globalPriorityCallback?: PriorityCallback;

  /** Global sync callback (for sync broadcasts) */
  private globalSyncCallback?: SyncCallback;

  /** Logger instance */
  private logger: StateBroadcasterLogger;

  /** Maximum pending messages per subscriber */
  private maxPendingMessages: number;

  /** Timestamp generator function */
  private generateTs: () => string;

  /** Broadcast timeout in milliseconds */
  private broadcastTimeoutMs: number;

  /**
   * Creates a new StateBroadcaster instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: StateBroadcasterOptions = {}) {
    this.logger = options.logger ?? defaultStateBroadcasterLogger;
    this.maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES;
    this.generateTs = options.timestampGenerator ?? (() => new Date().toISOString());
    this.broadcastTimeoutMs = options.broadcastTimeoutMs ?? DEFAULT_BROADCAST_TIMEOUT_MS;
  }

  // ==========================================================================
  // Subscription Management
  // ==========================================================================

  /**
   * Subscribes a session to receive broadcasts.
   * 
   * @param sessionId - The session ID to subscribe
   * 
   * Validates: Requirements 2.1, 2.6
   */
  subscribe(sessionId: string): void {
    if (this.subscribers.has(sessionId)) {
      this.logger.info('Session already subscribed', { sessionId });
      return;
    }

    const subscriber: Subscriber = {
      sessionId,
      subscribedAt: this.generateTs(),
      pendingCount: 0,
    };

    this.subscribers.set(sessionId, subscriber);
    this.logger.info('Session subscribed', { sessionId });
  }

  /**
   * Unsubscribes a session from receiving broadcasts.
   * 
   * @param sessionId - The session ID to unsubscribe
   * 
   * Validates: Requirements 2.1, 2.6
   */
  unsubscribe(sessionId: string): void {
    if (!this.subscribers.has(sessionId)) {
      this.logger.warn('Session not subscribed', { sessionId });
      return;
    }

    this.subscribers.delete(sessionId);
    this.logger.info('Session unsubscribed', { sessionId });
  }

  /**
   * Checks if a session is subscribed.
   * 
   * @param sessionId - The session ID to check
   * @returns true if subscribed
   */
  isSubscribed(sessionId: string): boolean {
    return this.subscribers.has(sessionId);
  }

  /**
   * Gets the number of subscribers.
   * 
   * @returns Number of subscribed sessions
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Gets all subscribed session IDs.
   * 
   * @returns Array of session IDs
   */
  getSubscribers(): string[] {
    return Array.from(this.subscribers.keys());
  }

  // ==========================================================================
  // Callback Registration
  // ==========================================================================

  /**
   * Registers a global callback for all broadcast messages.
   * 
   * @param callback - Callback function to receive broadcasts
   */
  onBroadcast(callback: BroadcastCallback): void {
    this.globalBroadcastCallback = callback;
  }

  /**
   * Registers a global callback for priority notifications (new best val_bpb).
   * 
   * @param callback - Callback function to receive priority notifications
   */
  onPriority(callback: PriorityCallback): void {
    this.globalPriorityCallback = callback;
  }

  /**
   * Registers a global callback for sync broadcasts.
   * 
   * @param callback - Callback function to receive sync broadcasts
   */
  onSync(callback: SyncCallback): void {
    this.globalSyncCallback = callback;
  }

  /**
   * Registers callbacks for a specific subscriber.
   * 
   * @param sessionId - The session ID
   * @param callbacks - Callback functions
   */
  setSubscriberCallbacks(
    sessionId: string,
    callbacks: {
      onBroadcast?: BroadcastCallback;
      onPriority?: PriorityCallback;
      onSync?: SyncCallback;
    }
  ): void {
    const subscriber = this.subscribers.get(sessionId);
    if (!subscriber) {
      this.logger.warn('Cannot set callbacks for non-subscribed session', { sessionId });
      return;
    }

    if (callbacks.onBroadcast) {
      subscriber.onBroadcast = callbacks.onBroadcast;
    }
    if (callbacks.onPriority) {
      subscriber.onPriority = callbacks.onPriority;
    }
    if (callbacks.onSync) {
      subscriber.onSync = callbacks.onSync;
    }
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  /**
   * Broadcasts an experiment result to all subscribers.
   * 
   * The broadcast includes the originating agent_id and must complete
   * within 1 second (configurable via broadcastTimeoutMs).
   * 
   * @param result - The experiment result to broadcast
   * @returns Promise that resolves when broadcast is complete
   * 
   * Validates: Requirements 2.1, 2.6
   */
  async broadcastResult(result: ExperimentResult): Promise<void> {
    const startTime = Date.now();

    // Convert ExperimentResult to ExperimentResultParams
    const params: ExperimentResultParams = {
      commit: result.commit,
      valBpb: result.valBpb,
      memoryGb: result.memoryGb,
      status: result.status,
      description: result.description,
      agentId: result.agentId,
      timestamp: result.timestamp,
      branch: result.branch,
    };

    // Create the Result_Message
    const message = createResultMessage(params);

    this.logger.info('Broadcasting result', {
      commit: result.commit,
      agentId: result.agentId,
      subscriberCount: this.subscribers.size,
    });

    // Broadcast to all subscribers
    const broadcastPromises: Promise<void>[] = [];

    for (const [sessionId, subscriber] of this.subscribers) {
      // Check backpressure
      if (subscriber.pendingCount >= this.maxPendingMessages) {
        this.logger.warn('Subscriber backpressure, skipping broadcast', {
          sessionId,
          pendingCount: subscriber.pendingCount,
        });
        continue;
      }

      // Increment pending count
      subscriber.pendingCount++;

      // Create broadcast promise with timeout
      const broadcastPromise = this.broadcastToSubscriber(sessionId, subscriber, message)
        .finally(() => {
          // Decrement pending count
          subscriber.pendingCount = Math.max(0, subscriber.pendingCount - 1);
        });

      broadcastPromises.push(broadcastPromise);
    }

    // Also call global callback if registered
    if (this.globalBroadcastCallback) {
      try {
        this.globalBroadcastCallback(message);
      } catch (error) {
        this.logger.error('Global broadcast callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Wait for all broadcasts with timeout
    await Promise.race([
      Promise.all(broadcastPromises),
      this.timeout(this.broadcastTimeoutMs),
    ]);

    const elapsed = Date.now() - startTime;
    this.logger.info('Broadcast complete', {
      commit: result.commit,
      elapsedMs: elapsed,
      subscriberCount: this.subscribers.size,
    });
  }

  /**
   * Broadcasts a priority notification for a new best val_bpb.
   * 
   * This is sent when an experiment achieves a new best (lowest) val_bpb.
   * 
   * @param result - The experiment result that achieved new best
   * @returns Promise that resolves when broadcast is complete
   * 
   * Validates: Requirements 5.6, 2.6
   */
  async broadcastNewBest(result: ExperimentResult): Promise<void> {
    const startTime = Date.now();

    this.logger.info('Broadcasting new best val_bpb', {
      valBpb: result.valBpb,
      agentId: result.agentId,
      commit: result.commit,
    });

    // Create priority notification
    const notification: NewBestNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: 'swarm.newBest',
      params: {
        valBpb: result.valBpb,
        agentId: result.agentId,
        commit: result.commit,
        timestamp: result.timestamp,
      },
    };

    // Broadcast to all subscribers
    const broadcastPromises: Promise<void>[] = [];

    for (const [sessionId, subscriber] of this.subscribers) {
      // Priority notifications bypass backpressure
      const broadcastPromise = this.broadcastPriorityToSubscriber(sessionId, subscriber, result);
      broadcastPromises.push(broadcastPromise);
    }

    // Also call global priority callback if registered
    if (this.globalPriorityCallback) {
      try {
        this.globalPriorityCallback(result);
      } catch (error) {
        this.logger.error('Global priority callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Wait for all broadcasts with timeout
    await Promise.race([
      Promise.all(broadcastPromises),
      this.timeout(this.broadcastTimeoutMs),
    ]);

    const elapsed = Date.now() - startTime;
    this.logger.info('Priority broadcast complete', {
      valBpb: result.valBpb,
      elapsedMs: elapsed,
      subscriberCount: this.subscribers.size,
    });
  }

  /**
   * Broadcasts a sync message with current swarm state to all subscribers.
   * 
   * @param state - The current swarm state to broadcast
   * @returns Promise that resolves when broadcast is complete
   */
  async broadcastSync(state: SwarmState): Promise<void> {
    const startTime = Date.now();

    this.logger.info('Broadcasting sync', {
      bestValBpb: state.bestValBpb,
      totalExperiments: state.totalExperiments,
      activeAgents: state.activeAgents.length,
    });

    // Create sync broadcast
    const syncBroadcast: SyncBroadcast = {
      jsonrpc: JSONRPC_VERSION,
      method: 'swarm.syncBroadcast',
      params: state,
    };

    // Broadcast to all subscribers
    const broadcastPromises: Promise<void>[] = [];

    for (const [sessionId, subscriber] of this.subscribers) {
      const broadcastPromise = this.broadcastSyncToSubscriber(sessionId, subscriber, state);
      broadcastPromises.push(broadcastPromise);
    }

    // Also call global sync callback if registered
    if (this.globalSyncCallback) {
      try {
        this.globalSyncCallback(state);
      } catch (error) {
        this.logger.error('Global sync callback error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Wait for all broadcasts with timeout
    await Promise.race([
      Promise.all(broadcastPromises),
      this.timeout(this.broadcastTimeoutMs),
    ]);

    const elapsed = Date.now() - startTime;
    this.logger.info('Sync broadcast complete', {
      elapsedMs: elapsed,
      subscriberCount: this.subscribers.size,
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Broadcasts a message to a specific subscriber.
   * 
   * @param sessionId - The session ID
   * @param subscriber - The subscriber info
   * @param message - The message to broadcast
   */
  private async broadcastToSubscriber(
    sessionId: string,
    subscriber: Subscriber,
    message: ResultMessage
  ): Promise<void> {
    try {
      if (subscriber.onBroadcast) {
        subscriber.onBroadcast(message);
      }
    } catch (error) {
      this.logger.error('Subscriber broadcast error', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcasts a priority notification to a specific subscriber.
   * 
   * @param sessionId - The session ID
   * @param subscriber - The subscriber info
   * @param result - The experiment result
   */
  private async broadcastPriorityToSubscriber(
    sessionId: string,
    subscriber: Subscriber,
    result: ExperimentResult
  ): Promise<void> {
    try {
      if (subscriber.onPriority) {
        subscriber.onPriority(result);
      }
    } catch (error) {
      this.logger.error('Subscriber priority broadcast error', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcasts a sync message to a specific subscriber.
   * 
   * @param sessionId - The session ID
   * @param subscriber - The subscriber info
   * @param state - The swarm state
   */
  private async broadcastSyncToSubscriber(
    sessionId: string,
    subscriber: Subscriber,
    state: SwarmState
  ): Promise<void> {
    try {
      if (subscriber.onSync) {
        subscriber.onSync(state);
      }
    } catch (error) {
      this.logger.error('Subscriber sync broadcast error', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Creates a timeout promise.
   * 
   * @param ms - Timeout in milliseconds
   * @returns Promise that resolves after timeout
   */
  private timeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Gets the pending message count for a subscriber.
   * 
   * @param sessionId - The session ID
   * @returns Pending count or 0 if not subscribed
   */
  getPendingCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.pendingCount ?? 0;
  }

  /**
   * Clears all subscribers and state.
   * Used for testing.
   */
  clear(): void {
    this.subscribers.clear();
    this.globalBroadcastCallback = undefined;
    this.globalPriorityCallback = undefined;
    this.globalSyncCallback = undefined;
    this.logger.info('StateBroadcaster cleared');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new StateBroadcaster instance.
 * 
 * @param options - Configuration options
 * @returns StateBroadcaster instance
 */
export function createStateBroadcaster(
  options: StateBroadcasterOptions = {}
): StateBroadcaster {
  return new StateBroadcaster(options);
}
