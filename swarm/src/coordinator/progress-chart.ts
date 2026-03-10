/**
 * Progress Chart Generator - Generates progress.png showing val_bpb over time.
 * 
 * This module provides functionality to generate progress charts showing
 * val_bpb progression over time across all agents with attribution.
 * 
 * Since no charting library is installed, this implementation:
 * 1. Generates chart data in JSON format for external rendering
 * 2. Generates a simple SVG chart that can be converted to PNG
 * 
 * Validates: Requirements 10.3
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExperimentResult } from '../state/experiment-registry';

// ============================================================================
// Types
// ============================================================================

/**
 * Data point for the progress chart.
 */
export interface ChartDataPoint {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  /** val_bpb value */
  valBpb: number;
  /** Agent that produced this result */
  agentId: string;
  /** Experiment status */
  status: 'keep' | 'discard' | 'crash';
  /** Commit hash */
  commit: string;
  /** Description */
  description: string;
}

/**
 * Chart data structure for external rendering.
 */
export interface ChartData {
  /** Chart title */
  title: string;
  /** X-axis label */
  xAxisLabel: string;
  /** Y-axis label */
  yAxisLabel: string;
  /** All data points */
  dataPoints: ChartDataPoint[];
  /** Data points grouped by agent */
  dataByAgent: Record<string, ChartDataPoint[]>;
  /** List of unique agent IDs */
  agents: string[];
  /** Best val_bpb achieved */
  bestValBpb: number;
  /** Total number of experiments */
  totalExperiments: number;
  /** Time range */
  timeRange: {
    start: string;
    end: string;
    durationMs: number;
  };
  /** Generated timestamp */
  generatedAt: string;
}

/**
 * Options for chart generation.
 */
export interface ChartGeneratorOptions {
  /** Output path for the chart image (default: './progress.png') */
  outputPath?: string;
  /** Output path for chart data JSON (default: './progress-data.json') */
  dataOutputPath?: string;
  /** Chart width in pixels (default: 800) */
  width?: number;
  /** Chart height in pixels (default: 600) */
  height?: number;
  /** Chart title (default: 'val_bpb Progress Over Time') */
  title?: string;
  /** Whether to include crash results (default: false) */
  includeCrashes?: boolean;
}

/**
 * Logger interface for chart generator.
 */
export interface ChartGeneratorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console logger.
 */
