/**
 * State management module for stdio_bus swarm integration.
 * 
 * Exports:
 * - ExperimentRegistry: Shared state store for all experiments
 * - Related types and utilities
 */

export {
  ExperimentRegistry,
  createExperimentRegistry,
  fromExperimentResultParams,
  toExperimentResultParams,
  DEFAULT_MAX_RECENT_RESULTS,
  DEFAULT_RESULTS_PATH,
  TSV_HEADERS,
  defaultExperimentRegistryLogger,
} from './experiment-registry';

export type {
  ExperimentResult,
  SwarmState,
  ExperimentLineage,
  ExperimentRegistryLogger,
  ExperimentRegistryOptions,
} from './experiment-registry';
