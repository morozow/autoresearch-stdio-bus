// ============================================================================
// MCP-ACP Bridge Server — NDJSON Framing Functions
// ============================================================================
// Pure, independently testable serialization and deserialization for
// Newline-Delimited JSON (NDJSON) framing.
//
// Requirements: 1.2, 1.6, 2.1, 2.2, 2.3

/**
 * Serialize a JSON-serializable value into an NDJSON line.
 *
 * Returns `JSON.stringify(obj) + '\n'`.
 *
 * Invariant: the result contains exactly one `\n` character, at the very end.
 * `JSON.stringify` never produces embedded newlines for any valid JSON value,
 * so this invariant holds by construction.
 */
export function serializeNdjson(obj: unknown): string {
  const json = JSON.stringify(obj);
  // JSON.stringify returns undefined for unsupported values (functions, symbols, undefined).
  // Guard against that so callers get a clear error rather than "undefined\n".
  if (json === undefined) {
    throw new TypeError('Value is not JSON-serializable');
  }
  return json + '\n';
}

/**
 * Deserialize a single NDJSON line (with or without trailing newline) into a value.
 *
 * Throws `SyntaxError` on invalid JSON — callers are expected to handle this
 * (e.g. emit a framing error event and discard the line).
 */
export function deserializeNdjsonLine(line: string): unknown {
  return JSON.parse(line);
}
