/**
 * Tests for configuration schema and validation.
 * 
 * Validates: Requirements 6.1, 6.2, 6.3, 6.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateConfig,
  parseAndValidateConfig,
  substituteEnvVars,
  substituteEnvVarsInObject,
  getTotalAgentInstances,
  formatValidationErrors,
  SwarmConfig,
  PoolConfig,
  DEFAULT_LIMITS,
  DEFAULT_SWARM_SETTINGS,
} from './schema';

describe('Configuration Schema', () => {
  // ============================================================================
  // Valid Configuration Tests
  // ============================================================================

  describe('valid configurations', () => {
    it('accepts minimal valid configuration', () => {
      const config = {
        pools: [
          { id: 'worker', command: 'node', instances: 1 }
        ],
        swarm: {
          gpuIds: [0]
        }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).toBeDefined();
    });

    it('accepts full configuration with all optional fields', () => {
      const config = {
        pools: [
          {
            id: 'swarm-coordinator',
            command: 'node',
            args: ['./swarm/coordinator.js'],
            instances: 1
          },
          {
            id: 'gpu-worker',
            command: 'node',
            args: ['./swarm/gpu-worker.js'],
            env: { DEBUG: 'true' },
            instances: 3
          }
        ],
        swarm: {
          gpuIds: [0, 1, 2, 3],
          agentModel: 'claude-acp',
          apiKeys: '/path/to/keys.json',
          experimentTimeout: 10,
          lockTimeout: 10
        },
        limits: {
          max_input_buffer: 4194304,
          max_output_queue: 16777216,
          max_restarts: 10,
          restart_window_sec: 120,
          backpressure_timeout_sec: 120
        }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).toBeDefined();
      expect(result.config?.pools).toHaveLength(2);
      expect(result.config?.swarm.gpuIds).toEqual([0, 1, 2, 3]);
    });

    it('applies default values for optional fields', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.config?.swarm.agentModel).toBe(DEFAULT_SWARM_SETTINGS.agentModel);
      expect(result.config?.swarm.experimentTimeout).toBe(DEFAULT_SWARM_SETTINGS.experimentTimeout);
      expect(result.config?.swarm.lockTimeout).toBe(DEFAULT_SWARM_SETTINGS.lockTimeout);
      expect(result.config?.limits?.max_input_buffer).toBe(DEFAULT_LIMITS.max_input_buffer);
      expect(result.config?.limits?.max_restarts).toBe(DEFAULT_LIMITS.max_restarts);
    });

    it('accepts N agents = M GPUs (exact match)', () => {
      const config = {
        pools: [
          { id: 'worker-a', command: 'node', instances: 2 },
          { id: 'worker-b', command: 'node', instances: 2 }
        ],
        swarm: { gpuIds: [0, 1, 2, 3] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
    });

    it('accepts N agents < M GPUs', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 2 }],
        swarm: { gpuIds: [0, 1, 2, 3] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // N agents > M GPUs Constraint Tests (Requirement 6.3)
  // ============================================================================

  describe('N agents ≤ M GPUs constraint', () => {
    it('rejects N agents > M GPUs', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 5 }],
        swarm: { gpuIds: [0, 1, 2, 3] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.message.includes('exceeds available GPUs') ||
        e.message.includes('N agents > M GPUs')
      )).toBe(true);
    });

    it('rejects when total instances across pools exceed GPUs', () => {
      const config = {
        pools: [
          { id: 'worker-a', command: 'node', instances: 3 },
          { id: 'worker-b', command: 'node', instances: 3 }
        ],
        swarm: { gpuIds: [0, 1, 2, 3] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('6'))).toBe(true); // 6 agents
      expect(result.errors.some(e => e.message.includes('4'))).toBe(true); // 4 GPUs
    });

    it('correctly calculates total instances from multiple pools', () => {
      const pools: PoolConfig[] = [
        { id: 'a', command: 'cmd', instances: 2 },
        { id: 'b', command: 'cmd', instances: 3 },
        { id: 'c', command: 'cmd', instances: 1 }
      ];

      expect(getTotalAgentInstances(pools)).toBe(6);
    });
  });

  // ============================================================================
  // Required Field Validation Tests (Requirements 6.1, 6.2)
  // ============================================================================

  describe('required field validation', () => {
    it('rejects missing pools', () => {
      const config = {
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools')).toBe(true);
    });

    it('rejects empty pools array', () => {
      const config = {
        pools: [],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools')).toBe(true);
    });

    it('rejects missing swarm settings', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }]
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'swarm')).toBe(true);
    });

    it('rejects missing gpuIds', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: {}
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'swarm.gpuIds')).toBe(true);
    });

    it('rejects empty gpuIds array', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: { gpuIds: [] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'swarm.gpuIds')).toBe(true);
    });

    it('rejects missing pool id', () => {
      const config = {
        pools: [{ command: 'node', instances: 1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools[0].id')).toBe(true);
    });

    it('rejects missing pool command', () => {
      const config = {
        pools: [{ id: 'worker', instances: 1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools[0].command')).toBe(true);
    });

    it('rejects missing pool instances', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node' }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools[0].instances')).toBe(true);
    });
  });

  // ============================================================================
  // Type Validation Tests
  // ============================================================================

  describe('type validation', () => {
    it('rejects non-object configuration', () => {
      expect(validateConfig(null).valid).toBe(false);
      expect(validateConfig(undefined).valid).toBe(false);
      expect(validateConfig('string').valid).toBe(false);
      expect(validateConfig(123).valid).toBe(false);
      expect(validateConfig([]).valid).toBe(false);
    });

    it('rejects non-integer instances', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1.5 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools[0].instances')).toBe(true);
    });

    it('rejects zero instances', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 0 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
    });

    it('rejects negative instances', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: -1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
    });

    it('rejects non-integer gpuIds', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: { gpuIds: [0.5, 1.5] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
    });

    it('rejects negative gpuIds', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: { gpuIds: [-1, 0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
    });

    it('rejects non-string pool args', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', args: [1, 2], instances: 1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'pools[0].args')).toBe(true);
    });

    it('rejects non-string pool env values', () => {
      const config = {
        pools: [{ id: 'worker', command: 'node', env: { KEY: 123 }, instances: 1 }],
        swarm: { gpuIds: [0] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path.includes('env'))).toBe(true);
    });
  });

  // ============================================================================
  // Report All Errors Tests (Requirement 6.6)
  // ============================================================================

  describe('reports all validation errors', () => {
    it('collects multiple errors from different fields', () => {
      const config = {
        pools: [
          { id: '', command: '', instances: -1 },
          { command: 'node', instances: 0 }
        ],
        swarm: { gpuIds: [] }
      };

      const result = validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(3);
    });

    it('formats errors into readable string', () => {
      const config = {
        pools: [{ id: '', command: '', instances: -1 }],
        swarm: { gpuIds: [] }
      };

      const result = validateConfig(config);
      const formatted = formatValidationErrors(result.errors);

      expect(formatted).toContain('pools[0].id');
      expect(formatted).toContain('pools[0].command');
      expect(formatted).toContain('pools[0].instances');
      expect(formatted).toContain('swarm.gpuIds');
    });
  });

  // ============================================================================
  // JSON Parsing Tests
  // ============================================================================

  describe('JSON parsing', () => {
    it('parses valid JSON configuration', () => {
      const json = JSON.stringify({
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: { gpuIds: [0] }
      });

      const result = parseAndValidateConfig(json);

      expect(result.valid).toBe(true);
    });

    it('rejects invalid JSON', () => {
      const result = parseAndValidateConfig('{ invalid json }');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid JSON'))).toBe(true);
    });
  });
});

// ============================================================================
// Environment Variable Substitution Tests (Requirement 6.5)
// ============================================================================

describe('Environment Variable Substitution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('substituteEnvVars', () => {
    it('substitutes single environment variable', () => {
      process.env.TEST_VAR = 'test-value';

      const result = substituteEnvVars('${TEST_VAR}');

      expect(result).toBe('test-value');
    });

    it('substitutes multiple environment variables', () => {
      process.env.VAR_A = 'value-a';
      process.env.VAR_B = 'value-b';

      const result = substituteEnvVars('${VAR_A}/${VAR_B}');

      expect(result).toBe('value-a/value-b');
    });

    it('preserves unset environment variables', () => {
      delete process.env.UNSET_VAR;

      const result = substituteEnvVars('${UNSET_VAR}');

      expect(result).toBe('${UNSET_VAR}');
    });

    it('handles mixed content', () => {
      process.env.API_KEY = 'secret123';

      const result = substituteEnvVars('prefix-${API_KEY}-suffix');

      expect(result).toBe('prefix-secret123-suffix');
    });

    it('handles empty environment variable value', () => {
      process.env.EMPTY_VAR = '';

      const result = substituteEnvVars('${EMPTY_VAR}');

      expect(result).toBe('');
    });

    it('returns string unchanged if no variables', () => {
      const result = substituteEnvVars('no variables here');

      expect(result).toBe('no variables here');
    });
  });

  describe('substituteEnvVarsInObject', () => {
    it('substitutes in nested objects', () => {
      process.env.NESTED_VAR = 'nested-value';

      const obj = {
        level1: {
          level2: '${NESTED_VAR}'
        }
      };

      const result = substituteEnvVarsInObject(obj);

      expect(result.level1.level2).toBe('nested-value');
    });

    it('substitutes in arrays', () => {
      process.env.ARRAY_VAR = 'array-value';

      const obj = {
        items: ['${ARRAY_VAR}', 'static']
      };

      const result = substituteEnvVarsInObject(obj);

      expect(result.items[0]).toBe('array-value');
      expect(result.items[1]).toBe('static');
    });

    it('preserves non-string values', () => {
      const obj = {
        number: 42,
        boolean: true,
        null: null,
        string: '${TEST}'
      };

      process.env.TEST = 'replaced';
      const result = substituteEnvVarsInObject(obj);

      expect(result.number).toBe(42);
      expect(result.boolean).toBe(true);
      expect(result.null).toBe(null);
      expect(result.string).toBe('replaced');
    });
  });

  describe('parseAndValidateConfig with env vars', () => {
    it('substitutes env vars before validation', () => {
      process.env.GPU_COUNT = '4';
      process.env.API_KEY_PATH = '/path/to/keys.json';

      const json = JSON.stringify({
        pools: [{ id: 'worker', command: 'node', instances: 1 }],
        swarm: {
          gpuIds: [0],
          apiKeys: '${API_KEY_PATH}'
        }
      });

      const result = parseAndValidateConfig(json);

      expect(result.valid).toBe(true);
      expect(result.config?.swarm.apiKeys).toBe('/path/to/keys.json');
    });
  });
});
