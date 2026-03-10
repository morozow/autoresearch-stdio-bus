/**
 * Broadcast module exports.
 * 
 * This module provides the StateBroadcaster for broadcasting experiment results
 * and state updates to all connected agents.
 */

export {
  StateBroadcaster,
  createStateBroadcaster,
  defaultStateBroadcasterLogger,
  DEFAULT_MAX_PENDING_MESSAGES,
  DEFAULT_BROADCAST_TIMEOUT_MS,
} from './state-broadcaster';

export type {
  StateBroadcasterOptions,
  StateBroadcasterLogger,
  BroadcastCallback,
  PriorityCallback,
  SyncCallback,
  NewBestNotification,
  SyncBroadcast,
} from './state-broadcaster';
