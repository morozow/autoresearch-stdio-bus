/**
 * Property-based tests for JSON-RPC 2.0 compliance.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 22: JSON-RPC 2.0 Compliance
 * 
 * For any message sent or received by the Swarm_Coordinator, the message shall
 * conform to JSON-RPC 2.0 specification with required fields (jsonrpc: "2.0",
 * method or result/error, id for requests).
 * 
 * **Validates: Requirements 8.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
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
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createResultMessage,
  createSyncRequest,
  createSyncResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type ExperimentResultParams,
  type ExperimentStatus,
  type SyncResult,
} from './types';
import { encode, decode } from './codec';

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid JSON-RPC 2.0 ID (string or number).
 */
const arbitraryJsonRpcId = (): fc.Arbitrary<JsonRpcId> =>
  fc.oneof(
    fc.string({ minLength: 1, maxLength: 50 }),
    fc.integer({ min: -1000000, max: 1000000 })
  );

/**
 * Generates a valid method name.
 */
const arbitraryMethodName = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant(METHOD_NAMES.EXPERIMENT_RESULT),
    fc.constant(METHOD_NAMES.SWARM_SYNC),
    fc.constant(METHOD_NAMES.SWARM_STATUS),
    fc.constant(METHOD_NAMES.SWARM_PAUSE),
    fc.constant(METHOD_NAMES.SWARM_RESUME),
    fc.constant(METHOD_NAMES.SWARM_HISTORY),
    fc.constant(METHOD_NAMES.LOCK_ACQUIRE),
    fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0)
  );

/**
 * Generates arbitrary params (object or array).
 */
const arbitraryParams = (): fc.Arbitrary<Record<string, unknown> | unknown[]> =>
  fc.oneof(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
    fc.array(fc.jsonValue(), { maxLength: 10 })
  );

/**
 * Generates a valid experiment status.
 */
const arbitraryExperimentStatus = (): fc.Arbitrary<ExperimentStatus> =>
  fc.constantFrom('keep', 'discard', 'crash');

/**
 * Generates valid ExperimentResultParams.
 */
const arbitraryExperimentResultParams = (): fc.Arbitrary<ExperimentResultParams> =>
  fc.record({
    commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
    valBpb: fc.float({ min: 0, max: 10, noNaN: true }),
    memoryGb: fc.float({ min: 0, max: 100, noNaN: true }),
    status: arbitraryExperimentStatus(),
    description: fc.string({ minLength: 0, maxLength: 200 }),
    agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
      .map(d => d.toISOString()),
    branch: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
  });

/**
 * Generates valid SyncResult.
 */
const arbitrarySyncResult = (): fc.Arbitrary<SyncResult> =>
  fc.record({
    bestValBpb: fc.float({ min: 0, max: 10, noNaN: true }),
    totalExperiments: fc.integer({ min: 0, max: 100000 }),
    activeAgents: fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      { maxLength: 16 }
    ),
    recentResults: fc.array(arbitraryExperimentResultParams(), { maxLength: 50 }),
  });

/**
 * Generates a valid JSON-RPC 2.0 error code.
 */
const arbitraryErrorCode = (): fc.Arbitrary<number> =>
  fc.oneof(
    fc.constant(JSON_RPC_ERROR_CODES.PARSE_ERROR),
    fc.constant(JSON_RPC_ERROR_CODES.INVALID_REQUEST),
    fc.constant(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND),
    fc.constant(JSON_RPC_ERROR_CODES.INVALID_PARAMS),
    fc.constant(JSON_RPC_ERROR_CODES.INTERNAL_ERROR),
    fc.integer({ min: -32099, max: -32000 }), // Server errors
    fc.integer({ min: -32768, max: -32600 })  // Reserved for implementation
  );

// ============================================================================
// Property 22: JSON-RPC 2.0 Compliance
// ============================================================================

