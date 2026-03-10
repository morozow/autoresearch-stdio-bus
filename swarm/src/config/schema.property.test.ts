/**
 * Property-based tests for configuration validation.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 19: Configuration Validation
 * 
 * For any configuration file, the Swarm_Coordinator shall validate all required fields
 * (pools, swarm.gpuIds), verify N agents ≤ M GPUs, substitute environment variables,
 * and report all validation errors before launching any agents.
 * 
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.5, 6.6**
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  validateConfig,
  substituteEnvVars,
  substituteEnvVarsInObject,
  getTotalAgentInstances,
  PoolConfig,
  SwarmConfig,
  ValidationResult,
} from './schema';

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid pool configuration.
 */
const arbitraryValidPool = (): fc.Arbitrary<PoolConfig> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    command: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    args: fc.option(fc.array(fc.string(), { maxLength: 10 }), { nil: undefined }),
    env: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        fc.string({ maxLength: 100 })
      ),
      { nil: undefined }
    ),
    instances: fc.integer({ min: 1, max: 16 }),
  });

/**
 * Generates a valid GPU ID array.
 */
const arbitraryGpuIds = (minLength: number = 1, maxLength: number = 16): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 0, max: 15 }), { minLength, maxLength })
    .map(ids => [...new Set(ids)]); // Ensure unique GPU IDs

/**
 * Generates a valid swarm configuration where N agents ≤ M GPUs.
 */
const arbitraryValidConfig = (): fc.Arbitrary<{ pools: PoolConfig[]; swarm: { gpuIds: number[] } }> =>
  fc.integer({ min: 1, max: 8 }).chain(numGpus => {
    const gpuIds = Array.from({ length: numGpus }, (_, i) => i);
    return fc.array(arbitraryValidPool(), { minLength: 1, maxLength: 4 })
      .filter(pools => getTotalAgentInstances(pools) <= numGpus)
      .map(pools => ({
        pools,
        swarm: { gpuIds },
      }));
  });

/**
 * Generates an invalid configuration where N agents > M GPUs.
 */
const arbitraryInvalidNGreaterThanM = (): fc.Arbitrary<{ pools: PoolConfig[]; swarm: { gpuIds: number[] }; totalAgents: number; totalGpus: number }> =>
  fc.record({
    numAgents: fc.integer({ min: 2, max: 16 }),
    numGpus: fc.integer({ min: 1, max: 15 }),
  }).filter(({ numAgents, numGpus }) => numAgents > numGpus)
    .chain(({ numAgents, numGpus }) => {
      const gpuIds = Array.from({ length: numGpus }, (_, i) => i);
      return arbitraryValidPool()
        .map(pool => ({
          pools: [{ ...pool, instances: numAgents }],
          swarm: { gpuIds },
          totalAgents: numAgents,
          totalGpus: numGpus,
        }));
    });

/**
 * Generates a valid environment variable name.
 */
const arbitraryEnvVarName = (): fc.Arbitrary<string> =>
  fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789'.split('')),
    { minLength: 1, maxLength: 20 }
  ).filter(s => /^[A-Z_][A-Z0-9_]*$/.test(s));

/**
 * Generates a string containing ${VAR} patterns.
 * Prefix and suffix are restricted to alphanumeric and safe characters
 * to avoid creating malformed patterns like ${${VAR}.
 */
