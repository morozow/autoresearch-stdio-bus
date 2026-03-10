/**
 * Property-based tests for SessionRouter.
 * 
 * Feature: stdio-bus-swarm-autoresearch
 * 
 * Property 1: Session ID Uniqueness
 * For any sequence of agent connections to the Session_Router, all assigned
 * session identifiers shall be unique across the lifetime of the swarm coordinator.
 * **Validates: Requirements 1.2**
 * 
 * Property 2: Message Routing Correctness
 * For any message M sent to Session_Router with target session S, the message
 * shall be delivered to the worker associated with S with content unchanged.
 * **Validates: Requirements 1.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  SessionRouter,
  generateSessionId,
  type RoutedMessage,
} from './session-router';
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  JSONRPC_VERSION,
} from '../protocol/types';

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/** Generates a valid agent ID. */
const arbitraryAgentId = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 1, maxLength: 20 }
  ).filter(s => s.trim().length > 0);

/** Generates a valid GPU ID. */
const arbitraryGpuId = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 15 });

/** Generates a sequence of unique agent IDs. */
const arbitraryUniqueAgentIds = (minLength: number = 1, maxLength: number = 100): fc.Arbitrary<string[]> =>
  fc.array(arbitraryAgentId(), { minLength, maxLength })
    .map(ids => [...new Set(ids)])
    .filter(ids => ids.length >= minLength);

/** Generates a valid JSON-RPC 2.0 request message. */
const arbitraryJsonRpcRequest = (): fc.Arbitrary<JsonRpcRequest> =>
  fc.record({
    jsonrpc: fc.constant(JSONRPC_VERSION),
    id: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 10000 })),
    method: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz._'.split('')), { minLength: 1, maxLength: 30 }),
    params: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue()), { nil: undefined }),
  }).map(msg => msg.params === undefined ? { jsonrpc: msg.jsonrpc, id: msg.id, method: msg.method } as JsonRpcRequest : msg);

/** Generates a valid JSON-RPC 2.0 notification message. */
const arbitraryJsonRpcNotification = (): fc.Arbitrary<JsonRpcNotification> =>
  fc.record({
    jsonrpc: fc.constant(JSONRPC_VERSION),
    method: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz._'.split('')), { minLength: 1, maxLength: 30 }),
    params: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue()), { nil: undefined }),
  }).map(msg => msg.params === undefined ? { jsonrpc: msg.jsonrpc, method: msg.method } as JsonRpcNotification : msg);

/** Generates a valid JSON-RPC 2.0 success response message. */
const arbitraryJsonRpcSuccessResponse = (): fc.Arbitrary<JsonRpcSuccessResponse> =>
  fc.record({
    jsonrpc: fc.constant(JSONRPC_VERSION),
    id: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 10000 })),
    result: fc.jsonValue(),
  });

/** Generates a valid JSON-RPC 2.0 error response message. */
const arbitraryJsonRpcErrorResponse = (): fc.Arbitrary<JsonRpcErrorResponse> =>
  fc.record({
    jsonrpc: fc.constant(JSONRPC_VERSION),
    id: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 10000 }), fc.constant(null)),
    error: fc.record({
      code: fc.integer({ min: -32700, max: -32600 }),
      message: fc.string({ minLength: 1, maxLength: 100 }),
      data: fc.option(fc.jsonValue(), { nil: undefined }),
    }).map(err => err.data === undefined ? { code: err.code, message: err.message } : err),
  });

/** Generates any valid JSON-RPC 2.0 message. */
const arbitraryJsonRpcMessage = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.oneof(arbitraryJsonRpcRequest(), arbitraryJsonRpcNotification(), arbitraryJsonRpcSuccessResponse(), arbitraryJsonRpcErrorResponse());

/** Generates a complex nested params object for testing content preservation. */
const arbitraryComplexParams = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: true }), fc.boolean(), fc.constant(null)),
    { minKeys: 1, maxKeys: 5 }
  );

// ============================================================================
// Silent Logger for Tests
// ============================================================================

const silentLogger = { info: () => { }, warn: () => { }, error: () => { } };

// ============================================================================
// Helper Functions
// ============================================================================

/** Deep equality check for JSON-RPC messages. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Creates a mock handler that captures delivered messages. */
function createCapturingHandler(): { handler: (rm: RoutedMessage) => Promise<void>; deliveredMessages: RoutedMessage[] } {
  const deliveredMessages: RoutedMessage[] = [];
  const handler = async (routedMessage: RoutedMessage): Promise<void> => { deliveredMessages.push(routedMessage); };
  return { handler, deliveredMessages };
}

