/**
 * Unit tests for NDJSON codec.
 * 
 * Tests encoding/decoding of JSON-RPC 2.0 messages with NDJSON framing.
 * 
 * Validates: Requirements 8.1, 8.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encode,
  encodeMultiple,
  decode,
  decodeWithError,
  decodeMultiple,
  createNdjsonParser,
  splitNdjsonLines,
  createParseErrorResponse,
  CodecLogger,
  NdjsonParserEvent,
} from './codec';
import {
  JsonRpcMessage,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createResultMessage,
  JSON_RPC_ERROR_CODES,
} from './types';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockLogger = (): CodecLogger => ({
  error: vi.fn(),
  warn: vi.fn(),
});

// ============================================================================
// encode() Tests
// ============================================================================

describe('encode', () => {
  it('should serialize a request message to NDJSON', () => {
    const message = createRequest('req-1', 'test.method', { foo: 'bar' });
    const result = encode(message);

    expect(result).toBe('{"jsonrpc":"2.0","id":"req-1","method":"test.method","params":{"foo":"bar"}}\n');
  });

  it('should serialize a notification message to NDJSON', () => {
    const message = createNotification('test.notify', { data: 123 });
    const result = encode(message);

    expect(result).toBe('{"jsonrpc":"2.0","method":"test.notify","params":{"data":123}}\n');
  });

  it('should serialize a success response to NDJSON', () => {
    const message = createSuccessResponse('resp-1', { result: 'ok' });
    const result = encode(message);

    expect(result).toBe('{"jsonrpc":"2.0","id":"resp-1","result":{"result":"ok"}}\n');
  });

  it('should serialize an error response to NDJSON', () => {
    const message = createErrorResponse('err-1', -32600, 'Invalid request');
    const result = encode(message);

    expect(result).toBe('{"jsonrpc":"2.0","id":"err-1","error":{"code":-32600,"message":"Invalid request"}}\n');
  });

  it('should serialize a Result_Message to NDJSON', () => {
    const message = createResultMessage({
      commit: 'a1b2c3d',
      valBpb: 0.9979,
      memoryGb: 44.0,
      status: 'keep',
      description: 'test experiment',
      agentId: 'agent-0',
      timestamp: '2025-01-15T10:00:00Z',
      branch: 'autoresearch/swarm/agent-0',
    });
    const result = encode(message);

    expect(result).toContain('"method":"experiment.result"');
    expect(result).toContain('"commit":"a1b2c3d"');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('should always end with a newline', () => {
    const message = createRequest(1, 'test');
    const result = encode(message);

    expect(result.endsWith('\n')).toBe(true);
    expect(result.split('\n').length).toBe(2); // content + empty after newline
  });
});

// ============================================================================
// encodeMultiple() Tests
// ============================================================================

describe('encodeMultiple', () => {
  it('should serialize multiple messages to NDJSON', () => {
    const messages: JsonRpcMessage[] = [
      createRequest('1', 'method1'),
      createNotification('method2'),
      createSuccessResponse('2', { ok: true }),
    ];
    const result = encodeMultiple(messages);

    const lines = result.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).method).toBe('method1');
    expect(JSON.parse(lines[1]!).method).toBe('method2');
    expect(JSON.parse(lines[2]!).result.ok).toBe(true);
  });

  it('should return empty string for empty array', () => {
    const result = encodeMultiple([]);
    expect(result).toBe('');
  });
});

// ============================================================================
// decode() Tests
// ============================================================================

describe('decode', () => {
  it('should parse a valid request message', () => {
    const line = '{"jsonrpc":"2.0","id":"req-1","method":"test.method","params":{"foo":"bar"}}';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect(result?.jsonrpc).toBe('2.0');
    expect((result as any).id).toBe('req-1');
    expect((result as any).method).toBe('test.method');
  });

  it('should parse a valid notification message', () => {
    const line = '{"jsonrpc":"2.0","method":"test.notify","params":{"data":123}}';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect((result as any).method).toBe('test.notify');
    expect((result as any).id).toBeUndefined();
  });

  it('should parse a valid success response', () => {
    const line = '{"jsonrpc":"2.0","id":"resp-1","result":{"ok":true}}';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect((result as any).result.ok).toBe(true);
  });

  it('should parse a valid error response', () => {
    const line = '{"jsonrpc":"2.0","id":"err-1","error":{"code":-32600,"message":"Invalid"}}';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect((result as any).error.code).toBe(-32600);
  });

  it('should handle trailing newline', () => {
    const line = '{"jsonrpc":"2.0","id":"1","method":"test"}\n';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect((result as any).method).toBe('test');
  });

  it('should handle trailing whitespace', () => {
    const line = '{"jsonrpc":"2.0","id":"1","method":"test"}  \n  ';
    const result = decode(line);

    expect(result).not.toBeNull();
    expect((result as any).method).toBe('test');
  });

  it('should return null for empty line', () => {
    const result = decode('');
    expect(result).toBeNull();
  });

  it('should return null for whitespace-only line', () => {
    const result = decode('   \n  ');
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const logger = createMockLogger();
    const result = decode('not valid json', { logger });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it('should return null for invalid JSON-RPC message', () => {
    const logger = createMockLogger();
    const result = decode('{"foo":"bar"}', { logger });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it('should skip validation when validateMessages is false', () => {
    const result = decode('{"foo":"bar"}', { validateMessages: false });

    expect(result).not.toBeNull();
    expect((result as any).foo).toBe('bar');
  });

  it('should reject lines exceeding maxLineLength', () => {
    const logger = createMockLogger();
    const longLine = '{"jsonrpc":"2.0","id":"1","method":"test","params":{"data":"' + 'x'.repeat(1000) + '"}}';
    const result = decode(longLine, { logger, maxLineLength: 100 });

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

// ============================================================================
// decodeWithError() Tests
// ============================================================================

describe('decodeWithError', () => {
  it('should return success result for valid message', () => {
    const line = '{"jsonrpc":"2.0","id":"1","method":"test"}';
    const result = decodeWithError(line);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.message as any).method).toBe('test');
    }
  });

  it('should return error result for invalid JSON', () => {
    const result = decodeWithError('not json');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
      expect(result.error.message).toContain('Invalid JSON');
    }
  });

  it('should return error result for invalid JSON-RPC', () => {
    const result = decodeWithError('{"foo":"bar"}');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    }
  });

  it('should include line preview in error', () => {
    const result = decodeWithError('invalid');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.line).toBe('invalid');
    }
  });

  it('should truncate long lines in error', () => {
    const longLine = 'x'.repeat(200);
    const result = decodeWithError(longLine);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.line?.length).toBeLessThanOrEqual(103); // 100 + '...'
    }
  });
});

// ============================================================================
// decodeMultiple() Tests
// ============================================================================

describe('decodeMultiple', () => {
  it('should decode multiple valid messages', () => {
    const data = [
      '{"jsonrpc":"2.0","id":"1","method":"m1"}',
      '{"jsonrpc":"2.0","id":"2","method":"m2"}',
      '{"jsonrpc":"2.0","id":"3","method":"m3"}',
    ].join('\n');

    const results = decodeMultiple(data);

    expect(results.length).toBe(3);
    expect((results[0] as any).method).toBe('m1');
    expect((results[1] as any).method).toBe('m2');
    expect((results[2] as any).method).toBe('m3');
  });

  it('should skip invalid lines and continue', () => {
    const logger = createMockLogger();
    const data = [
      '{"jsonrpc":"2.0","id":"1","method":"m1"}',
      'invalid json',
      '{"jsonrpc":"2.0","id":"2","method":"m2"}',
    ].join('\n');

    const results = decodeMultiple(data, { logger });

    expect(results.length).toBe(2);
    expect((results[0] as any).method).toBe('m1');
    expect((results[1] as any).method).toBe('m2');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should handle empty lines', () => {
    const data = [
      '{"jsonrpc":"2.0","id":"1","method":"m1"}',
      '',
      '{"jsonrpc":"2.0","id":"2","method":"m2"}',
    ].join('\n');

    const results = decodeMultiple(data);

    expect(results.length).toBe(2);
  });
});

// ============================================================================
// createNdjsonParser() Tests
// ============================================================================

describe('createNdjsonParser', () => {
  let events: NdjsonParserEvent[];
  let callback: (event: NdjsonParserEvent) => void;

  beforeEach(() => {
    events = [];
    callback = (event) => events.push(event);
  });

  it('should parse complete lines', () => {
    const parser = createNdjsonParser(callback);

    parser.write('{"jsonrpc":"2.0","id":"1","method":"test"}\n');

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('message');
    const event = events[0]!;
    if (event.type === 'message') {
      expect((event.message as any).method).toBe('test');
    }
  });

  it('should buffer partial lines', () => {
    const parser = createNdjsonParser(callback);

    parser.write('{"jsonrpc":"2.0",');
    expect(events.length).toBe(0);

    parser.write('"id":"1","method":"test"}\n');
    expect(events.length).toBe(1);
  });

  it('should handle multiple messages in one chunk', () => {
    const parser = createNdjsonParser(callback);

    parser.write(
      '{"jsonrpc":"2.0","id":"1","method":"m1"}\n' +
      '{"jsonrpc":"2.0","id":"2","method":"m2"}\n' +
      '{"jsonrpc":"2.0","id":"3","method":"m3"}\n'
    );

    expect(events.length).toBe(3);
  });

  it('should emit error events for invalid lines', () => {
    const parser = createNdjsonParser(callback);

    parser.write('invalid json\n');

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('error');
  });

  it('should continue processing after errors', () => {
    const parser = createNdjsonParser(callback);

    parser.write('invalid\n{"jsonrpc":"2.0","id":"1","method":"test"}\n');

    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('error');
    expect(events[1]!.type).toBe('message');
  });

  it('should skip empty lines', () => {
    const parser = createNdjsonParser(callback);

    parser.write('\n\n{"jsonrpc":"2.0","id":"1","method":"test"}\n\n');

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('message');
  });

  it('should flush remaining buffer', () => {
    const parser = createNdjsonParser(callback);

    parser.write('{"jsonrpc":"2.0","id":"1","method":"test"}');
    expect(events.length).toBe(0);

    parser.flush();
    expect(events.length).toBe(1);
  });

  it('should reset buffer', () => {
    const parser = createNdjsonParser(callback);

    parser.write('{"jsonrpc":"2.0",');
    expect(parser.getBuffer()).toBe('{"jsonrpc":"2.0",');

    parser.reset();
    expect(parser.getBuffer()).toBe('');
  });

  it('should handle buffer overflow', () => {
    const parser = createNdjsonParser(callback, { maxLineLength: 50 });

    // Write a very long line without newline
    parser.write('x'.repeat(200));

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('error');
    const event = events[0]!;
    if (event.type === 'error') {
      expect(event.error.message).toContain('Buffer overflow');
    }
  });

  it('should handle interleaved partial and complete messages', () => {
    const parser = createNdjsonParser(callback);

    parser.write('{"jsonrpc":"2.0","id":"1","method":"m1"}\n{"jsonrpc":');
    expect(events.length).toBe(1);

    parser.write('"2.0","id":"2","method":"m2"}\n');
    expect(events.length).toBe(2);
  });
});

// ============================================================================
// splitNdjsonLines() Tests
// ============================================================================

describe('splitNdjsonLines', () => {
  it('should split NDJSON data into lines', () => {
    const data = 'line1\nline2\nline3';
    const lines = splitNdjsonLines(data);

    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('should filter empty lines', () => {
    const data = 'line1\n\nline2\n\n\nline3\n';
    const lines = splitNdjsonLines(data);

    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('should filter whitespace-only lines', () => {
    const data = 'line1\n   \nline2\n  \t  \nline3';
    const lines = splitNdjsonLines(data);

    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });
});

// ============================================================================
// createParseErrorResponse() Tests
// ============================================================================

describe('createParseErrorResponse', () => {
  it('should create a valid error response', () => {
    const error = {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: 'Invalid JSON',
    };
    const response = createParseErrorResponse(error);

    const parsed = JSON.parse(response.trim());
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toBe('Invalid JSON');
  });

  it('should include line data when provided', () => {
    const error = {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: 'Invalid JSON',
      line: 'bad data',
    };
    const response = createParseErrorResponse(error);

    const parsed = JSON.parse(response.trim());
    expect(parsed.error.data.line).toBe('bad data');
  });

  it('should end with newline', () => {
    const error = {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: 'Error',
    };
    const response = createParseErrorResponse(error);

    expect(response.endsWith('\n')).toBe(true);
  });
});

// ============================================================================
// Round-trip Tests
// ============================================================================

describe('encode/decode round-trip', () => {
  it('should preserve request message through round-trip', () => {
    const original = createRequest('req-123', 'test.method', { key: 'value', num: 42 });
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded).toEqual(original);
  });

  it('should preserve notification message through round-trip', () => {
    const original = createNotification('test.notify', { items: [1, 2, 3] });
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded).toEqual(original);
  });

  it('should preserve success response through round-trip', () => {
    const original = createSuccessResponse('resp-456', { data: { nested: true } });
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded).toEqual(original);
  });

  it('should preserve error response through round-trip', () => {
    const original = createErrorResponse('err-789', -32600, 'Invalid request', { detail: 'extra' });
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded).toEqual(original);
  });

  it('should preserve Result_Message through round-trip', () => {
    const original = createResultMessage({
      commit: 'a1b2c3d',
      valBpb: 0.9979,
      memoryGb: 44.0,
      status: 'keep',
      description: 'test experiment',
      agentId: 'agent-0',
      timestamp: '2025-01-15T10:00:00Z',
      branch: 'autoresearch/swarm/agent-0',
    });
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded).toEqual(original);
  });
});
