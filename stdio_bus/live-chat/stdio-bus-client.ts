// ============================================================================
// stdio Bus ACP Client — Shared helper for real stdio_bus sandbox examples
// ============================================================================
// Speaks the real ACP protocol over NDJSON-framed TCP via stdio_bus kernel.
//
// Key protocol differences from the mock server:
//   - Every JSON-RPC message includes `agentId` at the top level
//   - session/new params: { cwd, mcpServers }
//   - session/prompt params: { sessionId, prompt: [{ type, role?, text }] }
//   - Agent responses arrive as session/update notifications (no `id` field)
//   - session/prompt response only contains { stopReason }
//   - session/cancel is a notification (no `id`), not a request

import { NDJSONClient } from './ndjson-client';
import { createRequestTracker, type RequestTracker } from './request-tracker';
import type { JsonRpcResponse } from './types';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// ACP session/update notification types
// ---------------------------------------------------------------------------

export interface SessionUpdateNotification {
  jsonrpc: '2.0';
  method: 'session/update';
  params: {
    sessionId: string;
    update: SessionUpdate;
  };
}

export type SessionUpdate =
  | AgentMessageChunk
  | PlanUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate;

export interface AgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: { type: string; text: string };
}

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: Array<{ content: string; priority: string; status: string }>;
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status: string;
  content?: Array<{ type: string; content: { type: string; text: string } }>;
}

// ---------------------------------------------------------------------------
// Session/new result
// ---------------------------------------------------------------------------

export interface SessionNewResult {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: unknown;
}

// ---------------------------------------------------------------------------
// Prompt result (the final JSON-RPC response)
// ---------------------------------------------------------------------------

export interface PromptResult {
  stopReason: string;
  /** All session/update notifications received during this prompt turn */
  updates: SessionUpdate[];
  /** Concatenated text from agent_message_chunk updates */
  text: string;
}

// ---------------------------------------------------------------------------
// StdioBusACPClient
// ---------------------------------------------------------------------------

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name: string; title?: string; version?: string };
  authMethods?: unknown[];
}

export interface ConfigOption {
  id: string;
  value: string;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface SessionNewOptions {
  configOptions?: ConfigOption[];
  mcpServers?: MCPServerConfig[];
}

export interface StdioBusACPClient extends EventEmitter {
  initialize(): Promise<InitializeResult>;
  sessionNew(options?: SessionNewOptions): Promise<SessionNewResult>;
  sessionPrompt(sessionId: string, text: string, role?: string): Promise<PromptResult>;
  sessionConfigure(sessionId: string, options: ConfigOption[]): Promise<void>;
  sessionCancel(sessionId: string): void;
  readonly requestTracker: RequestTracker;
  readonly clientSessionId: string;
}

export interface StdioBusACPClientOptions {
  agentId: string;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title?: string; version?: string };
  /** Pass an existing clientSessionId to resume a session on a new connection */
  clientSessionId?: string;
}