// ============================================================================
// Property 1: Session ID Uniqueness
// ============================================================================

describe('Property 1: Session ID Uniqueness', () => {
  describe('sequential session assignments produce unique IDs', () => {
    it('any sequence of session assignments should produce unique session IDs', () => {
      fc.assert(
        fc.property(arbitraryUniqueAgentIds(2, 50), (agentIds) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionIds: string[] = [];
          for (const agentId of agentIds) {
            sessionIds.push(router.assignSession(agentId));
          }
          const uniqueSessionIds = new Set(sessionIds);
          return uniqueSessionIds.size === sessionIds.length;
        }),
        { numRuns: 100 }
      );
    });

    it('session IDs should be unique even with many agents', () => {
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 200 }), (count) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionIds: string[] = [];
          for (let i = 0; i < count; i++) {
            sessionIds.push(router.assignSession(`agent-${i}`));
          }
          return new Set(sessionIds).size === count;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('rapid successive assignments produce unique IDs', () => {
    it('session IDs should remain unique even with rapid successive assignments', () => {
      fc.assert(
        fc.property(fc.integer({ min: 50, max: 500 }), (count) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionIds: string[] = [];
          for (let i = 0; i < count; i++) {
            sessionIds.push(router.assignSession(`rapid-agent-${i}`));
          }
          return new Set(sessionIds).size === count;
        }),
        { numRuns: 100 }
      );
    });

    it('generateSessionId function produces unique IDs in rapid succession', () => {
      fc.assert(
        fc.property(fc.integer({ min: 100, max: 1000 }), (count) => {
          const sessionIds: string[] = [];
          for (let i = 0; i < count; i++) {
            sessionIds.push(generateSessionId());
          }
          return new Set(sessionIds).size === count;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('uniqueness across multiple SessionRouter instances', () => {
    it('session IDs should be unique across multiple SessionRouter instances', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 5, max: 50 }), (routerCount, agentsPerRouter) => {
          const allSessionIds: string[] = [];
          for (let r = 0; r < routerCount; r++) {
            const router = new SessionRouter({ logger: silentLogger });
            for (let a = 0; a < agentsPerRouter; a++) {
              allSessionIds.push(router.assignSession(`router-${r}-agent-${a}`));
            }
          }
          return new Set(allSessionIds).size === routerCount * agentsPerRouter;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('re-assignment after release produces new unique IDs', () => {
    it('re-assigning a session after release should produce a new unique ID', () => {
      fc.assert(
        fc.property(arbitraryUniqueAgentIds(2, 20), fc.integer({ min: 1, max: 5 }), (agentIds, releaseCount) => {
          const router = new SessionRouter({ logger: silentLogger });
          const allSessionIds: string[] = [];
          const initialSessions: Map<string, string> = new Map();
          for (const agentId of agentIds) {
            const sessionId = router.assignSession(agentId);
            initialSessions.set(agentId, sessionId);
            allSessionIds.push(sessionId);
          }
          const agentsToReassign = agentIds.slice(0, Math.min(releaseCount, agentIds.length));
          for (const agentId of agentsToReassign) {
            const oldSessionId = initialSessions.get(agentId)!;
            router.releaseSession(oldSessionId);
            const newSessionId = router.assignSession(agentId);
            allSessionIds.push(newSessionId);
            if (newSessionId === oldSessionId) return false;
          }
          return new Set(allSessionIds).size === allSessionIds.length;
        }),
        { numRuns: 100 }
      );
    });

    it('multiple release-reassign cycles produce unique IDs', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 10 }), (cycleCount) => {
          const router = new SessionRouter({ logger: silentLogger });
          const allSessionIds: string[] = [];
          const agentId = 'cycling-agent';
          for (let cycle = 0; cycle < cycleCount; cycle++) {
            const sessionId = router.assignSession(agentId);
            allSessionIds.push(sessionId);
            router.releaseSession(sessionId);
          }
          return new Set(allSessionIds).size === cycleCount;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('additional uniqueness guarantees', () => {
    it('session ID format includes unique components', () => {
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 100 }), (count) => {
          const sessionIds: string[] = [];
          for (let i = 0; i < count; i++) {
            sessionIds.push(generateSessionId());
          }
          for (const sessionId of sessionIds) {
            if (!/^sess-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(sessionId)) return false;
          }
          return new Set(sessionIds).size === count;
        }),
        { numRuns: 100 }
      );
    });

    it('same agent ID returns same session ID when not released', () => {
      fc.assert(
        fc.property(arbitraryAgentId(), fc.integer({ min: 2, max: 10 }), (agentId, callCount) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionIds: string[] = [];
          for (let i = 0; i < callCount; i++) {
            sessionIds.push(router.assignSession(agentId));
          }
          return sessionIds.every(id => id === sessionIds[0]);
        }),
        { numRuns: 100 }
      );
    });
  });
});

// ============================================================================
// Property 2: Message Routing Correctness
// ============================================================================

describe('Property 2: Message Routing Correctness', () => {
  describe('messages are delivered to correct session handler', () => {
    it('message routed to session is delivered to that session\'s handler', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryGpuId(), arbitraryJsonRpcMessage(), async (agentId, gpuId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId, gpuId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deliveredMessages.length === 1 && deliveredMessages[0].targetSessionId === sessionId;
        }),
        { numRuns: 100 }
      );
    });

    it('messages are delivered to correct handler when multiple sessions exist', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 10), arbitraryJsonRpcMessage(), fc.integer({ min: 0, max: 9 }), async (agentIds, message, targetIndex) => {
          const router = new SessionRouter({ logger: silentLogger });
          const handlers: Map<string, { handler: (rm: RoutedMessage) => Promise<void>; deliveredMessages: RoutedMessage[] }> = new Map();
          const sessionIds: string[] = [];
          for (const agentId of agentIds) {
            const sessionId = router.assignSession(agentId);
            sessionIds.push(sessionId);
            const capturingHandler = createCapturingHandler();
            handlers.set(sessionId, capturingHandler);
            router.registerHandler(sessionId, capturingHandler.handler);
          }
          const targetSessionId = sessionIds[targetIndex % sessionIds.length];
          await router.route(message, targetSessionId);
          for (const [sessionId, { deliveredMessages }] of handlers) {
            if (sessionId === targetSessionId) {
              if (deliveredMessages.length !== 1) return false;
            } else {
              if (deliveredMessages.length !== 0) return false;
            }
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('message content is preserved unchanged', () => {
    it('JSON-RPC request message content is preserved during routing', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcRequest(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deepEqual(deliveredMessages[0].message, message);
        }),
        { numRuns: 100 }
      );
    });

    it('JSON-RPC notification message content is preserved during routing', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcNotification(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deepEqual(deliveredMessages[0].message, message);
        }),
        { numRuns: 100 }
      );
    });

    it('JSON-RPC success response message content is preserved during routing', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcSuccessResponse(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deepEqual(deliveredMessages[0].message, message);
        }),
        { numRuns: 100 }
      );
    });

    it('JSON-RPC error response message content is preserved during routing', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcErrorResponse(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deepEqual(deliveredMessages[0].message, message);
        }),
        { numRuns: 100 }
      );
    });

    it('complex nested params are preserved unchanged during routing', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), fc.string({ minLength: 1, maxLength: 20 }), arbitraryComplexParams(), async (agentId, method, params) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          const message: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method, params };
          await router.route(message, sessionId);
          const delivered = deliveredMessages[0].message as JsonRpcNotification;
          return deepEqual(delivered.params, params);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('target session ID matches registered handler session', () => {
    it('routed message contains correct target session ID', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcMessage(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deliveredMessages[0].targetSessionId === sessionId;
        }),
        { numRuns: 100 }
      );
    });

    it('routeToAgent delivers to correct session with correct target ID', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryGpuId(), arbitraryJsonRpcMessage(), async (agentId, gpuId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId, gpuId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.routeToAgent(message, agentId);
          return deliveredMessages[0].targetSessionId === sessionId;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('source session ID is correctly passed through', () => {
    it('source session ID is included when provided', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 2), arbitraryJsonRpcMessage(), async (agentIds, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sourceSessionId = router.assignSession(agentIds[0]);
          const targetSessionId = router.assignSession(agentIds[1]);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(targetSessionId, handler);
          await router.route(message, targetSessionId, sourceSessionId);
          return deliveredMessages[0].sourceSessionId === sourceSessionId;
        }),
        { numRuns: 100 }
      );
    });

    it('source session ID is undefined when not provided', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcMessage(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          await router.route(message, sessionId);
          return deliveredMessages[0].sourceSessionId === undefined;
        }),
        { numRuns: 100 }
      );
    });

    it('source session ID is preserved through routeToAgent', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 2), arbitraryJsonRpcMessage(), async (agentIds, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sourceSessionId = router.assignSession(agentIds[0]);
          const targetSessionId = router.assignSession(agentIds[1]);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(targetSessionId, handler);
          await router.routeToAgent(message, agentIds[1], sourceSessionId);
          return deliveredMessages[0].sourceSessionId === sourceSessionId;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('broadcast delivers to all sessions correctly', () => {
    it('broadcast delivers message to all registered handlers', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 10), arbitraryJsonRpcMessage(), async (agentIds, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const handlers: { sessionId: string; deliveredMessages: RoutedMessage[] }[] = [];
          for (const agentId of agentIds) {
            const sessionId = router.assignSession(agentId);
            const { handler, deliveredMessages } = createCapturingHandler();
            handlers.push({ sessionId, deliveredMessages });
            router.registerHandler(sessionId, handler);
          }
          await router.broadcast(message);
          return handlers.every(h => h.deliveredMessages.length === 1 && deepEqual(h.deliveredMessages[0].message, message));
        }),
        { numRuns: 100 }
      );
    });

    it('broadcast excludes source session when specified', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(3, 10), arbitraryJsonRpcMessage(), fc.integer({ min: 0, max: 9 }), async (agentIds, message, sourceIndex) => {
          const router = new SessionRouter({ logger: silentLogger });
          const handlers: Map<string, RoutedMessage[]> = new Map();
          const sessionIds: string[] = [];
          for (const agentId of agentIds) {
            const sessionId = router.assignSession(agentId);
            sessionIds.push(sessionId);
            const { handler, deliveredMessages } = createCapturingHandler();
            handlers.set(sessionId, deliveredMessages);
            router.registerHandler(sessionId, handler);
          }
          const sourceSessionId = sessionIds[sourceIndex % sessionIds.length];
          await router.broadcast(message, sourceSessionId);
          for (const [sessionId, deliveredMessages] of handlers) {
            if (sessionId === sourceSessionId) {
              if (deliveredMessages.length !== 0) return false;
            } else {
              if (deliveredMessages.length !== 1) return false;
              if (!deepEqual(deliveredMessages[0].message, message)) return false;
            }
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('broadcast preserves message content for all recipients', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueAgentIds(2, 5), arbitraryComplexParams(), async (agentIds, params) => {
          const router = new SessionRouter({ logger: silentLogger });
          const handlers: RoutedMessage[][] = [];
          const message: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method: 'test.broadcast', params };
          for (const agentId of agentIds) {
            const sessionId = router.assignSession(agentId);
            const { handler, deliveredMessages } = createCapturingHandler();
            handlers.push(deliveredMessages);
            router.registerHandler(sessionId, handler);
          }
          await router.broadcast(message);
          return handlers.every(msgs => msgs.length === 1 && deepEqual((msgs[0].message as JsonRpcNotification).params, params));
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('routing errors are handled correctly', () => {
    it('routing to non-existent session throws error', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryJsonRpcMessage(), fc.string({ minLength: 10, maxLength: 30 }), async (message, fakeSessionId) => {
          const router = new SessionRouter({ logger: silentLogger });
          try {
            await router.route(message, fakeSessionId);
            return false;
          } catch (error) {
            return error instanceof Error && (error as Error).message.includes('Target session not found');
          }
        }),
        { numRuns: 100 }
      );
    });

    it('routing to session without handler throws error', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), arbitraryJsonRpcMessage(), async (agentId, message) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          try {
            await router.route(message, sessionId);
            return false;
          } catch (error) {
            return error instanceof Error && (error as Error).message.includes('No handler registered');
          }
        }),
        { numRuns: 100 }
      );
    });

    it('routeToAgent to non-existent agent throws error', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryJsonRpcMessage(), fc.string({ minLength: 5, maxLength: 20 }), async (message, fakeAgentId) => {
          const router = new SessionRouter({ logger: silentLogger });
          try {
            await router.routeToAgent(message, fakeAgentId);
            return false;
          } catch (error) {
            return error instanceof Error && (error as Error).message.includes('Agent not found');
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('multiple sequential messages are delivered correctly', () => {
    it('all messages in a sequence are delivered with content preserved', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAgentId(), fc.array(arbitraryJsonRpcMessage(), { minLength: 1, maxLength: 20 }), async (agentId, messages) => {
          const router = new SessionRouter({ logger: silentLogger });
          const sessionId = router.assignSession(agentId);
          const { handler, deliveredMessages } = createCapturingHandler();
          router.registerHandler(sessionId, handler);
          for (const message of messages) {
            await router.route(message, sessionId);
          }
          if (deliveredMessages.length !== messages.length) return false;
          return messages.every((msg, i) => deepEqual(deliveredMessages[i].message, msg));
        }),
        { numRuns: 100 }
      );
    });
  });
});
