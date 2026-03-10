/**
 * ExperimentRegistry - Shared state store for all experiments across the swarm.
 * 
 * Responsibilities:
 * - Maintain shared results.tsv with swarm metadata columns
 * - Persist state to disk for crash recovery
 * - Provide searchable index of experiment descriptions
 * - Track experiment lineage (parent-child relationships)
 * - Respond to state sync requests from agents
 * 
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 5.3, 5.5, 7.4, 9.2
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExperimentResultParams, ExperimentStatus } from '../protocol/types';

// ============================================================================
// Types
// ============================================================================

/**
 * ExperimentResult represents a single experiment outcome.
 * This is an alias for ExperimentResultParams from the protocol types.
 * 
 * Validates: Requirements 2.2, 7.4
 */
export interface ExperimentResult {
  /** 7-char git hash */
  commit: string;
  /** Validation bits per byte (0.000000 for crashes) */
  valBpb: number;
  /** Peak VRAM in GB */
  memoryGb: number;
  /** Experiment outcome status */
  status: ExperimentStatus;
  /** Description of the experiment/modification */
  description: string;
  /** Agent that ran the experiment */
  agentId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Git branch (e.g., autoresearch/swarm/agent-0) */
  branch: string;
}

/**
 * SwarmState represents the current state of the swarm.
 * 
 * Validates: Requirements 2.3
 */
export interface SwarmState {
  /** Best (minimum) val_bpb across all "keep" experiments */
  bestValBpb: number;
  /** Total number of experiments recorded */
  totalExperiments: number;
  /** List of currently active agent IDs */
  activeAgents: string[];
  /** Recent experiment results (up to 50) */
  recentResults: ExperimentResult[];
}

/**
 * ExperimentLineage tracks parent-child relationships between experiments.
 * 
 * Validates: Requirements 5.5
 */
export interface ExperimentLineage {
  /** Commit hash of this experiment */
  commit: string;
  /** Parent commit hash (null if root) */
  parent: string | null;
  /** Child commit hashes */
  children: string[];
  /** Val_bpb of this experiment */
  valBpb: number;
}

/**
 * Logger interface for experiment registry.
 */
