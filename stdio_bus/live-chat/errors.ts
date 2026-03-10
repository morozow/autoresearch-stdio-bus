// ============================================================================
// MCP-ACP Bridge Server — Typed Error Classes and Error Codes
// ============================================================================

// ----------------------------------------------------------------------------
// Error Codes
// ----------------------------------------------------------------------------

export const ErrorCodes = {
  // Standard JSON-RPC error codes
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Bridge-specific error codes
  CAPACITY_EXCEEDED: -32000,
  REQUEST_TIMEOUT: -32001,
  NOT_INITIALIZED: -32002,
  SHUTTING_DOWN: -32003,
  DISCONNECTED: -32004,
  TASK_ITERATION_LIMIT: -32005,
  TASK_DURATION_LIMIT: -32006,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ----------------------------------------------------------------------------
// Base Bridge Error
// ----------------------------------------------------------------------------

export class BridgeError extends Error {
  public readonly code: ErrorCode;
  public readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }

  toJsonRpcError() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined && { data: this.data }),
    };
  }
}

// ----------------------------------------------------------------------------
// Standard JSON-RPC Errors
// ----------------------------------------------------------------------------

export class InvalidRequestError extends BridgeError {
  constructor(message = 'Invalid request', data?: unknown) {
    super(ErrorCodes.INVALID_REQUEST, message, data);
    this.name = 'InvalidRequestError';
  }
}

export class MethodNotFoundError extends BridgeError {
  constructor(message = 'Method not found', data?: unknown) {
    super(ErrorCodes.METHOD_NOT_FOUND, message, data);
    this.name = 'MethodNotFoundError';
  }
}

export class InvalidParamsError extends BridgeError {
  constructor(message = 'Invalid params', data?: unknown) {
    super(ErrorCodes.INVALID_PARAMS, message, data);
    this.name = 'InvalidParamsError';
  }
}

export class InternalError extends BridgeError {
  constructor(message = 'Internal error', data?: unknown) {
    super(ErrorCodes.INTERNAL_ERROR, message, data);
    this.name = 'InternalError';
  }
}

// ----------------------------------------------------------------------------
// Bridge-Specific Errors
// ----------------------------------------------------------------------------

export class CapacityExceededError extends BridgeError {
  constructor(message = 'Capacity exceeded', data?: unknown) {
    super(ErrorCodes.CAPACITY_EXCEEDED, message, data);
    this.name = 'CapacityExceededError';
  }
}

export class RequestTimeoutError extends BridgeError {
  constructor(message = 'Request timeout', data?: unknown) {
    super(ErrorCodes.REQUEST_TIMEOUT, message, data);
    this.name = 'RequestTimeoutError';
  }
}

export class NotInitializedError extends BridgeError {
  constructor(message = 'Not initialized', data?: unknown) {
    super(ErrorCodes.NOT_INITIALIZED, message, data);
    this.name = 'NotInitializedError';
  }
}

export class ShuttingDownError extends BridgeError {
  constructor(message = 'Shutting down', data?: unknown) {
    super(ErrorCodes.SHUTTING_DOWN, message, data);
    this.name = 'ShuttingDownError';
  }
}

export class DisconnectedError extends BridgeError {
  constructor(message = 'Disconnected', data?: unknown) {
    super(ErrorCodes.DISCONNECTED, message, data);
    this.name = 'DisconnectedError';
  }
}

export class TaskIterationLimitError extends BridgeError {
  constructor(message = 'Task iteration limit exceeded', data?: unknown) {
    super(ErrorCodes.TASK_ITERATION_LIMIT, message, data);
    this.name = 'TaskIterationLimitError';
  }
}

export class TaskDurationLimitError extends BridgeError {
  constructor(message = 'Task duration limit exceeded', data?: unknown) {
    super(ErrorCodes.TASK_DURATION_LIMIT, message, data);
    this.name = 'TaskDurationLimitError';
  }
}
