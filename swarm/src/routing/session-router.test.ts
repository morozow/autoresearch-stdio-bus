/**
 * Unit tests for SessionRouter class.
 * 
 * Tests session assignment, message routing, and session cleanup.
 * 
 * Validates: Requirements 1.1, 1.2, 1.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SessionRouter,
  SessionInfo,
  RoutedMessage,
  generateSessionId,
  createSessionRouter,
  SessionRouterLogger,
} from './session-router';
import { JsonRpcMessage, createNotification, createRequest } from '../protocol/types';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock logger that captures log calls.
 */
function createMockLogger(): SessionRouterLogger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    info: [],
    warn: [],
    error: [],
  };

  return {
    calls,
    info(message: string, context?: Record<string, unknown>): void {
      calls.info.push([message, context]);
    },
    warn(message: string, context?: Record<string, unknown>): void {
      calls.warn.push([message, context]);
    },
    error(message: string, context?: Record<string, unknown>): void {
      calls.error.push([message, context]);
    },
  };
}

/**
 * Creates a mock message handler that captures delivered messages.
 */
function createMockHandler(): {
  handler: (msg: RoutedMessage) => Promise<void>;
  messages: RoutedMessage[];
} {
  const messages: RoutedMessage[] = [];
  return {
    handler: async (msg: RoutedMessage) => {
      messages.push(msg);
    },
    messages,
  };
}

// ============================================================================
// Session ID Generation Tests
// ============================================================================

describe('generateSessionId', () => {
  it('generates unique session IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateSessionId());
    }
    expect(ids.size).toBe(1000);
  });

  it('generates IDs with correct format', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^sess-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('generates IDs starting with sess- prefix', () => {
    const id = generateSessionId();
    expect(id.startsWith('sess-')).toBe(true);
  });
});

// ============================================================================
// SessionRouter Tests
// ============================================================================

