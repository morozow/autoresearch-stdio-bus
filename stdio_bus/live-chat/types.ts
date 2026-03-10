// ============================================================================
// MCP-ACP Bridge Server — Shared Data Models and Type Definitions
// ============================================================================

// ----------------------------------------------------------------------------
// JSON-RPC 2.0 Message Types
// ----------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ----------------------------------------------------------------------------
// ACP Method Payloads
// ----------------------------------------------------------------------------

/** session/new request params (empty) */
export interface SessionNewParams { }

/** session/new response result */
export interface SessionNewResult {
  sessionId: string;
}

/** session/prompt request params */
export interface SessionPromptParams {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
}

/** session/prompt response result */
export interface SessionPromptResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/** session/cancel request params */
export interface SessionCancelParams {
  sessionId: string;
}

// ----------------------------------------------------------------------------
// Internal State Models
// ----------------------------------------------------------------------------

/** Request_Tracker pending entry */
export interface PendingEntry {
  id: JsonRpcId;
  registeredAt: number;
  timeoutMs: number;
  timeoutHandle: NodeJS.Timeout;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
}

/** Session_Manager entry */
export interface SessionEntry {
  mcpSessionId: string;
  busSessionId: string;
  createdAt: number;
  lastAccessedAt: number;
  idleTimeoutHandle: NodeJS.Timeout;
}

/** Task_Controller state */
export interface TaskState {
  taskId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'aborted_iteration_limit' | 'aborted_timeout' | 'aborted_error';
  iteration: number;
  startedAt: number;
  subResults: SubTaskResult[];
  abortController: AbortController;
}

/** NDJSON_Client connection state */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

// ----------------------------------------------------------------------------
// MCP Tool Input Schemas
// ----------------------------------------------------------------------------

/** send_acp_prompt tool input */
export interface SendAcpPromptInput {
  prompt: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  multiStep?: boolean;
}

/** close_acp_session tool input */
export interface CloseAcpSessionInput {
  sessionId: string;
}

/** get_acp_session_status tool input */
export interface GetAcpSessionStatusInput {
  sessionId: string;
}

// ----------------------------------------------------------------------------
// Task Controller Types
// ----------------------------------------------------------------------------

export interface TaskDefinition {
  taskId: string;
  prompt: string;
  context?: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'aborted_iteration_limit' | 'aborted_timeout' | 'aborted_error';
  iterations: number;
  durationMs: number;
  subResults: SubTaskResult[];
  finalResult?: string;
}

export interface SubTaskResult {
  iteration: number;
  prompt: string;
  response: string;
  decision: 'continue' | 'complete' | 'retry' | 'abort';
}

// ----------------------------------------------------------------------------
// Health Monitoring
// ----------------------------------------------------------------------------

export interface HealthStatus {
  connected: boolean;
  activeSessions: number;
  pendingRequests: number;
  uptimeMs: number;
  lastError?: string;
}

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export interface BridgeConfig {
  bus: {
    address: string;
    connectionType: 'tcp' | 'unix';
  };
  timeouts: {
    requestMs: number;
    sessionIdleMs: number;
    shutdownMs: number;
    taskMaxDurationMs: number;
  };
  limits: {
    maxSessions: number;
    maxPendingRequests: number;
    maxTaskIterations: number;
    maxReconnectAttempts: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  mcp: {
    transport: 'stdio' | 'sse';
    name: string;
    version: string;
  };
}
