/**
 * Unit tests for JSON-RPC 2.0 message types and validation.
 * 
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import { describe, it, expect } from 'vitest';
import {
  JSONRPC_VERSION,
  JSON_RPC_ERROR_CODES,
  METHOD_NAMES,
  validateJsonRpcRequest,
  validateJsonRpcNotification,
  validateJsonRpcSuccessResponse,
  validateJsonRpcErrorResponse,
  validateJsonRpcMessage,
  validateResultMessage,
  validateSyncRequest,
  validateSyncResponse,
  validateExperimentResultParams,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  isResultMessage,
  isSyncRequest,
  isSyncResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createResultMessage,
  createSyncRequest,
  createSyncResponse,
  type ExperimentResultParams,
  type SyncResult,
} from './types';

// ============================================================================
// Test Data
// ============================================================================

const validExperimentParams: ExperimentResultParams = {
  commit: 'a1b2c3d',
  valBpb: 0.9979,
  memoryGb: 44.0,
  status: 'keep',
  description: 'increase LR to 0.04',
  agentId: 'agent-0',
  timestamp: '2025-01-15T10:30:00Z',
  branch: 'autoresearch/swarm/agent-0',
};

const validSyncResult: SyncResult = {
  bestValBpb: 0.9932,
  totalExperiments: 47,
  activeAgents: ['agent-0', 'agent-1', 'agent-2', 'agent-3'],
  recentResults: [validExperimentParams],
};

// ============================================================================
// JSON-RPC 2.0 Base Validation Tests
// ============================================================================

describe('JSON-RPC 2.0 Request Validation', () => {
  it('validates a correct request', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'req-001',
      method: 'swarm.sync',
      params: {},
    };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates request with numeric id', () => {
    const request = {
      jsonrpc: '2.0',
      id: 123,
      method: 'test.method',
    };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(true);
  });

  it('rejects request without jsonrpc version', () => {
    const request = { id: 'req-001', method: 'test' };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'jsonrpc')).toBe(true);
  });

  it('rejects request with wrong jsonrpc version', () => {
    const request = { jsonrpc: '1.0', id: 'req-001', method: 'test' };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(false);
  });

  it('rejects request without id', () => {
    const request = { jsonrpc: '2.0', method: 'test' };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'id')).toBe(true);
  });

  it('rejects request without method', () => {
    const request = { jsonrpc: '2.0', id: 'req-001' };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'method')).toBe(true);
  });

  it('rejects request with empty method', () => {
    const request = { jsonrpc: '2.0', id: 'req-001', method: '' };
    const result = validateJsonRpcRequest(request);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object message', () => {
    const result = validateJsonRpcRequest('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects null message', () => {
    const result = validateJsonRpcRequest(null);
    expect(result.valid).toBe(false);
  });
});

describe('JSON-RPC 2.0 Notification Validation', () => {
  it('validates a correct notification', () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'experiment.result',
      params: validExperimentParams,
    };
    const result = validateJsonRpcNotification(notification);
    expect(result.valid).toBe(true);
  });

  it('rejects notification with id field', () => {
    const notification = {
      jsonrpc: '2.0',
      id: 'should-not-be-here',
      method: 'test',
    };
    const result = validateJsonRpcNotification(notification);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'id')).toBe(true);
  });

  it('rejects notification without method', () => {
    const notification = { jsonrpc: '2.0' };
    const result = validateJsonRpcNotification(notification);
    expect(result.valid).toBe(false);
  });
});

describe('JSON-RPC 2.0 Success Response Validation', () => {
  it('validates a correct success response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      result: { data: 'test' },
    };
    const result = validateJsonRpcSuccessResponse(response);
    expect(result.valid).toBe(true);
  });

  it('validates response with null result', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      result: null,
    };
    const result = validateJsonRpcSuccessResponse(response);
    expect(result.valid).toBe(true);
  });

  it('rejects response without result', () => {
    const response = { jsonrpc: '2.0', id: 'req-001' };
    const result = validateJsonRpcSuccessResponse(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'result')).toBe(true);
  });

  it('rejects response with error field', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      result: {},
      error: { code: -32600, message: 'test' },
    };
    const result = validateJsonRpcSuccessResponse(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'error')).toBe(true);
  });
});

describe('JSON-RPC 2.0 Error Response Validation', () => {
  it('validates a correct error response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid request',
      },
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(true);
  });

  it('validates error response with null id (parse error)', () => {
    const response = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
        message: 'Parse error',
      },
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(true);
  });

  it('validates error response with data field', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { details: 'missing field' },
      },
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(true);
  });

  it('rejects error response without error object', () => {
    const response = { jsonrpc: '2.0', id: 'req-001' };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(false);
  });

  it('rejects error response with missing error.code', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: { message: 'test' },
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'error.code')).toBe(true);
  });

  it('rejects error response with missing error.message', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: { code: -32600 },
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'error.message')).toBe(true);
  });

  it('rejects error response with result field', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: { code: -32600, message: 'test' },
      result: {},
    };
    const result = validateJsonRpcErrorResponse(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'result')).toBe(true);
  });
});

describe('JSON-RPC 2.0 Generic Message Validation', () => {
  it('correctly identifies and validates a request', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'req-001',
      method: 'test',
    };
    const result = validateJsonRpcMessage(request);
    expect(result.valid).toBe(true);
  });

  it('correctly identifies and validates a notification', () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'test',
    };
    const result = validateJsonRpcMessage(notification);
    expect(result.valid).toBe(true);
  });

  it('correctly identifies and validates a success response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      result: {},
    };
    const result = validateJsonRpcMessage(response);
    expect(result.valid).toBe(true);
  });

  it('correctly identifies and validates an error response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 'req-001',
      error: { code: -32600, message: 'test' },
    };
    const result = validateJsonRpcMessage(response);
    expect(result.valid).toBe(true);
  });

  it('rejects message with neither method nor result/error', () => {
    const invalid = { jsonrpc: '2.0', id: 'req-001' };
    const result = validateJsonRpcMessage(invalid);
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Result_Message Validation Tests (Requirement 8.2)
// ============================================================================

describe('Result_Message Validation', () => {
  it('validates a correct Result_Message', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'experiment.result',
      params: validExperimentParams,
    };
    const result = validateResultMessage(message);
    expect(result.valid).toBe(true);
  });

  it('rejects Result_Message with wrong method', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'wrong.method',
      params: validExperimentParams,
    };
    const result = validateResultMessage(message);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'method')).toBe(true);
  });

  it('rejects Result_Message without params', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'experiment.result',
    };
    const result = validateResultMessage(message);
    expect(result.valid).toBe(false);
  });
});

describe('ExperimentResultParams Validation', () => {
  it('validates correct params', () => {
    const result = validateExperimentResultParams(validExperimentParams);
    expect(result.valid).toBe(true);
  });

  it('rejects params with missing commit', () => {
    const params = { ...validExperimentParams, commit: undefined };
    const result = validateExperimentResultParams(params);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'params.commit')).toBe(true);
  });

  it('rejects params with invalid valBpb', () => {
    const params = { ...validExperimentParams, valBpb: 'not a number' };
    const result = validateExperimentResultParams(params);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'params.valBpb')).toBe(true);
  });

  it('rejects params with invalid status', () => {
    const params = { ...validExperimentParams, status: 'invalid' };
    const result = validateExperimentResultParams(params);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'params.status')).toBe(true);
  });

  it('accepts all valid status values', () => {
    for (const status of ['keep', 'discard', 'crash']) {
      const params = { ...validExperimentParams, status };
      const result = validateExperimentResultParams(params);
      expect(result.valid).toBe(true);
    }
  });

  it('rejects params with empty agentId', () => {
    const params = { ...validExperimentParams, agentId: '' };
    const result = validateExperimentResultParams(params);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object params', () => {
    const result = validateExperimentResultParams('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects null params', () => {
    const result = validateExperimentResultParams(null);
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Sync_Message Validation Tests (Requirement 8.3)
// ============================================================================

describe('Sync_Message Request Validation', () => {
  it('validates a correct Sync request', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      method: 'swarm.sync',
      params: {},
    };
    const result = validateSyncRequest(message);
    expect(result.valid).toBe(true);
  });

  it('rejects Sync request with wrong method', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      method: 'wrong.method',
    };
    const result = validateSyncRequest(message);
    expect(result.valid).toBe(false);
  });
});

describe('Sync_Message Response Validation', () => {
  it('validates a correct Sync response', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      result: validSyncResult,
    };
    const result = validateSyncResponse(message);
    expect(result.valid).toBe(true);
  });

  it('rejects Sync response with missing bestValBpb', () => {
    const invalidResult = { ...validSyncResult, bestValBpb: undefined };
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      result: invalidResult,
    };
    const result = validateSyncResponse(message);
    expect(result.valid).toBe(false);
  });

  it('rejects Sync response with non-array activeAgents', () => {
    const invalidResult = { ...validSyncResult, activeAgents: 'not-array' };
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      result: invalidResult,
    };
    const result = validateSyncResponse(message);
    expect(result.valid).toBe(false);
  });

  it('rejects Sync response with invalid recentResults item', () => {
    const invalidResult = {
      ...validSyncResult,
      recentResults: [{ invalid: 'item' }],
    };
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      result: invalidResult,
    };
    const result = validateSyncResponse(message);
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('Type Guards', () => {
  it('isJsonRpcRequest returns true for valid request', () => {
    const request = { jsonrpc: '2.0', id: '1', method: 'test' };
    expect(isJsonRpcRequest(request)).toBe(true);
  });

  it('isJsonRpcRequest returns false for notification', () => {
    const notification = { jsonrpc: '2.0', method: 'test' };
    expect(isJsonRpcRequest(notification)).toBe(false);
  });

  it('isJsonRpcNotification returns true for valid notification', () => {
    const notification = { jsonrpc: '2.0', method: 'test' };
    expect(isJsonRpcNotification(notification)).toBe(true);
  });

  it('isJsonRpcSuccessResponse returns true for valid response', () => {
    const response = { jsonrpc: '2.0', id: '1', result: {} };
    expect(isJsonRpcSuccessResponse(response)).toBe(true);
  });

  it('isJsonRpcErrorResponse returns true for valid error', () => {
    const response = {
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32600, message: 'test' },
    };
    expect(isJsonRpcErrorResponse(response)).toBe(true);
  });

  it('isResultMessage returns true for valid Result_Message', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'experiment.result',
      params: validExperimentParams,
    };
    expect(isResultMessage(message)).toBe(true);
  });

  it('isSyncRequest returns true for valid Sync request', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      method: 'swarm.sync',
    };
    expect(isSyncRequest(message)).toBe(true);
  });

  it('isSyncResponse returns true for valid Sync response', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'sync-001',
      result: validSyncResult,
    };
    expect(isSyncResponse(message)).toBe(true);
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe('Factory Functions', () => {
  describe('createRequest', () => {
    it('creates a valid request', () => {
      const request = createRequest('req-001', 'test.method', { key: 'value' });
      expect(request.jsonrpc).toBe(JSONRPC_VERSION);
      expect(request.id).toBe('req-001');
      expect(request.method).toBe('test.method');
      expect(request.params).toEqual({ key: 'value' });
      expect(isJsonRpcRequest(request)).toBe(true);
    });

    it('creates request without params', () => {
      const request = createRequest('req-001', 'test.method');
      expect(request.params).toBeUndefined();
      expect(isJsonRpcRequest(request)).toBe(true);
    });
  });

  describe('createNotification', () => {
    it('creates a valid notification', () => {
      const notification = createNotification('test.method', { key: 'value' });
      expect(notification.jsonrpc).toBe(JSONRPC_VERSION);
      expect(notification.method).toBe('test.method');
      expect(notification.params).toEqual({ key: 'value' });
      expect(isJsonRpcNotification(notification)).toBe(true);
    });

    it('creates notification without params', () => {
      const notification = createNotification('test.method');
      expect(notification.params).toBeUndefined();
      expect(isJsonRpcNotification(notification)).toBe(true);
    });
  });

  describe('createSuccessResponse', () => {
    it('creates a valid success response', () => {
      const response = createSuccessResponse('req-001', { data: 'test' });
      expect(response.jsonrpc).toBe(JSONRPC_VERSION);
      expect(response.id).toBe('req-001');
      expect(response.result).toEqual({ data: 'test' });
      expect(isJsonRpcSuccessResponse(response)).toBe(true);
    });
  });

  describe('createErrorResponse', () => {
    it('creates a valid error response', () => {
      const response = createErrorResponse(
        'req-001',
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        'Invalid request'
      );
      expect(response.jsonrpc).toBe(JSONRPC_VERSION);
      expect(response.id).toBe('req-001');
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toBe('Invalid request');
      expect(isJsonRpcErrorResponse(response)).toBe(true);
    });

    it('creates error response with data', () => {
      const response = createErrorResponse(
        'req-001',
        -32602,
        'Invalid params',
        { details: 'missing field' }
      );
      expect(response.error.data).toEqual({ details: 'missing field' });
    });

    it('creates error response with null id', () => {
      const response = createErrorResponse(
        null,
        JSON_RPC_ERROR_CODES.PARSE_ERROR,
        'Parse error'
      );
      expect(response.id).toBeNull();
      expect(isJsonRpcErrorResponse(response)).toBe(true);
    });
  });
});

describe('createResultMessage', () => {
  it('creates a valid Result_Message', () => {
    const message = createResultMessage(validExperimentParams);
    expect(message.jsonrpc).toBe(JSONRPC_VERSION);
    expect(message.method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);
    expect(message.params).toEqual(validExperimentParams);
    expect(isResultMessage(message)).toBe(true);
  });
});

describe('createSyncRequest', () => {
  it('creates a valid Sync request', () => {
    const request = createSyncRequest('sync-001');
    expect(request.jsonrpc).toBe(JSONRPC_VERSION);
    expect(request.id).toBe('sync-001');
    expect(request.method).toBe(METHOD_NAMES.SWARM_SYNC);
    expect(request.params).toEqual({});
    expect(isSyncRequest(request)).toBe(true);
  });
});

describe('createSyncResponse', () => {
  it('creates a valid Sync response', () => {
    const response = createSyncResponse('sync-001', validSyncResult);
    expect(response.jsonrpc).toBe(JSONRPC_VERSION);
    expect(response.id).toBe('sync-001');
    expect(response.result).toEqual(validSyncResult);
    expect(isSyncResponse(response)).toBe(true);
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('Constants', () => {
  it('JSONRPC_VERSION is 2.0', () => {
    expect(JSONRPC_VERSION).toBe('2.0');
  });

  it('JSON_RPC_ERROR_CODES has standard codes', () => {
    expect(JSON_RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(JSON_RPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
    expect(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(JSON_RPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
    expect(JSON_RPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
  });

  it('METHOD_NAMES has all required methods', () => {
    expect(METHOD_NAMES.EXPERIMENT_RESULT).toBe('experiment.result');
    expect(METHOD_NAMES.SWARM_SYNC).toBe('swarm.sync');
    expect(METHOD_NAMES.SWARM_STATUS).toBe('swarm.status');
    expect(METHOD_NAMES.SWARM_PAUSE).toBe('swarm.pause');
    expect(METHOD_NAMES.SWARM_RESUME).toBe('swarm.resume');
    expect(METHOD_NAMES.SWARM_HISTORY).toBe('swarm.history');
    expect(METHOD_NAMES.LOCK_ACQUIRE).toBe('lock.acquire');
  });
});
