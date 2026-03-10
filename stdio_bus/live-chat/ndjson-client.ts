// ============================================================================
// MCP-ACP Bridge Server — NDJSON Client (TCP/Unix Socket Transport)
// ============================================================================
// Manages the TCP or Unix socket connection to the stdio Bus kernel and
// handles NDJSON framing, reconnection with exponential backoff, and
// connection state tracking.
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 2.5

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { serializeNdjson, deserializeNdjsonLine } from './ndjson';
import { DisconnectedError } from './errors';
import type { ConnectionState } from './types';

// ----------------------------------------------------------------------------
// Options
// ----------------------------------------------------------------------------

export interface NDJSONClientOptions {
  address: string;              // "host:port" for TCP, "/path/to/socket" for Unix
  connectionType: 'tcp' | 'unix';
  maxReconnectAttempts: number;
  baseReconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

// ----------------------------------------------------------------------------
// Event map (for typed emitter)
// ----------------------------------------------------------------------------

export interface NDJSONClientEvents {
  message: (msg: unknown) => void;
  error: (err: Error) => void;
  disconnect: () => void;
  reconnect: (attempt: number) => void;
  framingError: (line: string, err: Error) => void;
}

// ----------------------------------------------------------------------------
// Implementation
// ----------------------------------------------------------------------------

export class NDJSONClient extends EventEmitter {
  private readonly opts: NDJSONClientOptions;
  private socket: net.Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lineBuffer = '';

  // Track whether close() was called explicitly so we don't reconnect.
  private closedByUser = false;

  constructor(opts: NDJSONClientOptions) {
    super();
    this.opts = opts;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Establish the initial connection. Resolves when connected. */
  connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return Promise.resolve();
    }
    if (this.state === 'closed') {
      return Promise.reject(new Error('Client has been closed'));
    }

    this.closedByUser = false;
    this.reconnectAttempt = 0;
    return this.createConnection();
  }

  /** Send a message over the socket. Throws DisconnectedError if not connected. */
  send(message: unknown): void {
    if (this.state !== 'connected' || !this.socket) {
      throw new DisconnectedError('Cannot send: not connected to stdio Bus');
    }
    const data = serializeNdjson(message);
    this.socket.write(data);
  }

  /** Gracefully close the connection. No reconnection will be attempted. */
  close(): Promise<void> {
    this.closedByUser = true;
    this.clearReconnectTimer();

    const prevState = this.state;
    this.state = 'closed';

    if (prevState === 'closed' || prevState === 'disconnected') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      if (this.socket) {
        const sock = this.socket;
        this.socket = null;
        // If the socket is already destroyed, resolve immediately
        if (sock.destroyed) {
          resolve();
          return;
        }
        sock.once('close', () => resolve());
        sock.destroy();
      } else {
        resolve();
      }
    });
  }

  /** Returns true when the connection is established and ready. */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /** Returns the current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  // --------------------------------------------------------------------------
  // Connection management (private)
  // --------------------------------------------------------------------------

  private createConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.state = this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
      this.lineBuffer = '';

      const connectOpts = this.buildConnectOptions();
      const socket = net.createConnection(connectOpts);
      this.socket = socket;

      const onConnect = () => {
        cleanup();
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this.wireSocketEvents(socket);
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        // If this is the initial connect() call (not a reconnect), reject the promise.
        if (this.reconnectAttempt === 0 && this.state === 'connecting') {
          this.state = 'disconnected';
          reject(err);
        }
        // Otherwise the error is handled by scheduleReconnect via the socket events.
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  private buildConnectOptions(): net.NetConnectOpts {
    if (this.opts.connectionType === 'unix') {
      return { path: this.opts.address };
    }
    // TCP: parse "host:port"
    const lastColon = this.opts.address.lastIndexOf(':');
    if (lastColon === -1) {
      throw new Error(`Invalid TCP address: expected "host:port", got "${this.opts.address}"`);
    }
    const host = this.opts.address.slice(0, lastColon);
    const port = parseInt(this.opts.address.slice(lastColon + 1), 10);
    if (isNaN(port)) {
      throw new Error(`Invalid TCP port in address "${this.opts.address}"`);
    }
    return { host, port };
  }

  /**
   * Wire up data/error/close events on an established socket.
   * Called once after a successful connect.
   */
  private wireSocketEvents(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString('utf-8'));
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      if (this.closedByUser || this.state === 'closed') {
        return;
      }
      this.state = 'disconnected';
      this.emit('disconnect');
      this.scheduleReconnect();
    });
  }

  // --------------------------------------------------------------------------
  // NDJSON stream parsing
  // --------------------------------------------------------------------------

  /**
   * Append incoming data to the line buffer and emit parsed messages.
   * Handles partial lines by buffering until a newline is received.
   * Requirements: 1.3, 2.4, 2.5
   */
  private handleData(data: string): void {
    this.lineBuffer += data;

    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx);
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);

      // Skip empty lines (e.g. consecutive newlines)
      if (line.length === 0) {
        continue;
      }

      try {
        const parsed = deserializeNdjsonLine(line);
        this.emit('message', parsed);
      } catch (err) {
        // Requirement 1.4: emit framing error and discard malformed line
        this.emit('framingError', line, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  // --------------------------------------------------------------------------
  // Reconnection with exponential backoff
  // --------------------------------------------------------------------------

  /**
   * Schedule a reconnection attempt using exponential backoff with jitter.
   * delay = min(baseDelay × 2^attempt + jitter, maxDelay)
   * Requirement: 1.5
   */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.state === 'closed') {
      return;
    }

    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) {
      // Max attempts exhausted — stay disconnected
      this.state = 'disconnected';
      this.emit('disconnect');
      return;
    }

    this.state = 'reconnecting';
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt++;

    const jitter = Math.random() * this.opts.baseReconnectDelayMs;
    const delay = Math.min(
      this.opts.baseReconnectDelayMs * Math.pow(2, attempt) + jitter,
      this.opts.maxReconnectDelayMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.emit('reconnect', this.reconnectAttempt);
      this.attemptReconnect();
    }, delay);
  }

  private attemptReconnect(): void {
    if (this.closedByUser || this.state === 'closed') {
      return;
    }

    this.lineBuffer = '';
    const connectOpts = this.buildConnectOptions();
    const socket = net.createConnection(connectOpts);
    this.socket = socket;

    socket.once('connect', () => {
      socket.removeAllListeners('error');
      this.state = 'connected';
      this.reconnectAttempt = 0;
      this.wireSocketEvents(socket);
    });

    socket.once('error', () => {
      // Connection failed — try again
      socket.destroy();
      this.scheduleReconnect();
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
