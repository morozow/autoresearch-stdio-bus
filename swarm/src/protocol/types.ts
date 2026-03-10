/**
 * JSON-RPC 2.0 message types for stdio_bus swarm communication.
 * 
 * All messages follow the JSON-RPC 2.0 specification with NDJSON framing.
 * 
 * Validates: Requirements 8.1, 8.2, 8.3
 */

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

/**
 * JSON-RPC 2.0 version constant.
 */
export const JSONRPC_VERSION = '2.0' as const;

/**
 * Valid JSON-RPC 2.0 request/response ID types.
 */
export type JsonRpcId = string | number;

/**
 * Base JSON-RPC 2.0 message structure.
 */
export interface JsonRpcBase {
  jsonrpc: typeof JSONRPC_VERSION;
}

/**
 * JSON-RPC 2.0 Request message.
 * A request expects a response (has an id).
 */
export interface JsonRpcRequest<P = unknown> extends JsonRpcBase {
  id: JsonRpcId;
  method: string;
  params?: P;
}

/**
 * JSON-RPC 2.0 Notification message.
 * A notification does not expect a response (no id).
 */
export interface JsonRpcNotification<P = unknown> extends JsonRpcBase {
  method: string;
  params?: P;
}

/**
 * JSON-RPC 2.0 Success Response message.
 */
export interface JsonRpcSuccessResponse<R = unknown> extends JsonRpcBase {
  id: JsonRpcId;
  result: R;
}

/**
 * JSON-RPC 2.0 Error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Error Response message.
 */
export interface JsonRpcErrorResponse extends JsonRpcBase {
  id: JsonRpcId | null;
  error: JsonRpcError;
}

/**
 * Union type for all JSON-RPC 2.0 message types.
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

/**
 * Union type for JSON-RPC 2.0 response messages.
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ============================================================================
// Standard JSON-RPC 2.0 Error Codes
// ============================================================================

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// Experiment Result Types
// ============================================================================

/**
 * Status of an experiment result.
 */
export type ExperimentStatus = 'keep' | 'discard' | 'crash';

/**
 * Parameters for experiment.result notification.
 * Validates: Requirement 8.2
 */
export interface ExperimentResultParams {
  commit: string;
  valBpb: number;
  memoryGb: number;
  status: ExperimentStatus;
  description: string;
  agentId: string;
  timestamp: string;
  branch: string;
}

/**
 * Result_Message notification for broadcasting experiment results.
 * Validates: Requirement 8.2
 */
export interface ResultMessage extends JsonRpcNotification<ExperimentResultParams> {
  method: 'experiment.result';
  params: ExperimentResultParams;
}

// ============================================================================
// Sync Message Types
// ============================================================================

/**
 * Parameters for swarm.sync request (empty for request).
 */
export type SyncRequestParams = Record<string, never>;

/**
 * Sync_Message request to get current swarm state.
 * Validates: Requirement 8.3
 */
export interface SyncRequest extends JsonRpcRequest<SyncRequestParams> {
  method: 'swarm.sync';
}

/**
 * Result data for swarm.sync response.
 * Validates: Requirement 8.3
 */
export interface SyncResult {
  bestValBpb: number;
  totalExperiments: number;
  activeAgents: string[];
  recentResults: ExperimentResultParams[];
}

/**
 * Sync_Message response with current swarm state.
 * Validates: Requirement 8.3
 */
export interface SyncResponse extends JsonRpcSuccessResponse<SyncResult> {
  result: SyncResult;
}

// ============================================================================
// Lock Message Types
// ============================================================================

/**
 * Parameters for lock.acquire request.
 */
export interface LockAcquireParams {
  agentId: string;
}

/**
 * Lock acquire request message.
 */
export interface LockAcquireRequest extends JsonRpcRequest<LockAcquireParams> {
  method: 'lock.acquire';
  params: LockAcquireParams;
}

/**
 * Result data for lock.acquire response.
 */
export interface LockAcquireResult {
  granted: boolean;
  branch: string;
  expiresAt: string;
  queuePosition?: number;
}

/**
 * Lock acquire response message.
 */
export interface LockAcquireResponse extends JsonRpcSuccessResponse<LockAcquireResult> {
  result: LockAcquireResult;
}

// ============================================================================
// Status Message Types
// ============================================================================

/**
 * Parameters for swarm.status request (empty).
 */