const arbitraryEnvVarPattern = (): fc.Arbitrary<{ template: string; varName: string; varValue: string }> =>
  fc.record({
    varName: arbitraryEnvVarName(),
    varValue: fc.string({ minLength: 0, maxLength: 100 }),
    // Use safe characters that won't create malformed ${...} patterns
    prefix: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { maxLength: 20 }),
    suffix: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { maxLength: 20 }),
  }).map(({ varName, varValue, prefix, suffix }) => ({
    template: `${prefix}\${${varName}}${suffix}`,
    varName,
    varValue,
  }));

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 19: Configuration Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // --------------------------------------------------------------------------
  // Property 19.1: Valid configs with N agents ≤ M GPUs should pass validation
  // --------------------------------------------------------------------------
  describe('N agents ≤ M GPUs acceptance', () => {
    it('any valid config with N agents ≤ M GPUs should pass validation', () => {
      fc.assert(
        fc.property(
          arbitraryValidConfig(),
          (config) => {
            const result = validateConfig(config);
            const totalAgents = getTotalAgentInstances(config.pools);
            const totalGpus = config.swarm.gpuIds.length;

            // Verify the constraint holds
            expect(totalAgents).toBeLessThanOrEqual(totalGpus);

            // Validation should pass
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.config).toBeDefined();

            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('exact match N agents = M GPUs should pass validation', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 8 }),
          (n) => {
            const config = {
              pools: [{ id: 'worker', command: 'node', instances: n }],
              swarm: { gpuIds: Array.from({ length: n }, (_, i) => i) },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(true);
            return result.valid === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 19.2: Configs with N agents > M GPUs should fail validation
  // --------------------------------------------------------------------------
  describe('N agents > M GPUs rejection', () => {
    it('any config with N agents > M GPUs should fail validation', () => {
      fc.assert(
        fc.property(
          arbitraryInvalidNGreaterThanM(),
          ({ pools, swarm, totalAgents, totalGpus }) => {
            const config = { pools, swarm };
            const result = validateConfig(config);

            // Verify the constraint is violated
            expect(totalAgents).toBeGreaterThan(totalGpus);

            // Validation should fail
            expect(result.valid).toBe(false);

            // Error message should mention the constraint violation
            const hasConstraintError = result.errors.some(
              e => e.message.includes('exceeds') ||
                e.message.includes('N agents > M GPUs') ||
                (e.message.includes(String(totalAgents)) && e.message.includes(String(totalGpus)))
            );
            expect(hasConstraintError).toBe(true);

            return result.valid === false && hasConstraintError;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple pools summing to N > M should fail validation', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 1, max: 4 }),
          (a, b, numGpus) => {
            const totalAgents = a + b;
            // Only test when N > M
            fc.pre(totalAgents > numGpus);

            const config = {
              pools: [
                { id: 'pool-a', command: 'node', instances: a },
                { id: 'pool-b', command: 'node', instances: b },
              ],
              swarm: { gpuIds: Array.from({ length: numGpus }, (_, i) => i) },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 19.3: Environment variable substitution
  // --------------------------------------------------------------------------
  describe('environment variable substitution', () => {
    it('${VAR} patterns should be substituted with environment variable values', () => {
      fc.assert(
        fc.property(
          arbitraryEnvVarPattern(),
          ({ template, varName, varValue }) => {
            // Set the environment variable
            process.env[varName] = varValue;

            const result = substituteEnvVars(template);

            // The result should contain the substituted value
            expect(result).toContain(varValue);
            // The result should not contain the ${VAR} pattern
            expect(result).not.toContain(`\${${varName}}`);

            // Clean up
            delete process.env[varName];

            return result.includes(varValue) && !result.includes(`\${${varName}}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('unset environment variables should preserve the ${VAR} pattern', () => {
      fc.assert(
        fc.property(
          arbitraryEnvVarName(),
          (varName) => {
            // Ensure the variable is not set
            delete process.env[varName];

            const template = `\${${varName}}`;
            const result = substituteEnvVars(template);

            // The pattern should be preserved
            expect(result).toBe(template);

            return result === template;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('multiple ${VAR} patterns should all be substituted', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryEnvVarPattern(), { minLength: 1, maxLength: 5 }),
          (patterns) => {
            // Set all environment variables
            for (const { varName, varValue } of patterns) {
              process.env[varName] = varValue;
            }

            // Create a template with all patterns
            const template = patterns.map(p => `\${${p.varName}}`).join('/');
            const result = substituteEnvVars(template);

            // All patterns should be substituted
            for (const { varName, varValue } of patterns) {
              expect(result).toContain(varValue);
              expect(result).not.toContain(`\${${varName}}`);
            }

            // Clean up
            for (const { varName } of patterns) {
              delete process.env[varName];
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('nested objects should have all ${VAR} patterns substituted', () => {
      fc.assert(
        fc.property(
          arbitraryEnvVarPattern(),
          ({ template, varName, varValue }) => {
            process.env[varName] = varValue;

            const obj = {
              level1: {
                level2: {
                  value: template,
                },
              },
              array: [template, 'static'],
            };

            const result = substituteEnvVarsInObject(obj);

            expect(result.level1.level2.value).toContain(varValue);
            expect(result.array[0]).toContain(varValue);
            expect(result.array[1]).toBe('static');

            delete process.env[varName];

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 19.4: Missing required fields should produce validation errors
  // --------------------------------------------------------------------------
  describe('required field validation', () => {
    it('missing pools should always produce a validation error', () => {
      fc.assert(
        fc.property(
          arbitraryGpuIds(),
          (gpuIds) => {
            const config = {
              swarm: { gpuIds },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'pools' || e.message.includes('pools'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('missing swarm should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryValidPool(), { minLength: 1, maxLength: 4 }),
          (pools) => {
            const config = { pools };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path === 'swarm' || e.message.includes('swarm'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('missing gpuIds should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryValidPool(), { minLength: 1, maxLength: 4 }),
          (pools) => {
            const config = {
              pools,
              swarm: {},
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('gpuIds') || e.message.includes('gpuIds'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty gpuIds array should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryValidPool(), { minLength: 1, maxLength: 4 }),
          (pools) => {
            const config = {
              pools,
              swarm: { gpuIds: [] },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('gpuIds'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('missing pool.id should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.integer({ min: 1, max: 8 }),
          (command, instances) => {
            const config = {
              pools: [{ command, instances }],
              swarm: { gpuIds: [0, 1, 2, 3, 4, 5, 6, 7] },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('id'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('missing pool.command should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.integer({ min: 1, max: 8 }),
          (id, instances) => {
            const config = {
              pools: [{ id, instances }],
              swarm: { gpuIds: [0, 1, 2, 3, 4, 5, 6, 7] },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('command'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('missing pool.instances should always produce a validation error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (id, command) => {
            const config = {
              pools: [{ id, command }],
              swarm: { gpuIds: [0] },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.path.includes('instances'))).toBe(true);

            return result.valid === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 19.5: All validation errors should be reported (not just the first)
  // --------------------------------------------------------------------------
  describe('all validation errors reported', () => {
    it('multiple missing required fields should all be reported', () => {
      fc.assert(
        fc.property(
          fc.constant({}),
          () => {
            // Empty config missing both pools and swarm
            const config = {};

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            // Should have errors for both pools and swarm
            expect(result.errors.length).toBeGreaterThanOrEqual(2);
            expect(result.errors.some(e => e.path === 'pools' || e.message.includes('pools'))).toBe(true);
            expect(result.errors.some(e => e.path === 'swarm' || e.message.includes('swarm'))).toBe(true);

            return result.errors.length >= 2;
          }
        ),
        { numRuns: 10 }
      );
    });

    it('multiple pool errors should all be reported', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 5 }),
          (numPools) => {
            // Create multiple invalid pools
            const pools = Array.from({ length: numPools }, () => ({
              id: '',      // Invalid: empty
              command: '', // Invalid: empty
              instances: -1, // Invalid: negative
            }));

            const config = {
              pools,
              swarm: { gpuIds: [0] },
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            // Should have errors for each pool's invalid fields
            // At minimum: id, command, instances for each pool = 3 * numPools errors
            expect(result.errors.length).toBeGreaterThanOrEqual(numPools * 3);

            // Verify errors reference different pool indices
            const poolIndices = new Set(
              result.errors
                .map(e => e.path.match(/pools\[(\d+)\]/)?.[1])
                .filter(Boolean)
            );
            expect(poolIndices.size).toBe(numPools);

            return result.errors.length >= numPools * 3;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('errors from different config sections should all be reported', () => {
      fc.assert(
        fc.property(
          fc.constant(null),
          () => {
            const config = {
              pools: [
                { id: '', command: '', instances: 0 }, // Multiple pool errors
              ],
              swarm: { gpuIds: [] }, // Swarm error
              limits: { max_input_buffer: -1 }, // Limits error
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);

            // Should have errors from pools section
            expect(result.errors.some(e => e.path.startsWith('pools'))).toBe(true);

            // Should have errors from swarm section
            expect(result.errors.some(e => e.path.startsWith('swarm'))).toBe(true);

            // Should have errors from limits section
            expect(result.errors.some(e => e.path.startsWith('limits'))).toBe(true);

            return result.errors.length >= 3;
          }
        ),
        { numRuns: 10 }
      );
    });

    it('error count should be proportional to number of invalid fields', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 4 }),
          (numInvalidPools) => {
            // Each invalid pool has 3 invalid fields (id, command, instances)
            const pools = Array.from({ length: numInvalidPools }, () => ({
              id: '',
              command: '',
              instances: -1,
            }));

            const config = {
              pools,
              swarm: { gpuIds: [0, 1, 2, 3, 4, 5, 6, 7] }, // Valid swarm
            };

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            // Should have at least 3 errors per invalid pool
            expect(result.errors.length).toBeGreaterThanOrEqual(numInvalidPools * 3);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
