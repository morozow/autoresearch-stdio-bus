/**
 * SessionRouter - Routes messages between agents based on session affinity.
 * 
 * Responsibilities:
 * - Assign unique session IDs to connecting agents
 * - Maintain session affinity for message routing
 * - Deliver messages within 100ms under normal load
 * - Handle session cleanup on agent disconnect
 * 
 * Validates: Requirements 1.1, 1.2, 1.4
 */

import { JsonRpcMessage } from '../protocol/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Session metadata tracking agent connection state.
 */
export interface SessionInfo {
  /** Unique session identifier */
  sessionId: string;
  /** Agent identifier associated with this session */
  agentId: string;
  /** GPU ID assigned to this session's worker */
  gpuId: number;
  /** ISO 8601 timestamp when session was created */
  createdAt: string;
  /** ISO 8601 timestamp of last activity */
  lastActivity: string;
}

/**
 * Message with routing metadata for delivery.
 */
export interface RoutedMessage {
  /** The original JSON-RPC message */
  message: JsonRpcMessage;
  /** Target session ID for delivery */
  targetSessionId: string;
  /** Source session ID (if from another session) */
  sourceSessionId?: string;
  /** Timestamp when message was routed */
  routedAt: string;
}

/**
 * Handler function for delivering messages to workers.
 */
export type MessageHandler = (routedMessage: RoutedMessage) => Promise<void>;

/**
 * Logger interface for session router.
 */
