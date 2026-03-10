/**
 * Unit tests for ProgressChartGenerator.
 * 
 * Tests the progress chart generation functionality including:
 * - Chart data generation from experiment results
 * - SVG chart rendering
 * - File saving operations
 * - Agent color assignment
 * 
 * Validates: Requirements 10.3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ProgressChartGenerator,
  createProgressChartGenerator,
  ChartData,
  ChartDataPoint,
  AGENT_COLORS,
  DEFAULT_AGENT_COLOR,
  DEFAULT_CHART_WIDTH,
  DEFAULT_CHART_HEIGHT,
} from './progress-chart';
import { ExperimentResult } from '../state/experiment-registry';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock experiment result for testing.
 */
function createMockResult(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    commit: 'abc1234',
    valBpb: 1.0,
    memoryGb: 44.0,
    status: 'keep',
    description: 'test experiment',
    agentId: 'agent-0',
    timestamp: new Date().toISOString(),
    branch: 'autoresearch/swarm/agent-0',
    ...overrides,
  };
}

/**
 * Creates multiple mock results with different timestamps and agents.
 */
function createMockResults(count: number): ExperimentResult[] {
  const results: ExperimentResult[] = [];
  const baseTime = Date.now() - count * 60000; // Start from count minutes ago

  for (let i = 0; i < count; i++) {
    const agentIndex = i % 4;
    results.push(createMockResult({
      commit: `abc${i.toString().padStart(4, '0')}`,
      valBpb: 1.0 - (i * 0.01), // Decreasing val_bpb
      agentId: `agent-${agentIndex}`,
      timestamp: new Date(baseTime + i * 60000).toISOString(),
      status: i % 5 === 0 ? 'discard' : 'keep',
      description: `experiment ${i}`,
    }));
  }

  return results;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('ProgressChartGenerator', () => {
  let generator: ProgressChartGenerator;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(__dirname, '.test-temp-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    generator = createProgressChartGenerator({
      outputPath: path.join(tempDir, 'progress.png'),
      dataOutputPath: path.join(tempDir, 'progress-data.json'),
    });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('generateChartData', () => {
    it('should generate chart data from experiment results', () => {
      const results = createMockResults(10);
      const chartData = generator.generateChartData(results);

      expect(chartData.title).toBe('val_bpb Progress Over Time');
      expect(chartData.xAxisLabel).toBe('Time');
      expect(chartData.yAxisLabel).toBe('val_bpb');
      expect(chartData.totalExperiments).toBe(10);
      expect(chartData.generatedAt).toBeDefined();
    });

    it('should sort data points by timestamp', () => {
      const results = [
        createMockResult({ timestamp: '2025-01-15T12:00:00Z', commit: 'aaa1111' }),
        createMockResult({ timestamp: '2025-01-15T10:00:00Z', commit: 'bbb2222' }),
        createMockResult({ timestamp: '2025-01-15T11:00:00Z', commit: 'ccc3333' }),
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.dataPoints[0].commit).toBe('bbb2222');
      expect(chartData.dataPoints[1].commit).toBe('ccc3333');
      expect(chartData.dataPoints[2].commit).toBe('aaa1111');
    });

    it('should group data by agent', () => {
      const results = [
        createMockResult({ agentId: 'agent-0', commit: 'aaa1111' }),
        createMockResult({ agentId: 'agent-1', commit: 'bbb2222' }),
        createMockResult({ agentId: 'agent-0', commit: 'ccc3333' }),
        createMockResult({ agentId: 'agent-2', commit: 'ddd4444' }),
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.agents).toContain('agent-0');
      expect(chartData.agents).toContain('agent-1');
      expect(chartData.agents).toContain('agent-2');
      expect(chartData.dataByAgent['agent-0']).toHaveLength(2);
      expect(chartData.dataByAgent['agent-1']).toHaveLength(1);
      expect(chartData.dataByAgent['agent-2']).toHaveLength(1);
    });

    it('should calculate best val_bpb from keep results only', () => {
      const results = [
        createMockResult({ valBpb: 1.0, status: 'keep' }),
        createMockResult({ valBpb: 0.5, status: 'crash' }), // Should be ignored
        createMockResult({ valBpb: 0.9, status: 'keep' }),
        createMockResult({ valBpb: 0.8, status: 'discard' }), // Should be ignored for best
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.bestValBpb).toBe(0.9);
    });

    it('should return Infinity for best val_bpb when no keep results', () => {
      const results = [
        createMockResult({ status: 'crash' }),
        createMockResult({ status: 'discard' }),
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.bestValBpb).toBe(Infinity);
    });

    it('should calculate time range correctly', () => {
      const results = [
        createMockResult({ timestamp: '2025-01-15T10:00:00Z' }),
        createMockResult({ timestamp: '2025-01-15T12:00:00Z' }),
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.timeRange.start).toBe('2025-01-15T10:00:00.000Z');
      expect(chartData.timeRange.end).toBe('2025-01-15T12:00:00.000Z');
      expect(chartData.timeRange.durationMs).toBe(2 * 60 * 60 * 1000); // 2 hours
    });

    it('should exclude crash results by default', () => {
      const results = [
        createMockResult({ status: 'keep', commit: 'aaa1111' }),
        createMockResult({ status: 'crash', commit: 'bbb2222' }),
        createMockResult({ status: 'discard', commit: 'ccc3333' }),
      ];

      const chartData = generator.generateChartData(results);

      expect(chartData.dataPoints).toHaveLength(2);
      expect(chartData.dataPoints.map(p => p.commit)).not.toContain('bbb2222');
    });

    it('should include crash results when configured', () => {
      const generatorWithCrashes = createProgressChartGenerator({
        includeCrashes: true,
      });

      const results = [
        createMockResult({ status: 'keep', commit: 'aaa1111' }),
        createMockResult({ status: 'crash', commit: 'bbb2222' }),
      ];

      const chartData = generatorWithCrashes.generateChartData(results);

      expect(chartData.dataPoints).toHaveLength(2);
      expect(chartData.dataPoints.map(p => p.commit)).toContain('bbb2222');
    });

    it('should handle empty results', () => {
      const chartData = generator.generateChartData([]);

      expect(chartData.dataPoints).toHaveLength(0);
      expect(chartData.agents).toHaveLength(0);
      expect(chartData.bestValBpb).toBe(Infinity);
      expect(chartData.totalExperiments).toBe(0);
    });
  });

  describe('generateSvgChart', () => {
    it('should generate valid SVG', () => {
      const results = createMockResults(5);
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('</svg>');
    });

    it('should include chart title', () => {
      const results = createMockResults(5);
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('val_bpb Progress Over Time');
    });

    it('should include axis labels', () => {
      const results = createMockResults(5);
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('Time');
      expect(svg).toContain('val_bpb');
    });

    it('should include data points as circles', () => {
      const results = createMockResults(5);
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('<circle');
    });

    it('should include legend with agents', () => {
      const results = [
        createMockResult({ agentId: 'agent-0' }),
        createMockResult({ agentId: 'agent-1' }),
      ];
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('Agents');
      expect(svg).toContain('agent-0');
      expect(svg).toContain('agent-1');
    });

    it('should include best val_bpb line', () => {
      const results = [
        createMockResult({ valBpb: 0.95, status: 'keep' }),
      ];
      const svg = generator.generateSvgChart(results);

      expect(svg).toContain('Best:');
      expect(svg).toContain('stroke-dasharray');
    });

    it('should handle empty results gracefully', () => {
      const svg = generator.generateSvgChart([]);

      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    });

    it('should use custom dimensions', () => {
      const customGenerator = createProgressChartGenerator({
        width: 1200,
        height: 800,
      });

      const svg = customGenerator.generateSvgChart(createMockResults(5));

      expect(svg).toContain('width="1200"');
      expect(svg).toContain('height="800"');
    });

    it('should use custom title', () => {
      const customGenerator = createProgressChartGenerator({
        title: 'Custom Chart Title',
      });

      const svg = customGenerator.generateSvgChart(createMockResults(5));

      expect(svg).toContain('Custom Chart Title');
    });
  });

  describe('getAgentColor', () => {
    it('should return predefined colors for known agents', () => {
      expect(generator.getAgentColor('agent-0')).toBe(AGENT_COLORS['agent-0']);
      expect(generator.getAgentColor('agent-1')).toBe(AGENT_COLORS['agent-1']);
      expect(generator.getAgentColor('agent-2')).toBe(AGENT_COLORS['agent-2']);
      expect(generator.getAgentColor('agent-3')).toBe(AGENT_COLORS['agent-3']);
    });

    it('should return default color for unknown agents', () => {
      expect(generator.getAgentColor('agent-99')).toBe(DEFAULT_AGENT_COLOR);
      expect(generator.getAgentColor('unknown-agent')).toBe(DEFAULT_AGENT_COLOR);
    });
  });

  describe('saveChartData', () => {
    it('should save chart data to JSON file', async () => {
      const results = createMockResults(5);
      const chartData = generator.generateChartData(results);

      await generator.saveChartData(chartData);

      const savedPath = path.join(tempDir, 'progress-data.json');
      expect(fs.existsSync(savedPath)).toBe(true);

      const savedContent = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
      expect(savedContent.title).toBe(chartData.title);
      expect(savedContent.totalExperiments).toBe(chartData.totalExperiments);
    });

    it('should save to custom path', async () => {
      const customPath = path.join(tempDir, 'custom-data.json');
      const chartData = generator.generateChartData(createMockResults(3));

      await generator.saveChartData(chartData, customPath);

      expect(fs.existsSync(customPath)).toBe(true);
    });

    it('should create directory if it does not exist', async () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'data.json');
      const chartData = generator.generateChartData(createMockResults(3));

      await generator.saveChartData(chartData, nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
    });
  });

  describe('saveSvgChart', () => {
    it('should save SVG chart to file', async () => {
      const results = createMockResults(5);

      await generator.saveSvgChart(results);

      const savedPath = path.join(tempDir, 'progress.svg');
      expect(fs.existsSync(savedPath)).toBe(true);

      const content = fs.readFileSync(savedPath, 'utf-8');
      expect(content).toContain('<svg');
    });

    it('should save to custom path', async () => {
      const customPath = path.join(tempDir, 'custom-chart.svg');

      await generator.saveSvgChart(createMockResults(3), customPath);

      expect(fs.existsSync(customPath)).toBe(true);
    });
  });

  describe('generateProgressChart', () => {
    it('should generate both SVG and JSON files', async () => {
      const results = createMockResults(10);

      const result = await generator.generateProgressChart(results);

      expect(fs.existsSync(result.svgPath)).toBe(true);
      expect(fs.existsSync(result.dataPath)).toBe(true);
      expect(result.chartData.totalExperiments).toBe(10);
    });

    it('should return correct paths', async () => {
      const result = await generator.generateProgressChart(createMockResults(5));

      expect(result.svgPath).toBe(path.join(tempDir, 'progress.svg'));
      expect(result.dataPath).toBe(path.join(tempDir, 'progress-data.json'));
    });
  });

  describe('getOutputPath', () => {
    it('should return configured output path', () => {
      expect(generator.getOutputPath()).toBe(path.join(tempDir, 'progress.png'));
    });
  });

  describe('getDataOutputPath', () => {
    it('should return configured data output path', () => {
      expect(generator.getDataOutputPath()).toBe(path.join(tempDir, 'progress-data.json'));
    });
  });

  describe('constants', () => {
    it('should have default chart dimensions', () => {
      expect(DEFAULT_CHART_WIDTH).toBe(800);
      expect(DEFAULT_CHART_HEIGHT).toBe(600);
    });

    it('should have agent colors defined', () => {
      expect(Object.keys(AGENT_COLORS).length).toBeGreaterThan(0);
      expect(AGENT_COLORS['agent-0']).toBeDefined();
    });

    it('should have default agent color', () => {
      expect(DEFAULT_AGENT_COLOR).toBe('#888888');
    });
  });
});
