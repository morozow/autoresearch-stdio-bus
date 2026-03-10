/**
 * Configuration schema and validation for stdio_bus swarm integration.
 * 
 * Validates: Requirements 6.1, 6.2, 6.3, 6.6
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Pool configuration for stdio_bus workers.
 */
export interface PoolConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instances: number;
}

/**
 * Swarm-specific configuration.
 */
export interface SwarmSettings {
  gpuIds: number[];
  agentModel?: string;
  apiKeys?: string;
  experimentTimeout?: number;
  lockTimeout?: number;
}

/**
 * Resource limits configuration.
 */
export interface LimitsConfig {
  max_input_buffer?: number;
  max_output_queue?: number;
  max_restarts?: number;
  restart_window_sec?: number;
  backpressure_timeout_sec?: number;
}

/**
 * Complete swarm configuration matching design specification.
 */
export interface SwarmConfig {
  pools: PoolConfig[];
  swarm: SwarmSettings;
  limits?: LimitsConfig;
}

/**
 * Validation error with field path and message.
 */
export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Result of configuration validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  config?: SwarmConfig;
}

// ============================================================================
// Default Values
// ============================================================================

export const DEFAULT_LIMITS: Required<LimitsConfig> = {
  max_input_buffer: 1048576,      // 1MB
  max_output_queue: 4194304,      // 4MB
  max_restarts: 5,
  restart_window_sec: 60,
  backpressure_timeout_sec: 60,
};

export const DEFAULT_SWARM_SETTINGS = {
  agentModel: 'claude-acp',
  experimentTimeout: 10,
  lockTimeout: 10,
};

// ============================================================================
// Environment Variable Substitution
// ============================================================================

/**
 * Pattern to match ${ENV_VAR} syntax.
 */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Substitutes ${ENV_VAR} patterns in a string with environment variable values.
 * 
 * @param value - String potentially containing ${ENV_VAR} patterns
 * @returns String with environment variables substituted
 */
export function substituteEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName) => {
    const envValue = process.env[varName];
    return envValue !== undefined ? envValue : match;
  });
}

/**
 * Recursively substitutes environment variables in an object.
 * 
 * @param obj - Object to process
 * @returns New object with environment variables substituted
 */
export function substituteEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVarsInObject(item)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result as T;
  }

  return obj;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates a pool configuration.
 */
function validatePool(pool: unknown, index: number, errors: ValidationError[]): pool is PoolConfig {
  const path = `pools[${index}]`;

  if (typeof pool !== 'object' || pool === null) {
    errors.push({ path, message: 'Pool must be an object' });
    return false;
  }

  const p = pool as Record<string, unknown>;

  // Required: id
  if (typeof p.id !== 'string' || p.id.length === 0) {
    errors.push({ path: `${path}.id`, message: 'Pool id must be a non-empty string' });
  }

  // Required: command
  if (typeof p.command !== 'string' || p.command.length === 0) {
    errors.push({ path: `${path}.command`, message: 'Pool command must be a non-empty string' });
  }

  // Optional: args (must be string array if present)
  if (p.args !== undefined) {
    if (!Array.isArray(p.args) || !p.args.every(a => typeof a === 'string')) {
      errors.push({ path: `${path}.args`, message: 'Pool args must be an array of strings' });
    }
  }

  // Optional: env (must be string record if present)
  if (p.env !== undefined) {
    if (typeof p.env !== 'object' || p.env === null || Array.isArray(p.env)) {
      errors.push({ path: `${path}.env`, message: 'Pool env must be an object' });
    } else {
      for (const [key, value] of Object.entries(p.env)) {
        if (typeof value !== 'string') {
          errors.push({ path: `${path}.env.${key}`, message: 'Pool env values must be strings' });
        }
      }
    }
  }

  // Required: instances
  if (typeof p.instances !== 'number' || !Number.isInteger(p.instances) || p.instances < 1) {
    errors.push({ path: `${path}.instances`, message: 'Pool instances must be a positive integer' });
  }

  return errors.length === 0;
}

/**
 * Validates swarm settings.
 */
function validateSwarmSettings(swarm: unknown, errors: ValidationError[]): swarm is SwarmSettings {
  const path = 'swarm';

  if (typeof swarm !== 'object' || swarm === null) {
    errors.push({ path, message: 'Swarm settings must be an object' });
    return false;
  }

  const s = swarm as Record<string, unknown>;

  // Required: gpuIds
  if (!Array.isArray(s.gpuIds)) {
    errors.push({ path: `${path}.gpuIds`, message: 'gpuIds must be an array' });
  } else if (s.gpuIds.length === 0) {
    errors.push({ path: `${path}.gpuIds`, message: 'gpuIds must contain at least one GPU ID' });
  } else if (!s.gpuIds.every(id => typeof id === 'number' && Number.isInteger(id) && id >= 0)) {
    errors.push({ path: `${path}.gpuIds`, message: 'gpuIds must be an array of non-negative integers' });
  }

  // Optional: agentModel
  if (s.agentModel !== undefined && typeof s.agentModel !== 'string') {
    errors.push({ path: `${path}.agentModel`, message: 'agentModel must be a string' });
  }

  // Optional: apiKeys
  if (s.apiKeys !== undefined && typeof s.apiKeys !== 'string') {
    errors.push({ path: `${path}.apiKeys`, message: 'apiKeys must be a string' });
  }

  // Optional: experimentTimeout
  if (s.experimentTimeout !== undefined) {
    if (typeof s.experimentTimeout !== 'number' || !Number.isInteger(s.experimentTimeout) || s.experimentTimeout < 1) {
      errors.push({ path: `${path}.experimentTimeout`, message: 'experimentTimeout must be a positive integer' });
    }
  }

  // Optional: lockTimeout
  if (s.lockTimeout !== undefined) {
    if (typeof s.lockTimeout !== 'number' || !Number.isInteger(s.lockTimeout) || s.lockTimeout < 1) {
      errors.push({ path: `${path}.lockTimeout`, message: 'lockTimeout must be a positive integer' });
    }
  }

  return true;
}

