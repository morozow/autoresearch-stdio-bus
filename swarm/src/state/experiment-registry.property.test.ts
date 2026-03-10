/**
 * Property-based tests for ExperimentRegistry TSV format completeness.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 4: TSV Format Completeness
 * 
 * For any experiment result recorded by the Experiment_Registry, the results.tsv file
 * shall contain all required columns (commit, val_bpb, memory_gb, status, description,
 * agent_id, timestamp, branch) with valid values.
 * 
 * **Validates: Requirements 2.2, 7.4**
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ExperimentRegistry,
  createExperimentRegistry,
  ExperimentResult,
  TSV_HEADERS,
} from './experiment-registry';
import { ExperimentStatus } from '../protocol/types';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a silent logger for tests.
 */
function createSilentLogger() {
  return {
    info: () => { },
    warn: () => { },
    error: () => { },
  };
}

/**
 * Parses a TSV file and returns the header and data rows.
 */
function parseTsvFile(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0].split('\t');
  const rows = lines.slice(1).map(line => line.split('\t'));

  return { headers, rows };
}

// ============================================================================
// Arbitraries (Test Generators)
// ============================================================================

/**
 * Generates a valid 7-character hex commit string.
 */
const arbitraryCommit = (): fc.Arbitrary<string> =>
  fc.hexaString({ minLength: 7, maxLength: 7 }).map(s => s.toLowerCase());

/**
 * Generates a valid val_bpb float between 0.5 and 2.0.
 * For crash status, generates 0.0.
 */
const arbitraryValBpb = (): fc.Arbitrary<number> =>
  fc.float({ min: 0.5, max: 2.0, noNaN: true });

/**
 * Generates a valid memory_gb float between 0 and 80.
 */
const arbitraryMemoryGb = (): fc.Arbitrary<number> =>
  fc.float({ min: 0, max: 80, noNaN: true });

/**
 * Generates a valid experiment status.
 */
const arbitraryStatus = (): fc.Arbitrary<ExperimentStatus> =>
  fc.constantFrom('keep', 'discard', 'crash');

/**
 * Generates a non-empty description string.
 * Avoids tabs and newlines to ensure TSV compatibility.
 */
const arbitraryDescription = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 100 })
    .map(s => s.replace(/[\t\n\r]/g, ' ').trim() || 'default description');

/**
 * Generates a valid agent ID (e.g., 'agent-0', 'agent-1').
 */
const arbitraryAgentId = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `agent-${n}`);

/**
 * Generates a valid ISO 8601 timestamp.
 */
const arbitraryTimestamp = (): fc.Arbitrary<string> =>
  fc.date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2030-12-31T23:59:59Z'),
  }).map(d => d.toISOString());

/**
 * Generates a valid branch name (e.g., 'autoresearch/swarm/agent-0').
 */
const arbitraryBranch = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 99 }).map(n => `autoresearch/swarm/agent-${n}`);

/**
 * Generates a valid ExperimentResult object.
 */
const arbitraryExperimentResult = (): fc.Arbitrary<ExperimentResult> =>
  fc.record({
    commit: arbitraryCommit(),
    valBpb: arbitraryValBpb(),
    memoryGb: arbitraryMemoryGb(),
    status: arbitraryStatus(),
    description: arbitraryDescription(),
    agentId: arbitraryAgentId(),
    timestamp: arbitraryTimestamp(),
    branch: arbitraryBranch(),
  }).map(result => {
    // For crash status, set valBpb to 0 and memoryGb to 0
    if (result.status === 'crash') {
      return { ...result, valBpb: 0.0, memoryGb: 0.0 };
    }
    return result;
  });

/**
 * Generates an array of unique ExperimentResult objects (unique by commit).
 */