describe('SessionRouter', () => {
  let router: SessionRouter;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    router = new SessionRouter({ logger: mockLogger });
  });

  // ==========================================================================
  // Session Assignment Tests
  // ==========================================================================

  describe('assignSession', () => {
    it('assigns a unique session ID to an agent', () => {
      const sessionId = router.assignSession('agent-0', 0);
      expect(sessionId).toBeTruthy();
      expect(sessionId.startsWith('sess-')).toBe(true);
    });

    it('returns the same session ID for the same agent', () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      const sessionId2 = router.assignSession('agent-0', 0);
      expect(sessionId1).toBe(sessionId2);
    });

    it('assigns different session IDs to different agents', () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      const sessionId2 = router.assignSession('agent-1', 1);
      expect(sessionId1).not.toBe(sessionId2);
    });

    it('stores session metadata correctly', () => {
      const sessionId = router.assignSession('agent-0', 2);
      const session = router.getSession(sessionId);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
      expect(session!.agentId).toBe('agent-0');
      expect(session!.gpuId).toBe(2);
      expect(session!.createdAt).toBeTruthy();
      expect(session!.lastActivity).toBeTruthy();
    });

    it('uses default gpuId of 0 when not specified', () => {
      const sessionId = router.assignSession('agent-0');
      const session = router.getSession(sessionId);
      expect(session!.gpuId).toBe(0);
    });

    it('logs session assignment', () => {
      router.assignSession('agent-0', 0);
      expect(mockLogger.calls.info.length).toBeGreaterThan(0);
      expect(mockLogger.calls.info[0][0]).toContain('Assigned new session');
    });
  });

  // ==========================================================================
  // Session Retrieval Tests
  // ==========================================================================

  describe('getSession', () => {
    it('returns session info for valid session ID', () => {
      const sessionId = router.assignSession('agent-0', 0);
      const session = router.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it('returns null for non-existent session ID', () => {
      const session = router.getSession('non-existent');
      expect(session).toBeNull();
    });
  });

  describe('getSessionByAgent', () => {
    it('returns session info for valid agent ID', () => {
      const sessionId = router.assignSession('agent-0', 0);
      const session = router.getSessionByAgent('agent-0');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it('returns null for non-existent agent ID', () => {
      const session = router.getSessionByAgent('non-existent');
      expect(session).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('returns empty array when no sessions exist', () => {
      const sessions = router.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('returns all active sessions', () => {
      router.assignSession('agent-0', 0);
      router.assignSession('agent-1', 1);
      router.assignSession('agent-2', 2);

      const sessions = router.getAllSessions();
      expect(sessions.length).toBe(3);
    });
  });

  describe('getSessionCount', () => {
    it('returns 0 when no sessions exist', () => {
      expect(router.getSessionCount()).toBe(0);
    });

    it('returns correct count of sessions', () => {
      router.assignSession('agent-0', 0);
      router.assignSession('agent-1', 1);
      expect(router.getSessionCount()).toBe(2);
    });
  });

  describe('hasSession', () => {
    it('returns true for existing session', () => {
      const sessionId = router.assignSession('agent-0', 0);
      expect(router.hasSession(sessionId)).toBe(true);
    });

    it('returns false for non-existent session', () => {
      expect(router.hasSession('non-existent')).toBe(false);
    });
  });

  // ==========================================================================
  // Session Release Tests
  // ==========================================================================

  describe('releaseSession', () => {
    it('removes session from router', () => {
      const sessionId = router.assignSession('agent-0', 0);
      router.releaseSession(sessionId);
      expect(router.getSession(sessionId)).toBeNull();
    });

    it('removes agent-to-session mapping', () => {
      const sessionId = router.assignSession('agent-0', 0);
      router.releaseSession(sessionId);
      expect(router.getSessionByAgent('agent-0')).toBeNull();
    });

    it('logs warning for non-existent session', () => {
      router.releaseSession('non-existent');
      expect(mockLogger.calls.warn.length).toBeGreaterThan(0);
    });

    it('allows reassigning session after release', () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      router.releaseSession(sessionId1);
      const sessionId2 = router.assignSession('agent-0', 0);
      expect(sessionId2).not.toBe(sessionId1);
    });

    it('removes handler on session release', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler } = createMockHandler();
      router.registerHandler(sessionId, handler);

      // Verify handler is registered
      const message = createNotification('test.method');
      await router.route(message, sessionId);

      // Release session
      router.releaseSession(sessionId);

      // Re-assign session with same agent
      const newSessionId = router.assignSession('agent-0', 0);

      // Verify handler was removed (routing should fail without re-registering)
      await expect(router.route(message, newSessionId)).rejects.toThrow(
        'No handler registered'
      );
    });
  });

  // ==========================================================================
  // Message Routing Tests
  // ==========================================================================

  describe('route', () => {
    it('delivers message to registered handler', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler, messages } = createMockHandler();
      router.registerHandler(sessionId, handler);

      const message = createNotification('test.method', { data: 'test' });
      await router.route(message, sessionId);

      expect(messages.length).toBe(1);
      expect(messages[0]!.message).toEqual(message);
      expect(messages[0]!.targetSessionId).toBe(sessionId);
    });

    it('preserves message content unchanged', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler, messages } = createMockHandler();
      router.registerHandler(sessionId, handler);

      const originalMessage = createRequest('req-1', 'test.method', {
        nested: { data: [1, 2, 3] },
      });
      await router.route(originalMessage, sessionId);

      expect(messages[0]!.message).toEqual(originalMessage);
    });

    it('includes source session ID when provided', async () => {
      const targetSessionId = router.assignSession('agent-0', 0);
      const sourceSessionId = router.assignSession('agent-1', 1);
      const { handler, messages } = createMockHandler();
      router.registerHandler(targetSessionId, handler);

      const message = createNotification('test.method');
      await router.route(message, targetSessionId, sourceSessionId);

      expect(messages[0]!.sourceSessionId).toBe(sourceSessionId);
    });

    it('throws error for non-existent target session', async () => {
      const message = createNotification('test.method');
      await expect(router.route(message, 'non-existent')).rejects.toThrow(
        'Target session not found'
      );
    });

    it('throws error when no handler registered', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const message = createNotification('test.method');
      await expect(router.route(message, sessionId)).rejects.toThrow(
        'No handler registered'
      );
    });

    it('updates last activity timestamp', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler } = createMockHandler();
      router.registerHandler(sessionId, handler);

      const sessionBefore = router.getSession(sessionId)!;
      const activityBefore = sessionBefore.lastActivity;

      // Wait a bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      const message = createNotification('test.method');
      await router.route(message, sessionId);

      const sessionAfter = router.getSession(sessionId)!;
      expect(sessionAfter.lastActivity).not.toBe(activityBefore);
    });
  });

  describe('broadcast', () => {
    it('delivers message to all sessions', async () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      const sessionId2 = router.assignSession('agent-1', 1);
      const sessionId3 = router.assignSession('agent-2', 2);

      const { handler: handler1, messages: messages1 } = createMockHandler();
      const { handler: handler2, messages: messages2 } = createMockHandler();
      const { handler: handler3, messages: messages3 } = createMockHandler();

      router.registerHandler(sessionId1, handler1);
      router.registerHandler(sessionId2, handler2);
      router.registerHandler(sessionId3, handler3);

      const message = createNotification('broadcast.test');
      await router.broadcast(message);

      expect(messages1.length).toBe(1);
      expect(messages2.length).toBe(1);
      expect(messages3.length).toBe(1);
    });

    it('excludes source session from broadcast', async () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      const sessionId2 = router.assignSession('agent-1', 1);

      const { handler: handler1, messages: messages1 } = createMockHandler();
      const { handler: handler2, messages: messages2 } = createMockHandler();

      router.registerHandler(sessionId1, handler1);
      router.registerHandler(sessionId2, handler2);

      const message = createNotification('broadcast.test');
      await router.broadcast(message, sessionId1);

      expect(messages1.length).toBe(0);
      expect(messages2.length).toBe(1);
    });

    it('continues delivery even if one handler fails', async () => {
      const sessionId1 = router.assignSession('agent-0', 0);
      const sessionId2 = router.assignSession('agent-1', 1);

      const failingHandler = async () => {
        throw new Error('Handler failed');
      };
      const { handler: successHandler, messages } = createMockHandler();

      router.registerHandler(sessionId1, failingHandler);
      router.registerHandler(sessionId2, successHandler);

      const message = createNotification('broadcast.test');
      await router.broadcast(message);

      expect(messages.length).toBe(1);
    });
  });

  describe('routeToAgent', () => {
    it('routes message to agent by agent ID', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler, messages } = createMockHandler();
      router.registerHandler(sessionId, handler);

      const message = createNotification('test.method');
      await router.routeToAgent(message, 'agent-0');

      expect(messages.length).toBe(1);
    });

    it('throws error for non-existent agent', async () => {
      const message = createNotification('test.method');
      await expect(router.routeToAgent(message, 'non-existent')).rejects.toThrow(
        'Agent not found'
      );
    });
  });

  // ==========================================================================
  // Handler Management Tests
  // ==========================================================================

  describe('registerHandler', () => {
    it('registers handler for session', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler, messages } = createMockHandler();
      router.registerHandler(sessionId, handler);

      const message = createNotification('test.method');
      await router.route(message, sessionId);

      expect(messages.length).toBe(1);
    });

    it('logs warning when registering for non-existent session', () => {
      const { handler } = createMockHandler();
      router.registerHandler('non-existent', handler);
      expect(mockLogger.calls.warn.length).toBeGreaterThan(0);
    });
  });

  describe('unregisterHandler', () => {
    it('removes handler for session', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler } = createMockHandler();
      router.registerHandler(sessionId, handler);
      router.unregisterHandler(sessionId);

      const message = createNotification('test.method');
      await expect(router.route(message, sessionId)).rejects.toThrow(
        'No handler registered'
      );
    });
  });

  // ==========================================================================
  // Cleanup Tests
  // ==========================================================================

  describe('clear', () => {
    it('removes all sessions', () => {
      router.assignSession('agent-0', 0);
      router.assignSession('agent-1', 1);
      router.clear();
      expect(router.getSessionCount()).toBe(0);
    });

    it('removes all handlers', async () => {
      const sessionId = router.assignSession('agent-0', 0);
      const { handler } = createMockHandler();
      router.registerHandler(sessionId, handler);
      router.clear();

      // Re-assign session to test handler was cleared
      const newSessionId = router.assignSession('agent-0', 0);
      const message = createNotification('test.method');
      await expect(router.route(message, newSessionId)).rejects.toThrow(
        'No handler registered'
      );
    });
  });

  describe('releaseInactiveSessions', () => {
    it('releases sessions inactive longer than threshold', async () => {
      // Create a session with a timestamp from 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const customRouter = new SessionRouter({
        logger: mockLogger,
        timestampGenerator: () => twoHoursAgo,
      });

      const sessionId = customRouter.assignSession('agent-0', 0);

      // Release sessions inactive for more than 30 minutes
      const released = customRouter.releaseInactiveSessions(30 * 60 * 1000); // 30 min threshold
      expect(released).toContain(sessionId);
      expect(customRouter.getSession(sessionId)).toBeNull();
    });

    it('keeps sessions within threshold', () => {
      const sessionId = router.assignSession('agent-0', 0);
      const released = router.releaseInactiveSessions(60 * 60 * 1000); // 1 hour threshold
      expect(released).not.toContain(sessionId);
      expect(router.getSession(sessionId)).not.toBeNull();
    });
  });

  // ==========================================================================
  // Factory Function Tests
  // ==========================================================================

  describe('createSessionRouter', () => {
    it('creates a SessionRouter instance', () => {
      const router = createSessionRouter();
      expect(router).toBeInstanceOf(SessionRouter);
    });

    it('accepts custom options', () => {
      const customLogger = createMockLogger();
      const router = createSessionRouter({ logger: customLogger });
      router.assignSession('agent-0', 0);
      expect(customLogger.calls.info.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Custom Generator Tests
  // ==========================================================================

  describe('custom generators', () => {
    it('uses custom session ID generator', () => {
      let counter = 0;
      const customRouter = new SessionRouter({
        sessionIdGenerator: () => `custom-${counter++}`,
      });

      const sessionId1 = customRouter.assignSession('agent-0', 0);
      const sessionId2 = customRouter.assignSession('agent-1', 1);

      expect(sessionId1).toBe('custom-0');
      expect(sessionId2).toBe('custom-1');
    });

    it('uses custom timestamp generator', () => {
      const fixedTime = '2025-01-15T10:00:00.000Z';
      const customRouter = new SessionRouter({
        timestampGenerator: () => fixedTime,
      });

      const sessionId = customRouter.assignSession('agent-0', 0);
      const session = customRouter.getSession(sessionId);

      expect(session!.createdAt).toBe(fixedTime);
      expect(session!.lastActivity).toBe(fixedTime);
    });
  });
});