export type StatusRequestParams = Record<string, never>;

/**
 * Status request message.
 */
export interface StatusRequest extends JsonRpcRequest<StatusRequestParams> {
  method: 'swarm.status';
}

/**
 * GPU utilization status.
 */
export interface GpuUtilization {
  available: boolean;
  currentExperiment: string | null;
}

/**
 * Result data for swarm.status response.
 */
export interface StatusResult {
  activeAgents: number;
  totalExperiments: number;
  bestValBpb: number;
  experimentsPerHour: number;
  uptime: number;
  gpuUtilization: Record<number, GpuUtilization>;
}

/**
 * Status response message.
 */
export interface StatusResponse extends JsonRpcSuccessResponse<StatusResult> {
  result: StatusResult;
}

// ============================================================================
// Pause/Resume Message Types
// ============================================================================

/**
 * Parameters for swarm.pause request (empty).
 */
export type PauseRequestParams = Record<string, never>;

/**
 * Pause request message.
 */
export interface PauseRequest extends JsonRpcRequest<PauseRequestParams> {
  method: 'swarm.pause';
}

/**
 * Pause response result.
 */
export interface PauseResult {
  paused: boolean;
}

/**
 * Pause response message.
 */
export interface PauseResponse extends JsonRpcSuccessResponse<PauseResult> {
  result: PauseResult;
}

/**
 * Parameters for swarm.resume request (empty).
 */
export type ResumeRequestParams = Record<string, never>;

/**
 * Resume request message.
 */
export interface ResumeRequest extends JsonRpcRequest<ResumeRequestParams> {
  method: 'swarm.resume';
}

/**
 * Resume response result.
 */
export interface ResumeResult {
  resumed: boolean;
}

/**
 * Resume response message.
 */
export interface ResumeResponse extends JsonRpcSuccessResponse<ResumeResult> {
  result: ResumeResult;
}

// ============================================================================
// History Message Types
// ============================================================================

/**
 * Parameters for swarm.history request.
 */
export interface HistoryRequestParams {
  limit?: number;
}

/**
 * History request message.
 */
export interface HistoryRequest extends JsonRpcRequest<HistoryRequestParams> {
  method: 'swarm.history';
}

/**
 * Result data for swarm.history response.
 */
export interface HistoryResult {
  experiments: ExperimentResultParams[];
  totalCount: number;
}

/**
 * History response message.
 */
export interface HistoryResponse extends JsonRpcSuccessResponse<HistoryResult> {
  result: HistoryResult;
}

// ============================================================================
// Method Names
// ============================================================================

/**
 * All supported JSON-RPC method names.
 */
export const METHOD_NAMES = {
  EXPERIMENT_RESULT: 'experiment.result',
  SWARM_SYNC: 'swarm.sync',
  SWARM_STATUS: 'swarm.status',
  SWARM_PAUSE: 'swarm.pause',
  SWARM_RESUME: 'swarm.resume',
  SWARM_HISTORY: 'swarm.history',
  LOCK_ACQUIRE: 'lock.acquire',
} as const;

export type MethodName = typeof METHOD_NAMES[keyof typeof METHOD_NAMES];

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Validation error with field path and message.
 */
export interface MessageValidationError {
  path: string;
  message: string;
}

/**
 * Result of message validation.
 */
