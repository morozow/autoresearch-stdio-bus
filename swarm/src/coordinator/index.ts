/**
 * Coordinator module exports.
 * 
 * Provides the SwarmCoordinator class and related types for managing
 * the swarm lifecycle.
 */

export {
  SwarmCoordinator,
  createSwarmCoordinator,
  createSwarmCoordinatorFromFile,
  SwarmCoordinatorOptions,
  SwarmCoordinatorLogger,
  defaultSwarmCoordinatorLogger,
  FileLogger,
  SwarmStatus,
  GpuStatus,
  ExperimentTimeline,
  ExperimentTimelineEntry,
  DEFAULT_LOG_PATH,
  WORKER_RESTART_DELAY_MS,
} from './swarm-coordinator';

export {
  ProgressChartGenerator,
  createProgressChartGenerator,
  ChartGeneratorOptions,
  ChartGeneratorLogger,
  ChartData,
  ChartDataPoint,
  AGENT_COLORS,
  DEFAULT_AGENT_COLOR,
  DEFAULT_CHART_WIDTH,
  DEFAULT_CHART_HEIGHT,
  CHART_MARGIN,
} from './progress-chart';