describe('Property 22: JSON-RPC 2.0 Compliance', () => {
  // --------------------------------------------------------------------------
  // Property 22.1: Messages from factory functions pass JSON-RPC 2.0 validation
  // --------------------------------------------------------------------------
  describe('factory function messages pass JSON-RPC 2.0 validation', () => {
    it('any request created by createRequest should pass JSON-RPC 2.0 validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitraryMethodName(),
          fc.option(arbitraryParams(), { nil: undefined }),
          (id, method, params) => {
            const request = createRequest(id, method, params);
            const result = validateJsonRpcRequest(request);

            // Must have jsonrpc: "2.0"
            expect(request.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have id
            expect(request.id).toBe(id);
            // Must have method
            expect(request.method).toBe(method);
            // Validation should pass
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any notification created by createNotification should pass JSON-RPC 2.0 validation', () => {
      fc.assert(
        fc.property(
          arbitraryMethodName(),
          fc.option(arbitraryParams(), { nil: undefined }),
          (method, params) => {
            const notification = createNotification(method, params);
            const result = validateJsonRpcNotification(notification);

            // Must have jsonrpc: "2.0"
            expect(notification.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have method
            expect(notification.method).toBe(method);
            // Must NOT have id
            expect('id' in notification).toBe(false);
            // Validation should pass
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any success response created by createSuccessResponse should pass JSON-RPC 2.0 validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          fc.jsonValue(),
          (id, resultValue) => {
            const response = createSuccessResponse(id, resultValue);
            const result = validateJsonRpcSuccessResponse(response);

            // Must have jsonrpc: "2.0"
            expect(response.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have id
            expect(response.id).toBe(id);
            // Must have result
            expect('result' in response).toBe(true);
            // Validation should pass
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any error response created by createErrorResponse should pass JSON-RPC 2.0 validation', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryJsonRpcId(), fc.constant(null)),
          arbitraryErrorCode(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.option(fc.jsonValue(), { nil: undefined }),
          (id, code, message, data) => {
            const response = createErrorResponse(id, code, message, data);
            const result = validateJsonRpcErrorResponse(response);

            // Must have jsonrpc: "2.0"
            expect(response.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have id (can be null)
            expect(response.id).toBe(id);
            // Must have error object with code and message
            expect(response.error).toBeDefined();
            expect(response.error.code).toBe(code);
            expect(response.error.message).toBe(message);
            // Validation should pass
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 22.2: Valid requests have jsonrpc: "2.0", id, and method
  // --------------------------------------------------------------------------
  describe('valid requests have required fields', () => {
    it('any valid request should have jsonrpc: "2.0", id, and method', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitraryMethodName(),
          fc.option(arbitraryParams(), { nil: undefined }),
          (id, method, params) => {
            const request = createRequest(id, method, params);

            // Check required fields
            expect(request.jsonrpc).toBe('2.0');
            expect(typeof request.id === 'string' || typeof request.id === 'number').toBe(true);
            expect(typeof request.method).toBe('string');
            expect(request.method.length).toBeGreaterThan(0);

            // Validate as generic message
            const result = validateJsonRpcMessage(request);
            expect(result.valid).toBe(true);

            // Type guard should identify as request
            expect(isJsonRpcRequest(request)).toBe(true);
            expect(isJsonRpcNotification(request)).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 22.3: Valid notifications have jsonrpc: "2.0" and method (no id)
  // --------------------------------------------------------------------------
  describe('valid notifications have required fields', () => {
    it('any valid notification should have jsonrpc: "2.0" and method (no id)', () => {
      fc.assert(
        fc.property(
          arbitraryMethodName(),
          fc.option(arbitraryParams(), { nil: undefined }),
          (method, params) => {
            const notification = createNotification(method, params);

            // Check required fields
            expect(notification.jsonrpc).toBe('2.0');
            expect(typeof notification.method).toBe('string');
            expect(notification.method.length).toBeGreaterThan(0);
            // Must NOT have id
            expect('id' in notification).toBe(false);

            // Validate as generic message
            const result = validateJsonRpcMessage(notification);
            expect(result.valid).toBe(true);

            // Type guard should identify as notification
            expect(isJsonRpcNotification(notification)).toBe(true);
            expect(isJsonRpcRequest(notification)).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 22.4: Valid success responses have jsonrpc: "2.0", id, and result
  // --------------------------------------------------------------------------
  describe('valid success responses have required fields', () => {
    it('any valid success response should have jsonrpc: "2.0", id, and result', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          fc.jsonValue(),
          (id, resultValue) => {
            const response = createSuccessResponse(id, resultValue);

            // Check required fields
            expect(response.jsonrpc).toBe('2.0');
            expect(typeof response.id === 'string' || typeof response.id === 'number').toBe(true);
            expect('result' in response).toBe(true);
            // Must NOT have error
            expect('error' in response).toBe(false);

            // Validate as generic message
            const result = validateJsonRpcMessage(response);
            expect(result.valid).toBe(true);

            // Type guard should identify as success response
            expect(isJsonRpcSuccessResponse(response)).toBe(true);
            expect(isJsonRpcErrorResponse(response)).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 22.5: Valid error responses have jsonrpc: "2.0", id (or null), and error object
  // --------------------------------------------------------------------------
  describe('valid error responses have required fields', () => {
    it('any valid error response should have jsonrpc: "2.0", id (or null), and error with code and message', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryJsonRpcId(), fc.constant(null)),
          arbitraryErrorCode(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.option(fc.jsonValue(), { nil: undefined }),
          (id, code, message, data) => {
            const response = createErrorResponse(id, code, message, data);

            // Check required fields
            expect(response.jsonrpc).toBe('2.0');
            expect(response.id === null || typeof response.id === 'string' || typeof response.id === 'number').toBe(true);
            expect('error' in response).toBe(true);
            expect(typeof response.error.code).toBe('number');
            expect(typeof response.error.message).toBe('string');
            // Must NOT have result
            expect('result' in response).toBe(false);

            // Validate as generic message
            const result = validateJsonRpcMessage(response);
            expect(result.valid).toBe(true);

            // Type guard should identify as error response
            expect(isJsonRpcErrorResponse(response)).toBe(true);
            expect(isJsonRpcSuccessResponse(response)).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 22.6: Round-trip encode/decode preserves message structure
  // --------------------------------------------------------------------------
  describe('round-trip encode/decode preserves message structure', () => {
    it('any request should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitraryMethodName(),
          fc.option(
            fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue()),
            { nil: undefined }
          ),
          (id, method, params) => {
            const original = createRequest(id, method, params);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(original.jsonrpc);
            expect((decoded as JsonRpcRequest).id).toBe(original.id);
            expect((decoded as JsonRpcRequest).method).toBe(original.method);

            // Params comparison (handle undefined vs missing)
            if (params !== undefined) {
              expect((decoded as JsonRpcRequest).params).toEqual(original.params);
            }

            // Decoded message should still be valid
            const result = validateJsonRpcRequest(decoded);
            expect(result.valid).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any notification should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryMethodName(),
          fc.option(
            fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue()),
            { nil: undefined }
          ),
          (method, params) => {
            const original = createNotification(method, params);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(original.jsonrpc);
            expect((decoded as JsonRpcNotification).method).toBe(original.method);
            expect('id' in decoded!).toBe(false);

            // Decoded message should still be valid
            const result = validateJsonRpcNotification(decoded);
            expect(result.valid).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any success response should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          fc.jsonValue(),
          (id, resultValue) => {
            const original = createSuccessResponse(id, resultValue);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(original.jsonrpc);
            expect((decoded as JsonRpcSuccessResponse).id).toBe(original.id);
            expect((decoded as JsonRpcSuccessResponse).result).toEqual(original.result);

            // Decoded message should still be valid
            const result = validateJsonRpcSuccessResponse(decoded);
            expect(result.valid).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any error response should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryJsonRpcId(), fc.constant(null)),
          arbitraryErrorCode(),
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.option(fc.jsonValue(), { nil: undefined }),
          (id, code, message, data) => {
            const original = createErrorResponse(id, code, message, data);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(original.jsonrpc);
            expect((decoded as JsonRpcErrorResponse).id).toBe(original.id);
            expect((decoded as JsonRpcErrorResponse).error.code).toBe(original.error.code);
            expect((decoded as JsonRpcErrorResponse).error.message).toBe(original.error.message);

            // Decoded message should still be valid
            const result = validateJsonRpcErrorResponse(decoded);
            expect(result.valid).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ResultMessage should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const original = createResultMessage(params);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(JSONRPC_VERSION);
            expect((decoded as JsonRpcNotification).method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);

            const decodedParams = (decoded as JsonRpcNotification<ExperimentResultParams>).params;
            expect(decodedParams).toBeDefined();
            expect(decodedParams!.commit).toBe(params.commit);
            expect(decodedParams!.valBpb).toBeCloseTo(params.valBpb, 5);
            expect(decodedParams!.memoryGb).toBeCloseTo(params.memoryGb, 5);
            expect(decodedParams!.status).toBe(params.status);
            expect(decodedParams!.agentId).toBe(params.agentId);
            expect(decodedParams!.timestamp).toBe(params.timestamp);
            expect(decodedParams!.branch).toBe(params.branch);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('SyncRequest should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const original = createSyncRequest(id);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(JSONRPC_VERSION);
            expect((decoded as JsonRpcRequest).id).toBe(id);
            expect((decoded as JsonRpcRequest).method).toBe(METHOD_NAMES.SWARM_SYNC);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('SyncResponse should survive encode/decode round-trip', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const original = createSyncResponse(id, syncResult);
            const encoded = encode(original);
            const decoded = decode(encoded);

            expect(decoded).not.toBeNull();
            expect(decoded!.jsonrpc).toBe(JSONRPC_VERSION);
            expect((decoded as JsonRpcSuccessResponse).id).toBe(id);

            const decodedResult = (decoded as JsonRpcSuccessResponse<SyncResult>).result;
            expect(decodedResult.bestValBpb).toBeCloseTo(syncResult.bestValBpb, 5);
            expect(decodedResult.totalExperiments).toBe(syncResult.totalExperiments);
            expect(decodedResult.activeAgents).toEqual(syncResult.activeAgents);
            expect(decodedResult.recentResults.length).toBe(syncResult.recentResults.length);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Additional compliance checks
  // --------------------------------------------------------------------------
  describe('additional JSON-RPC 2.0 compliance checks', () => {
    it('jsonrpc field is always exactly "2.0" for all message types', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            // Request
            fc.tuple(arbitraryJsonRpcId(), arbitraryMethodName()).map(([id, method]) =>
              createRequest(id, method)
            ),
            // Notification
            arbitraryMethodName().map(method => createNotification(method)),
            // Success response
            fc.tuple(arbitraryJsonRpcId(), fc.jsonValue()).map(([id, result]) =>
              createSuccessResponse(id, result)
            ),
            // Error response
            fc.tuple(
              fc.oneof(arbitraryJsonRpcId(), fc.constant(null)),
              arbitraryErrorCode(),
              fc.string({ minLength: 1, maxLength: 100 })
            ).map(([id, code, message]) => createErrorResponse(id, code, message))
          ),
          (message) => {
            expect(message.jsonrpc).toBe('2.0');
            expect(typeof message.jsonrpc).toBe('string');
            return message.jsonrpc === '2.0';
          }
        ),
        { numRuns: 100 }
      );
    });

    it('id field type is consistent (string or number) for requests and responses', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const request = createRequest(id, 'test.method');
            const response = createSuccessResponse(id, {});

            // ID type should be preserved
            expect(typeof request.id).toBe(typeof id);
            expect(typeof response.id).toBe(typeof id);
            expect(request.id).toBe(id);
            expect(response.id).toBe(id);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('method field is always a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryMethodName(),
          (method) => {
            const request = createRequest('id', method);
            const notification = createNotification(method);

            expect(typeof request.method).toBe('string');
            expect(request.method.length).toBeGreaterThan(0);
            expect(typeof notification.method).toBe('string');
            expect(notification.method.length).toBeGreaterThan(0);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('error.code is always a number', () => {
      fc.assert(
        fc.property(
          arbitraryErrorCode(),
          fc.string({ minLength: 1, maxLength: 100 }),
          (code, message) => {
            const response = createErrorResponse('id', code, message);

            expect(typeof response.error.code).toBe('number');
            expect(Number.isInteger(response.error.code)).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('error.message is always a string', () => {
      fc.assert(
        fc.property(
          arbitraryErrorCode(),
          fc.string({ minLength: 1, maxLength: 200 }),
          (code, message) => {
            const response = createErrorResponse('id', code, message);

            expect(typeof response.error.message).toBe('string');
            expect(response.error.message).toBe(message);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 23: Result_Message Schema
// ============================================================================

/**
 * Property 23: Result_Message Schema
 *
 * For any Result_Message, the message shall include all required fields:
 * jsonrpc, method ("experiment.result"), and params containing commit, val_bpb,
 * memory_gb, status, description, agent_id, timestamp, and branch.
 *
 * **Validates: Requirements 8.2**
 */
describe('Property 23: Result_Message Schema', () => {
  // --------------------------------------------------------------------------
  // Property 23.1: Any Result_Message created by createResultMessage should have method "experiment.result"
  // --------------------------------------------------------------------------
  describe('Result_Message method field', () => {
    it('any Result_Message created by createResultMessage should have method "experiment.result"', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            // Method must be exactly "experiment.result"
            expect(message.method).toBe('experiment.result');
            expect(message.method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);

            return message.method === 'experiment.result';
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.2: Any Result_Message should have all required params fields
  // --------------------------------------------------------------------------
  describe('Result_Message required params fields', () => {
    it('any Result_Message should have all required params fields', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            // Must have jsonrpc: "2.0"
            expect(message.jsonrpc).toBe(JSONRPC_VERSION);

            // Must have method: "experiment.result"
            expect(message.method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);

            // Must have params with all required fields
            expect(message.params).toBeDefined();
            expect('commit' in message.params).toBe(true);
            expect('valBpb' in message.params).toBe(true);
            expect('memoryGb' in message.params).toBe(true);
            expect('status' in message.params).toBe(true);
            expect('description' in message.params).toBe(true);
            expect('agentId' in message.params).toBe(true);
            expect('timestamp' in message.params).toBe(true);
            expect('branch' in message.params).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.3: params.status should be one of "keep", "discard", or "crash"
  // --------------------------------------------------------------------------
  describe('Result_Message status field', () => {
    it('params.status should be one of "keep", "discard", or "crash"', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const validStatuses = ['keep', 'discard', 'crash'];

            expect(validStatuses).toContain(message.params.status);

            return validStatuses.includes(message.params.status);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('status field should only accept valid values', () => {
      // Test each valid status explicitly
      const validStatuses: ExperimentStatus[] = ['keep', 'discard', 'crash'];

      for (const status of validStatuses) {
        fc.assert(
          fc.property(
            fc.record({
              commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
              valBpb: fc.float({ min: 0, max: 10, noNaN: true }),
              memoryGb: fc.float({ min: 0, max: 100, noNaN: true }),
              status: fc.constant(status),
              description: fc.string({ minLength: 0, maxLength: 200 }),
              agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
              timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
                .map(d => d.toISOString()),
              branch: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
            }),
            (params) => {
              const message = createResultMessage(params);
              expect(message.params.status).toBe(status);
              return message.params.status === status;
            }
          ),
          { numRuns: 30 }
        );
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.4: params.valBpb should be a number (0.000000 for crashes)
  // --------------------------------------------------------------------------
  describe('Result_Message valBpb field', () => {
    it('params.valBpb should be a number', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.valBpb).toBe('number');
            expect(Number.isNaN(message.params.valBpb)).toBe(false);

            return typeof message.params.valBpb === 'number' && !Number.isNaN(message.params.valBpb);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.valBpb should be 0.0 for crash status (convention)', () => {
      fc.assert(
        fc.property(
          fc.record({
            commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
            valBpb: fc.constant(0.0),
            memoryGb: fc.float({ min: 0, max: 100, noNaN: true }),
            status: fc.constant('crash' as ExperimentStatus),
            description: fc.string({ minLength: 0, maxLength: 200 }),
            agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
            timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
              .map(d => d.toISOString()),
            branch: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          }),
          (params) => {
            const message = createResultMessage(params);

            // For crashes, valBpb should be 0.0
            expect(message.params.valBpb).toBe(0.0);
            expect(message.params.status).toBe('crash');

            return message.params.valBpb === 0.0;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.5: params.memoryGb should be a number
  // --------------------------------------------------------------------------
  describe('Result_Message memoryGb field', () => {
    it('params.memoryGb should be a number', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.memoryGb).toBe('number');
            expect(Number.isNaN(message.params.memoryGb)).toBe(false);
            expect(message.params.memoryGb).toBeGreaterThanOrEqual(0);

            return typeof message.params.memoryGb === 'number' &&
              !Number.isNaN(message.params.memoryGb) &&
              message.params.memoryGb >= 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.6: params.commit, agentId, timestamp, branch should be non-empty strings
  // --------------------------------------------------------------------------
  describe('Result_Message string fields', () => {
    it('params.commit should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.commit).toBe('string');
            expect(message.params.commit.length).toBeGreaterThan(0);

            return typeof message.params.commit === 'string' && message.params.commit.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.agentId should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.agentId).toBe('string');
            expect(message.params.agentId.length).toBeGreaterThan(0);

            return typeof message.params.agentId === 'string' && message.params.agentId.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.timestamp should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.timestamp).toBe('string');
            expect(message.params.timestamp.length).toBeGreaterThan(0);

            return typeof message.params.timestamp === 'string' && message.params.timestamp.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.branch should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.branch).toBe('string');
            expect(message.params.branch.length).toBeGreaterThan(0);

            return typeof message.params.branch === 'string' && message.params.branch.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.7: Invalid Result_Messages (missing fields) should fail validation
  // --------------------------------------------------------------------------
  describe('Result_Message validation rejects invalid messages', () => {
    it('Result_Message without jsonrpc field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const invalidMessage = {
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params,
            };

            const result = validateJsonRpcMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'jsonrpc')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message without method field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              params,
            };

            const result = validateJsonRpcMessage(invalidMessage);
            expect(result.valid).toBe(false);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message without params should fail Result_Message validation', () => {
      const invalidMessage = {
        jsonrpc: JSONRPC_VERSION,
        method: METHOD_NAMES.EXPERIMENT_RESULT,
      };

      const result = validateResultMessage(invalidMessage);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('params'))).toBe(true);
    });

    it('Result_Message with missing params.commit should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { commit, ...paramsWithoutCommit } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutCommit,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('commit'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.valBpb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { valBpb, ...paramsWithoutValBpb } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutValBpb,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('valBpb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.memoryGb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { memoryGb, ...paramsWithoutMemoryGb } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutMemoryGb,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('memoryGb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.status should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { status, ...paramsWithoutStatus } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutStatus,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('status'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.agentId should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { agentId, ...paramsWithoutAgentId } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutAgentId,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('agentId'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.timestamp should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { timestamp, ...paramsWithoutTimestamp } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutTimestamp,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('timestamp'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.branch should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { branch, ...paramsWithoutBranch } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutBranch,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('branch'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with invalid status value should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !['keep', 'discard', 'crash'].includes(s)),
          (params, invalidStatus) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: { ...params, status: invalidStatus },
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('status'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with wrong method should fail Result_Message validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s !== METHOD_NAMES.EXPERIMENT_RESULT),
          (params, wrongMethod) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: wrongMethod,
              params,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'method')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.8: Valid Result_Messages pass validation
  // --------------------------------------------------------------------------
  describe('Valid Result_Messages pass validation', () => {
    it('any valid Result_Message should pass validateResultMessage', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateResultMessage(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Result_Message should pass validateJsonRpcMessage', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateJsonRpcMessage(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Result_Message should pass validateJsonRpcNotification', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateJsonRpcNotification(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});



// ============================================================================
// Property 23: Result_Message Schema
// ============================================================================

/**
 * Property 23: Result_Message Schema
 * 
 * For any Result_Message, the message shall include all required fields:
 * jsonrpc, method ("experiment.result"), and params containing commit, val_bpb,
 * memory_gb, status, description, agent_id, timestamp, and branch.
 * 
 * **Validates: Requirements 8.2**
 */
describe('Property 23: Result_Message Schema', () => {
  // --------------------------------------------------------------------------
  // Property 23.1: Any Result_Message created by createResultMessage should have method "experiment.result"
  // --------------------------------------------------------------------------
  describe('Result_Message method field', () => {
    it('any Result_Message created by createResultMessage should have method "experiment.result"', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            // Method must be exactly "experiment.result"
            expect(message.method).toBe('experiment.result');
            expect(message.method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);

            return message.method === 'experiment.result';
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.2: Any Result_Message should have all required params fields
  // --------------------------------------------------------------------------
  describe('Result_Message required params fields', () => {
    it('any Result_Message should have all required params fields', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            // Must have jsonrpc: "2.0"
            expect(message.jsonrpc).toBe(JSONRPC_VERSION);

            // Must have method: "experiment.result"
            expect(message.method).toBe(METHOD_NAMES.EXPERIMENT_RESULT);

            // Must have params with all required fields
            expect(message.params).toBeDefined();
            expect('commit' in message.params).toBe(true);
            expect('valBpb' in message.params).toBe(true);
            expect('memoryGb' in message.params).toBe(true);
            expect('status' in message.params).toBe(true);
            expect('description' in message.params).toBe(true);
            expect('agentId' in message.params).toBe(true);
            expect('timestamp' in message.params).toBe(true);
            expect('branch' in message.params).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.3: params.status should be one of "keep", "discard", or "crash"
  // --------------------------------------------------------------------------
  describe('Result_Message status field', () => {
    it('params.status should be one of "keep", "discard", or "crash"', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const validStatuses = ['keep', 'discard', 'crash'];

            expect(validStatuses).toContain(message.params.status);

            return validStatuses.includes(message.params.status);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('status field should only accept valid values', () => {
      // Test each valid status explicitly
      const validStatuses: ExperimentStatus[] = ['keep', 'discard', 'crash'];

      for (const status of validStatuses) {
        fc.assert(
          fc.property(
            fc.record({
              commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
              valBpb: fc.float({ min: 0, max: 10, noNaN: true }),
              memoryGb: fc.float({ min: 0, max: 100, noNaN: true }),
              status: fc.constant(status),
              description: fc.string({ minLength: 0, maxLength: 200 }),
              agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
              timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
                .map(d => d.toISOString()),
              branch: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
            }),
            (params) => {
              const message = createResultMessage(params);
              expect(message.params.status).toBe(status);
              return message.params.status === status;
            }
          ),
          { numRuns: 30 }
        );
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.4: params.valBpb should be a number (0.000000 for crashes)
  // --------------------------------------------------------------------------
  describe('Result_Message valBpb field', () => {
    it('params.valBpb should be a number', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.valBpb).toBe('number');
            expect(Number.isNaN(message.params.valBpb)).toBe(false);

            return typeof message.params.valBpb === 'number' && !Number.isNaN(message.params.valBpb);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.valBpb should be 0.0 for crash status (convention)', () => {
      fc.assert(
        fc.property(
          fc.record({
            commit: fc.hexaString({ minLength: 7, maxLength: 7 }),
            valBpb: fc.constant(0.0),
            memoryGb: fc.float({ min: 0, max: 100, noNaN: true }),
            status: fc.constant('crash' as ExperimentStatus),
            description: fc.string({ minLength: 0, maxLength: 200 }),
            agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
            timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
              .map(d => d.toISOString()),
            branch: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          }),
          (params) => {
            const message = createResultMessage(params);

            // For crashes, valBpb should be 0.0
            expect(message.params.valBpb).toBe(0.0);
            expect(message.params.status).toBe('crash');

            return message.params.valBpb === 0.0;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.5: params.memoryGb should be a number
  // --------------------------------------------------------------------------
  describe('Result_Message memoryGb field', () => {
    it('params.memoryGb should be a number', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.memoryGb).toBe('number');
            expect(Number.isNaN(message.params.memoryGb)).toBe(false);
            expect(message.params.memoryGb).toBeGreaterThanOrEqual(0);

            return typeof message.params.memoryGb === 'number' &&
              !Number.isNaN(message.params.memoryGb) &&
              message.params.memoryGb >= 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.6: params.commit, agentId, timestamp, branch should be non-empty strings
  // --------------------------------------------------------------------------
  describe('Result_Message string fields', () => {
    it('params.commit should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.commit).toBe('string');
            expect(message.params.commit.length).toBeGreaterThan(0);

            return typeof message.params.commit === 'string' && message.params.commit.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.agentId should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.agentId).toBe('string');
            expect(message.params.agentId.length).toBeGreaterThan(0);

            return typeof message.params.agentId === 'string' && message.params.agentId.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.timestamp should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.timestamp).toBe('string');
            expect(message.params.timestamp.length).toBeGreaterThan(0);

            return typeof message.params.timestamp === 'string' && message.params.timestamp.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('params.branch should be a non-empty string', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);

            expect(typeof message.params.branch).toBe('string');
            expect(message.params.branch.length).toBeGreaterThan(0);

            return typeof message.params.branch === 'string' && message.params.branch.length > 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.7: Invalid Result_Messages (missing fields) should fail validation
  // --------------------------------------------------------------------------
  describe('Result_Message validation rejects invalid messages', () => {
    it('Result_Message without jsonrpc field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const invalidMessage = {
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params,
            };

            const result = validateJsonRpcMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'jsonrpc')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message without method field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              params,
            };

            const result = validateJsonRpcMessage(invalidMessage);
            expect(result.valid).toBe(false);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message without params should fail Result_Message validation', () => {
      const invalidMessage = {
        jsonrpc: JSONRPC_VERSION,
        method: METHOD_NAMES.EXPERIMENT_RESULT,
      };

      const result = validateResultMessage(invalidMessage);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('params'))).toBe(true);
    });

    it('Result_Message with missing params.commit should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { commit, ...paramsWithoutCommit } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutCommit,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('commit'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.valBpb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { valBpb, ...paramsWithoutValBpb } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutValBpb,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('valBpb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.memoryGb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { memoryGb, ...paramsWithoutMemoryGb } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutMemoryGb,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('memoryGb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.status should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { status, ...paramsWithoutStatus } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutStatus,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('status'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.agentId should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { agentId, ...paramsWithoutAgentId } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutAgentId,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('agentId'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.timestamp should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { timestamp, ...paramsWithoutTimestamp } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutTimestamp,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('timestamp'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with missing params.branch should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const { branch, ...paramsWithoutBranch } = params;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: paramsWithoutBranch,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('branch'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with invalid status value should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !['keep', 'discard', 'crash'].includes(s)),
          (params, invalidStatus) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: METHOD_NAMES.EXPERIMENT_RESULT,
              params: { ...params, status: invalidStatus },
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('status'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Result_Message with wrong method should fail Result_Message validation', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s !== METHOD_NAMES.EXPERIMENT_RESULT),
          (params, wrongMethod) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              method: wrongMethod,
              params,
            };

            const result = validateResultMessage(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'method')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23.8: Valid Result_Messages pass validation
  // --------------------------------------------------------------------------
  describe('Valid Result_Messages pass validation', () => {
    it('any valid Result_Message should pass validateResultMessage', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateResultMessage(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Result_Message should pass validateJsonRpcMessage', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateJsonRpcMessage(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Result_Message should pass validateJsonRpcNotification', () => {
      fc.assert(
        fc.property(
          arbitraryExperimentResultParams(),
          (params) => {
            const message = createResultMessage(params);
            const result = validateJsonRpcNotification(message);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 24: Sync_Message Schema
// ============================================================================

/**
 * Property 24: Sync_Message Schema
 *
 * For any Sync_Message response, the message shall include all required fields:
 * jsonrpc, id, and result containing best_val_bpb, total_experiments, active_agents,
 * and recent_results.
 *
 * **Validates: Requirements 8.3**
 */
describe('Property 24: Sync_Message Schema', () => {
  // --------------------------------------------------------------------------
  // Property 24.1: Any Sync_Message request should have method "swarm.sync" and an id
  // --------------------------------------------------------------------------
  describe('Sync_Message request fields', () => {
    it('any Sync_Message request should have method "swarm.sync" and an id', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const request = createSyncRequest(id);

            // Must have jsonrpc: "2.0"
            expect(request.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have id
            expect(request.id).toBe(id);
            // Must have method "swarm.sync"
            expect(request.method).toBe('swarm.sync');
            expect(request.method).toBe(METHOD_NAMES.SWARM_SYNC);

            return request.jsonrpc === JSONRPC_VERSION &&
              request.id === id &&
              request.method === METHOD_NAMES.SWARM_SYNC;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any Sync_Message request should pass validateSyncRequest', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const request = createSyncRequest(id);
            const result = validateSyncRequest(request);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.2: Any Sync_Message response should have all required result fields
  // --------------------------------------------------------------------------
  describe('Sync_Message response required fields', () => {
    it('any Sync_Message response should have all required result fields', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);

            // Must have jsonrpc: "2.0"
            expect(response.jsonrpc).toBe(JSONRPC_VERSION);
            // Must have id
            expect(response.id).toBe(id);
            // Must have result with all required fields
            expect(response.result).toBeDefined();
            expect('bestValBpb' in response.result).toBe(true);
            expect('totalExperiments' in response.result).toBe(true);
            expect('activeAgents' in response.result).toBe(true);
            expect('recentResults' in response.result).toBe(true);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.3: result.bestValBpb should be a number
  // --------------------------------------------------------------------------
  describe('Sync_Message result.bestValBpb field', () => {
    it('result.bestValBpb should be a number', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);

            expect(typeof response.result.bestValBpb).toBe('number');
            expect(Number.isNaN(response.result.bestValBpb)).toBe(false);

            return typeof response.result.bestValBpb === 'number' &&
              !Number.isNaN(response.result.bestValBpb);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.4: result.totalExperiments should be an integer
  // --------------------------------------------------------------------------
  describe('Sync_Message result.totalExperiments field', () => {
    it('result.totalExperiments should be an integer', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);

            expect(typeof response.result.totalExperiments).toBe('number');
            expect(Number.isInteger(response.result.totalExperiments)).toBe(true);
            expect(response.result.totalExperiments).toBeGreaterThanOrEqual(0);

            return typeof response.result.totalExperiments === 'number' &&
              Number.isInteger(response.result.totalExperiments) &&
              response.result.totalExperiments >= 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.5: result.activeAgents should be an array of strings
  // --------------------------------------------------------------------------
  describe('Sync_Message result.activeAgents field', () => {
    it('result.activeAgents should be an array of strings', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);

            expect(Array.isArray(response.result.activeAgents)).toBe(true);
            expect(response.result.activeAgents.every(a => typeof a === 'string')).toBe(true);

            return Array.isArray(response.result.activeAgents) &&
              response.result.activeAgents.every(a => typeof a === 'string');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.6: result.recentResults should be an array of valid ExperimentResultParams
  // --------------------------------------------------------------------------
  describe('Sync_Message result.recentResults field', () => {
    it('result.recentResults should be an array of valid ExperimentResultParams', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);

            expect(Array.isArray(response.result.recentResults)).toBe(true);

            // Each item should have all required ExperimentResultParams fields
            for (const item of response.result.recentResults) {
              expect('commit' in item).toBe(true);
              expect('valBpb' in item).toBe(true);
              expect('memoryGb' in item).toBe(true);
              expect('status' in item).toBe(true);
              expect('description' in item).toBe(true);
              expect('agentId' in item).toBe(true);
              expect('timestamp' in item).toBe(true);
              expect('branch' in item).toBe(true);

              // Validate types
              expect(typeof item.commit).toBe('string');
              expect(typeof item.valBpb).toBe('number');
              expect(typeof item.memoryGb).toBe('number');
              expect(['keep', 'discard', 'crash']).toContain(item.status);
              expect(typeof item.description).toBe('string');
              expect(typeof item.agentId).toBe('string');
              expect(typeof item.timestamp).toBe('string');
              expect(typeof item.branch).toBe('string');
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.7: Invalid Sync_Messages (missing fields) should fail validation
  // --------------------------------------------------------------------------
  describe('Sync_Message validation rejects invalid messages', () => {
    it('Sync_Message response without jsonrpc field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const invalidMessage = {
              id,
              result: syncResult,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'jsonrpc')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response without id field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitrarySyncResult(),
          (syncResult) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              result: syncResult,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'id')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response without result field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'result')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with missing result.bestValBpb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const { bestValBpb, ...resultWithoutBestValBpb } = syncResult;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: resultWithoutBestValBpb,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('bestValBpb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with missing result.totalExperiments should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const { totalExperiments, ...resultWithoutTotalExperiments } = syncResult;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: resultWithoutTotalExperiments,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('totalExperiments'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with missing result.activeAgents should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const { activeAgents, ...resultWithoutActiveAgents } = syncResult;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: resultWithoutActiveAgents,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('activeAgents'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with missing result.recentResults should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const { recentResults, ...resultWithoutRecentResults } = syncResult;
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: resultWithoutRecentResults,
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('recentResults'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with non-number bestValBpb should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          fc.string({ minLength: 1, maxLength: 20 }),
          (id, syncResult, invalidBestValBpb) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: { ...syncResult, bestValBpb: invalidBestValBpb },
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('bestValBpb'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with non-integer totalExperiments should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          fc.double({ min: 0.1, max: 100, noNaN: true }).filter(n => !Number.isInteger(n)),
          (id, syncResult, nonIntegerTotal) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: { ...syncResult, totalExperiments: nonIntegerTotal },
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('totalExperiments'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with non-array activeAgents should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          fc.string({ minLength: 1, maxLength: 20 }),
          (id, syncResult, invalidActiveAgents) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: { ...syncResult, activeAgents: invalidActiveAgents },
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('activeAgents'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with non-string elements in activeAgents should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
          (id, syncResult, invalidAgents) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: { ...syncResult, activeAgents: invalidAgents },
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('activeAgents'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message response with non-array recentResults should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          fc.string({ minLength: 1, maxLength: 20 }),
          (id, syncResult, invalidRecentResults) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: { ...syncResult, recentResults: invalidRecentResults },
            };

            const result = validateSyncResponse(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('recentResults'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message request without method field should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              params: {},
            };

            const result = validateSyncRequest(invalidMessage);
            expect(result.valid).toBe(false);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Sync_Message request with wrong method should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s !== METHOD_NAMES.SWARM_SYNC),
          (id, wrongMethod) => {
            const invalidMessage = {
              jsonrpc: JSONRPC_VERSION,
              id,
              method: wrongMethod,
              params: {},
            };

            const result = validateSyncRequest(invalidMessage);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'method')).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24.8: Valid Sync_Messages pass validation
  // --------------------------------------------------------------------------
  describe('Valid Sync_Messages pass validation', () => {
    it('any valid Sync_Message request should pass validateSyncRequest', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          (id) => {
            const request = createSyncRequest(id);
            const result = validateSyncRequest(request);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Sync_Message response should pass validateSyncResponse', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);
            const result = validateSyncResponse(response);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Sync_Message response should pass validateJsonRpcSuccessResponse', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);
            const result = validateJsonRpcSuccessResponse(response);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('any valid Sync_Message response should pass validateJsonRpcMessage', () => {
      fc.assert(
        fc.property(
          arbitraryJsonRpcId(),
          arbitrarySyncResult(),
          (id, syncResult) => {
            const response = createSyncResponse(id, syncResult);
            const result = validateJsonRpcMessage(response);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