export interface MessageValidationResult {
  valid: boolean;
  errors: MessageValidationError[];
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Checks if a value is a valid JSON-RPC 2.0 ID (string or number).
 */
export function isValidJsonRpcId(id: unknown): id is JsonRpcId {
  return typeof id === 'string' || typeof id === 'number';
}

/**
 * Validates that a message has the required JSON-RPC 2.0 version field.
 */
function validateJsonRpcVersion(message: unknown, errors: MessageValidationError[]): boolean {
  if (typeof message !== 'object' || message === null) {
    errors.push({ path: '', message: 'Message must be an object' });
    return false;
  }

  const msg = message as Record<string, unknown>;
  if (msg.jsonrpc !== JSONRPC_VERSION) {
    errors.push({ path: 'jsonrpc', message: `jsonrpc must be "${JSONRPC_VERSION}"` });
    return false;
  }

  return true;
}

/**
 * Validates a JSON-RPC 2.0 request message.
 * A request has: jsonrpc, id, method, and optional params.
 */
export function validateJsonRpcRequest(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (!validateJsonRpcVersion(message, errors)) {
    return { valid: false, errors };
  }

  const msg = message as Record<string, unknown>;

  // id is required for requests
  if (!isValidJsonRpcId(msg.id)) {
    errors.push({ path: 'id', message: 'id must be a string or number' });
  }

  // method is required
  if (typeof msg.method !== 'string' || msg.method.length === 0) {
    errors.push({ path: 'method', message: 'method must be a non-empty string' });
  }

  // params is optional but must be object or array if present
  if (msg.params !== undefined && typeof msg.params !== 'object') {
    errors.push({ path: 'params', message: 'params must be an object or array' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a JSON-RPC 2.0 notification message.
 * A notification has: jsonrpc, method, and optional params (no id).
 */
export function validateJsonRpcNotification(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (!validateJsonRpcVersion(message, errors)) {
    return { valid: false, errors };
  }

  const msg = message as Record<string, unknown>;

  // id must NOT be present for notifications
  if ('id' in msg) {
    errors.push({ path: 'id', message: 'Notifications must not have an id field' });
  }

  // method is required
  if (typeof msg.method !== 'string' || msg.method.length === 0) {
    errors.push({ path: 'method', message: 'method must be a non-empty string' });
  }

  // params is optional but must be object or array if present
  if (msg.params !== undefined && typeof msg.params !== 'object') {
    errors.push({ path: 'params', message: 'params must be an object or array' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a JSON-RPC 2.0 success response message.
 * A success response has: jsonrpc, id, and result.
 */
export function validateJsonRpcSuccessResponse(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (!validateJsonRpcVersion(message, errors)) {
    return { valid: false, errors };
  }

  const msg = message as Record<string, unknown>;

  // id is required for responses
  if (!isValidJsonRpcId(msg.id)) {
    errors.push({ path: 'id', message: 'id must be a string or number' });
  }

  // result is required for success responses
  if (!('result' in msg)) {
    errors.push({ path: 'result', message: 'result is required for success responses' });
  }

  // error must NOT be present
  if ('error' in msg) {
    errors.push({ path: 'error', message: 'Success responses must not have an error field' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a JSON-RPC 2.0 error response message.
 * An error response has: jsonrpc, id (or null), and error object.
 */
export function validateJsonRpcErrorResponse(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (!validateJsonRpcVersion(message, errors)) {
    return { valid: false, errors };
  }

  const msg = message as Record<string, unknown>;

  // id is required (can be null for parse errors)
  if (msg.id !== null && !isValidJsonRpcId(msg.id)) {
    errors.push({ path: 'id', message: 'id must be a string, number, or null' });
  }

  // error is required
  if (!('error' in msg) || typeof msg.error !== 'object' || msg.error === null) {
    errors.push({ path: 'error', message: 'error object is required' });
  } else {
    const err = msg.error as Record<string, unknown>;
    if (typeof err.code !== 'number') {
      errors.push({ path: 'error.code', message: 'error.code must be a number' });
    }
    if (typeof err.message !== 'string') {
      errors.push({ path: 'error.message', message: 'error.message must be a string' });
    }
  }

  // result must NOT be present
  if ('result' in msg) {
    errors.push({ path: 'result', message: 'Error responses must not have a result field' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates any JSON-RPC 2.0 message (request, notification, or response).
 * Determines the message type and validates accordingly.
 */
export function validateJsonRpcMessage(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (!validateJsonRpcVersion(message, errors)) {
    return { valid: false, errors };
  }

  const msg = message as Record<string, unknown>;

  // Determine message type based on fields present
  const hasMethod = 'method' in msg;
  const hasId = 'id' in msg;
  const hasResult = 'result' in msg;
  const hasError = 'error' in msg;

  if (hasMethod && hasId) {
    // Request
    return validateJsonRpcRequest(message);
  } else if (hasMethod && !hasId) {
    // Notification
    return validateJsonRpcNotification(message);
  } else if (hasResult && hasId) {
    // Success response
    return validateJsonRpcSuccessResponse(message);
  } else if (hasError && hasId) {
    // Error response
    return validateJsonRpcErrorResponse(message);
  } else if (hasError && !hasId) {
    // Error response with null id (parse error case)
    return validateJsonRpcErrorResponse({ ...msg, id: null });
  } else {
    errors.push({
      path: '',
      message: 'Invalid JSON-RPC 2.0 message: must have method (request/notification) or result/error (response)',
    });
    return { valid: false, errors };
  }
}

// ============================================================================
// Specific Message Validators
// ============================================================================

/**
 * Validates ExperimentResultParams structure.
 * Validates: Requirement 8.2
 */
export function validateExperimentResultParams(params: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (typeof params !== 'object' || params === null) {
    errors.push({ path: 'params', message: 'params must be an object' });
    return { valid: false, errors };
  }

  const p = params as Record<string, unknown>;

  // commit: 7-char git hash
  if (typeof p.commit !== 'string' || p.commit.length === 0) {
    errors.push({ path: 'params.commit', message: 'commit must be a non-empty string' });
  }

  // valBpb: number
  if (typeof p.valBpb !== 'number' || isNaN(p.valBpb)) {
    errors.push({ path: 'params.valBpb', message: 'valBpb must be a number' });
  }

  // memoryGb: number
  if (typeof p.memoryGb !== 'number' || isNaN(p.memoryGb)) {
    errors.push({ path: 'params.memoryGb', message: 'memoryGb must be a number' });
  }

  // status: 'keep' | 'discard' | 'crash'
  if (!['keep', 'discard', 'crash'].includes(p.status as string)) {
    errors.push({ path: 'params.status', message: 'status must be "keep", "discard", or "crash"' });
  }

  // description: string
  if (typeof p.description !== 'string') {
    errors.push({ path: 'params.description', message: 'description must be a string' });
  }

  // agentId: string
  if (typeof p.agentId !== 'string' || p.agentId.length === 0) {
    errors.push({ path: 'params.agentId', message: 'agentId must be a non-empty string' });
  }

  // timestamp: ISO 8601 string
  if (typeof p.timestamp !== 'string' || p.timestamp.length === 0) {
    errors.push({ path: 'params.timestamp', message: 'timestamp must be a non-empty string' });
  }

  // branch: string
  if (typeof p.branch !== 'string' || p.branch.length === 0) {
    errors.push({ path: 'params.branch', message: 'branch must be a non-empty string' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a Result_Message (experiment.result notification).
 * Validates: Requirement 8.2
 */
export function validateResultMessage(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  // First validate as a notification
  const notificationResult = validateJsonRpcNotification(message);
  if (!notificationResult.valid) {
    return notificationResult;
  }

  const msg = message as Record<string, unknown>;

  // Check method is 'experiment.result'
  if (msg.method !== METHOD_NAMES.EXPERIMENT_RESULT) {
    errors.push({ path: 'method', message: `method must be "${METHOD_NAMES.EXPERIMENT_RESULT}"` });
  }

  // Validate params
  if (msg.params === undefined) {
    errors.push({ path: 'params', message: 'params is required for experiment.result' });
  } else {
    const paramsResult = validateExperimentResultParams(msg.params);
    errors.push(...paramsResult.errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates SyncResult structure.
 * Validates: Requirement 8.3
 */
export function validateSyncResult(result: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  if (typeof result !== 'object' || result === null) {
    errors.push({ path: 'result', message: 'result must be an object' });
    return { valid: false, errors };
  }

  const r = result as Record<string, unknown>;

  // bestValBpb: number
  if (typeof r.bestValBpb !== 'number' || isNaN(r.bestValBpb)) {
    errors.push({ path: 'result.bestValBpb', message: 'bestValBpb must be a number' });
  }

  // totalExperiments: number
  if (typeof r.totalExperiments !== 'number' || !Number.isInteger(r.totalExperiments)) {
    errors.push({ path: 'result.totalExperiments', message: 'totalExperiments must be an integer' });
  }

  // activeAgents: string[]
  if (!Array.isArray(r.activeAgents)) {
    errors.push({ path: 'result.activeAgents', message: 'activeAgents must be an array' });
  } else if (!r.activeAgents.every(a => typeof a === 'string')) {
    errors.push({ path: 'result.activeAgents', message: 'activeAgents must be an array of strings' });
  }

  // recentResults: ExperimentResultParams[]
  if (!Array.isArray(r.recentResults)) {
    errors.push({ path: 'result.recentResults', message: 'recentResults must be an array' });
  } else {
    r.recentResults.forEach((item, index) => {
      const itemResult = validateExperimentResultParams(item);
      itemResult.errors.forEach(e => {
        errors.push({
          path: e.path.replace('params', `result.recentResults[${index}]`),
          message: e.message,
        });
      });
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a Sync_Message request (swarm.sync).
 * Validates: Requirement 8.3
 */
export function validateSyncRequest(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  // First validate as a request
  const requestResult = validateJsonRpcRequest(message);
  if (!requestResult.valid) {
    return requestResult;
  }

  const msg = message as Record<string, unknown>;

  // Check method is 'swarm.sync'
  if (msg.method !== METHOD_NAMES.SWARM_SYNC) {
    errors.push({ path: 'method', message: `method must be "${METHOD_NAMES.SWARM_SYNC}"` });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a Sync_Message response (swarm.sync).
 * Validates: Requirement 8.3
 */
export function validateSyncResponse(message: unknown): MessageValidationResult {
  const errors: MessageValidationError[] = [];

  // First validate as a success response
  const responseResult = validateJsonRpcSuccessResponse(message);
  if (!responseResult.valid) {
    return responseResult;
  }

  const msg = message as Record<string, unknown>;

  // Validate result structure
  const resultValidation = validateSyncResult(msg.result);
  errors.push(...resultValidation.errors);

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for JSON-RPC 2.0 request messages.
 */
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return validateJsonRpcRequest(message).valid;
}

/**
 * Type guard for JSON-RPC 2.0 notification messages.
 */
export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return validateJsonRpcNotification(message).valid;
}

/**
 * Type guard for JSON-RPC 2.0 success response messages.
 */
export function isJsonRpcSuccessResponse(message: unknown): message is JsonRpcSuccessResponse {
  return validateJsonRpcSuccessResponse(message).valid;
}

/**
 * Type guard for JSON-RPC 2.0 error response messages.
 */
export function isJsonRpcErrorResponse(message: unknown): message is JsonRpcErrorResponse {
  return validateJsonRpcErrorResponse(message).valid;
}

/**
 * Type guard for Result_Message (experiment.result notification).
 */
export function isResultMessage(message: unknown): message is ResultMessage {
  return validateResultMessage(message).valid;
}

/**
 * Type guard for Sync_Message request.
 */
export function isSyncRequest(message: unknown): message is SyncRequest {
  return validateSyncRequest(message).valid;
}

/**
 * Type guard for Sync_Message response.
 */
export function isSyncResponse(message: unknown): message is SyncResponse {
  return validateSyncResponse(message).valid;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a JSON-RPC 2.0 request message.
 */
export function createRequest<P>(id: JsonRpcId, method: string, params?: P): JsonRpcRequest<P> {
  const request: JsonRpcRequest<P> = {
    jsonrpc: JSONRPC_VERSION,
    id,
    method,
  };
  if (params !== undefined) {
    request.params = params;
  }
  return request;
}

/**
 * Creates a JSON-RPC 2.0 notification message.
 */
export function createNotification<P>(method: string, params?: P): JsonRpcNotification<P> {
  const notification: JsonRpcNotification<P> = {
    jsonrpc: JSONRPC_VERSION,
    method,
  };
  if (params !== undefined) {
    notification.params = params;
  }
  return notification;
}

/**
 * Creates a JSON-RPC 2.0 success response message.
 */
export function createSuccessResponse<R>(id: JsonRpcId, result: R): JsonRpcSuccessResponse<R> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

/**
 * Creates a JSON-RPC 2.0 error response message.
 */
export function createErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  const response: JsonRpcErrorResponse = {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  };
  if (data !== undefined) {
    response.error.data = data;
  }
  return response;
}

/**
 * Creates a Result_Message notification.
 */
export function createResultMessage(params: ExperimentResultParams): ResultMessage {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: METHOD_NAMES.EXPERIMENT_RESULT,
    params,
  };
}

/**
 * Creates a Sync_Message request.
 */
export function createSyncRequest(id: JsonRpcId): SyncRequest {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: METHOD_NAMES.SWARM_SYNC,
    params: {},
  };
}

/**
 * Creates a Sync_Message response.
 */
export function createSyncResponse(id: JsonRpcId, result: SyncResult): SyncResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

/**
 * Formats validation errors into a human-readable string.
 */
export function formatMessageValidationErrors(errors: MessageValidationError[]): string {
  if (errors.length === 0) {
    return 'No errors';
  }

  return errors
    .map(e => e.path ? `${e.path}: ${e.message}` : e.message)
    .join('\n');
}