export interface ExperimentRegistryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
export const defaultExperimentRegistryLogger: ExperimentRegistryLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[experiment-registry] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[experiment-registry] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[experiment-registry] ${message}`, context ?? '');
  },
};

/**
 * Configuration options for ExperimentRegistry.
 */
export interface ExperimentRegistryOptions {
  /** Logger for registry events. Defaults to console logger. */
  logger?: ExperimentRegistryLogger;
  /** Path to results.tsv file. Defaults to './results.tsv'. */
  resultsPath?: string;
  /** Maximum number of recent results to return. Defaults to 50. */
  maxRecentResults?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default maximum number of recent results */
export const DEFAULT_MAX_RECENT_RESULTS = 50;

/** Default path to results.tsv */
export const DEFAULT_RESULTS_PATH = './results.tsv';

/** TSV column headers */
export const TSV_HEADERS = [
  'commit',
  'val_bpb',
  'memory_gb',
  'status',
  'description',
  'agent_id',
  'timestamp',
  'branch',
  'parent',
] as const;

// ============================================================================
// ExperimentRegistry Class
// ============================================================================

/**
 * ExperimentRegistry manages shared experiment state for the swarm.
 * 
 * Key features:
 * - In-memory storage of all experiment results
 * - Best val_bpb tracking across "keep" experiments
 * - Recent results retrieval with configurable limit
 * - Experiment lineage tracking
 * - Description search index for similarity matching
 * 
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 5.3, 5.5, 7.4, 9.2
 */
export class ExperimentRegistry {
  /** All recorded experiment results */
  private results: ExperimentResult[] = [];

  /** Map of commit hash to experiment result for fast lookup */
  private resultsByCommit: Map<string, ExperimentResult> = new Map();

  /** Set of currently active agent IDs */
  private activeAgentIds: Set<string> = new Set();

  /** Map of commit to parent commit for lineage tracking */
  private parentMap: Map<string, string | null> = new Map();

  /** Map of commit to child commits for lineage tracking */
  private childrenMap: Map<string, string[]> = new Map();

  /** Search index: maps lowercase words to commit hashes */
  private searchIndex: Map<string, Set<string>> = new Map();

  /** Logger instance */
  private logger: ExperimentRegistryLogger;

  /** Path to results.tsv file */
  private resultsPath: string;

  /** Maximum number of recent results to return */
  private maxRecentResults: number;

  /**
   * Creates a new ExperimentRegistry instance.
   * 
   * @param options - Configuration options
   */
  constructor(options: ExperimentRegistryOptions = {}) {
    this.logger = options.logger ?? defaultExperimentRegistryLogger;
    this.resultsPath = options.resultsPath ?? DEFAULT_RESULTS_PATH;
    this.maxRecentResults = options.maxRecentResults ?? DEFAULT_MAX_RECENT_RESULTS;
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Records a new experiment result.
   * 
   * Updates internal state including:
   * - Results array
   * - Commit lookup map
   * - Active agents set
   * - Lineage tracking
   * - Search index
   * 
   * @param result - The experiment result to record
   * 
   * Validates: Requirements 2.2, 7.4
   */
  async recordResult(result: ExperimentResult): Promise<void> {
    // Validate result
    this.validateResult(result);

    // Store result
    this.results.push(result);
    this.resultsByCommit.set(result.commit, result);

    // Track active agent
    this.activeAgentIds.add(result.agentId);

    // Update search index
    this.indexDescription(result.commit, result.description);

    // Initialize lineage for this commit
    if (!this.parentMap.has(result.commit)) {
      this.parentMap.set(result.commit, null);
    }
    if (!this.childrenMap.has(result.commit)) {
      this.childrenMap.set(result.commit, []);
    }

    this.logger.info('Recorded experiment result', {
      commit: result.commit,
      valBpb: result.valBpb,
      status: result.status,
      agentId: result.agentId,
    });
  }

  /**
   * Gets the current swarm state.
   * 
   * Returns:
   * - Best val_bpb across all "keep" experiments
   * - Total experiment count
   * - List of active agents
   * - Recent results (up to maxRecentResults)
   * 
   * @returns Current SwarmState
   * 
   * Validates: Requirements 2.3
   */
  async getState(): Promise<SwarmState> {
    return {
      bestValBpb: this.getBestValBpb(),
      totalExperiments: this.results.length,
      activeAgents: Array.from(this.activeAgentIds),
      recentResults: await this.getRecentResults(this.maxRecentResults),
    };
  }

  /**
   * Gets recent experiment results ordered by timestamp descending.
   * 
   * @param limit - Maximum number of results to return
   * @returns Array of recent ExperimentResult objects
   * 
   * Validates: Requirements 2.3
   */
  async getRecentResults(limit: number): Promise<ExperimentResult[]> {
    // Sort by timestamp descending and take limit
    const sorted = [...this.results].sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return sorted.slice(0, Math.min(limit, this.maxRecentResults));
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Gets the best (minimum) val_bpb across all "keep" experiments.
   * 
   * Returns Infinity if no "keep" experiments exist.
   * 
   * @returns Best val_bpb value
   * 
   * Validates: Requirements 2.3
   */
  getBestValBpb(): number {
    const keepResults = this.results.filter(r => r.status === 'keep');

    if (keepResults.length === 0) {
      return Infinity;
    }

    return Math.min(...keepResults.map(r => r.valBpb));
  }

  /**
   * Searches for experiments with similar descriptions.
   * 
   * Uses a simple keyword-based search index.
   * 
   * @param description - Description to search for
   * @param limit - Maximum number of results to return
   * @returns Array of matching ExperimentResult objects
   * 
   * Validates: Requirements 5.3
   */
  async searchSimilar(description: string, limit: number): Promise<ExperimentResult[]> {
    const words = this.tokenize(description);

    if (words.length === 0) {
      return [];
    }

    // Count matches per commit
    const matchCounts = new Map<string, number>();

    for (const word of words) {
      const commits = this.searchIndex.get(word);
      if (commits) {
        for (const commit of commits) {
          matchCounts.set(commit, (matchCounts.get(commit) ?? 0) + 1);
        }
      }
    }

    // Sort by match count descending
    const sortedCommits = Array.from(matchCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([commit]) => commit);

    // Get results for matching commits
    const results: ExperimentResult[] = [];
    for (const commit of sortedCommits) {
      const result = this.resultsByCommit.get(commit);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Gets the lineage information for a commit.
   * 
   * @param commit - Commit hash to get lineage for
   * @returns ExperimentLineage or null if commit not found
   * 
   * Validates: Requirements 5.5
   */
  async getLineage(commit: string): Promise<ExperimentLineage | null> {
    const result = this.resultsByCommit.get(commit);
    if (!result) {
      return null;
    }

    return {
      commit,
      parent: this.parentMap.get(commit) ?? null,
      children: this.childrenMap.get(commit) ?? [],
      valBpb: result.valBpb,
    };
  }

  /**
   * Sets the parent commit for lineage tracking.
   * 
   * @param commit - Child commit hash
   * @param parent - Parent commit hash
   * 
   * Validates: Requirements 5.5
   */
  setParent(commit: string, parent: string): void {
    this.parentMap.set(commit, parent);

    // Update children map for parent
    const children = this.childrenMap.get(parent) ?? [];
    if (!children.includes(commit)) {
      children.push(commit);
      this.childrenMap.set(parent, children);
    }

    this.logger.info('Set experiment lineage', { commit, parent });
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  /**
   * Persists current state to disk.
   * 
   * Writes results to results.tsv in the extended format using atomic writes
   * (write to temp file, then rename) to prevent corruption.
   * 
   * TSV Format:
   * commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch
   * 
   * Validates: Requirements 2.2, 2.4, 9.2
   */
  async persist(): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.persistInternal();
        this.logger.info('Persisted state to disk', {
          resultsPath: this.resultsPath,
          totalExperiments: this.results.length,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Persist attempt ${attempt}/${maxRetries} failed`, {
          error: lastError.message,
          resultsPath: this.resultsPath,
        });

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await this.sleep(100 * Math.pow(2, attempt - 1));
        }
      }
    }

    this.logger.error('Failed to persist state after all retries', {
      error: lastError?.message,
      resultsPath: this.resultsPath,
    });
    throw lastError;
  }

  /**
   * Internal persist implementation with atomic write.
   */
  private async persistInternal(): Promise<void> {
    // Build TSV content
    const lines: string[] = [];

    // Add header row
    lines.push(TSV_HEADERS.join('\t'));

    // Add data rows
    for (const result of this.results) {
      const parent = this.parentMap.get(result.commit) ?? '';
      const row = [
        result.commit,
        result.valBpb.toFixed(6),
        result.memoryGb.toFixed(1),
        result.status,
        this.escapeTsvField(result.description),
        result.agentId,
        result.timestamp,
        result.branch,
        parent,
      ];
      lines.push(row.join('\t'));
    }

    const content = lines.join('\n') + '\n';

    // Ensure directory exists
    const dir = path.dirname(this.resultsPath);
    if (dir && dir !== '.' && dir !== '/') {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    // Write to temp file first (atomic write pattern)
    const tempPath = `${this.resultsPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    try {
      await fs.promises.writeFile(tempPath, content, 'utf-8');

      // Rename temp file to target (atomic on most filesystems)
      await fs.promises.rename(tempPath, this.resultsPath);
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Restores state from disk.
   * 
   * Reads results from results.tsv and rebuilds internal state including:
   * - Results array
   * - Commit lookup map
   * - Active agents set
   * - Search index
   * 
   * Handles missing file gracefully (starts with empty state).
   * Handles malformed lines gracefully (logs warning, skips line).
   * 
   * Validates: Requirements 2.4, 9.2
   */
  async restore(): Promise<void> {
    // Check if file exists
    try {
      await fs.promises.access(this.resultsPath, fs.constants.R_OK);
    } catch {
      this.logger.info('No existing results.tsv found, starting with empty state', {
        resultsPath: this.resultsPath,
      });
      return;
    }

    try {
      const content = await fs.promises.readFile(this.resultsPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);

      if (lines.length === 0) {
        this.logger.info('Empty results.tsv, starting with empty state', {
          resultsPath: this.resultsPath,
        });
        return;
      }

      // Parse header to get column indices
      const headerLine = lines[0];
      if (!headerLine) {
        this.logger.warn('Empty header line, starting with empty state', {
          resultsPath: this.resultsPath,
        });
        return;
      }
      const headers = headerLine.split('\t');
      const columnIndices = this.parseHeaderIndices(headers);

      if (!columnIndices) {
        this.logger.warn('Invalid TSV header, starting with empty state', {
          resultsPath: this.resultsPath,
          header: headerLine,
        });
        return;
      }

      // Clear existing state before restoring
      this.clear();

      // Parse data rows
      let restoredCount = 0;
      let skippedCount = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        try {
          const result = this.parseTsvLine(line, columnIndices);
          if (result) {
            // Add to internal state without validation (already validated during parse)
            this.results.push(result);
            this.resultsByCommit.set(result.commit, result);
            this.activeAgentIds.add(result.agentId);
            this.indexDescription(result.commit, result.description);

            // Parse and restore lineage from parent column
            const fields = line.split('\t');
            const parentIndex = columnIndices['parent'];
            const parent = parentIndex !== undefined && fields[parentIndex]
              ? fields[parentIndex].trim() || null
              : null;

            this.parentMap.set(result.commit, parent);
            if (!this.childrenMap.has(result.commit)) {
              this.childrenMap.set(result.commit, []);
            }

            restoredCount++;
          } else {
            skippedCount++;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Skipping malformed line ${i + 1}`, {
            line,
            error: errorMessage,
          });
          skippedCount++;
        }
      }

      // Rebuild children map from parent relationships
      this.rebuildChildrenMap();

      this.logger.info('Restored state from disk', {
        resultsPath: this.resultsPath,
        restoredCount,
        skippedCount,
        totalExperiments: this.results.length,
        bestValBpb: this.getBestValBpb(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to restore state from disk', {
        error: errorMessage,
        resultsPath: this.resultsPath,
      });
      throw error;
    }
  }

  /**
   * Parses TSV header to get column indices.
   * 
   * @param headers - Array of header column names
   * @returns Column indices or null if invalid
   */
  private parseHeaderIndices(headers: string[]): Record<string, number> | null {
    const indices: Record<string, number> = {};

    // Required headers (all except 'parent' which is optional for backward compatibility)
    const requiredHeaders = TSV_HEADERS.filter(h => h !== 'parent');

    for (const expectedHeader of requiredHeaders) {
      const index = headers.findIndex(h => h === expectedHeader);
      if (index === -1) {
        return null;
      }
      indices[expectedHeader] = index;
    }

    // Optional parent column (for backward compatibility)
    const parentIndex = headers.findIndex(h => h === 'parent');
    if (parentIndex !== -1) {
      indices['parent'] = parentIndex;
    }

    return indices;
  }

  /**
   * Parses a single TSV line into an ExperimentResult.
   * 
   * @param line - TSV line to parse
   * @param columnIndices - Map of column names to indices
   * @returns ExperimentResult or null if invalid
   */
  private parseTsvLine(
    line: string,
    columnIndices: Record<string, number>
  ): ExperimentResult | null {
    const fields = line.split('\t');

    // Check we have enough fields
    const maxIndex = Math.max(...Object.values(columnIndices));
    if (fields.length <= maxIndex) {
      return null;
    }

    const commitIdx = columnIndices['commit'];
    const valBpbIdx = columnIndices['val_bpb'];
    const memoryGbIdx = columnIndices['memory_gb'];
    const statusIdx = columnIndices['status'];
    const descriptionIdx = columnIndices['description'];
    const agentIdIdx = columnIndices['agent_id'];
    const timestampIdx = columnIndices['timestamp'];
    const branchIdx = columnIndices['branch'];

    // Validate all required indices exist
    if (commitIdx === undefined || valBpbIdx === undefined ||
      memoryGbIdx === undefined || statusIdx === undefined ||
      descriptionIdx === undefined || agentIdIdx === undefined ||
      timestampIdx === undefined || branchIdx === undefined) {
      return null;
    }

    const commit = fields[commitIdx];
    const valBpbStr = fields[valBpbIdx];
    const memoryGbStr = fields[memoryGbIdx];
    const status = fields[statusIdx];
    const description = this.unescapeTsvField(fields[descriptionIdx] ?? '');
    const agentId = fields[agentIdIdx];
    const timestamp = fields[timestampIdx];
    const branch = fields[branchIdx];

    // Validate required fields
    if (!commit || !valBpbStr || !memoryGbStr || !status || !agentId || !timestamp || !branch) {
      return null;
    }

    // Parse numeric fields
    const valBpb = parseFloat(valBpbStr);
    const memoryGb = parseFloat(memoryGbStr);

    if (isNaN(valBpb) || isNaN(memoryGb)) {
      return null;
    }

    // Validate status
    if (!['keep', 'discard', 'crash'].includes(status)) {
      return null;
    }

    return {
      commit,
      valBpb,
      memoryGb,
      status: status as ExperimentStatus,
      description: description ?? '',
      agentId,
      timestamp,
      branch,
    };
  }

  /**
   * Escapes a field value for TSV format.
   * Replaces tabs and newlines with spaces.
   * 
   * @param value - Field value to escape
   * @returns Escaped value
   */
  private escapeTsvField(value: string): string {
    return value.replace(/[\t\n\r]/g, ' ');
  }

  /**
   * Unescapes a field value from TSV format.
   * Currently just returns the value as-is since we escape by replacing.
   * 
   * @param value - Field value to unescape
   * @returns Unescaped value
   */
  private unescapeTsvField(value: string): string {
    return value;
  }

  /**
   * Rebuilds the children map from parent relationships.
   * Called after restoring state from disk.
   */
  private rebuildChildrenMap(): void {
    // Clear existing children
    for (const commit of this.childrenMap.keys()) {
      this.childrenMap.set(commit, []);
    }

    // Rebuild children from parent relationships
    for (const [commit, parent] of this.parentMap.entries()) {
      if (parent) {
        const children = this.childrenMap.get(parent) ?? [];
        if (!children.includes(commit)) {
          children.push(commit);
          this.childrenMap.set(parent, children);
        }
      }
    }
  }

  /**
   * Sleep helper for retry backoff.
   * 
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Active Agent Management
  // ==========================================================================

  /**
   * Registers an agent as active.
   * 
   * @param agentId - Agent identifier
   */
  registerAgent(agentId: string): void {
    this.activeAgentIds.add(agentId);
    this.logger.info('Registered active agent', { agentId });
  }

  /**
   * Unregisters an agent (marks as inactive).
   * 
   * @param agentId - Agent identifier
   */
  unregisterAgent(agentId: string): void {
    this.activeAgentIds.delete(agentId);
    this.logger.info('Unregistered agent', { agentId });
  }

  /**
   * Gets all active agent IDs.
   * 
   * @returns Array of active agent IDs
   */
  getActiveAgents(): string[] {
    return Array.from(this.activeAgentIds);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Gets all recorded results.
   * 
   * @returns Array of all ExperimentResult objects
   */
  getAllResults(): ExperimentResult[] {
    return [...this.results];
  }

  /**
   * Gets a result by commit hash.
   * 
   * @param commit - Commit hash
   * @returns ExperimentResult or undefined if not found
   */
  getResultByCommit(commit: string): ExperimentResult | undefined {
    return this.resultsByCommit.get(commit);
  }

  /**
   * Gets the total number of experiments.
   * 
   * @returns Total experiment count
   */
  getTotalExperiments(): number {
    return this.results.length;
  }

  /**
   * Clears all state.
   * Used for testing.
   */
  clear(): void {
    this.results = [];
    this.resultsByCommit.clear();
    this.activeAgentIds.clear();
    this.parentMap.clear();
    this.childrenMap.clear();
    this.searchIndex.clear();
    this.logger.info('Registry cleared');
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Validates an experiment result.
   * 
   * @param result - Result to validate
   * @throws Error if result is invalid
   */
  private validateResult(result: ExperimentResult): void {
    if (!result.commit || typeof result.commit !== 'string') {
      throw new Error('Invalid result: commit must be a non-empty string');
    }
    if (typeof result.valBpb !== 'number' || isNaN(result.valBpb)) {
      throw new Error('Invalid result: valBpb must be a number');
    }
    if (typeof result.memoryGb !== 'number' || isNaN(result.memoryGb)) {
      throw new Error('Invalid result: memoryGb must be a number');
    }
    if (!['keep', 'discard', 'crash'].includes(result.status)) {
      throw new Error('Invalid result: status must be "keep", "discard", or "crash"');
    }
    if (typeof result.description !== 'string') {
      throw new Error('Invalid result: description must be a string');
    }
    if (!result.agentId || typeof result.agentId !== 'string') {
      throw new Error('Invalid result: agentId must be a non-empty string');
    }
    if (!result.timestamp || typeof result.timestamp !== 'string') {
      throw new Error('Invalid result: timestamp must be a non-empty string');
    }
    if (!result.branch || typeof result.branch !== 'string') {
      throw new Error('Invalid result: branch must be a non-empty string');
    }
  }

  /**
   * Tokenizes a description into lowercase words for indexing.
   * 
   * @param description - Description to tokenize
   * @returns Array of lowercase words
   */
  private tokenize(description: string): string[] {
    return description
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 0);
  }

  /**
   * Indexes a description for search.
   * 
   * @param commit - Commit hash
   * @param description - Description to index
   */
  private indexDescription(commit: string, description: string): void {
    const words = this.tokenize(description);

    for (const word of words) {
      let commits = this.searchIndex.get(word);
      if (!commits) {
        commits = new Set();
        this.searchIndex.set(word, commits);
      }
      commits.add(commit);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ExperimentRegistry instance.
 * 
 * @param options - Configuration options
 * @returns ExperimentRegistry instance
 */
export function createExperimentRegistry(
  options: ExperimentRegistryOptions = {}
): ExperimentRegistry {
  return new ExperimentRegistry(options);
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/**
 * Converts ExperimentResultParams to ExperimentResult.
 * These types are structurally identical.
 * 
 * @param params - ExperimentResultParams from protocol
 * @returns ExperimentResult
 */
export function fromExperimentResultParams(params: ExperimentResultParams): ExperimentResult {
  return {
    commit: params.commit,
    valBpb: params.valBpb,
    memoryGb: params.memoryGb,
    status: params.status,
    description: params.description,
    agentId: params.agentId,
    timestamp: params.timestamp,
    branch: params.branch,
  };
}

/**
 * Converts ExperimentResult to ExperimentResultParams.
 * These types are structurally identical.
 * 
 * @param result - ExperimentResult
 * @returns ExperimentResultParams for protocol
 */
export function toExperimentResultParams(result: ExperimentResult): ExperimentResultParams {
  return {
    commit: result.commit,
    valBpb: result.valBpb,
    memoryGb: result.memoryGb,
    status: result.status,
    description: result.description,
    agentId: result.agentId,
    timestamp: result.timestamp,
    branch: result.branch,
  };
}
