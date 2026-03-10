// ============================================================================
// MCP-ACP Bridge Server — Request Tracker
// ============================================================================
// Correlates outgoing JSON-RPC requests with incoming responses by id.
// Enforces the pending request capacity bound and per-request timeouts.
// ============================================================================

import type { JsonRpcId, JsonRpcResponse, PendingEntry } from './types';
import { CapacityExceededError, RequestTimeoutError } from './errors';

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

export interface RequestTrackerOptions {
  maxPending: number;       // default: 4096
  defaultTimeoutMs: number; // default: 30000, minimum: 1000
}

const DEFAULT_OPTIONS: RequestTrackerOptions = {
  maxPending: 4096,
  defaultTimeoutMs: 30_000,
};

const MIN_TIMEOUT_MS = 1000;

// ----------------------------------------------------------------------------
// RequestTracker interface
// ----------------------------------------------------------------------------

export interface RequestTracker {
  register(id: JsonRpcId, timeoutMs?: number): Promise<JsonRpcResponse>;
  resolve(response: JsonRpcResponse): boolean;
  cancelAll(reason: Error): void;
  pendingCount(): number;
  hasPending(id: JsonRpcId): boolean;
}

// ----------------------------------------------------------------------------
// Implementation
// ----------------------------------------------------------------------------

export function createRequestTracker(
  opts?: Partial<RequestTrackerOptions>,
): RequestTracker {
  const options: RequestTrackerOptions = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };

  // Clamp default timeout to minimum
  if (options.defaultTimeoutMs < MIN_TIMEOUT_MS) {
    options.defaultTimeoutMs = MIN_TIMEOUT_MS;
  }

  const pending = new Map<JsonRpcId, PendingEntry>();

  function register(id: JsonRpcId, timeoutMs?: number): Promise<JsonRpcResponse> {
    if (pending.size >= options.maxPending) {
      return Promise.reject(
        new CapacityExceededError(
          `Maximum pending requests (${options.maxPending}) exceeded`,
        ),
      );
    }

    // Determine effective timeout, enforce minimum
    let effectiveTimeout = timeoutMs ?? options.defaultTimeoutMs;
    if (effectiveTimeout < MIN_TIMEOUT_MS) {
      effectiveTimeout = MIN_TIMEOUT_MS;
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        pending.delete(id);
        reject(
          new RequestTimeoutError(
            `Request ${String(id)} timed out after ${effectiveTimeout}ms`,
            { id, timeoutMs: effectiveTimeout },
          ),
        );
      }, effectiveTimeout);

      // Prevent the timer from keeping the process alive
      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }

      const entry: PendingEntry = {
        id,
        registeredAt: Date.now(),
        timeoutMs: effectiveTimeout,
        timeoutHandle,
        resolve,
        reject,
      };

      pending.set(id, entry);
    });
  }

  function resolve(response: JsonRpcResponse): boolean {
    const entry = pending.get(response.id);
    if (!entry) {
      return false;
    }

    clearTimeout(entry.timeoutHandle);
    pending.delete(response.id);
    entry.resolve(response);
    return true;
  }

  function cancelAll(reason: Error): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(reason);
    }
    pending.clear();
  }

  function pendingCount(): number {
    return pending.size;
  }

  function hasPending(id: JsonRpcId): boolean {
    return pending.has(id);
  }

  return {
    register,
    resolve,
    cancelAll,
    pendingCount,
    hasPending,
  };
}