export const defaultChartLogger: ChartGeneratorLogger = {
  info(message: string, context?: Record<string, unknown>): void {
    console.info(`[progress-chart] ${message}`, context ?? '');
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[progress-chart] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[progress-chart] ${message}`, context ?? '');
  },
};

// ============================================================================
// Constants
// ============================================================================

/** Default chart dimensions */
export const DEFAULT_CHART_WIDTH = 800;
export const DEFAULT_CHART_HEIGHT = 600;

/** Chart margins */
export const CHART_MARGIN = {
  top: 60,
  right: 120,
  bottom: 60,
  left: 80,
};

/** Agent colors for chart visualization */
export const AGENT_COLORS: Record<string, string> = {
  'agent-0': '#4a90e2',  // Blue
  'agent-1': '#50c878',  // Green
  'agent-2': '#e24a4a',  // Red
  'agent-3': '#9b59b6',  // Purple
  'agent-4': '#f39c12',  // Orange
  'agent-5': '#1abc9c',  // Teal
  'agent-6': '#e91e63',  // Pink
  'agent-7': '#795548',  // Brown
};

/** Default color for unknown agents */
export const DEFAULT_AGENT_COLOR = '#888888';

// ============================================================================
// ProgressChartGenerator Class
// ============================================================================

/**
 * Generates progress charts showing val_bpb over time across all agents.
 * 
 * Validates: Requirements 10.3
 */
export class ProgressChartGenerator {
  private logger: ChartGeneratorLogger;
  private outputPath: string;
  private dataOutputPath: string;
  private width: number;
  private height: number;
  private title: string;
  private includeCrashes: boolean;

  constructor(options: ChartGeneratorOptions = {}, logger?: ChartGeneratorLogger) {
    this.logger = logger ?? defaultChartLogger;
    this.outputPath = options.outputPath ?? './progress.png';
    this.dataOutputPath = options.dataOutputPath ?? './progress-data.json';
    this.width = options.width ?? DEFAULT_CHART_WIDTH;
    this.height = options.height ?? DEFAULT_CHART_HEIGHT;
    this.title = options.title ?? 'val_bpb Progress Over Time';
    this.includeCrashes = options.includeCrashes ?? false;
  }

  /**
   * Generates chart data from experiment results.
   * 
   * @param results - Array of experiment results
   * @returns ChartData structure
   */
  generateChartData(results: ExperimentResult[]): ChartData {
    // Filter results based on options
    const filteredResults = this.includeCrashes
      ? results
      : results.filter(r => r.status !== 'crash');

    // Sort by timestamp
    const sortedResults = [...filteredResults].sort((a, b) => {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    // Convert to data points
    const dataPoints: ChartDataPoint[] = sortedResults.map(r => ({
      timestamp: r.timestamp,
      timestampMs: new Date(r.timestamp).getTime(),
      valBpb: r.valBpb,
      agentId: r.agentId,
      status: r.status,
      commit: r.commit,
      description: r.description,
    }));

    // Group by agent
    const dataByAgent: Record<string, ChartDataPoint[]> = {};
    const agentSet = new Set<string>();

    for (const point of dataPoints) {
      agentSet.add(point.agentId);
      if (!dataByAgent[point.agentId]) {
        dataByAgent[point.agentId] = [];
      }
      dataByAgent[point.agentId]!.push(point);
    }

    const agents = Array.from(agentSet).sort();

    // Calculate best val_bpb (from keep results only)
    const keepResults = results.filter(r => r.status === 'keep');
    const bestValBpb = keepResults.length > 0
      ? Math.min(...keepResults.map(r => r.valBpb))
      : Infinity;

    // Calculate time range
    const timestamps = dataPoints.map(p => p.timestampMs);
    const startMs = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const endMs = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();

    return {
      title: this.title,
      xAxisLabel: 'Time',
      yAxisLabel: 'val_bpb',
      dataPoints,
      dataByAgent,
      agents,
      bestValBpb,
      totalExperiments: results.length,
      timeRange: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        durationMs: endMs - startMs,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Saves chart data to a JSON file for external rendering.
   * 
   * @param chartData - Chart data to save
   * @param outputPath - Optional override for output path
   */
  async saveChartData(chartData: ChartData, outputPath?: string): Promise<void> {
    const targetPath = outputPath ?? this.dataOutputPath;

    // Ensure directory exists
    const dir = path.dirname(targetPath);
    if (dir && dir !== '.' && dir !== '/') {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const content = JSON.stringify(chartData, null, 2);
    await fs.promises.writeFile(targetPath, content, 'utf-8');

    this.logger.info('Chart data saved', {
      path: targetPath,
      dataPoints: chartData.dataPoints.length,
      agents: chartData.agents.length,
    });
  }

  /**
   * Generates an SVG chart from experiment results.
   * 
   * The SVG can be converted to PNG using external tools like:
   * - Inkscape: inkscape progress.svg -o progress.png
   * - ImageMagick: convert progress.svg progress.png
   * - librsvg: rsvg-convert progress.svg -o progress.png
   * 
   * @param results - Array of experiment results
   * @returns SVG string
   */
  generateSvgChart(results: ExperimentResult[]): string {
    const chartData = this.generateChartData(results);
    return this.renderSvg(chartData);
  }

  /**
   * Renders chart data to SVG format.
   * 
   * @param chartData - Chart data to render
   * @returns SVG string
   */
  private renderSvg(chartData: ChartData): string {
    const { width, height } = this;
    const plotWidth = width - CHART_MARGIN.left - CHART_MARGIN.right;
    const plotHeight = height - CHART_MARGIN.top - CHART_MARGIN.bottom;

    // Calculate scales
    const { xScale, yScale, xDomain, yDomain } = this.calculateScales(chartData, plotWidth, plotHeight);

    // Build SVG
    const svgParts: string[] = [];

    // SVG header
    svgParts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

    // Background
    svgParts.push(`  <rect width="${width}" height="${height}" fill="white"/>`);

    // Title
    svgParts.push(`  <text x="${width / 2}" y="30" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="bold">${this.escapeXml(chartData.title)}</text>`);

    // Plot area group
    svgParts.push(`  <g transform="translate(${CHART_MARGIN.left}, ${CHART_MARGIN.top})">`);

    // Grid lines
    svgParts.push(this.renderGridLines(plotWidth, plotHeight, yScale, yDomain));

    // Axes
    svgParts.push(this.renderAxes(plotWidth, plotHeight, xScale, yScale, xDomain, yDomain));

    // Data points by agent
    for (const agentId of chartData.agents) {
      const agentData = chartData.dataByAgent[agentId] ?? [];
      const color = this.getAgentColor(agentId);
      svgParts.push(this.renderAgentData(agentData, xScale, yScale, color, agentId, plotHeight));
    }

    // Best val_bpb line
    if (chartData.bestValBpb !== Infinity) {
      const bestY = yScale(chartData.bestValBpb);
      svgParts.push(`    <line x1="0" y1="${bestY}" x2="${plotWidth}" y2="${bestY}" stroke="#ff0000" stroke-width="1" stroke-dasharray="5,5" opacity="0.7"/>`);
      svgParts.push(`    <text x="${plotWidth + 5}" y="${bestY + 4}" font-family="Arial, sans-serif" font-size="10" fill="#ff0000">Best: ${chartData.bestValBpb.toFixed(4)}</text>`);
    }

    svgParts.push(`  </g>`);

    // Legend
    svgParts.push(this.renderLegend(chartData.agents, width, CHART_MARGIN.top));

    // Axis labels
    svgParts.push(`  <text x="${width / 2}" y="${height - 15}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12">${chartData.xAxisLabel}</text>`);
    svgParts.push(`  <text x="15" y="${height / 2}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" transform="rotate(-90, 15, ${height / 2})">${chartData.yAxisLabel}</text>`);

    svgParts.push(`</svg>`);

    return svgParts.join('\n');
  }

  /**
   * Calculates scales for the chart.
   */
  private calculateScales(
    chartData: ChartData,
    plotWidth: number,
    plotHeight: number
  ): {
    xScale: (timestamp: number) => number;
    yScale: (valBpb: number) => number;
    xDomain: [number, number];
    yDomain: [number, number];
  } {
    const timestamps = chartData.dataPoints.map(p => p.timestampMs);
    const valBpbs = chartData.dataPoints.map(p => p.valBpb).filter(v => v > 0);

    // X domain (time)
    const xMin = timestamps.length > 0 ? Math.min(...timestamps) : Date.now() - 3600000;
    const xMax = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
    const xPadding = (xMax - xMin) * 0.05 || 3600000; // 5% padding or 1 hour
    const xDomain: [number, number] = [xMin - xPadding, xMax + xPadding];

    // Y domain (val_bpb)
    const yMin = valBpbs.length > 0 ? Math.min(...valBpbs) : 0.9;
    const yMax = valBpbs.length > 0 ? Math.max(...valBpbs) : 1.1;
    const yPadding = (yMax - yMin) * 0.1 || 0.05; // 10% padding
    const yDomain: [number, number] = [yMin - yPadding, yMax + yPadding];

    // Scale functions
    const xScale = (timestamp: number): number => {
      return ((timestamp - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidth;
    };

    const yScale = (valBpb: number): number => {
      // Invert Y axis (lower val_bpb at top)
      return plotHeight - ((valBpb - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotHeight;
    };

    return { xScale, yScale, xDomain, yDomain };
  }

  /**
   * Renders grid lines.
   */
  private renderGridLines(
    plotWidth: number,
    plotHeight: number,
    yScale: (v: number) => number,
    yDomain: [number, number]
  ): string {
    const lines: string[] = [];
    const numLines = 5;
    const yStep = (yDomain[1] - yDomain[0]) / numLines;

    for (let i = 0; i <= numLines; i++) {
      const yVal = yDomain[0] + i * yStep;
      const y = yScale(yVal);
      lines.push(`    <line x1="0" y1="${y}" x2="${plotWidth}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`);
    }

    return lines.join('\n');
  }

  /**
   * Renders axes.
   */
  private renderAxes(
    plotWidth: number,
    plotHeight: number,
    xScale: (t: number) => number,
    yScale: (v: number) => number,
    xDomain: [number, number],
    yDomain: [number, number]
  ): string {
    const parts: string[] = [];

    // X axis
    parts.push(`    <line x1="0" y1="${plotHeight}" x2="${plotWidth}" y2="${plotHeight}" stroke="black" stroke-width="1"/>`);

    // Y axis
    parts.push(`    <line x1="0" y1="0" x2="0" y2="${plotHeight}" stroke="black" stroke-width="1"/>`);

    // X axis ticks (time)
    const numXTicks = 5;
    const xStep = (xDomain[1] - xDomain[0]) / numXTicks;
    for (let i = 0; i <= numXTicks; i++) {
      const timestamp = xDomain[0] + i * xStep;
      const x = xScale(timestamp);
      const date = new Date(timestamp);
      const label = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      parts.push(`    <line x1="${x}" y1="${plotHeight}" x2="${x}" y2="${plotHeight + 5}" stroke="black" stroke-width="1"/>`);
      parts.push(`    <text x="${x}" y="${plotHeight + 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="10">${label}</text>`);
    }

    // Y axis ticks (val_bpb)
    const numYTicks = 5;
    const yStep = (yDomain[1] - yDomain[0]) / numYTicks;
    for (let i = 0; i <= numYTicks; i++) {
      const valBpb = yDomain[0] + i * yStep;
      const y = yScale(valBpb);
      const label = valBpb.toFixed(3);
      parts.push(`    <line x1="-5" y1="${y}" x2="0" y2="${y}" stroke="black" stroke-width="1"/>`);
      parts.push(`    <text x="-10" y="${y + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="10">${label}</text>`);
    }

    return parts.join('\n');
  }

  /**
   * Renders data points for a single agent.
   */
  private renderAgentData(
    data: ChartDataPoint[],
    xScale: (t: number) => number,
    yScale: (v: number) => number,
    color: string,
    agentId: string,
    plotHeight: number
  ): string {
    if (data.length === 0) {
      return '';
    }

    const parts: string[] = [];

    // Draw line connecting points
    if (data.length > 1) {
      const pathPoints = data.map(p => `${xScale(p.timestampMs)},${yScale(p.valBpb)}`);
      parts.push(`    <polyline points="${pathPoints.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>`);
    }

    // Draw points
    for (const point of data) {
      const x = xScale(point.timestampMs);
      const y = yScale(point.valBpb);
      const radius = point.status === 'keep' ? 5 : 3;
      const fillOpacity = point.status === 'keep' ? 1 : 0.5;

      parts.push(`    <circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="1">`);
      parts.push(`      <title>${agentId}: ${point.valBpb.toFixed(4)} (${point.status})\n${point.description}</title>`);
      parts.push(`    </circle>`);
    }

    return parts.join('\n');
  }

  /**
   * Renders the legend.
   */
  private renderLegend(agents: string[], width: number, topMargin: number): string {
    const parts: string[] = [];
    const legendX = width - CHART_MARGIN.right + 10;
    let legendY = topMargin + 20;

    parts.push(`  <text x="${legendX}" y="${legendY}" font-family="Arial, sans-serif" font-size="12" font-weight="bold">Agents</text>`);
    legendY += 20;

    for (const agentId of agents) {
      const color = this.getAgentColor(agentId);
      parts.push(`  <circle cx="${legendX + 6}" cy="${legendY - 4}" r="5" fill="${color}"/>`);
      parts.push(`  <text x="${legendX + 16}" y="${legendY}" font-family="Arial, sans-serif" font-size="10">${this.escapeXml(agentId)}</text>`);
      legendY += 18;
    }

    return parts.join('\n');
  }

  /**
   * Gets the color for an agent.
   */
  getAgentColor(agentId: string): string {
    return AGENT_COLORS[agentId] ?? DEFAULT_AGENT_COLOR;
  }

  /**
   * Escapes XML special characters.
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Saves the SVG chart to a file.
   * 
   * @param results - Experiment results
   * @param outputPath - Optional override for output path (will use .svg extension)
   */
  async saveSvgChart(results: ExperimentResult[], outputPath?: string): Promise<void> {
    const svg = this.generateSvgChart(results);
    const targetPath = outputPath ?? this.outputPath.replace(/\.png$/, '.svg');

    // Ensure directory exists
    const dir = path.dirname(targetPath);
    if (dir && dir !== '.' && dir !== '/') {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(targetPath, svg, 'utf-8');

    this.logger.info('SVG chart saved', {
      path: targetPath,
      experiments: results.length,
    });
  }

  /**
   * Generates and saves both chart data and SVG chart.
   * 
   * @param results - Experiment results
   * @returns Object with paths to generated files
   */
  async generateProgressChart(results: ExperimentResult[]): Promise<{
    svgPath: string;
    dataPath: string;
    chartData: ChartData;
  }> {
    const chartData = this.generateChartData(results);

    // Save chart data JSON
    await this.saveChartData(chartData);

    // Save SVG chart
    const svgPath = this.outputPath.replace(/\.png$/, '.svg');
    await this.saveSvgChart(results, svgPath);

    this.logger.info('Progress chart generated', {
      svgPath,
      dataPath: this.dataOutputPath,
      experiments: results.length,
      agents: chartData.agents.length,
      bestValBpb: chartData.bestValBpb,
    });

    return {
      svgPath,
      dataPath: this.dataOutputPath,
      chartData,
    };
  }

  /**
   * Gets the configured output path.
   */
  getOutputPath(): string {
    return this.outputPath;
  }

  /**
   * Gets the configured data output path.
   */
  getDataOutputPath(): string {
    return this.dataOutputPath;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ProgressChartGenerator instance.
 * 
 * @param options - Configuration options
 * @param logger - Optional logger
 * @returns ProgressChartGenerator instance
 */
export function createProgressChartGenerator(
  options: ChartGeneratorOptions = {},
  logger?: ChartGeneratorLogger
): ProgressChartGenerator {
  return new ProgressChartGenerator(options, logger);
}
