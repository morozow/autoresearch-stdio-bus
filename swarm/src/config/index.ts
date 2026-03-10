/**
 * Configuration module exports.
 */

export {
  // Types
  PoolConfig,
  SwarmSettings,
  LimitsConfig,
  SwarmConfig,
  ValidationError,
  ValidationResult,

  // Constants
  DEFAULT_LIMITS,
  DEFAULT_SWARM_SETTINGS,

  // Functions
  validateConfig,
  parseAndValidateConfig,
  substituteEnvVars,
  substituteEnvVarsInObject,
  getTotalAgentInstances,
  formatValidationErrors,
} from './schema';
