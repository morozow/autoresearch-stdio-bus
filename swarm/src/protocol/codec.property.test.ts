/**
 * Property-based tests for parse error recovery.
 *
 * Feature: stdio-bus-swarm-autoresearch, Property 25: Parse Error Recovery
 *
 * For any malformed message received by the Session_Router, the router shall
 * log the error and continue processing subsequent valid messages without crashing.
 *
 * **Validates: Requirements 8.4**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  decode,
  decodeWithError,
  decodeMultiple,
  createNdjsonParser,
  CodecLogger,
  NdjsonParserEvent,
} from './codec';
import {
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  JSON_RPC_ERROR_CODES,
  JSONRPC_VERSION,
  METHOD_NAMES,
  type JsonRpcMessage,
  type ExperimentResultParams,
} from './types';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockLogger = (): CodecLogger & { errorCalls: unknown[][] } => {
  const errorCalls: unknown[][] = [];
  return {
    errorCalls,
    error: vi.fn((...args: unknown[]) => {
      errorCalls.push(args);
    }),
    warn: vi.fn(),
  };
};

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid JSON-RPC 2.0 ID (string or number).
 */
const arbitraryJsonRpcId = (): fc.Arbitrary<string | number> =>
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
    fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0)
  );

/**
 * Generates arbitrary params (object).
 */
const arbitraryParams = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue());

/**
 * Generates a valid JSON-RPC 2.0 request message.
 */
const arbitraryValidRequest = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.record({
    id: arbitraryJsonRpcId(),
    method: arbitraryMethodName(),
    params: fc.option(arbitraryParams(), { nil: undefined }),
  }).map(({ id, method, params }) => createRequest(id, method, params));

/**
 * Generates a valid JSON-RPC 2.0 notification message.
 */
const arbitraryValidNotification = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.record({
    method: arbitraryMethodName(),
    params: fc.option(arbitraryParams(), { nil: undefined }),
  }).map(({ method, params }) => createNotification(method, params));

/**
 * Generates a valid JSON-RPC 2.0 success response.
 */
const arbitraryValidSuccessResponse = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.record({
    id: arbitraryJsonRpcId(),
    result: fc.jsonValue(),
  }).map(({ id, result }) => createSuccessResponse(id, result));

/**
 * Generates a valid JSON-RPC 2.0 error response.
 */
const arbitraryValidErrorResponse = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.record({
    id: fc.oneof(arbitraryJsonRpcId(), fc.constant(null)),
    code: fc.constantFrom(
      JSON_RPC_ERROR_CODES.PARSE_ERROR,
      JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR
    ),
    message: fc.string({ minLength: 1, maxLength: 100 }),
  }).map(({ id, code, message }) => createErrorResponse(id, code, message));

/**
 * Generates any valid JSON-RPC 2.0 message.
 */
const arbitraryValidMessage = (): fc.Arbitrary<JsonRpcMessage> =>
  fc.oneof(
    arbitraryValidRequest(),
    arbitraryValidNotification(),
    arbitraryValidSuccessResponse(),
    arbitraryValidErrorResponse()
  );

/**
 * Generates invalid JSON strings (not parseable as JSON).
 * Excludes whitespace-only strings as those are skipped by the parser.
 */
const arbitraryInvalidJson = (): fc.Arbitrary<string> =>
  fc.oneof(
    // Truncated JSON
    fc.constant('{"jsonrpc":"2.0"'),
    fc.constant('{"method":'),
    fc.constant('[1, 2, 3'),
    // Invalid syntax
    fc.constant('{jsonrpc: "2.0"}'), // Missing quotes on key
    fc.constant("{'jsonrpc': '2.0'}"), // Single quotes
    fc.constant('{jsonrpc: 2.0, method: test}'), // Unquoted values
    // Random garbage (filter out whitespace-only strings)
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
      // Must not be whitespace-only (those are skipped, not errors)
      if (s.trim().length === 0) return false;
      try {
        JSON.parse(s);
        return false; // Valid JSON, filter out
      } catch {
        return true; // Invalid JSON, keep
      }
    }),
    // Special characters
    fc.constant('null'),
    fc.constant('undefined'),
    fc.constant('NaN'),
    fc.constant('true'),
    fc.constant('false'),
    fc.constant('123'),
    fc.constant('"just a string"'),
    fc.constant('[]'),
    // Malformed structures
    fc.constant('}{'),
    fc.constant('{{}}'),
    fc.constant('[}'),
    fc.constant('{]'),
  );

