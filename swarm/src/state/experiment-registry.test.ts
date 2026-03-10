/**
 * Unit tests for ExperimentRegistry class.
 * 
 * Tests core functionality:
 * - Recording experiment results
 * - State queries (getBestValBpb, getRecentResults, getState)
 * - Lineage tracking
 * - Description search
 * - Active agent management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExperimentRegistry,
  createExperimentRegistry,
  ExperimentResult,
  fromExperimentResultParams,
  toExperimentResultParams,
} from './experiment-registry';
import { ExperimentResultParams } from '../protocol/types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestResult(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    commit: 'a1b2c3d',
    valBpb: 0.997900,
    memoryGb: 44.0,
    status: 'keep',
    description: 'baseline experiment',
    agentId: 'agent-0',
    timestamp: '2025-01-15T10:00:00Z',
    branch: 'autoresearch/swarm/agent-0',
    ...overrides,
  };
}

function createSilentLogger() {
  return {
    info: () => { },
    warn: () => { },
    error: () => { },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ExperimentRegistry', () => {
  let registry: ExperimentRegistry;

  beforeEach(() => {
    registry = createExperimentRegistry({ logger: createSilentLogger() });
  });

  describe('constructor', () => {
    it('creates an empty registry', () => {
      expect(registry.getTotalExperiments()).toBe(0);
      expect(registry.getBestValBpb()).toBe(Infinity);
      expect(registry.getActiveAgents()).toEqual([]);
    });

    it('accepts custom options', () => {
      const customRegistry = createExperimentRegistry({
        resultsPath: '/custom/path/results.tsv',
        maxRecentResults: 100,
        logger: createSilentLogger(),
      });
      expect(customRegistry).toBeInstanceOf(ExperimentRegistry);
    });
  });

  describe('recordResult', () => {
    it('records a valid experiment result', async () => {
      const result = createTestResult();
      await registry.recordResult(result);

      expect(registry.getTotalExperiments()).toBe(1);
      expect(registry.getResultByCommit('a1b2c3d')).toEqual(result);
    });

    it('tracks active agents', async () => {
      await registry.recordResult(createTestResult({ agentId: 'agent-0' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', agentId: 'agent-1' }));

      const activeAgents = registry.getActiveAgents();
      expect(activeAgents).toContain('agent-0');
      expect(activeAgents).toContain('agent-1');
    });

    it('throws on invalid commit', async () => {
      const result = createTestResult({ commit: '' });
      await expect(registry.recordResult(result)).rejects.toThrow('commit must be a non-empty string');
    });

    it('throws on invalid valBpb', async () => {
      const result = createTestResult({ valBpb: NaN });
      await expect(registry.recordResult(result)).rejects.toThrow('valBpb must be a number');
    });

    it('throws on invalid status', async () => {
      const result = createTestResult({ status: 'invalid' as any });
      await expect(registry.recordResult(result)).rejects.toThrow('status must be');
    });

    it('throws on invalid agentId', async () => {
      const result = createTestResult({ agentId: '' });
      await expect(registry.recordResult(result)).rejects.toThrow('agentId must be a non-empty string');
    });
  });

  describe('getBestValBpb', () => {
    it('returns Infinity when no experiments exist', () => {
      expect(registry.getBestValBpb()).toBe(Infinity);
    });

    it('returns Infinity when no "keep" experiments exist', async () => {
      await registry.recordResult(createTestResult({ status: 'discard' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', status: 'crash' }));

      expect(registry.getBestValBpb()).toBe(Infinity);
    });

    it('returns minimum val_bpb across "keep" experiments', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900, status: 'keep' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200, status: 'keep' }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', valBpb: 1.005000, status: 'discard' }));

      expect(registry.getBestValBpb()).toBe(0.993200);
    });

    it('ignores crash and discard experiments', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.5, status: 'crash' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.6, status: 'discard' }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', valBpb: 0.997900, status: 'keep' }));

      expect(registry.getBestValBpb()).toBe(0.997900);
    });

    it('returns correct value with single "keep" experiment', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900, status: 'keep' }));

      expect(registry.getBestValBpb()).toBe(0.997900);
    });

    it('handles very small val_bpb values', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.000001, status: 'keep' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.000002, status: 'keep' }));

      expect(registry.getBestValBpb()).toBe(0.000001);
    });
  });

  describe('getRecentResults', () => {
    it('returns empty array when no experiments exist', async () => {
      const results = await registry.getRecentResults(10);
      expect(results).toEqual([]);
    });

    it('returns results ordered by timestamp descending', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', timestamp: '2025-01-15T10:00:00Z' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', timestamp: '2025-01-15T10:05:00Z' }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', timestamp: '2025-01-15T10:02:00Z' }));

      const results = await registry.getRecentResults(10);

      expect(results.length).toBe(3);
      expect(results[0]!.commit).toBe('b2c3d4e'); // Most recent
      expect(results[1]!.commit).toBe('c3d4e5f');
      expect(results[2]!.commit).toBe('a1b2c3d'); // Oldest
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await registry.recordResult(createTestResult({
          commit: `commit${i}`,
          timestamp: `2025-01-15T10:0${i}:00Z`,
        }));
      }

      const results = await registry.getRecentResults(5);
      expect(results.length).toBe(5);
    });

    it('respects maxRecentResults configuration', async () => {
      const limitedRegistry = createExperimentRegistry({
        maxRecentResults: 3,
        logger: createSilentLogger(),
      });

      for (let i = 0; i < 10; i++) {
        await limitedRegistry.recordResult(createTestResult({
          commit: `commit${i}`,
          timestamp: `2025-01-15T10:0${i}:00Z`,
        }));
      }

      const results = await limitedRegistry.getRecentResults(100);
      expect(results.length).toBe(3);
    });
  });

  describe('getState', () => {
    it('returns correct state for empty registry', async () => {
      const state = await registry.getState();

      expect(state.bestValBpb).toBe(Infinity);
      expect(state.totalExperiments).toBe(0);
      expect(state.activeAgents).toEqual([]);
      expect(state.recentResults).toEqual([]);
    });

    it('returns correct state with experiments', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900, agentId: 'agent-0' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200, agentId: 'agent-1' }));

      const state = await registry.getState();

      expect(state.bestValBpb).toBe(0.993200);
      expect(state.totalExperiments).toBe(2);
      expect(state.activeAgents).toContain('agent-0');
      expect(state.activeAgents).toContain('agent-1');
      expect(state.recentResults.length).toBe(2);
    });

    it('limits recentResults to maxRecentResults (default 50)', async () => {
      // Add 60 experiments
      for (let i = 0; i < 60; i++) {
        await registry.recordResult(createTestResult({
          commit: `commit${i.toString().padStart(3, '0')}`,
          timestamp: `2025-01-15T${(10 + Math.floor(i / 60)).toString().padStart(2, '0')}:${(i % 60).toString().padStart(2, '0')}:00Z`,
        }));
      }

      const state = await registry.getState();

      // totalExperiments should be 60
      expect(state.totalExperiments).toBe(60);
      // recentResults should be capped at 50 (default maxRecentResults)
      expect(state.recentResults.length).toBe(50);
    });

    it('returns recentResults ordered by timestamp descending', async () => {
      await registry.recordResult(createTestResult({ commit: 'oldest', timestamp: '2025-01-15T10:00:00Z' }));
      await registry.recordResult(createTestResult({ commit: 'newest', timestamp: '2025-01-15T10:10:00Z' }));
      await registry.recordResult(createTestResult({ commit: 'middle', timestamp: '2025-01-15T10:05:00Z' }));

      const state = await registry.getState();

      expect(state.recentResults[0]!.commit).toBe('newest');
      expect(state.recentResults[1]!.commit).toBe('middle');
      expect(state.recentResults[2]!.commit).toBe('oldest');
    });
  });

  describe('searchSimilar', () => {
    it('returns empty array for empty description', async () => {
      await registry.recordResult(createTestResult({ description: 'increase learning rate' }));

      const results = await registry.searchSimilar('', 10);
      expect(results).toEqual([]);
    });

    it('finds experiments with matching keywords', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', description: 'increase learning rate' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', description: 'decrease batch size' }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', description: 'increase batch size' }));

      const results = await registry.searchSimilar('increase', 10);

      expect(results.length).toBe(2);
      expect(results.map(r => r.commit)).toContain('a1b2c3d');
      expect(results.map(r => r.commit)).toContain('c3d4e5f');
    });

    it('ranks results by match count', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', description: 'increase learning rate to 0.04' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', description: 'increase batch size' }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', description: 'increase learning rate and batch size' }));

      const results = await registry.searchSimilar('increase learning rate', 10);

      // c3d4e5f and a1b2c3d should rank higher (3 matches each)
      expect(results.length).toBe(3);
      expect(results[0]!.commit).not.toBe('b2c3d4e'); // Only 1 match
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await registry.recordResult(createTestResult({
          commit: `commit${i}`,
          description: `experiment ${i} with learning rate`,
        }));
      }

      const results = await registry.searchSimilar('learning rate', 3);
      expect(results.length).toBe(3);
    });

    it('is case-insensitive', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', description: 'Increase Learning Rate' }));

      const results = await registry.searchSimilar('increase learning rate', 10);
      expect(results.length).toBe(1);
      expect(results[0]!.commit).toBe('a1b2c3d');
    });
  });

  describe('lineage tracking', () => {
    it('initializes lineage for new commits', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d' }));

      const lineage = await registry.getLineage('a1b2c3d');

      expect(lineage).not.toBeNull();
      expect(lineage!.commit).toBe('a1b2c3d');
      expect(lineage!.parent).toBeNull();
      expect(lineage!.children).toEqual([]);
    });

    it('tracks parent-child relationships', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900 }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200 }));

      registry.setParent('b2c3d4e', 'a1b2c3d');

      const parentLineage = await registry.getLineage('a1b2c3d');
      const childLineage = await registry.getLineage('b2c3d4e');

      expect(parentLineage!.children).toContain('b2c3d4e');
      expect(childLineage!.parent).toBe('a1b2c3d');
    });

    it('returns null for unknown commits', async () => {
      const lineage = await registry.getLineage('unknown');
      expect(lineage).toBeNull();
    });

    it('includes valBpb in lineage', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900 }));

      const lineage = await registry.getLineage('a1b2c3d');
      expect(lineage!.valBpb).toBe(0.997900);
    });
  });

  describe('active agent management', () => {
    it('registers agents', () => {
      registry.registerAgent('agent-0');
      registry.registerAgent('agent-1');

      const agents = registry.getActiveAgents();
      expect(agents).toContain('agent-0');
      expect(agents).toContain('agent-1');
    });

    it('unregisters agents', () => {
      registry.registerAgent('agent-0');
      registry.registerAgent('agent-1');
      registry.unregisterAgent('agent-0');

      const agents = registry.getActiveAgents();
      expect(agents).not.toContain('agent-0');
      expect(agents).toContain('agent-1');
    });

    it('does not duplicate agents', () => {
      registry.registerAgent('agent-0');
      registry.registerAgent('agent-0');

      const agents = registry.getActiveAgents();
      expect(agents.filter(a => a === 'agent-0').length).toBe(1);
    });
  });

  describe('utility methods', () => {
    it('getAllResults returns all recorded results', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e' }));

      const results = registry.getAllResults();
      expect(results.length).toBe(2);
    });

    it('getResultByCommit returns correct result', async () => {
      const result = createTestResult({ commit: 'a1b2c3d' });
      await registry.recordResult(result);

      expect(registry.getResultByCommit('a1b2c3d')).toEqual(result);
      expect(registry.getResultByCommit('unknown')).toBeUndefined();
    });

    it('clear removes all state', async () => {
      await registry.recordResult(createTestResult());
      registry.registerAgent('agent-0');
      registry.setParent('b2c3d4e', 'a1b2c3d');

      registry.clear();

      expect(registry.getTotalExperiments()).toBe(0);
      expect(registry.getActiveAgents()).toEqual([]);
      expect(registry.getBestValBpb()).toBe(Infinity);
    });
  });

  describe('conversion utilities', () => {
    it('fromExperimentResultParams converts correctly', () => {
      const params: ExperimentResultParams = {
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test',
        agentId: 'agent-0',
        timestamp: '2025-01-15T10:00:00Z',
        branch: 'autoresearch/swarm/agent-0',
      };

      const result = fromExperimentResultParams(params);

      expect(result.commit).toBe(params.commit);
      expect(result.valBpb).toBe(params.valBpb);
      expect(result.memoryGb).toBe(params.memoryGb);
      expect(result.status).toBe(params.status);
      expect(result.description).toBe(params.description);
      expect(result.agentId).toBe(params.agentId);
      expect(result.timestamp).toBe(params.timestamp);
      expect(result.branch).toBe(params.branch);
    });

    it('toExperimentResultParams converts correctly', () => {
      const result: ExperimentResult = {
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        memoryGb: 44.0,
        status: 'keep',
        description: 'test',
        agentId: 'agent-0',
        timestamp: '2025-01-15T10:00:00Z',
        branch: 'autoresearch/swarm/agent-0',
      };

      const params = toExperimentResultParams(result);

      expect(params.commit).toBe(result.commit);
      expect(params.valBpb).toBe(result.valBpb);
      expect(params.memoryGb).toBe(result.memoryGb);
      expect(params.status).toBe(result.status);
      expect(params.description).toBe(result.description);
      expect(params.agentId).toBe(result.agentId);
      expect(params.timestamp).toBe(result.timestamp);
      expect(params.branch).toBe(result.branch);
    });
  });
});


// ============================================================================
// Persistence Tests
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ExperimentRegistry Persistence', () => {
  let registry: ExperimentRegistry;
  let tempDir: string;
  let resultsPath: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'experiment-registry-test-'));
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

  describe('persist', () => {
    it('creates results.tsv with correct header', async () => {
      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n');

      expect(lines[0]).toBe('commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch\tparent');
    });

    it('writes experiment results in TSV format', async () => {
      await registry.recordResult(createTestResult({
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline experiment',
        agentId: 'agent-0',
        timestamp: '2025-01-15T10:00:00Z',
        branch: 'autoresearch/swarm/agent-0',
      }));

      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      expect(lines.length).toBe(2); // header + 1 data row
      // Parent column is empty for experiments without a parent
      expect(lines[1]).toBe('a1b2c3d\t0.997900\t44.0\tkeep\tbaseline experiment\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0\t');
    });

    it('writes multiple results', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900 }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200 }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', valBpb: 1.005000, status: 'discard' }));

      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      expect(lines.length).toBe(4); // header + 3 data rows
    });

    it('escapes tabs and newlines in description', async () => {
      await registry.recordResult(createTestResult({
        commit: 'a1b2c3d',
        description: 'test\twith\ttabs\nand\nnewlines',
      }));

      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Description should have tabs/newlines replaced with spaces
      expect(lines[1]).toContain('test with tabs and newlines');
      // Should not contain actual tabs in description field
      const fields = lines[1]!.split('\t');
      expect(fields.length).toBe(9); // Exactly 9 columns (including parent)
    });

    it('creates parent directories if needed', async () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'results.tsv');
      const nestedRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath: nestedPath,
      });

      await nestedRegistry.recordResult(createTestResult());
      await nestedRegistry.persist();

      const exists = await fs.promises.access(nestedPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('overwrites existing file', async () => {
      // First persist
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d' }));
      await registry.persist();

      // Add more and persist again
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e' }));
      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      expect(lines.length).toBe(3); // header + 2 data rows
    });

    it('handles empty registry', async () => {
      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      expect(lines.length).toBe(1); // header only
    });

    it('formats val_bpb with 6 decimal places', async () => {
      await registry.recordResult(createTestResult({ valBpb: 0.9 }));
      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      expect(content).toContain('0.900000');
    });

    it('formats memory_gb with 1 decimal place', async () => {
      await registry.recordResult(createTestResult({ memoryGb: 44.123 }));
      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      expect(content).toContain('44.1');
    });
  });

  describe('restore', () => {
    it('handles missing file gracefully', async () => {
      // Should not throw
      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(0);
    });

    it('handles empty file gracefully', async () => {
      await fs.promises.writeFile(resultsPath, '', 'utf-8');

      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(0);
    });

    it('restores experiments from TSV file', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\tbaseline experiment\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
b2c3d4e\t0.993200\t44.2\tkeep\tincrease LR\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(2);
      expect(registry.getBestValBpb()).toBe(0.993200);

      const result1 = registry.getResultByCommit('a1b2c3d');
      expect(result1).toBeDefined();
      expect(result1!.valBpb).toBe(0.997900);
      expect(result1!.status).toBe('keep');
      expect(result1!.description).toBe('baseline experiment');
      expect(result1!.agentId).toBe('agent-0');

      const result2 = registry.getResultByCommit('b2c3d4e');
      expect(result2).toBeDefined();
      expect(result2!.valBpb).toBe(0.993200);
    });

    it('rebuilds active agents set', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\ttest\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
b2c3d4e\t0.993200\t44.2\tkeep\ttest\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
c3d4e5f\t1.000000\t44.0\tkeep\ttest\tagent-0\t2025-01-15T10:10:00Z\tautoresearch/swarm/agent-0
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      const activeAgents = registry.getActiveAgents();
      expect(activeAgents).toContain('agent-0');
      expect(activeAgents).toContain('agent-1');
      expect(activeAgents.length).toBe(2);
    });

    it('rebuilds search index', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\tincrease learning rate\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
b2c3d4e\t0.993200\t44.2\tkeep\tdecrease batch size\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      const results = await registry.searchSimilar('learning rate', 10);
      expect(results.length).toBe(1);
      expect(results[0]!.commit).toBe('a1b2c3d');
    });

    it('skips malformed lines gracefully', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\tvalid line\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
invalid\tline\twith\ttoo\tfew\tfields
b2c3d4e\t0.993200\t44.2\tkeep\tanother valid\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
c3d4e5f\tnotanumber\t44.0\tkeep\tinvalid val_bpb\tagent-2\t2025-01-15T10:10:00Z\tautoresearch/swarm/agent-2
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      // Should have restored 2 valid lines, skipped 2 invalid
      expect(registry.getTotalExperiments()).toBe(2);
      expect(registry.getResultByCommit('a1b2c3d')).toBeDefined();
      expect(registry.getResultByCommit('b2c3d4e')).toBeDefined();
      expect(registry.getResultByCommit('c3d4e5f')).toBeUndefined();
    });

    it('handles invalid status gracefully', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tinvalid_status\ttest\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(0);
    });

    it('handles invalid header gracefully', async () => {
      const tsvContent = `wrong\theader\tformat
a1b2c3d\t0.997900\t44.0
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(0);
    });

    it('clears existing state before restoring', async () => {
      // Add some initial data
      await registry.recordResult(createTestResult({ commit: 'initial' }));
      expect(registry.getTotalExperiments()).toBe(1);

      // Create TSV with different data
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\trestored\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      // Should only have restored data, not initial
      expect(registry.getTotalExperiments()).toBe(1);
      expect(registry.getResultByCommit('initial')).toBeUndefined();
      expect(registry.getResultByCommit('a1b2c3d')).toBeDefined();
    });

    it('handles all experiment statuses', async () => {
      const tsvContent = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\tkeep status\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
b2c3d4e\t1.005000\t44.2\tdiscard\tdiscard status\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
c3d4e5f\t0.000000\t0.0\tcrash\tcrash status\tagent-2\t2025-01-15T10:10:00Z\tautoresearch/swarm/agent-2
`;
      await fs.promises.writeFile(resultsPath, tsvContent, 'utf-8');

      await registry.restore();

      expect(registry.getTotalExperiments()).toBe(3);
      expect(registry.getResultByCommit('a1b2c3d')!.status).toBe('keep');
      expect(registry.getResultByCommit('b2c3d4e')!.status).toBe('discard');
      expect(registry.getResultByCommit('c3d4e5f')!.status).toBe('crash');
    });
  });

  describe('persist/restore round-trip', () => {
    it('round-trips experiment data correctly', async () => {
      // Record some experiments
      await registry.recordResult(createTestResult({
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        memoryGb: 44.0,
        status: 'keep',
        description: 'baseline experiment',
        agentId: 'agent-0',
        timestamp: '2025-01-15T10:00:00Z',
        branch: 'autoresearch/swarm/agent-0',
      }));
      await registry.recordResult(createTestResult({
        commit: 'b2c3d4e',
        valBpb: 0.993200,
        memoryGb: 44.2,
        status: 'keep',
        description: 'increase LR to 0.04',
        agentId: 'agent-1',
        timestamp: '2025-01-15T10:05:00Z',
        branch: 'autoresearch/swarm/agent-1',
      }));
      await registry.recordResult(createTestResult({
        commit: 'c3d4e5f',
        valBpb: 0.0,
        memoryGb: 0.0,
        status: 'crash',
        description: 'OOM error',
        agentId: 'agent-2',
        timestamp: '2025-01-15T10:10:00Z',
        branch: 'autoresearch/swarm/agent-2',
      }));

      const originalBestValBpb = registry.getBestValBpb();
      const originalTotal = registry.getTotalExperiments();

      // Persist
      await registry.persist();

      // Create new registry and restore
      const newRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newRegistry.restore();

      // Verify state matches
      expect(newRegistry.getTotalExperiments()).toBe(originalTotal);
      expect(newRegistry.getBestValBpb()).toBe(originalBestValBpb);

      // Verify individual results
      const result1 = newRegistry.getResultByCommit('a1b2c3d');
      expect(result1).toBeDefined();
      expect(result1!.valBpb).toBeCloseTo(0.997900, 6);
      expect(result1!.memoryGb).toBeCloseTo(44.0, 1);
      expect(result1!.status).toBe('keep');
      expect(result1!.description).toBe('baseline experiment');
      expect(result1!.agentId).toBe('agent-0');
      expect(result1!.timestamp).toBe('2025-01-15T10:00:00Z');
      expect(result1!.branch).toBe('autoresearch/swarm/agent-0');

      const result2 = newRegistry.getResultByCommit('b2c3d4e');
      expect(result2).toBeDefined();
      expect(result2!.valBpb).toBeCloseTo(0.993200, 6);

      const result3 = newRegistry.getResultByCommit('c3d4e5f');
      expect(result3).toBeDefined();
      expect(result3!.status).toBe('crash');
    });

    it('preserves search functionality after round-trip', async () => {
      await registry.recordResult(createTestResult({
        commit: 'a1b2c3d',
        description: 'increase learning rate to 0.04',
      }));
      await registry.recordResult(createTestResult({
        commit: 'b2c3d4e',
        description: 'decrease batch size',
      }));

      await registry.persist();

      const newRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newRegistry.restore();

      const results = await newRegistry.searchSimilar('learning rate', 10);
      expect(results.length).toBe(1);
      expect(results[0]!.commit).toBe('a1b2c3d');
    });

    it('preserves active agents after round-trip', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', agentId: 'agent-0' }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', agentId: 'agent-1' }));

      await registry.persist();

      const newRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newRegistry.restore();

      const activeAgents = newRegistry.getActiveAgents();
      expect(activeAgents).toContain('agent-0');
      expect(activeAgents).toContain('agent-1');
    });

    it('preserves lineage after round-trip', async () => {
      // Record parent experiment
      await registry.recordResult(createTestResult({
        commit: 'a1b2c3d',
        valBpb: 0.997900,
        description: 'baseline'
      }));
      // Record child experiment
      await registry.recordResult(createTestResult({
        commit: 'b2c3d4e',
        valBpb: 0.993200,
        description: 'improvement'
      }));
      // Set parent-child relationship
      registry.setParent('b2c3d4e', 'a1b2c3d');

      await registry.persist();

      // Create new registry and restore
      const newRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newRegistry.restore();

      // Verify lineage is preserved
      const parentLineage = await newRegistry.getLineage('a1b2c3d');
      expect(parentLineage).not.toBeNull();
      expect(parentLineage!.parent).toBeNull();
      expect(parentLineage!.children).toContain('b2c3d4e');

      const childLineage = await newRegistry.getLineage('b2c3d4e');
      expect(childLineage).not.toBeNull();
      expect(childLineage!.parent).toBe('a1b2c3d');
      expect(childLineage!.children).toEqual([]);
    });

    it('preserves complex lineage tree after round-trip', async () => {
      // Create a lineage tree:
      //   a1b2c3d (root)
      //   ├── b2c3d4e (child 1)
      //   │   └── d4e5f6g (grandchild)
      //   └── c3d4e5f (child 2)

      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900 }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200 }));
      await registry.recordResult(createTestResult({ commit: 'c3d4e5f', valBpb: 0.995000 }));
      await registry.recordResult(createTestResult({ commit: 'd4e5f6g', valBpb: 0.990000 }));

      registry.setParent('b2c3d4e', 'a1b2c3d');
      registry.setParent('c3d4e5f', 'a1b2c3d');
      registry.setParent('d4e5f6g', 'b2c3d4e');

      await registry.persist();

      const newRegistry = createExperimentRegistry({
        logger: createSilentLogger(),
        resultsPath,
      });
      await newRegistry.restore();

      // Verify root
      const rootLineage = await newRegistry.getLineage('a1b2c3d');
      expect(rootLineage!.parent).toBeNull();
      expect(rootLineage!.children).toContain('b2c3d4e');
      expect(rootLineage!.children).toContain('c3d4e5f');
      expect(rootLineage!.children.length).toBe(2);

      // Verify child 1
      const child1Lineage = await newRegistry.getLineage('b2c3d4e');
      expect(child1Lineage!.parent).toBe('a1b2c3d');
      expect(child1Lineage!.children).toContain('d4e5f6g');

      // Verify child 2
      const child2Lineage = await newRegistry.getLineage('c3d4e5f');
      expect(child2Lineage!.parent).toBe('a1b2c3d');
      expect(child2Lineage!.children).toEqual([]);

      // Verify grandchild
      const grandchildLineage = await newRegistry.getLineage('d4e5f6g');
      expect(grandchildLineage!.parent).toBe('b2c3d4e');
      expect(grandchildLineage!.children).toEqual([]);
    });

    it('handles backward compatibility with TSV files without parent column', async () => {
      // Write a TSV file without the parent column (old format)
      const oldFormatTsv = `commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
a1b2c3d\t0.997900\t44.0\tkeep\tbaseline\tagent-0\t2025-01-15T10:00:00Z\tautoresearch/swarm/agent-0
b2c3d4e\t0.993200\t44.2\tkeep\timprovement\tagent-1\t2025-01-15T10:05:00Z\tautoresearch/swarm/agent-1
`;
      await fs.promises.writeFile(resultsPath, oldFormatTsv, 'utf-8');

      await registry.restore();

      // Should restore experiments successfully
      expect(registry.getTotalExperiments()).toBe(2);
      expect(registry.getResultByCommit('a1b2c3d')).toBeDefined();
      expect(registry.getResultByCommit('b2c3d4e')).toBeDefined();

      // Lineage should be initialized with null parents
      const lineage1 = await registry.getLineage('a1b2c3d');
      expect(lineage1!.parent).toBeNull();
      const lineage2 = await registry.getLineage('b2c3d4e');
      expect(lineage2!.parent).toBeNull();
    });

    it('writes parent column in TSV format', async () => {
      await registry.recordResult(createTestResult({ commit: 'a1b2c3d', valBpb: 0.997900 }));
      await registry.recordResult(createTestResult({ commit: 'b2c3d4e', valBpb: 0.993200 }));
      registry.setParent('b2c3d4e', 'a1b2c3d');

      await registry.persist();

      const content = await fs.promises.readFile(resultsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Header should include parent column
      expect(lines[0]).toContain('parent');

      // First result (no parent) should have empty parent field
      expect(lines[1]!.endsWith('\t')).toBe(true);

      // Second result should have parent commit
      expect(lines[2]).toContain('a1b2c3d');
      const fields = lines[2]!.split('\t');
      expect(fields[fields.length - 1]).toBe('a1b2c3d');
    });
  });
});
