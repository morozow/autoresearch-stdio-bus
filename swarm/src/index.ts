/**
 * stdio_bus Swarm Integration for Autoresearch
 *
 * This module provides swarm coordination for parallel AI research,
 * enabling N agents to work on N GPUs while sharing experiment results
 * through NDJSON message passing.
 */

// Re-export all public interfaces and classes

export const VERSION = '0.1.0';

// Configuration
export * from './config';

// Protocol types and codec
export * from './protocol';

// Session routing
export * from './routing';

// State management
export * from './state';

// Conflict resolution
export * from './conflict';

// Broadcasting
export * from './broadcast';

// GPU Worker
export * from './worker';

// Swarm Coordinator
export * from './coordinator';