const arbitraryUniqueExperimentResults = (
  minLength: number = 1,
  maxLength: number = 20
): fc.Arbitrary<ExperimentResult[]> =>
  fc.array(arbitraryExperimentResult(), { minLength, maxLength })
    .map(results => {
      // Ensure unique commits
      const seen = new Set<string>();
      return results.filter(r => {
        if (seen.has(r.commit)) return false;
        seen.add(r.commit);
        return true;
      });
    })
    .filter(results => results.length >= minLength);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 4: TSV Format Completeness', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 4.1: TSV file contains all required columns
  // --------------------------------------------------------------------------
  describe('TSV file contains all required columns', () => {
    it('for any valid ExperimentResult, after persist(), the TSV file should contain all required columns', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          // Clear registry and add the result
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          // Read and parse the TSV file
          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);

          // Required columns (excluding 'parent' which is optional metadata)
          const requiredColumns = [
            'commit',
            'val_bpb',
            'memory_gb',
            'status',
            'description',
            'agent_id',
            'timestamp',
            'branch',
          ];

          // Verify all required columns are present in header
          for (const col of requiredColumns) {
            expect(headers).toContain(col);
          }

          // Verify we have exactly one data row
          expect(rows.length).toBe(1);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('header row should match TSV_HEADERS constant', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers } = parseTsvFile(content);

          // Headers should match TSV_HEADERS exactly
          expect(headers).toEqual([...TSV_HEADERS]);

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 4.2: All column values are valid
  // --------------------------------------------------------------------------
  describe('all column values are valid', () => {
    it('commit column should contain non-empty string', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const commitIndex = headers.indexOf('commit');

          expect(commitIndex).toBeGreaterThanOrEqual(0);
          expect(rows[0]![commitIndex]).toBeTruthy();
          expect(rows[0]![commitIndex].length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('val_bpb column should contain valid number format', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const valBpbIndex = headers.indexOf('val_bpb');

          expect(valBpbIndex).toBeGreaterThanOrEqual(0);
          const valBpbStr = rows[0]![valBpbIndex];
          const valBpb = parseFloat(valBpbStr);

          expect(isNaN(valBpb)).toBe(false);
          // Should be formatted with 6 decimal places
          expect(valBpbStr).toMatch(/^\d+\.\d{6}$/);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('memory_gb column should contain valid number format', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const memoryGbIndex = headers.indexOf('memory_gb');

          expect(memoryGbIndex).toBeGreaterThanOrEqual(0);
          const memoryGbStr = rows[0]![memoryGbIndex];
          const memoryGb = parseFloat(memoryGbStr);

          expect(isNaN(memoryGb)).toBe(false);
          // Should be formatted with 1 decimal place
          expect(memoryGbStr).toMatch(/^\d+\.\d$/);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('status column should contain valid status value', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const statusIndex = headers.indexOf('status');

          expect(statusIndex).toBeGreaterThanOrEqual(0);
          const status = rows[0]![statusIndex];

          expect(['keep', 'discard', 'crash']).toContain(status);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('agent_id column should contain non-empty string', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const agentIdIndex = headers.indexOf('agent_id');

          expect(agentIdIndex).toBeGreaterThanOrEqual(0);
          expect(rows[0]![agentIdIndex]).toBeTruthy();
          expect(rows[0]![agentIdIndex].length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('timestamp column should contain non-empty string', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const timestampIndex = headers.indexOf('timestamp');

          expect(timestampIndex).toBeGreaterThanOrEqual(0);
          expect(rows[0]![timestampIndex]).toBeTruthy();
          expect(rows[0]![timestampIndex].length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('branch column should contain non-empty string', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);
          const branchIndex = headers.indexOf('branch');

          expect(branchIndex).toBeGreaterThanOrEqual(0);
          expect(rows[0]![branchIndex]).toBeTruthy();
          expect(rows[0]![branchIndex].length).toBeGreaterThan(0);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 4.3: TSV is parseable and round-trips correctly
  // --------------------------------------------------------------------------
  describe('TSV is parseable and round-trips correctly', () => {
    it('for any valid ExperimentResult, persist then restore should preserve all data', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          // Create a new registry and restore from the TSV
          const newRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newRegistry.restore();

          // Verify the result was restored correctly
          const restoredResult = newRegistry.getResultByCommit(result.commit);
          expect(restoredResult).toBeDefined();

          // Compare all fields
          expect(restoredResult!.commit).toBe(result.commit);
          expect(restoredResult!.status).toBe(result.status);
          expect(restoredResult!.agentId).toBe(result.agentId);
          expect(restoredResult!.timestamp).toBe(result.timestamp);
          expect(restoredResult!.branch).toBe(result.branch);

          // For numeric fields, compare with tolerance due to formatting
          expect(restoredResult!.valBpb).toBeCloseTo(result.valBpb, 5);
          expect(restoredResult!.memoryGb).toBeCloseTo(result.memoryGb, 0);

          // Description may have tabs/newlines escaped, so compare normalized
          const normalizedOriginal = result.description.replace(/[\t\n\r]/g, ' ');
          expect(restoredResult!.description).toBe(normalizedOriginal);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('multiple experiments should round-trip correctly', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }
          await registry.persist();

          // Create a new registry and restore
          const newRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newRegistry.restore();

          // Verify all results were restored
          expect(newRegistry.getTotalExperiments()).toBe(results.length);

          for (const result of results) {
            const restored = newRegistry.getResultByCommit(result.commit);
            expect(restored).toBeDefined();
            expect(restored!.status).toBe(result.status);
            expect(restored!.agentId).toBe(result.agentId);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('TSV file should have correct number of columns per row', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);

          // Each row should have the same number of columns as the header
          for (const row of rows) {
            expect(row.length).toBe(headers.length);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 4.4: Data integrity across persist operations
  // --------------------------------------------------------------------------
  describe('data integrity across persist operations', () => {
    it('multiple persist operations should not corrupt data', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 5),
          fc.integer({ min: 2, max: 5 }),
          async (results, persistCount) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            // Persist multiple times
            for (let i = 0; i < persistCount; i++) {
              await registry.persist();
            }

            // Verify data is still correct
            const newRegistry = createExperimentRegistry({
              logger: createSilentLogger(),
              resultsPath,
            });
            await newRegistry.restore();

            expect(newRegistry.getTotalExperiments()).toBe(results.length);

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });

    it('values should match original input after persist', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryExperimentResult(), async (result) => {
          registry.clear();
          await registry.recordResult(result);
          await registry.persist();

          const content = await fs.promises.readFile(resultsPath, 'utf-8');
          const { headers, rows } = parseTsvFile(content);

          // Get column indices
          const commitIndex = headers.indexOf('commit');
          const valBpbIndex = headers.indexOf('val_bpb');
          const memoryGbIndex = headers.indexOf('memory_gb');
          const statusIndex = headers.indexOf('status');
          const agentIdIndex = headers.indexOf('agent_id');
          const timestampIndex = headers.indexOf('timestamp');
          const branchIndex = headers.indexOf('branch');

          const row = rows[0];

          // Verify values match
          expect(row![commitIndex]).toBe(result.commit);
          expect(parseFloat(row![valBpbIndex])).toBeCloseTo(result.valBpb, 5);
          expect(parseFloat(row![memoryGbIndex])).toBeCloseTo(result.memoryGb, 0);
          expect(row![statusIndex]).toBe(result.status);
          expect(row![agentIdIndex]).toBe(result.agentId);
          expect(row![timestampIndex]).toBe(result.timestamp);
          expect(row![branchIndex]).toBe(result.branch);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});


// ============================================================================
// Property 5: State Query Response Correctness
// ============================================================================

/**
 * Property-based tests for State Query Response Correctness.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 5: State Query Response Correctness
 * 
 * For any state query to the Experiment_Registry, the response shall contain the correct
 * current best val_bpb (minimum across all "keep" experiments) and at most 50 recent
 * results ordered by timestamp descending.
 * 
 * **Validates: Requirements 2.3**
 */
describe('Property 5: State Query Response Correctness', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property5-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 5.1: getBestValBpb() returns minimum val_bpb among "keep" experiments
  // --------------------------------------------------------------------------
  describe('getBestValBpb() returns minimum val_bpb among "keep" experiments', () => {
    it('for any sequence of experiments, getBestValBpb() should return the minimum val_bpb among "keep" experiments', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const keepResults = results.filter(r => r.status === 'keep');
          const expectedBest = keepResults.length > 0
            ? Math.min(...keepResults.map(r => r.valBpb))
            : Infinity;

          const actualBest = registry.getBestValBpb();

          expect(actualBest).toBeCloseTo(expectedBest, 5);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('getBestValBpb() should ignore "discard" experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(2, 20),
          async (results) => {
            // Ensure we have at least one keep and one discard
            const modifiedResults = results.map((r, i) => ({
              ...r,
              status: (i % 2 === 0 ? 'keep' : 'discard') as ExperimentStatus,
              // Make discard experiments have lower val_bpb to test they're ignored
              valBpb: i % 2 === 0 ? r.valBpb : r.valBpb * 0.5,
            }));

            registry.clear();
            for (const result of modifiedResults) {
              await registry.recordResult(result);
            }

            const keepResults = modifiedResults.filter(r => r.status === 'keep');
            const expectedBest = Math.min(...keepResults.map(r => r.valBpb));

            const actualBest = registry.getBestValBpb();

            expect(actualBest).toBeCloseTo(expectedBest, 5);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('getBestValBpb() should ignore "crash" experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(2, 20),
          async (results) => {
            // Ensure we have at least one keep and one crash
            const modifiedResults = results.map((r, i) => ({
              ...r,
              status: (i % 2 === 0 ? 'keep' : 'crash') as ExperimentStatus,
              valBpb: i % 2 === 0 ? r.valBpb : 0.0, // crash experiments have 0.0 val_bpb
              memoryGb: i % 2 === 0 ? r.memoryGb : 0.0,
            }));

            registry.clear();
            for (const result of modifiedResults) {
              await registry.recordResult(result);
            }

            const keepResults = modifiedResults.filter(r => r.status === 'keep');
            const expectedBest = Math.min(...keepResults.map(r => r.valBpb));

            const actualBest = registry.getBestValBpb();

            expect(actualBest).toBeCloseTo(expectedBest, 5);

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 5.2: getBestValBpb() returns Infinity when no "keep" experiments exist
  // --------------------------------------------------------------------------
  describe('getBestValBpb() returns Infinity when no "keep" experiments exist', () => {
    it('for an empty registry, getBestValBpb() should return Infinity', () => {
      expect(registry.getBestValBpb()).toBe(Infinity);
    });

    it('for any sequence of only "discard" experiments, getBestValBpb() should return Infinity', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          // Make all experiments "discard"
          const discardResults = results.map(r => ({
            ...r,
            status: 'discard' as ExperimentStatus,
          }));

          registry.clear();
          for (const result of discardResults) {
            await registry.recordResult(result);
          }

          expect(registry.getBestValBpb()).toBe(Infinity);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of only "crash" experiments, getBestValBpb() should return Infinity', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          // Make all experiments "crash"
          const crashResults = results.map(r => ({
            ...r,
            status: 'crash' as ExperimentStatus,
            valBpb: 0.0,
            memoryGb: 0.0,
          }));

          registry.clear();
          for (const result of crashResults) {
            await registry.recordResult(result);
          }

          expect(registry.getBestValBpb()).toBe(Infinity);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any mix of "discard" and "crash" experiments (no "keep"), getBestValBpb() should return Infinity', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          // Make experiments alternate between discard and crash
          const noKeepResults = results.map((r, i) => ({
            ...r,
            status: (i % 2 === 0 ? 'discard' : 'crash') as ExperimentStatus,
            valBpb: i % 2 === 0 ? r.valBpb : 0.0,
            memoryGb: i % 2 === 0 ? r.memoryGb : 0.0,
          }));

          registry.clear();
          for (const result of noKeepResults) {
            await registry.recordResult(result);
          }

          expect(registry.getBestValBpb()).toBe(Infinity);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 5.3: getRecentResults() returns at most 50 results
  // --------------------------------------------------------------------------
  describe('getRecentResults() returns at most 50 results', () => {
    it('for any number of experiments, getRecentResults() should return at most 50 results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          async (count) => {
            registry.clear();

            // Generate unique commits for each experiment
            for (let i = 0; i < count; i++) {
              const result: ExperimentResult = {
                commit: `${i.toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: `agent-${i % 4}`,
                timestamp: new Date(Date.now() - i * 60000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              await registry.recordResult(result);
            }

            const recentResults = await registry.getRecentResults(100);

            expect(recentResults.length).toBeLessThanOrEqual(50);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('for exactly 50 experiments, getRecentResults() should return exactly 50 results', async () => {
      registry.clear();

      for (let i = 0; i < 50; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        await registry.recordResult(result);
      }

      const recentResults = await registry.getRecentResults(100);

      expect(recentResults.length).toBe(50);
    });

    it('for fewer than 50 experiments, getRecentResults() should return all experiments', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 49 }),
          async (count) => {
            registry.clear();

            for (let i = 0; i < count; i++) {
              const result: ExperimentResult = {
                commit: `${i.toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: `agent-${i % 4}`,
                timestamp: new Date(Date.now() - i * 60000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              await registry.recordResult(result);
            }

            const recentResults = await registry.getRecentResults(100);

            expect(recentResults.length).toBe(count);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 5.4: getRecentResults() returns results ordered by timestamp descending
  // --------------------------------------------------------------------------
  describe('getRecentResults() returns results ordered by timestamp descending', () => {
    it('for any sequence of experiments, getRecentResults() should return results ordered by timestamp descending', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const recentResults = await registry.getRecentResults(50);

          // Verify ordering: each result should have a timestamp >= the next result
          for (let i = 0; i < recentResults.length - 1; i++) {
            const currentTime = new Date(recentResults[i]!.timestamp).getTime();
            const nextTime = new Date(recentResults[i + 1]!.timestamp).getTime();
            expect(currentTime).toBeGreaterThanOrEqual(nextTime);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('most recent experiment should be first in getRecentResults()', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const recentResults = await registry.getRecentResults(50);

          // Find the most recent timestamp from input
          const mostRecentTimestamp = Math.max(
            ...results.map(r => new Date(r.timestamp).getTime())
          );

          // First result should have the most recent timestamp
          const firstResultTime = new Date(recentResults[0]!.timestamp).getTime();
          expect(firstResultTime).toBe(mostRecentTimestamp);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('oldest experiment should be last in getRecentResults() when count <= 50', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const recentResults = await registry.getRecentResults(50);

          // Find the oldest timestamp from input
          const oldestTimestamp = Math.min(
            ...results.map(r => new Date(r.timestamp).getTime())
          );

          // Last result should have the oldest timestamp
          const lastResultTime = new Date(recentResults[recentResults.length - 1]!.timestamp).getTime();
          expect(lastResultTime).toBe(oldestTimestamp);

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 5.5: getState() returns correct SwarmState
  // --------------------------------------------------------------------------
  describe('getState() returns correct SwarmState', () => {
    it('for any sequence of experiments, getState() should return correct bestValBpb and recentResults', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const state = await registry.getState();

          // Verify bestValBpb
          const keepResults = results.filter(r => r.status === 'keep');
          const expectedBest = keepResults.length > 0
            ? Math.min(...keepResults.map(r => r.valBpb))
            : Infinity;
          expect(state.bestValBpb).toBeCloseTo(expectedBest, 5);

          // Verify totalExperiments
          expect(state.totalExperiments).toBe(results.length);

          // Verify recentResults count
          expect(state.recentResults.length).toBeLessThanOrEqual(50);
          expect(state.recentResults.length).toBe(Math.min(results.length, 50));

          // Verify recentResults ordering
          for (let i = 0; i < state.recentResults.length - 1; i++) {
            const currentTime = new Date(state.recentResults[i]!.timestamp).getTime();
            const nextTime = new Date(state.recentResults[i + 1]!.timestamp).getTime();
            expect(currentTime).toBeGreaterThanOrEqual(nextTime);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('getState().recentResults should contain at most 50 results even with many experiments', async () => {
      registry.clear();

      // Add 100 experiments
      for (let i = 0; i < 100; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        await registry.recordResult(result);
      }

      const state = await registry.getState();

      expect(state.totalExperiments).toBe(100);
      expect(state.recentResults.length).toBe(50);
    });
  });
});


// ============================================================================
// Property 6: State Persistence Round-Trip
// ============================================================================

/**
 * Property-based tests for State Persistence Round-Trip.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 6: State Persistence Round-Trip
 * 
 * For any swarm state persisted to disk, restarting the Swarm_Coordinator and restoring
 * from the persisted results.tsv shall produce an equivalent state with the same
 * best_val_bpb, total_experiments, and experiment history.
 * 
 * **Validates: Requirements 2.4, 9.2**
 */
describe('Property 6: State Persistence Round-Trip', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property6-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 6.1: best_val_bpb is preserved after persist/restore
  // --------------------------------------------------------------------------
  describe('best_val_bpb is preserved after persist/restore', () => {
    it('for any sequence of experiments, best_val_bpb should be identical after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const originalBestValBpb = registry.getBestValBpb();
          await registry.persist();

          // Create a new registry and restore from disk
          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          const restoredBestValBpb = restoredRegistry.getBestValBpb();

          // Best val_bpb should be identical (within floating point tolerance)
          if (originalBestValBpb === Infinity) {
            expect(restoredBestValBpb).toBe(Infinity);
          } else {
            expect(restoredBestValBpb).toBeCloseTo(originalBestValBpb, 5);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('best_val_bpb should be Infinity after restore when no "keep" experiments exist', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          // Make all experiments non-keep
          const nonKeepResults = results.map((r, i) => ({
            ...r,
            status: (i % 2 === 0 ? 'discard' : 'crash') as ExperimentStatus,
            valBpb: i % 2 === 0 ? r.valBpb : 0.0,
            memoryGb: i % 2 === 0 ? r.memoryGb : 0.0,
          }));

          registry.clear();
          for (const result of nonKeepResults) {
            await registry.recordResult(result);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          expect(restoredRegistry.getBestValBpb()).toBe(Infinity);

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.2: total_experiments is preserved after persist/restore
  // --------------------------------------------------------------------------
  describe('total_experiments is preserved after persist/restore', () => {
    it('for any sequence of experiments, total_experiments should be identical after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 50), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const originalTotal = registry.getTotalExperiments();
          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          const restoredTotal = restoredRegistry.getTotalExperiments();

          expect(restoredTotal).toBe(originalTotal);

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('total_experiments should be 0 after restore from empty state', async () => {
      registry.clear();
      await registry.persist();

      const restoredRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await restoredRegistry.restore();

      expect(restoredRegistry.getTotalExperiments()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.3: experiment history is preserved after persist/restore
  // --------------------------------------------------------------------------
  describe('experiment history is preserved after persist/restore', () => {
    it('for any sequence of experiments, all experiment results should be preserved after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Verify all experiments are present
          for (const originalResult of results) {
            const restoredResult = restoredRegistry.getResultByCommit(originalResult.commit);
            expect(restoredResult).toBeDefined();

            // Verify all fields match
            expect(restoredResult!.commit).toBe(originalResult.commit);
            expect(restoredResult!.status).toBe(originalResult.status);
            expect(restoredResult!.agentId).toBe(originalResult.agentId);
            expect(restoredResult!.timestamp).toBe(originalResult.timestamp);
            expect(restoredResult!.branch).toBe(originalResult.branch);

            // Numeric fields with tolerance
            expect(restoredResult!.valBpb).toBeCloseTo(originalResult.valBpb, 5);
            expect(restoredResult!.memoryGb).toBeCloseTo(originalResult.memoryGb, 0);

            // Description may have tabs/newlines normalized
            const normalizedDescription = originalResult.description.replace(/[\t\n\r]/g, ' ');
            expect(restoredResult!.description).toBe(normalizedDescription);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('experiment order should be preserved in getAllResults() after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const originalResults = registry.getAllResults();
          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          const restoredResults = restoredRegistry.getAllResults();

          // Same number of results
          expect(restoredResults.length).toBe(originalResults.length);

          // Same order (by commit)
          for (let i = 0; i < originalResults.length; i++) {
            expect(restoredResults[i]!.commit).toBe(originalResults[i]!.commit);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.4: search index is rebuilt correctly after restore
  // --------------------------------------------------------------------------
  describe('search index is rebuilt correctly after restore', () => {
    it('for any experiment with a description, searchSimilar should find it after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // For each result, verify it can be found via search
          for (const result of results) {
            // Get the first word of the description for search
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              const searchResults = await restoredRegistry.searchSimilar(words[0]!, 100);
              const found = searchResults.some(r => r.commit === result.commit);
              expect(found).toBe(true);
            }
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('search index should return same results before and after persist/restore', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(3, 15),
          fc.integer({ min: 0, max: 2 }),
          async (results, searchIndex) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            // Pick a search term from one of the results
            const targetResult = results[searchIndex % results.length];
            const normalizedDescription = targetResult!.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.split(/\s+/).filter(w => w.length > 0);

            if (words.length === 0) {
              return true; // Skip if no searchable words
            }

            const searchTerm = words[0]!;
            const originalSearchResults = await registry.searchSimilar(searchTerm, 100);

            await registry.persist();

            const restoredRegistry = createExperimentRegistry({
              logger: createSilentLogger(),
              resultsPath,
            });
            await restoredRegistry.restore();

            const restoredSearchResults = await restoredRegistry.searchSimilar(searchTerm, 100);

            // Same commits should be found (order may differ due to match count ties)
            const originalCommits = new Set(originalSearchResults.map(r => r.commit));
            const restoredCommits = new Set(restoredSearchResults.map(r => r.commit));

            expect(restoredCommits).toEqual(originalCommits);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.5: SwarmState is equivalent after persist/restore
  // --------------------------------------------------------------------------
  describe('SwarmState is equivalent after persist/restore', () => {
    it('for any sequence of experiments, getState() should return equivalent state after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const originalState = await registry.getState();
          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          const restoredState = await restoredRegistry.getState();

          // Verify bestValBpb
          if (originalState.bestValBpb === Infinity) {
            expect(restoredState.bestValBpb).toBe(Infinity);
          } else {
            expect(restoredState.bestValBpb).toBeCloseTo(originalState.bestValBpb, 5);
          }

          // Verify totalExperiments
          expect(restoredState.totalExperiments).toBe(originalState.totalExperiments);

          // Verify recentResults count
          expect(restoredState.recentResults.length).toBe(originalState.recentResults.length);

          // Verify recentResults content (same commits in same order)
          for (let i = 0; i < originalState.recentResults.length; i++) {
            expect(restoredState.recentResults[i].commit).toBe(originalState.recentResults[i].commit);
            expect(restoredState.recentResults[i].status).toBe(originalState.recentResults[i].status);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.6: Multiple persist/restore cycles preserve state
  // --------------------------------------------------------------------------
  describe('multiple persist/restore cycles preserve state', () => {
    it('for any sequence of experiments, state should be preserved across multiple persist/restore cycles', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 20),
          fc.integer({ min: 2, max: 5 }),
          async (results, cycles) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            const originalBestValBpb = registry.getBestValBpb();
            const originalTotal = registry.getTotalExperiments();

            let currentRegistry = registry;

            // Perform multiple persist/restore cycles
            for (let i = 0; i < cycles; i++) {
              await currentRegistry.persist();

              currentRegistry = createExperimentRegistry({
                logger: createSilentLogger(),
                resultsPath,
              });
              await currentRegistry.restore();
            }

            // Verify state is still correct after all cycles
            if (originalBestValBpb === Infinity) {
              expect(currentRegistry.getBestValBpb()).toBe(Infinity);
            } else {
              expect(currentRegistry.getBestValBpb()).toBeCloseTo(originalBestValBpb, 5);
            }
            expect(currentRegistry.getTotalExperiments()).toBe(originalTotal);

            // Verify all experiments are still present
            for (const result of results) {
              const restored = currentRegistry.getResultByCommit(result.commit);
              expect(restored).toBeDefined();
              expect(restored!.status).toBe(result.status);
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 6.7: Lineage is preserved after persist/restore
  // --------------------------------------------------------------------------
  describe('lineage is preserved after persist/restore', () => {
    it('for any experiments with parent relationships, lineage should be preserved after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 15), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set up some parent relationships
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Verify lineage is preserved
          for (let i = 1; i < results.length; i++) {
            const lineage = await restoredRegistry.getLineage(results[i]!.commit);
            expect(lineage).toBeDefined();
            expect(lineage!.parent).toBe(results[i - 1]!.commit);
          }

          // Verify first experiment has no parent
          const firstLineage = await restoredRegistry.getLineage(results[0]!.commit);
          expect(firstLineage).toBeDefined();
          expect(firstLineage!.parent).toBeNull();

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 7: Join State Completeness
// ============================================================================

/**
 * Property-based tests for Join State Completeness.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 7: Join State Completeness
 * 
 * For any new agent joining the swarm, the Experiment_Registry shall provide the
 * complete experiment history (all recorded results) and the current best val_bpb.
 * 
 * **Validates: Requirements 2.5**
 */
describe('Property 7: Join State Completeness', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property7-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 7.1: getState() includes all recorded results (up to 50 recent)
  // --------------------------------------------------------------------------
  describe('getState() includes all recorded results (up to 50 recent)', () => {
    it('for any sequence of experiments <= 50, getState().recentResults should include all recorded results', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 50), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const state = await registry.getState();

          // All results should be included in recentResults
          expect(state.recentResults.length).toBe(results.length);

          // Verify all commits are present
          const stateCommits = new Set(state.recentResults.map(r => r.commit));
          for (const result of results) {
            expect(stateCommits.has(result.commit)).toBe(true);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('for any sequence of experiments > 50, getState().recentResults should include the 50 most recent', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 51, max: 100 }),
          async (count) => {
            registry.clear();

            const results: ExperimentResult[] = [];
            // Generate experiments with distinct timestamps
            for (let i = 0; i < count; i++) {
              const result: ExperimentResult = {
                commit: `${i.toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: `agent-${i % 4}`,
                // Ensure distinct timestamps - older experiments have earlier timestamps
                timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              results.push(result);
              await registry.recordResult(result);
            }

            const state = await registry.getState();

            // Should have exactly 50 recent results
            expect(state.recentResults.length).toBe(50);

            // Should include the 50 most recent (highest timestamps)
            const sortedByTimestamp = [...results].sort((a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
            const expectedRecent = sortedByTimestamp.slice(0, 50);
            const expectedCommits = new Set(expectedRecent.map(r => r.commit));

            const stateCommits = new Set(state.recentResults.map(r => r.commit));
            expect(stateCommits).toEqual(expectedCommits);

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 7.2: getState() includes the correct best val_bpb
  // --------------------------------------------------------------------------
  describe('getState() includes the correct best val_bpb', () => {
    it('for any sequence of experiments, getState().bestValBpb should equal the minimum val_bpb among "keep" experiments', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 50), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const state = await registry.getState();

          const keepResults = results.filter(r => r.status === 'keep');
          const expectedBest = keepResults.length > 0
            ? Math.min(...keepResults.map(r => r.valBpb))
            : Infinity;

          if (expectedBest === Infinity) {
            expect(state.bestValBpb).toBe(Infinity);
          } else {
            expect(state.bestValBpb).toBeCloseTo(expectedBest, 5);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('getState().bestValBpb should be Infinity when no "keep" experiments exist', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          // Make all experiments non-keep
          const nonKeepResults = results.map((r, i) => ({
            ...r,
            status: (i % 2 === 0 ? 'discard' : 'crash') as ExperimentStatus,
            valBpb: i % 2 === 0 ? r.valBpb : 0.0,
            memoryGb: i % 2 === 0 ? r.memoryGb : 0.0,
          }));

          registry.clear();
          for (const result of nonKeepResults) {
            await registry.recordResult(result);
          }

          const state = await registry.getState();
          expect(state.bestValBpb).toBe(Infinity);

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 7.3: getAllResults() returns the complete experiment history
  // --------------------------------------------------------------------------
  describe('getAllResults() returns the complete experiment history', () => {
    it('for any sequence of experiments, getAllResults() should return all recorded results', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 100), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const allResults = registry.getAllResults();

          // Should have all results
          expect(allResults.length).toBe(results.length);

          // All commits should be present
          const allCommits = new Set(allResults.map(r => r.commit));
          for (const result of results) {
            expect(allCommits.has(result.commit)).toBe(true);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('getAllResults() should return results in insertion order', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const allResults = registry.getAllResults();

          // Results should be in the same order as they were inserted
          for (let i = 0; i < results.length; i++) {
            expect(allResults[i]!.commit).toBe(results[i]!.commit);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('getAllResults() should return more than 50 results when more exist', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 51, max: 100 }),
          async (count) => {
            registry.clear();

            for (let i = 0; i < count; i++) {
              const result: ExperimentResult = {
                commit: `${i.toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: `agent-${i % 4}`,
                timestamp: new Date(Date.now() - i * 60000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              await registry.recordResult(result);
            }

            const allResults = registry.getAllResults();

            // Should have all results, not limited to 50
            expect(allResults.length).toBe(count);

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 7.4: A new agent joining can access all experiment data
  // --------------------------------------------------------------------------
  describe('a new agent joining can access all experiment data', () => {
    it('for any sequence of experiments, a new registry instance should be able to restore and access all data', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 50), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Persist state (simulating existing swarm state)
          await registry.persist();

          // Create a new registry instance (simulating a new agent joining)
          const newAgentRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newAgentRegistry.restore();

          // New agent should have access to complete history
          const allResults = newAgentRegistry.getAllResults();
          expect(allResults.length).toBe(results.length);

          // New agent should have access to correct best val_bpb
          const keepResults = results.filter(r => r.status === 'keep');
          const expectedBest = keepResults.length > 0
            ? Math.min(...keepResults.map(r => r.valBpb))
            : Infinity;

          if (expectedBest === Infinity) {
            expect(newAgentRegistry.getBestValBpb()).toBe(Infinity);
          } else {
            expect(newAgentRegistry.getBestValBpb()).toBeCloseTo(expectedBest, 5);
          }

          // New agent should be able to get state
          const state = await newAgentRegistry.getState();
          expect(state.totalExperiments).toBe(results.length);

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('a new agent should be able to access experiment data by commit', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 30), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          await registry.persist();

          // New agent joins
          const newAgentRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newAgentRegistry.restore();

          // New agent should be able to look up any experiment by commit
          for (const result of results) {
            const found = newAgentRegistry.getResultByCommit(result.commit);
            expect(found).toBeDefined();
            expect(found!.commit).toBe(result.commit);
            expect(found!.status).toBe(result.status);
            expect(found!.agentId).toBe(result.agentId);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('a new agent should be able to search experiments by description', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          await registry.persist();

          // New agent joins
          const newAgentRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newAgentRegistry.restore();

          // New agent should be able to search experiments
          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              const searchResults = await newAgentRegistry.searchSimilar(words[0]!, 100);
              const found = searchResults.some(r => r.commit === result.commit);
              expect(found).toBe(true);
            }
          }

          return true;
        }),
        { numRuns: 30 }
      );
    });

    it('a new agent should be able to access experiment lineage', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 15), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set up parent relationships
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          await registry.persist();

          // New agent joins
          const newAgentRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await newAgentRegistry.restore();

          // New agent should be able to access lineage
          for (let i = 1; i < results.length; i++) {
            const lineage = await newAgentRegistry.getLineage(results[i]!.commit);
            expect(lineage).toBeDefined();
            expect(lineage!.parent).toBe(results[i - 1]!.commit);
          }

          return true;
        }),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 7.5: State completeness with large experiment counts
  // --------------------------------------------------------------------------
  describe('state completeness with large experiment counts', () => {
    it('for 100+ experiments, getAllResults() should return complete history while getState() returns 50 recent', async () => {
      registry.clear();

      const count = 100;
      const results: ExperimentResult[] = [];

      for (let i = 0; i < count; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        results.push(result);
        await registry.recordResult(result);
      }

      // getAllResults() should return all 100
      const allResults = registry.getAllResults();
      expect(allResults.length).toBe(100);

      // getState().recentResults should return only 50
      const state = await registry.getState();
      expect(state.recentResults.length).toBe(50);

      // But totalExperiments should reflect the full count
      expect(state.totalExperiments).toBe(100);
    });

    it('new agent joining should have access to complete history even when > 50 experiments', async () => {
      registry.clear();

      const count = 75;
      for (let i = 0; i < count; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `experiment ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        await registry.recordResult(result);
      }

      await registry.persist();

      // New agent joins
      const newAgentRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newAgentRegistry.restore();

      // New agent should have complete history
      const allResults = newAgentRegistry.getAllResults();
      expect(allResults.length).toBe(count);

      // State should show correct total
      const state = await newAgentRegistry.getState();
      expect(state.totalExperiments).toBe(count);
      expect(state.recentResults.length).toBe(50); // Limited to 50 recent
    });
  });
});


// ============================================================================
// Property 17: Experiment Lineage Tracking
// ============================================================================

/**
 * Property-based tests for Experiment Lineage Tracking.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 17: Experiment Lineage Tracking
 * 
 * For any successful experiment that builds on a previous commit, the Experiment_Registry
 * shall record the parent-child relationship in the lineage data.
 * 
 * **Validates: Requirements 5.5**
 */
describe('Property 17: Experiment Lineage Tracking', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property17-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 17.1: setParent() correctly records parent in getLineage()
  // --------------------------------------------------------------------------
  describe('setParent() correctly records parent in getLineage()', () => {
    it('for any experiment with a parent set via setParent(), getLineage() should return the correct parent', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set parent relationships: each experiment (except first) has the previous as parent
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          // Verify each experiment's lineage returns the correct parent
          for (let i = 1; i < results.length; i++) {
            const lineage = await registry.getLineage(results[i]!.commit);
            expect(lineage).toBeDefined();
            expect(lineage!.parent).toBe(results[i - 1]!.commit);
          }

          // First experiment should have no parent
          const firstLineage = await registry.getLineage(results[0]!.commit);
          expect(firstLineage).toBeDefined();
          expect(firstLineage!.parent).toBeNull();

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('setParent() should update parent even if called multiple times', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set initial parent
          registry.setParent(results[2]!.commit, results[0]!.commit);
          let lineage = await registry.getLineage(results[2]!.commit);
          expect(lineage!.parent).toBe(results[0]!.commit);

          // Update parent to a different commit
          registry.setParent(results[2]!.commit, results[1]!.commit);
          lineage = await registry.getLineage(results[2]!.commit);
          expect(lineage!.parent).toBe(results[1]!.commit);

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17.2: Parent experiments have the child in their children array
  // --------------------------------------------------------------------------
  describe('parent experiments have the child in their children array', () => {
    it('for any parent-child relationship, the parent should have the child in its children array', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(2, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set parent relationships
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          // Verify each parent has the correct child in its children array
          for (let i = 0; i < results.length - 1; i++) {
            const parentLineage = await registry.getLineage(results[i]!.commit);
            expect(parentLineage).toBeDefined();
            expect(parentLineage!.children).toContain(results[i + 1]!.commit);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('a parent with multiple children should have all children in its children array', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(4, 15), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set first experiment as parent of all others
          const parentCommit = results[0]!.commit;
          const childCommits = results.slice(1).map(r => r.commit);

          for (const childCommit of childCommits) {
            registry.setParent(childCommit, parentCommit);
          }

          // Verify parent has all children
          const parentLineage = await registry.getLineage(parentCommit);
          expect(parentLineage).toBeDefined();
          expect(parentLineage!.children.length).toBe(childCommits.length);

          for (const childCommit of childCommits) {
            expect(parentLineage!.children).toContain(childCommit);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('children array should not contain duplicates', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set parent multiple times for the same child
          registry.setParent(results[1]!.commit, results[0]!.commit);
          registry.setParent(results[1]!.commit, results[0]!.commit);
          registry.setParent(results[1]!.commit, results[0]!.commit);

          const parentLineage = await registry.getLineage(results[0]!.commit);
          expect(parentLineage).toBeDefined();

          // Children array should have no duplicates
          const uniqueChildren = new Set(parentLineage!.children);
          expect(uniqueChildren.size).toBe(parentLineage!.children.length);

          return true;
        }),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17.3: Lineage is preserved after persist/restore
  // --------------------------------------------------------------------------
  describe('lineage is preserved after persist/restore', () => {
    it('for any experiments with parent relationships, lineage should be preserved after persist and restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 15), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set up parent relationships
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Verify parent relationships are preserved
          for (let i = 1; i < results.length; i++) {
            const lineage = await restoredRegistry.getLineage(results[i]!.commit);
            expect(lineage).toBeDefined();
            expect(lineage!.parent).toBe(results[i - 1]!.commit);
          }

          // Verify first experiment has no parent
          const firstLineage = await restoredRegistry.getLineage(results[0]!.commit);
          expect(firstLineage).toBeDefined();
          expect(firstLineage!.parent).toBeNull();

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('children arrays should be correctly rebuilt after persist/restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(4, 12), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Set first experiment as parent of all others
          const parentCommit = results[0]!.commit;
          const childCommits = results.slice(1).map(r => r.commit);

          for (const childCommit of childCommits) {
            registry.setParent(childCommit, parentCommit);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Verify children array is correctly rebuilt
          const parentLineage = await restoredRegistry.getLineage(parentCommit);
          expect(parentLineage).toBeDefined();
          expect(parentLineage!.children.length).toBe(childCommits.length);

          for (const childCommit of childCommits) {
            expect(parentLineage!.children).toContain(childCommit);
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('lineage should survive multiple persist/restore cycles', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(3, 10),
          fc.integer({ min: 2, max: 4 }),
          async (results, cycles) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            // Set up parent relationships
            for (let i = 1; i < results.length; i++) {
              registry.setParent(results[i]!.commit, results[i - 1]!.commit);
            }

            let currentRegistry = registry;

            // Perform multiple persist/restore cycles
            for (let i = 0; i < cycles; i++) {
              await currentRegistry.persist();

              currentRegistry = createExperimentRegistry({
                logger: createSilentLogger(),
                resultsPath,
              });
              await currentRegistry.restore();
            }

            // Verify lineage is still correct after all cycles
            for (let i = 1; i < results.length; i++) {
              const lineage = await currentRegistry.getLineage(results[i]!.commit);
              expect(lineage).toBeDefined();
              expect(lineage!.parent).toBe(results[i - 1]!.commit);
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17.4: Multiple levels of lineage are tracked correctly
  // --------------------------------------------------------------------------
  describe('multiple levels of lineage (grandparent -> parent -> child) are tracked correctly', () => {
    it('for any chain of experiments, each level of lineage should be correctly tracked', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(4, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Create a chain: results[0] -> results[1] -> results[2] -> ... -> results[n-1]
          for (let i = 1; i < results.length; i++) {
            registry.setParent(results[i]!.commit, results[i - 1]!.commit);
          }

          // Verify each level of the chain
          for (let i = 0; i < results.length; i++) {
            const lineage = await registry.getLineage(results[i]!.commit);
            expect(lineage).toBeDefined();

            // Check parent
            if (i === 0) {
              expect(lineage!.parent).toBeNull();
            } else {
              expect(lineage!.parent).toBe(results[i - 1]!.commit);
            }

            // Check children
            if (i === results.length - 1) {
              expect(lineage!.children.length).toBe(0);
            } else {
              expect(lineage!.children).toContain(results[i + 1]!.commit);
            }
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('grandparent-parent-child relationships should be traversable', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(3, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Create chain: grandparent -> parent -> child
          const grandparent = results[0]!.commit;
          const parent = results[1]!.commit;
          const child = results[2]!.commit;

          registry.setParent(parent, grandparent);
          registry.setParent(child, parent);

          // Verify child can trace back to grandparent
          const childLineage = await registry.getLineage(child);
          expect(childLineage).toBeDefined();
          expect(childLineage!.parent).toBe(parent);

          const parentLineage = await registry.getLineage(childLineage!.parent!);
          expect(parentLineage).toBeDefined();
          expect(parentLineage!.parent).toBe(grandparent);

          const grandparentLineage = await registry.getLineage(parentLineage!.parent!);
          expect(grandparentLineage).toBeDefined();
          expect(grandparentLineage!.parent).toBeNull();

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('deep lineage chains should be preserved after persist/restore', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 5, max: 15 }),
          async (chainLength) => {
            registry.clear();

            // Create experiments for the chain
            const results: ExperimentResult[] = [];
            for (let i = 0; i < chainLength; i++) {
              const result: ExperimentResult = {
                commit: `${i.toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `experiment ${i}`,
                agentId: `agent-${i % 4}`,
                timestamp: new Date(Date.now() - i * 60000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              results.push(result);
              await registry.recordResult(result);
            }

            // Create the chain
            for (let i = 1; i < chainLength; i++) {
              registry.setParent(results[i]!.commit, results[i - 1]!.commit);
            }

            await registry.persist();

            const restoredRegistry = createExperimentRegistry({
              logger: createSilentLogger(),
              resultsPath,
            });
            await restoredRegistry.restore();

            // Verify the entire chain is preserved
            for (let i = 0; i < chainLength; i++) {
              const lineage = await restoredRegistry.getLineage(results[i]!.commit);
              expect(lineage).toBeDefined();

              if (i === 0) {
                expect(lineage!.parent).toBeNull();
              } else {
                expect(lineage!.parent).toBe(results[i - 1]!.commit);
              }

              if (i < chainLength - 1) {
                expect(lineage!.children).toContain(results[i + 1]!.commit);
              }
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });

    it('branching lineage (one parent with multiple children) should be tracked correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 8 }),
          async (branchCount) => {
            registry.clear();

            // Create root experiment
            const root: ExperimentResult = {
              commit: '0000000',
              valBpb: 1.0,
              memoryGb: 40,
              status: 'keep',
              description: 'root experiment',
              agentId: 'agent-0',
              timestamp: new Date().toISOString(),
              branch: 'autoresearch/swarm/agent-0',
            };
            await registry.recordResult(root);

            // Create branch experiments
            const branches: ExperimentResult[] = [];
            for (let i = 0; i < branchCount; i++) {
              const branch: ExperimentResult = {
                commit: `${(i + 1).toString(16).padStart(7, '0')}`,
                valBpb: 0.9 + Math.random() * 0.2,
                memoryGb: 40 + Math.random() * 10,
                status: 'keep',
                description: `branch ${i}`,
                agentId: `agent-${i % 4}`,
                timestamp: new Date(Date.now() + i * 1000).toISOString(),
                branch: `autoresearch/swarm/agent-${i % 4}`,
              };
              branches.push(branch);
              await registry.recordResult(branch);
              registry.setParent(branch.commit, root.commit);
            }

            // Verify root has all branches as children
            const rootLineage = await registry.getLineage(root.commit);
            expect(rootLineage).toBeDefined();
            expect(rootLineage!.children.length).toBe(branchCount);

            for (const branch of branches) {
              expect(rootLineage!.children).toContain(branch.commit);

              // Verify each branch has root as parent
              const branchLineage = await registry.getLineage(branch.commit);
              expect(branchLineage).toBeDefined();
              expect(branchLineage!.parent).toBe(root.commit);
            }

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17.5: getLineage() returns correct valBpb
  // --------------------------------------------------------------------------
  describe('getLineage() returns correct valBpb', () => {
    it('for any experiment, getLineage() should return the correct valBpb', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Verify each experiment's lineage has the correct valBpb
          for (const result of results) {
            const lineage = await registry.getLineage(result.commit);
            expect(lineage).toBeDefined();
            expect(lineage!.valBpb).toBeCloseTo(result.valBpb, 5);
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17.6: getLineage() returns null for unknown commits
  // --------------------------------------------------------------------------
  describe('getLineage() returns null for unknown commits', () => {
    it('for any unknown commit, getLineage() should return null', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 10),
          arbitraryCommit(),
          async (results, unknownCommit) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            // Skip if the unknown commit happens to match one of the results
            if (results.some(r => r.commit === unknownCommit)) {
              return true;
            }

            const lineage = await registry.getLineage(unknownCommit);
            expect(lineage).toBeNull();

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


// ============================================================================
// Property 37: Description Search Index
// ============================================================================

/**
 * Property-based tests for Description Search Index.
 * 
 * Feature: stdio-bus-swarm-autoresearch, Property 37: Description Search Index
 * 
 * For any experiment description stored in the Experiment_Registry, the searchable index
 * shall return that experiment when queried with matching keywords from the description.
 * 
 * **Validates: Requirements 5.3**
 */
describe('Property 37: Description Search Index', () => {
  let tempDir: string;
  let resultsPath: string;
  let registry: ExperimentRegistry;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-property37-test-'));
    resultsPath = path.join(tempDir, 'results.tsv');
    registry = createExperimentRegistry({
      logger: createSilentLogger(),
      resultsPath,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Property 37.1: searchSimilar() finds experiments with matching keywords
  // --------------------------------------------------------------------------
  describe('searchSimilar() finds experiments with matching keywords', () => {
    it('for any experiment with a description, searchSimilar() should find it when queried with words from the description', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // For each result, verify it can be found via search using words from its description
          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              // Search using the first word
              const searchResults = await registry.searchSimilar(words[0]!, 100);
              const found = searchResults.some(r => r.commit === result.commit);
              expect(found).toBe(true);
            }
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('searchSimilar() should find experiment when queried with any word from description', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 10),
          fc.integer({ min: 0, max: 100 }),
          async (results, wordIndexSeed) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            // Pick a random result and a random word from its description
            const targetResult = results[wordIndexSeed % results.length];
            const normalizedDescription = targetResult!.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              // Pick a random word from the description
              const wordIndex = wordIndexSeed % words.length;
              const searchWord = words[wordIndex];

              const searchResults = await registry.searchSimilar(searchWord, 100);
              const found = searchResults.some(r => r.commit === targetResult!.commit);
              expect(found).toBe(true);
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('searchSimilar() should find multiple experiments with the same keyword', async () => {
      registry.clear();

      // Create experiments with a common keyword
      const commonKeyword = 'optimization';
      const results: ExperimentResult[] = [];

      for (let i = 0; i < 5; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `${commonKeyword} experiment ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        results.push(result);
        await registry.recordResult(result);
      }

      const searchResults = await registry.searchSimilar(commonKeyword, 100);

      // All experiments should be found
      expect(searchResults.length).toBe(5);
      for (const result of results) {
        const found = searchResults.some(r => r.commit === result.commit);
        expect(found).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.2: Search is case-insensitive
  // --------------------------------------------------------------------------
  describe('search is case-insensitive', () => {
    it('searchSimilar() should find experiments regardless of case', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              const originalWord = words[0]!;

              // Search with lowercase
              const lowerResults = await registry.searchSimilar(originalWord!.toLowerCase(), 100);
              const foundLower = lowerResults.some(r => r.commit === result.commit);

              // Search with uppercase
              const upperResults = await registry.searchSimilar(originalWord!.toUpperCase(), 100);
              const foundUpper = upperResults.some(r => r.commit === result.commit);

              // Search with mixed case
              const mixedCase = originalWord!.split('').map((c, i) =>
                i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()
              ).join('');
              const mixedResults = await registry.searchSimilar(mixedCase, 100);
              const foundMixed = mixedResults.some(r => r.commit === result.commit);

              // All searches should find the experiment
              expect(foundLower).toBe(true);
              expect(foundUpper).toBe(true);
              expect(foundMixed).toBe(true);
            }
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('case-insensitive search should return same results for different cases', async () => {
      registry.clear();

      const result: ExperimentResult = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'Increase Learning Rate',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };
      await registry.recordResult(result);

      // All these searches should find the same experiment
      const searches = ['increase', 'INCREASE', 'Increase', 'InCrEaSe'];
      for (const search of searches) {
        const searchResults = await registry.searchSimilar(search, 100);
        expect(searchResults.length).toBe(1);
        expect(searchResults[0]!.commit).toBe(result.commit);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.3: Search ranks results by match count
  // --------------------------------------------------------------------------
  describe('search ranks results by match count', () => {
    it('experiments with more matching query words should rank higher', async () => {
      registry.clear();

      // Create experiments with varying numbers of matching keywords
      // The search index counts unique word matches from the query, not word frequency in description
      const result1: ExperimentResult = {
        commit: '0000001',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'learning rate optimization', // matches: learning, rate, optimization (3 unique words)
        agentId: 'agent-0',
        timestamp: new Date(Date.now() - 3000).toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };

      const result2: ExperimentResult = {
        commit: '0000002',
        valBpb: 0.94,
        memoryGb: 44.0,
        status: 'keep',
        description: 'learning only', // matches: learning (1 unique word from query)
        agentId: 'agent-1',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        branch: 'autoresearch/swarm/agent-1',
      };

      const result3: ExperimentResult = {
        commit: '0000003',
        valBpb: 0.93,
        memoryGb: 44.0,
        status: 'keep',
        description: 'batch size change', // no matching words
        agentId: 'agent-2',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        branch: 'autoresearch/swarm/agent-2',
      };

      await registry.recordResult(result1);
      await registry.recordResult(result2);
      await registry.recordResult(result3);

      // Search for 'learning rate' - result1 should rank higher (2 matches vs 1 match)
      const searchResults = await registry.searchSimilar('learning rate', 100);

      expect(searchResults.length).toBe(2); // result3 doesn't have 'learning' or 'rate'
      expect(searchResults[0]!.commit).toBe(result1.commit); // 2 matches (learning, rate)
      expect(searchResults[1]!.commit).toBe(result2.commit); // 1 match (learning)
    });

    it('multi-word search should rank by total match count', async () => {
      registry.clear();

      const result1: ExperimentResult = {
        commit: '0000001',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'increase learning rate', // matches: increase, learning, rate
        agentId: 'agent-0',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };

      const result2: ExperimentResult = {
        commit: '0000002',
        valBpb: 0.94,
        memoryGb: 44.0,
        status: 'keep',
        description: 'increase batch size', // matches: increase
        agentId: 'agent-1',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        branch: 'autoresearch/swarm/agent-1',
      };

      await registry.recordResult(result1);
      await registry.recordResult(result2);

      // Search for 'increase learning' - result1 should rank higher (2 matches vs 1)
      const searchResults = await registry.searchSimilar('increase learning', 100);

      expect(searchResults.length).toBe(2);
      expect(searchResults[0]!.commit).toBe(result1.commit); // 2 matches
      expect(searchResults[1]!.commit).toBe(result2.commit); // 1 match
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.4: Search index is rebuilt correctly after persist/restore
  // --------------------------------------------------------------------------
  describe('search index is rebuilt correctly after persist/restore', () => {
    it('for any experiments, search should work identically before and after persist/restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 15), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          // Collect search results before persist
          const searchResultsBefore: Map<string, string[]> = new Map();
          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);
            if (words.length > 0) {
              const searchResults = await registry.searchSimilar(words[0]!, 100);
              searchResultsBefore.set(result.commit, searchResults.map(r => r.commit));
            }
          }

          await registry.persist();

          // Create new registry and restore
          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Verify search results are identical after restore
          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);
            if (words.length > 0) {
              const searchResultsAfter = await restoredRegistry.searchSimilar(words[0]!, 100);
              const commitsAfter = searchResultsAfter.map(r => r.commit);
              const commitsBefore = searchResultsBefore.get(result.commit) ?? [];

              // Same commits should be found (order may differ due to match count ties)
              expect(new Set(commitsAfter)).toEqual(new Set(commitsBefore));
            }
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('search index should be fully functional after restore', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 20), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          await registry.persist();

          const restoredRegistry = createExperimentRegistry({
            logger: createSilentLogger(),
            resultsPath,
          });
          await restoredRegistry.restore();

          // Every experiment should be findable via search after restore
          for (const result of results) {
            const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
            const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);

            if (words.length > 0) {
              const searchResults = await restoredRegistry.searchSimilar(words[0]!, 100);
              const found = searchResults.some(r => r.commit === result.commit);
              expect(found).toBe(true);
            }
          }

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('search index should survive multiple persist/restore cycles', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 10),
          fc.integer({ min: 2, max: 4 }),
          async (results, cycles) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            let currentRegistry = registry;

            // Perform multiple persist/restore cycles
            for (let i = 0; i < cycles; i++) {
              await currentRegistry.persist();

              currentRegistry = createExperimentRegistry({
                logger: createSilentLogger(),
                resultsPath,
              });
              await currentRegistry.restore();
            }

            // Search should still work after all cycles
            for (const result of results) {
              const normalizedDescription = result.description.replace(/[\t\n\r]/g, ' ');
              const words = normalizedDescription.toLowerCase().split(/\s+/).filter(w => w.length > 0);

              if (words.length > 0) {
                const searchResults = await currentRegistry.searchSimilar(words[0]!, 100);
                const found = searchResults.some(r => r.commit === result.commit);
                expect(found).toBe(true);
              }
            }

            return true;
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.5: Empty search queries return empty results
  // --------------------------------------------------------------------------
  describe('empty search queries return empty results', () => {
    it('searchSimilar() with empty string should return empty results', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryUniqueExperimentResults(1, 10), async (results) => {
          registry.clear();
          for (const result of results) {
            await registry.recordResult(result);
          }

          const searchResults = await registry.searchSimilar('', 100);
          expect(searchResults.length).toBe(0);

          return true;
        }),
        { numRuns: 50 }
      );
    });

    it('searchSimilar() with whitespace-only string should return empty results', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueExperimentResults(1, 10),
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 10 }),
          async (results, whitespace) => {
            registry.clear();
            for (const result of results) {
              await registry.recordResult(result);
            }

            const searchResults = await registry.searchSimilar(whitespace, 100);
            expect(searchResults.length).toBe(0);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('searchSimilar() with non-matching query should return empty results', async () => {
      registry.clear();

      const result: ExperimentResult = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'increase learning rate',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };
      await registry.recordResult(result);

      // Search for a word that doesn't exist in any description
      const searchResults = await registry.searchSimilar('nonexistentword12345', 100);
      expect(searchResults.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.6: Search respects limit parameter
  // --------------------------------------------------------------------------
  describe('search respects limit parameter', () => {
    it('searchSimilar() should return at most limit results', async () => {
      registry.clear();

      // Create many experiments with a common keyword
      const commonKeyword = 'experiment';
      for (let i = 0; i < 20; i++) {
        const result: ExperimentResult = {
          commit: `${i.toString(16).padStart(7, '0')}`,
          valBpb: 0.9 + Math.random() * 0.2,
          memoryGb: 40 + Math.random() * 10,
          status: 'keep',
          description: `${commonKeyword} number ${i}`,
          agentId: `agent-${i % 4}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          branch: `autoresearch/swarm/agent-${i % 4}`,
        };
        await registry.recordResult(result);
      }

      // Search with different limits
      const limit5 = await registry.searchSimilar(commonKeyword, 5);
      expect(limit5.length).toBe(5);

      const limit10 = await registry.searchSimilar(commonKeyword, 10);
      expect(limit10.length).toBe(10);

      const limit100 = await registry.searchSimilar(commonKeyword, 100);
      expect(limit100.length).toBe(20); // Only 20 experiments exist
    });

    it('searchSimilar() with limit 0 should return empty results', async () => {
      registry.clear();

      const result: ExperimentResult = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test experiment',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };
      await registry.recordResult(result);

      const searchResults = await registry.searchSimilar('test', 0);
      expect(searchResults.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Property 37.7: Search handles special characters in descriptions
  // --------------------------------------------------------------------------
  describe('search handles special characters in descriptions', () => {
    it('descriptions with special characters should be searchable', async () => {
      registry.clear();

      const result: ExperimentResult = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'increase LR to 0.04 (from 0.02)',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };
      await registry.recordResult(result);

      // Should find by regular words
      let searchResults = await registry.searchSimilar('increase', 100);
      expect(searchResults.length).toBe(1);
      expect(searchResults[0]!.commit).toBe(result.commit);

      // Should find by 'LR'
      searchResults = await registry.searchSimilar('LR', 100);
      expect(searchResults.length).toBe(1);
      expect(searchResults[0]!.commit).toBe(result.commit);
    });

    it('search should handle descriptions with numbers', async () => {
      registry.clear();

      const result: ExperimentResult = {
        commit: 'abc1234',
        valBpb: 0.95,
        memoryGb: 44.0,
        status: 'keep',
        description: 'batch size 128 to 256',
        agentId: 'agent-0',
        timestamp: new Date().toISOString(),
        branch: 'autoresearch/swarm/agent-0',
      };
      await registry.recordResult(result);

      // Should find by number
      let searchResults = await registry.searchSimilar('128', 100);
      expect(searchResults.length).toBe(1);
      expect(searchResults[0]!.commit).toBe(result.commit);

      searchResults = await registry.searchSimilar('256', 100);
      expect(searchResults.length).toBe(1);
      expect(searchResults[0]!.commit).toBe(result.commit);
    });
  });
});