/**
 * Generates valid JSON but invalid JSON-RPC messages.
 */
const arbitraryInvalidJsonRpc = (): fc.Arbitrary<string> =>
  fc.oneof(
    // Missing jsonrpc field
    fc.constant('{"id":"1","method":"test"}'),
    // Wrong jsonrpc version
    fc.constant('{"jsonrpc":"1.0","id":"1","method":"test"}'),
    fc.constant('{"jsonrpc":"3.0","id":"1","method":"test"}'),
    // Missing required fields
    fc.constant('{"jsonrpc":"2.0"}'), // No method, id, result, or error
    fc.constant('{"jsonrpc":"2.0","id":"1"}'), // Request without method
    // Invalid field types
    fc.constant('{"jsonrpc":"2.0","id":"1","method":123}'), // Method not string
    fc.constant('{"jsonrpc":"2.0","id":{},"method":"test"}'), // ID is object
    // Both result and error
    fc.constant('{"jsonrpc":"2.0","id":"1","result":{},"error":{"code":-32600,"message":"err"}}'),
    // Error without code
    fc.constant('{"jsonrpc":"2.0","id":"1","error":{"message":"err"}}'),
    // Error without message
    fc.constant('{"jsonrpc":"2.0","id":"1","error":{"code":-32600}}'),
    // Random valid JSON objects
    fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.jsonValue())
      .map(obj => JSON.stringify(obj)),
    // Arrays (valid JSON but not JSON-RPC)
    fc.array(fc.jsonValue(), { maxLength: 5 }).map(arr => JSON.stringify(arr)),
  );

/**
 * Generates any malformed message (invalid JSON or invalid JSON-RPC).
 * Excludes whitespace-only strings as those are skipped by the parser.
 */
const arbitraryMalformedMessage = (): fc.Arbitrary<string> =>
  fc.oneof(arbitraryInvalidJson(), arbitraryInvalidJsonRpc())
    .filter(s => s.trim().length > 0); // Ensure not whitespace-only

/**
 * Generates arbitrary string input (for crash testing).
 */
const arbitraryArbitraryString = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string(), // Any string
    fc.unicodeString(), // Unicode strings
    fc.fullUnicodeString(), // Full unicode including surrogates
    fc.stringOf(fc.constantFrom('\n', '\r', '\t', '\0', ' ')), // Whitespace
    fc.stringOf(fc.char()), // ASCII chars
  );

// ============================================================================
// Property 25: Parse Error Recovery
// ============================================================================