/**
 * Validates limits configuration.
 */
function validateLimits(limits: unknown, errors: ValidationError[]): limits is LimitsConfig {
  const path = 'limits';

  if (limits === undefined) {
    return true;
  }

  if (typeof limits !== 'object' || limits === null) {
    errors.push({ path, message: 'Limits must be an object' });
    return false;
  }

  const l = limits as Record<string, unknown>;

  const intFields = [
    'max_input_buffer',
    'max_output_queue',
    'max_restarts',
    'restart_window_sec',
    'backpressure_timeout_sec',
  ];

  for (const field of intFields) {
    if (l[field] !== undefined) {
      if (typeof l[field] !== 'number' || !Number.isInteger(l[field]) || (l[field] as number) < 0) {
        errors.push({ path: `${path}.${field}`, message: `${field} must be a non-negative integer` });
      }
    }
  }

  return true;
}

/**
 * Calculates total agent instances from pool configurations.
 */
export function getTotalAgentInstances(pools: PoolConfig[]): number {
  return pools.reduce((sum, pool) => sum + pool.instances, 0);
}

/**
 * Validates that N agents ≤ M GPUs constraint is satisfied.
 * 
 * Validates: Requirement 6.3
 */
function validateAgentGpuConstraint(
  pools: PoolConfig[],
  gpuIds: number[],
  errors: ValidationError[]
): void {
  const totalAgents = getTotalAgentInstances(pools);
  const totalGpus = gpuIds.length;

  if (totalAgents > totalGpus) {
    errors.push({
      path: 'pools/swarm.gpuIds',
      message: `Total agent instances (${totalAgents}) exceeds available GPUs (${totalGpus}). ` +
        `Configuration specifies N agents > M GPUs which is not allowed.`,
    });
  }
}

/**
 * Validates a complete swarm configuration.
 * 
 * Reports all validation errors before launching any agents.
 * Validates: Requirements 6.1, 6.2, 6.3, 6.6
 * 
 * @param config - Raw configuration object to validate
 * @returns Validation result with errors or validated config
 */
export function validateConfig(config: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  // Check top-level structure
  if (typeof config !== 'object' || config === null) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Configuration must be an object' }],
    };
  }

  const c = config as Record<string, unknown>;

  // Validate required: pools
  if (!Array.isArray(c.pools)) {
    errors.push({ path: 'pools', message: 'pools is required and must be an array' });
  } else if (c.pools.length === 0) {
    errors.push({ path: 'pools', message: 'pools must contain at least one pool configuration' });
  } else {
    c.pools.forEach((pool, index) => validatePool(pool, index, errors));
  }

  // Validate required: swarm
  if (c.swarm === undefined) {
    errors.push({ path: 'swarm', message: 'swarm settings are required' });
  } else {
    validateSwarmSettings(c.swarm, errors);
  }

  // Validate optional: limits
  validateLimits(c.limits, errors);

  // If basic validation passed, check N agents ≤ M GPUs constraint
  if (errors.length === 0 && Array.isArray(c.pools) && c.swarm) {
    const swarm = c.swarm as SwarmSettings;
    if (Array.isArray(swarm.gpuIds)) {
      validateAgentGpuConstraint(c.pools as PoolConfig[], swarm.gpuIds, errors);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Return validated config with defaults applied
  const validatedConfig: SwarmConfig = {
    pools: c.pools as PoolConfig[],
    swarm: {
      ...DEFAULT_SWARM_SETTINGS,
      ...(c.swarm as SwarmSettings),
    },
    limits: {
      ...DEFAULT_LIMITS,
      ...(c.limits as LimitsConfig | undefined),
    },
  };

  return { valid: true, errors: [], config: validatedConfig };
}

/**
 * Parses and validates a JSON configuration string.
 * Applies environment variable substitution before validation.
 * 
 * @param jsonString - JSON configuration string
 * @returns Validation result
 */
export function parseAndValidateConfig(jsonString: string): ValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{ path: '', message: `Invalid JSON: ${(e as Error).message}` }],
    };
  }

  // Apply environment variable substitution
  const substituted = substituteEnvVarsInObject(parsed);

  return validateConfig(substituted);
}

/**
 * Formats validation errors into a human-readable string.
 * 
 * @param errors - Array of validation errors
 * @returns Formatted error message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) {
    return 'No errors';
  }

  return errors
    .map(e => e.path ? `${e.path}: ${e.message}` : e.message)
    .join('\n');
}