export interface SessionRouterLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultSessionRouterLogger: SessionRouterLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[session-router] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[session-router] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[session-router] ${message}`, context ?? '');
  },
};

/**
 * Configuration options for SessionRouter.
 */
export interface SessionRouterOptions {
  /** Logger for router events. Defaults to console logger. */
  logger?: SessionRouterLogger;
  /** Custom session ID generator. Defaults to UUID-based generator. */
  sessionIdGenerator?: () => string;
  /** Custom timestamp generator. Defaults to ISO 8601 current time. */
  timestampGenerator?: () => string;
}

// ============================================================================
// Session ID Generation
// ============================================================================

/**
 * Counter for generating unique session IDs.
 * Combined with timestamp and random component for uniqueness.
 */
let sessionCounter = 0;

/**
 * Generates a unique session ID.
 * 
 * Format: sess-{timestamp}-{counter}-{random}
 * 
 * This ensures uniqueness across:
 * - Multiple coordinator restarts (timestamp component)
 * - High-frequency session creation (counter component)
 * - Distributed systems (random component)
 * 
 * Validates: Requirement 1.2
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const counter = (sessionCounter++).toString(36).padStart(4, '0');
  const random = Math.random().toString(36).substring(2, 8);
  return `sess-${timestamp}-${counter}-${random}`;
}

/**
 * Generates an ISO 8601 timestamp for the current time.
 */
export function generateTimestamp(): string {
  return new Date().toISOString();
}

// ============================================================================
// SessionRouter Class
// ============================================================================

/**
 * SessionRouter manages session assignment and message routing.
 * 
 * Key features:
 * - Unique session ID assignment for each agent connection
 * - Session affinity maintenance for message routing
 * - Session metadata tracking (agentId, gpuId, timestamps)
 * - Session cleanup on disconnect
 * 
 * Validates: Requirements 1.1, 1.2, 1.4
 */
export class SessionRouter {
  /** Map of sessionId to SessionInfo */
  private sessions: Map<string, SessionInfo> = new Map();

  /** Map of agentId to sessionId for reverse lookup */
  private agentToSession: Map<string, string> = new Map();

  /** Message handlers registered for each session */
  private handlers: Map<string, MessageHandler> = new Map();

  /** Logger instance */
  private logger: SessionRouterLogger;

  /** Session ID generator function */
  private generateId: () => string;

  /** Timestamp generator function */
  private generateTs: () => string;

  /**
   * Creates a new SessionRouter instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: SessionRouterOptions = {}) {
    this.logger = options.logger ?? defaultSessionRouterLogger;
    this.generateId = options.sessionIdGenerator ?? generateSessionId;
    this.generateTs = options.timestampGenerator ?? generateTimestamp;
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Assigns a new session to an agent.
   * 
   * Creates a unique session ID and initializes session metadata.
   * If the agent already has a session, returns the existing session ID.
   * 
   * @param agentId - The agent identifier
   * @param gpuId - The GPU ID assigned to this agent's worker
   * @returns The assigned session ID
   * 
   * Validates: Requirement 1.2
   */
  assignSession(agentId: string, gpuId: number = 0): string {
    // Check if agent already has a session
    const existingSessionId = this.agentToSession.get(agentId);
    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session) {
        // Update last activity
        session.lastActivity = this.generateTs();
        this.logger.info('Reusing existing session for agent', {
          agentId,
          sessionId: existingSessionId,
        });
        return existingSessionId;
      }
    }

    // Generate new session ID
    const sessionId = this.generateId();
    const now = this.generateTs();

    // Create session info
    const sessionInfo: SessionInfo = {
      sessionId,
      agentId,
      gpuId,
      createdAt: now,
      lastActivity: now,
    };

    // Store session
    this.sessions.set(sessionId, sessionInfo);
    this.agentToSession.set(agentId, sessionId);

    this.logger.info('Assigned new session', {
      sessionId,
      agentId,
      gpuId,
    });

    return sessionId;
  }

  /**
   * Gets session information by session ID.
   * 
   * @param sessionId - The session identifier
   * @returns SessionInfo if found, null otherwise
   */
  getSession(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Gets session information by agent ID.
   * 
   * @param agentId - The agent identifier
   * @returns SessionInfo if found, null otherwise
   */
  getSessionByAgent(agentId: string): SessionInfo | null {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      return null;
    }
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Releases a session, cleaning up all associated resources.
   * 
   * @param sessionId - The session identifier to release
   */
  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn('Attempted to release non-existent session', { sessionId });
      return;
    }

    // Remove from maps
    this.sessions.delete(sessionId);
    this.agentToSession.delete(session.agentId);
    this.handlers.delete(sessionId);

    this.logger.info('Released session', {
      sessionId,
      agentId: session.agentId,
    });
  }

  /**
   * Gets all active sessions.
   * 
   * @returns Array of all active SessionInfo objects
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Gets the count of active sessions.
   * 
   * @returns Number of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Checks if a session exists.
   * 
   * @param sessionId - The session identifier
   * @returns true if session exists, false otherwise
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Updates the last activity timestamp for a session.
   * 
   * @param sessionId - The session identifier
   */
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = this.generateTs();
    }
  }

  // ==========================================================================
  // Message Routing
  // ==========================================================================

  /**
   * Registers a message handler for a session.
   * 
   * @param sessionId - The session identifier
   * @param handler - The message handler function
   */
  registerHandler(sessionId: string, handler: MessageHandler): void {
    if (!this.sessions.has(sessionId)) {
      this.logger.warn('Registering handler for non-existent session', { sessionId });
    }
    this.handlers.set(sessionId, handler);
  }

  /**
   * Unregisters a message handler for a session.
   * 
   * @param sessionId - The session identifier
   */
  unregisterHandler(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  /**
   * Routes a message to the target session.
   * 
   * The message is delivered to the registered handler for the target session.
   * Message content is preserved unchanged during routing.
   * 
   * @param message - The JSON-RPC message to route
   * @param targetSessionId - The target session ID
   * @param sourceSessionId - Optional source session ID
   * @returns Promise that resolves when message is delivered
   * @throws Error if target session not found or no handler registered
   * 
   * Validates: Requirements 1.1, 1.4
   */
  async route(
    message: JsonRpcMessage,
    targetSessionId: string,
    sourceSessionId?: string
  ): Promise<void> {
    // Validate target session exists
    const targetSession = this.sessions.get(targetSessionId);
    if (!targetSession) {
      this.logger.error('Route failed: target session not found', {
        targetSessionId,
        sourceSessionId,
      });
      throw new Error(`Target session not found: ${targetSessionId}`);
    }

    // Get handler for target session
    const handler = this.handlers.get(targetSessionId);
    if (!handler) {
      this.logger.error('Route failed: no handler registered for session', {
        targetSessionId,
      });
      throw new Error(`No handler registered for session: ${targetSessionId}`);
    }

    // Create routed message
    const routedMessage: RoutedMessage = {
      message,
      targetSessionId,
      sourceSessionId,
      routedAt: this.generateTs(),
    };

    // Update activity timestamps
    this.updateActivity(targetSessionId);
    if (sourceSessionId) {
      this.updateActivity(sourceSessionId);
    }

    // Deliver message
    await handler(routedMessage);

    this.logger.info('Message routed', {
      targetSessionId,
      sourceSessionId,
      method: 'method' in message ? message.method : undefined,
    });
  }

  /**
   * Routes a message to all active sessions (broadcast).
   * 
   * @param message - The JSON-RPC message to broadcast
   * @param sourceSessionId - Optional source session ID (excluded from broadcast)
   * @returns Promise that resolves when all messages are delivered
   * 
   * Validates: Requirement 1.1
   */
  async broadcast(
    message: JsonRpcMessage,
    sourceSessionId?: string
  ): Promise<void> {
    const deliveryPromises: Promise<void>[] = [];

    for (const [sessionId, handler] of this.handlers) {
      // Skip source session if specified
      if (sourceSessionId && sessionId === sourceSessionId) {
        continue;
      }

      const routedMessage: RoutedMessage = {
        message,
        targetSessionId: sessionId,
        sourceSessionId,
        routedAt: this.generateTs(),
      };

      deliveryPromises.push(
        handler(routedMessage).catch(error => {
          this.logger.error('Broadcast delivery failed', {
            targetSessionId: sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      );
    }

    await Promise.all(deliveryPromises);

    this.logger.info('Broadcast completed', {
      recipientCount: deliveryPromises.length,
      sourceSessionId,
      method: 'method' in message ? message.method : undefined,
    });
  }

  /**
   * Routes a message to a specific agent by agent ID.
   * 
   * @param message - The JSON-RPC message to route
   * @param targetAgentId - The target agent ID
   * @param sourceSessionId - Optional source session ID
   * @returns Promise that resolves when message is delivered
   * @throws Error if agent not found
   */
  async routeToAgent(
    message: JsonRpcMessage,
    targetAgentId: string,
    sourceSessionId?: string
  ): Promise<void> {
    const sessionId = this.agentToSession.get(targetAgentId);
    if (!sessionId) {
      this.logger.error('Route to agent failed: agent not found', {
        targetAgentId,
        sourceSessionId,
      });
      throw new Error(`Agent not found: ${targetAgentId}`);
    }

    await this.route(message, sessionId, sourceSessionId);
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Clears all sessions and handlers.
   * Used for testing and shutdown.
   */
  clear(): void {
    this.sessions.clear();
    this.agentToSession.clear();
    this.handlers.clear();
    this.logger.info('All sessions cleared');
  }

  /**
   * Releases sessions that have been inactive for longer than the specified duration.
   * 
   * @param maxInactiveMs - Maximum inactive time in milliseconds
   * @returns Array of released session IDs
   */
  releaseInactiveSessions(maxInactiveMs: number): string[] {
    const now = Date.now();
    const releasedSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = new Date(session.lastActivity).getTime();
      if (now - lastActivity > maxInactiveMs) {
        this.releaseSession(sessionId);
        releasedSessions.push(sessionId);
      }
    }

    if (releasedSessions.length > 0) {
      this.logger.info('Released inactive sessions', {
        count: releasedSessions.length,
        sessionIds: releasedSessions,
      });
    }

    return releasedSessions;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new SessionRouter instance.
 * 
 * @param options - Configuration options
 * @returns SessionRouter instance
 */
export function createSessionRouter(options: SessionRouterOptions = {}): SessionRouter {
  return new SessionRouter(options);
}
