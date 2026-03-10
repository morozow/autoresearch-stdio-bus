/**
 * NDJSON codec for JSON-RPC 2.0 message serialization/deserialization.
 * 
 * NDJSON (Newline Delimited JSON) format: one JSON object per line.
 * 
 * Validates: Requirements 8.1, 8.4
 */

import {
  JsonRpcMessage,
  validateJsonRpcMessage,
  JSON_RPC_ERROR_CODES,
} from './types';

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Logger interface for codec error reporting.
 * Allows injection of custom loggers for testing and production use.
 */
export interface CodecLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultLogger: CodecLogger = {
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[codec] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[codec] ${message}`, context ?? '');
  },
};

// ============================================================================
// Codec Configuration
// ============================================================================

/**
 * Configuration options for the NDJSON codec.
 */
export interface CodecOptions {
  /** Logger for error reporting. Defaults to console logger. */
  logger?: CodecLogger;
  /** Whether to validate messages against JSON-RPC 2.0 schema. Defaults to true. */
  validateMessages?: boolean;
  /** Maximum line length in bytes. Lines exceeding this are rejected. Defaults to 1MB. */
  maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024; // 1MB

// ============================================================================
// Encode Function
// ============================================================================

/**
 * Serializes a JSON-RPC message to an NDJSON line.
 * 
 * @param message - The JSON-RPC message to serialize
 * @returns The serialized message as a single line with newline terminator
 * @throws Error if message cannot be serialized (e.g., circular references)
 * 
 * Validates: Requirement 8.1
 */
export function encode(message: JsonRpcMessage): string {
  // JSON.stringify handles the serialization
  // We add a newline at the end for NDJSON format
  return JSON.stringify(message) + '\n';
}

/**
 * Serializes multiple JSON-RPC messages to NDJSON format.
 * 
 * @param messages - Array of JSON-RPC messages to serialize
 * @returns The serialized messages as NDJSON string
 */
export function encodeMultiple(messages: JsonRpcMessage[]): string {
  return messages.map(encode).join('');
}

// ============================================================================
// Decode Function
// ============================================================================

/**
 * Parse error details returned when decoding fails.
 */
export interface ParseError {
  code: number;
  message: string;
  line?: string;
  position?: number;
}

/**
 * Result of a decode operation.
 */
export type DecodeResult =
  | { success: true; message: JsonRpcMessage }
  | { success: false; error: ParseError };

/**
 * Parses an NDJSON line into a JSON-RPC message.
 * 
 * Returns null on parse errors, logging the error for debugging.
 * This allows processing to continue with subsequent messages.
 * 
 * @param line - The NDJSON line to parse (may include trailing newline)
 * @param options - Optional codec configuration
 * @returns The parsed message, or null if parsing failed
 * 
 * Validates: Requirements 8.1, 8.4
 */
export function decode(
  line: string,
  options: CodecOptions = {}
): JsonRpcMessage | null {
  const result = decodeWithError(line, options);
  return result.success ? result.message : null;
}

/**
 * Parses an NDJSON line into a JSON-RPC message with detailed error information.
 * 
 * @param line - The NDJSON line to parse (may include trailing newline)
 * @param options - Optional codec configuration
 * @returns DecodeResult with either the parsed message or error details
 * 
 * Validates: Requirements 8.1, 8.4
 */
export function decodeWithError(
  line: string,
  options: CodecOptions = {}
): DecodeResult {
  const logger = options.logger ?? defaultLogger;
  const validateMessages = options.validateMessages ?? true;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  // Trim the line (remove trailing newline and whitespace)
  const trimmedLine = line.trim();

  // Handle empty lines gracefully
  if (trimmedLine.length === 0) {
    return {
      success: false,
      error: {
        code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
        message: 'Empty line',
      },
    };
  }

  // Check line length limit
  if (trimmedLine.length > maxLineLength) {
    const error: ParseError = {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: `Line exceeds maximum length of ${maxLineLength} bytes`,
      line: trimmedLine.substring(0, 100) + '...',
    };
    logger.error('Parse error: line too long', {
      length: trimmedLine.length,
      maxLength: maxLineLength
    });
    return { success: false, error };
  }

  // Attempt JSON parsing
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch (e) {
    const jsonError = e as SyntaxError;
    const error: ParseError = {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: `Invalid JSON: ${jsonError.message}`,
      line: trimmedLine.length > 100 ? trimmedLine.substring(0, 100) + '...' : trimmedLine,
    };
    logger.error('Parse error: invalid JSON', {
      error: jsonError.message,
      line: error.line
    });
    return { success: false, error };
  }

  // Validate JSON-RPC 2.0 structure if enabled
  if (validateMessages) {
    const validation = validateJsonRpcMessage(parsed);
    if (!validation.valid) {
      const error: ParseError = {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: `Invalid JSON-RPC message: ${validation.errors.map(e => e.message).join(', ')}`,
        line: trimmedLine.length > 100 ? trimmedLine.substring(0, 100) + '...' : trimmedLine,
      };
      logger.error('Parse error: invalid JSON-RPC message', {
        errors: validation.errors,
        line: error.line
      });
      return { success: false, error };
    }
  }

  return { success: true, message: parsed as JsonRpcMessage };
}

// ============================================================================
// NDJSON Stream Parser
// ============================================================================

/**
 * Event types emitted by the NDJSON parser.
 */
export type NdjsonParserEvent =
  | { type: 'message'; message: JsonRpcMessage }
  | { type: 'error'; error: ParseError };

/**
 * Callback for NDJSON parser events.
 */
export type NdjsonParserCallback = (event: NdjsonParserEvent) => void;

/**
 * NDJSON stream parser that handles partial lines and emits complete messages.
 * 
 * The parser buffers incoming data and emits messages as complete lines are received.
 * Parse errors are emitted as error events, allowing processing to continue.
 * 
 * Validates: Requirements 8.1, 8.4
 */
export interface NdjsonParser {
  /**
   * Writes data to the parser buffer.
   * Complete lines are parsed and emitted via the callback.
   * 
   * @param data - String data to parse (may contain partial lines)
   */
  write(data: string): void;

  /**
   * Flushes any remaining buffered data.
   * Call this when the stream ends to process any final partial line.
   */
  flush(): void;

  /**
   * Resets the parser state, clearing the buffer.
   */
  reset(): void;

  /**
   * Returns the current buffer contents (for debugging).
   */
  getBuffer(): string;
}

/**
 * Creates an NDJSON stream parser.
 * 
 * The parser handles:
 * - Partial lines (buffered until newline received)
 * - Multiple messages in a single chunk
 * - Parse errors (logged and skipped, processing continues)
 * - Empty lines (ignored)
 * 
 * @param callback - Function called for each parsed message or error
 * @param options - Optional codec configuration
 * @returns NdjsonParser instance
 * 
 * Validates: Requirements 8.1, 8.4
 */
export function createNdjsonParser(
  callback: NdjsonParserCallback,
  options: CodecOptions = {}
): NdjsonParser {
  const logger = options.logger ?? defaultLogger;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  let buffer = '';

  const processLine = (line: string): void => {
    // Skip empty lines
    if (line.trim().length === 0) {
      return;
    }

    const result = decodeWithError(line, options);
    if (result.success) {
      callback({ type: 'message', message: result.message });
    } else {
      callback({ type: 'error', error: result.error });
    }
  };

  return {
    write(data: string): void {
      buffer += data;

      // Check for buffer overflow
      if (buffer.length > maxLineLength * 2) {
        // Find the last newline and discard everything before it
        const lastNewline = buffer.lastIndexOf('\n');
        if (lastNewline === -1) {
          // No newline found, buffer is one huge line - emit error and clear
          logger.error('Buffer overflow: line too long, clearing buffer', {
            bufferLength: buffer.length,
            maxLength: maxLineLength,
          });
          callback({
            type: 'error',
            error: {
              code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
              message: `Buffer overflow: line exceeds maximum length of ${maxLineLength} bytes`,
            },
          });
          buffer = '';
          return;
        }
      }

      // Process complete lines
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        processLine(line);
      }
    },

    flush(): void {
      // Process any remaining data in the buffer
      if (buffer.trim().length > 0) {
        processLine(buffer);
      }
      buffer = '';
    },

    reset(): void {
      buffer = '';
    },

    getBuffer(): string {
      return buffer;
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Splits NDJSON data into individual lines.
 * 
 * @param data - NDJSON string data
 * @returns Array of non-empty lines
 */
export function splitNdjsonLines(data: string): string[] {
  return data.split('\n').filter(line => line.trim().length > 0);
}

/**
 * Decodes multiple NDJSON lines into messages.
 * Invalid lines are skipped (logged via options.logger).
 * 
 * @param data - NDJSON string data
 * @param options - Optional codec configuration
 * @returns Array of successfully parsed messages
 */
export function decodeMultiple(
  data: string,
  options: CodecOptions = {}
): JsonRpcMessage[] {
  const lines = splitNdjsonLines(data);
  const messages: JsonRpcMessage[] = [];

  for (const line of lines) {
    const message = decode(line, options);
    if (message !== null) {
      messages.push(message);
    }
  }

  return messages;
}

/**
 * Creates a parse error response for a given error.
 * Useful for responding to clients when a parse error occurs.
 * 
 * @param error - The parse error details
 * @returns JSON-RPC error response as NDJSON line
 */
export function createParseErrorResponse(error: ParseError): string {
  const response = {
    jsonrpc: '2.0' as const,
    id: null,
    error: {
      code: error.code,
      message: error.message,
      data: error.line ? { line: error.line } : undefined,
    },
  };
  return encode(response as JsonRpcMessage);
}