export function createStdioBusACPClient(
  ndjsonClient: NDJSONClient,
  opts: StdioBusACPClientOptions,
): StdioBusACPClient {
  const { agentId, requestTimeoutMs = 120_000, clientInfo } = opts;
  const emitter = new EventEmitter();
  const requestTracker = createRequestTracker({ defaultTimeoutMs: requestTimeoutMs });

  let nextId = 1;

  // Client-level sessionId used by the bus to route notifications back to us.
  // Can be passed in to resume a previous session on a new TCP connection.
  const clientSessionId = opts.clientSessionId ?? `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Collect updates per session for the current prompt turn
  const pendingUpdates = new Map<string, SessionUpdate[]>();

  ndjsonClient.on('message', (msg: unknown) => {
    const obj = msg as Record<string, unknown>;
    if (!obj || obj['jsonrpc'] !== '2.0') return;

    // JSON-RPC response (has `id`)
    if ('id' in obj && ('result' in obj || 'error' in obj)) {
      requestTracker.resolve(obj as unknown as JsonRpcResponse);
      return;
    }

    // JSON-RPC notification (no `id`, has `method`)
    if ('method' in obj && !('id' in obj)) {
      const method = obj['method'] as string;
      const params = obj['params'] as Record<string, unknown> | undefined;

      if (method === 'session/update' && params) {
        const sessionId = params['sessionId'] as string;
        const update = params['update'] as SessionUpdate;

        // Store for the pending prompt
        const updates = pendingUpdates.get(sessionId);
        if (updates) updates.push(update);

        // Emit for real-time streaming
        emitter.emit('update', sessionId, update);
      }

      emitter.emit('notification', method, params);
    }
  });

  function send(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = nextId++;
    // Include top-level sessionId so the bus can map agent sessions to this client
    const request = { jsonrpc: '2.0' as const, id, method, agentId, sessionId: clientSessionId, params };
    const promise = requestTracker.register(id);
    ndjsonClient.send(request);
    return promise;
  }

  async function initialize(): Promise<InitializeResult> {
    const resp = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: clientInfo ?? { name: 'mcp-acp-bridge', version: '1.0.0' },
      agentId, // Required for acp-registry to route to correct agent
    });
    if (resp.error) throw new Error(`initialize: [${resp.error.code}] ${resp.error.message}`);
    return resp.result as InitializeResult;
  }

  async function sessionNew(options?: SessionNewOptions): Promise<SessionNewResult> {
    const params: Record<string, unknown> = { cwd: process.cwd(), mcpServers: [] };
    if (options?.configOptions && options.configOptions.length > 0) {
      params['configOptions'] = options.configOptions;
    }
    if (options?.mcpServers && options.mcpServers.length > 0) {
      params['mcpServers'] = options.mcpServers;
    }
    const resp = await send('session/new', params);
    if (resp.error) throw new Error(`session/new: [${resp.error.code}] ${resp.error.message}`);
    return resp.result as SessionNewResult;
  }

  async function sessionPrompt(sessionId: string, text: string, role = 'user'): Promise<PromptResult> {
    // Start collecting updates for this session
    pendingUpdates.set(sessionId, []);

    const resp = await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', role, text }],
    });

    // The JSON-RPC response (with stopReason) may arrive before all
    // session/update notifications have been delivered over the TCP stream.
    // Drain the event loop so any buffered notifications get processed.
    await new Promise(resolve => setTimeout(resolve, 200));

    // Gather collected updates
    const updates = pendingUpdates.get(sessionId) ?? [];
    pendingUpdates.delete(sessionId);

    if (resp.error) throw new Error(`session/prompt: [${resp.error.code}] ${resp.error.message}`);

    const result = resp.result as { stopReason: string };

    // Extract text from agent_message_chunk updates
    const textParts: string[] = [];
    for (const u of updates) {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        textParts.push(u.content.text);
      }
      if (u.sessionUpdate === 'tool_call_update' && u.content) {
        for (const c of u.content) {
          if (c.content?.text) textParts.push(c.content.text);
        }
      }
    }

    return {
      stopReason: result.stopReason,
      updates,
      text: textParts.join(''),
    };
  }

  async function sessionConfigure(sessionId: string, options: ConfigOption[]): Promise<void> {
    const resp = await send('session/configure', { sessionId, options });
    if (resp.error) throw new Error(`session/configure: [${resp.error.code}] ${resp.error.message}`);
  }

  function sessionCancel(sessionId: string): void {
    // session/cancel is a notification (no id, no response expected)
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'session/cancel',
      params: { sessionId },
      agentId,
      sessionId: clientSessionId,
    };
    ndjsonClient.send(notification);
  }

  return Object.assign(emitter, {
    initialize,
    sessionNew,
    sessionPrompt,
    sessionConfigure,
    sessionCancel,
    requestTracker,
    clientSessionId,
  }) as StdioBusACPClient;
}