describe('Property 25: Parse Error Recovery', () => {
  /**
   * **Validates: Requirements 8.4**
   */

  // --------------------------------------------------------------------------
  // Property 25.1: Any invalid JSON should return null from decode() without throwing
  // --------------------------------------------------------------------------
  describe('invalid JSON returns null without throwing', () => {
    it('any invalid JSON should return null from decode() without throwing', () => {
      fc.assert(
        fc.property(arbitraryInvalidJson(), (invalidJson) => {
          const logger = createMockLogger();

          // Should not throw
          let result: JsonRpcMessage | null;
          let threw = false;
          try {
            result = decode(invalidJson, { logger });
          } catch {
            threw = true;
            result = null;
          }

          // Must not throw
          expect(threw).toBe(false);
          // Must return null for invalid JSON
          expect(result).toBeNull();
          // Must log the error
          expect(logger.error).toHaveBeenCalled();

          return !threw && result === null;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25.2: Any invalid JSON-RPC message should return null from decode() without throwing
  // --------------------------------------------------------------------------
  describe('invalid JSON-RPC returns null without throwing', () => {
    it('any invalid JSON-RPC message should return null from decode() without throwing', () => {
      fc.assert(
        fc.property(arbitraryInvalidJsonRpc(), (invalidJsonRpc) => {
          const logger = createMockLogger();

          // Should not throw
          let result: JsonRpcMessage | null;
          let threw = false;
          try {
            result = decode(invalidJsonRpc, { logger });
          } catch {
            threw = true;
            result = null;
          }

          // Must not throw
          expect(threw).toBe(false);
          // Must return null for invalid JSON-RPC
          expect(result).toBeNull();
          // Must log the error
          expect(logger.error).toHaveBeenCalled();

          return !threw && result === null;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25.3: The NDJSON parser should continue processing after encountering invalid lines
  // --------------------------------------------------------------------------
  describe('NDJSON parser continues after invalid lines', () => {
    it('the NDJSON parser should continue processing after encountering invalid lines', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              arbitraryValidMessage().map(msg => ({ valid: true, line: JSON.stringify(msg) })),
              arbitraryMalformedMessage().map(line => ({ valid: false, line }))
            ),
            { minLength: 1, maxLength: 20 }
          ),
          (items) => {
            const events: NdjsonParserEvent[] = [];
            const logger = createMockLogger();
            const parser = createNdjsonParser(
              (event) => events.push(event),
              { logger }
            );

            // Write all lines
            for (const item of items) {
              parser.write(item.line + '\n');
            }

            // Count expected valid and invalid messages
            const expectedValid = items.filter(i => i.valid).length;
            const expectedInvalid = items.filter(i => !i.valid).length;

            // Count actual message and error events
            const messageEvents = events.filter(e => e.type === 'message');
            const errorEvents = events.filter(e => e.type === 'error');

            // All valid messages should be parsed
            expect(messageEvents.length).toBe(expectedValid);
            // All invalid messages should produce errors
            expect(errorEvents.length).toBe(expectedInvalid);
            // Total events should match total items
            expect(events.length).toBe(items.length);

            return messageEvents.length === expectedValid && errorEvents.length === expectedInvalid;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25.4: Valid messages after invalid messages should still be parsed correctly
  // --------------------------------------------------------------------------
  describe('valid messages after invalid messages are parsed correctly', () => {
    it('valid messages after invalid messages should still be parsed correctly', () => {
      fc.assert(
        fc.property(
          // Generate a sequence with at least one invalid followed by at least one valid
          fc.tuple(
            fc.array(arbitraryMalformedMessage(), { minLength: 1, maxLength: 5 }),
            fc.array(arbitraryValidMessage(), { minLength: 1, maxLength: 5 })
          ),
          ([invalidMessages, validMessages]) => {
            const logger = createMockLogger();

            // Build NDJSON data: invalid messages first, then valid messages
            const invalidLines = invalidMessages.join('\n');
            const validLines = validMessages.map(m => JSON.stringify(m)).join('\n');
            const allData = invalidLines + '\n' + validLines;

            // Decode all
            const results = decodeMultiple(allData, { logger });

            // All valid messages should be decoded
            expect(results.length).toBe(validMessages.length);

            // Each decoded message should match the original
            for (let i = 0; i < validMessages.length; i++) {
              expect(results[i]).toEqual(validMessages[i]);
            }

            // Errors should have been logged for invalid messages
            expect(logger.error).toHaveBeenCalled();

            return results.length === validMessages.length;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25.5: The parser should not crash on any arbitrary string input
  // --------------------------------------------------------------------------
  describe('parser does not crash on arbitrary input', () => {
    it('the parser should not crash on any arbitrary string input', () => {
      fc.assert(
        fc.property(arbitraryArbitraryString(), (arbitraryInput) => {
          const logger = createMockLogger();

          // decode() should not throw
          let decodeThrew = false;
          try {
            decode(arbitraryInput, { logger });
          } catch {
            decodeThrew = true;
          }
          expect(decodeThrew).toBe(false);

          // decodeWithError() should not throw
          let decodeWithErrorThrew = false;
          try {
            decodeWithError(arbitraryInput, { logger });
          } catch {
            decodeWithErrorThrew = true;
          }
          expect(decodeWithErrorThrew).toBe(false);

          // NDJSON parser should not throw
          let parserThrew = false;
          try {
            const events: NdjsonParserEvent[] = [];
            const parser = createNdjsonParser((e) => events.push(e), { logger });
            parser.write(arbitraryInput);
            parser.flush();
          } catch {
            parserThrew = true;
          }
          expect(parserThrew).toBe(false);

          return !decodeThrew && !decodeWithErrorThrew && !parserThrew;
        }),
        { numRuns: 100 }
      );
    });

    it('the parser should not crash on binary-like data', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 1000 }).map(arr =>
            String.fromCharCode(...arr)
          ),
          (binaryLikeData) => {
            const logger = createMockLogger();

            // Should not throw
            let threw = false;
            try {
              decode(binaryLikeData, { logger });
            } catch {
              threw = true;
            }

            expect(threw).toBe(false);
            return !threw;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25.6: Parse errors should be logged (via the logger interface)
  // --------------------------------------------------------------------------
  describe('parse errors are logged', () => {
    it('parse errors should be logged via the logger interface', () => {
      fc.assert(
        fc.property(arbitraryMalformedMessage(), (malformedMessage) => {
          const logger = createMockLogger();

          // Decode the malformed message
          decode(malformedMessage, { logger });

          // Logger.error should have been called
          expect(logger.error).toHaveBeenCalled();

          // The error call should include relevant information
          const errorCalls = logger.errorCalls;
          expect(errorCalls.length).toBeGreaterThan(0);

          // First argument should be a string message
          const firstCall = errorCalls[0];
          expect(typeof firstCall![0]).toBe('string');

          return logger.error.mock.calls.length > 0;
        }),
        { numRuns: 100 }
      );
    });

    it('NDJSON parser should emit error events for malformed lines', () => {
      fc.assert(
        fc.property(arbitraryMalformedMessage(), (malformedMessage) => {
          const events: NdjsonParserEvent[] = [];
          const logger = createMockLogger();
          const parser = createNdjsonParser((e) => events.push(e), { logger });

          // Write the malformed message
          parser.write(malformedMessage + '\n');

          // Should emit an error event
          const errorEvents = events.filter(e => e.type === 'error');
          expect(errorEvents.length).toBe(1);

          // Error event should have error details
          const errorEvent = errorEvents[0]!;
          if (errorEvent.type === 'error') {
            expect(errorEvent.error).toBeDefined();
            expect(typeof errorEvent.error.code).toBe('number');
            expect(typeof errorEvent.error.message).toBe('string');
          }

          return errorEvents.length === 1;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Additional robustness tests
  // --------------------------------------------------------------------------
  describe('additional robustness tests', () => {
    it('interleaved valid and invalid messages are all processed', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              arbitraryValidMessage().map(msg => ({ valid: true, msg })),
              arbitraryMalformedMessage().map(line => ({ valid: false, line }))
            ),
            { minLength: 2, maxLength: 20 }
          ),
          (items) => {
            const events: NdjsonParserEvent[] = [];
            const logger = createMockLogger();
            const parser = createNdjsonParser((e) => events.push(e), { logger });

            // Write all items
            for (const item of items) {
              if (item.valid) {
                parser.write(JSON.stringify((item as { valid: true; msg: JsonRpcMessage }).msg) + '\n');
              } else {
                parser.write((item as { valid: false; line: string }).line + '\n');
              }
            }

            // Count results
            const validCount = items.filter(i => i.valid).length;
            const invalidCount = items.filter(i => !i.valid).length;

            const messageEvents = events.filter(e => e.type === 'message');
            const errorEvents = events.filter(e => e.type === 'error');

            // All items should be processed
            expect(messageEvents.length).toBe(validCount);
            expect(errorEvents.length).toBe(invalidCount);

            return messageEvents.length === validCount && errorEvents.length === invalidCount;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty and whitespace-only lines do not cause errors', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.constant(''),
              fc.constant('   '),
              fc.constant('\t'),
              fc.constant('\n'),
              fc.constant('  \t  ')
            ),
            { minLength: 1, maxLength: 10 }
          ),
          (emptyLines) => {
            const events: NdjsonParserEvent[] = [];
            const logger = createMockLogger();
            const parser = createNdjsonParser((e) => events.push(e), { logger });

            // Write empty lines
            for (const line of emptyLines) {
              parser.write(line + '\n');
            }

            // No events should be emitted for empty lines
            expect(events.length).toBe(0);

            return events.length === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('very long invalid lines are handled gracefully', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 10000 }),
          (length) => {
            const logger = createMockLogger();
            const longLine = 'x'.repeat(length);

            // Should not throw
            let threw = false;
            try {
              decode(longLine, { logger, maxLineLength: 50 });
            } catch {
              threw = true;
            }

            expect(threw).toBe(false);
            return !threw;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('decodeWithError returns proper error structure for all malformed inputs', () => {
      fc.assert(
        fc.property(arbitraryMalformedMessage(), (malformedMessage) => {
          const logger = createMockLogger();
          const result = decodeWithError(malformedMessage, { logger });

          // Should return failure result
          expect(result.success).toBe(false);

          if (!result.success) {
            // Error should have required fields
            expect(typeof result.error.code).toBe('number');
            expect(typeof result.error.message).toBe('string');

            // Code should be a valid JSON-RPC error code
            expect(
              result.error.code === JSON_RPC_ERROR_CODES.PARSE_ERROR ||
              result.error.code === JSON_RPC_ERROR_CODES.INVALID_REQUEST
            ).toBe(true);
          }

          return !result.success;
        }),
        { numRuns: 100 }
      );
    });
  });
});
