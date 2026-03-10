#!/usr/bin/env node
/**
 * CLI Entry Point for stdio_bus Swarm Coordinator
 *
 * Usage:
 *   npx ts-node src/cli.ts [config-path]
 *   node dist/cli.js [config-path]
 *
 * Arguments:
 *   config-path  Path to swarm configuration JSON file (default: ./swarm-config.json)
 *
 * Environment Variables:
 *   SWARM_CONFIG  Alternative way to specify config path
 *   SWARM_LOG     Path to log file (default: ./swarm.log)
 *
 * The coordinator reads JSON-RPC messages from stdin and writes responses to stdout.
 * Progress reports and logs are written to stderr and the log file.
 *
 * Validates: Requirements 6.1
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SwarmCoordinator,
  createSwarmCoordinator,
  FileLogger,
} from './coordinator';
import { parseAndValidateConfig, formatValidationErrors } from './config';
import { VERSION } from './index';

// ============================================================================
// CLI Configuration
// ============================================================================

interface CliOptions {
  configPath: string;
  logPath: string;
  help: boolean;
  version: boolean;
}

function parseArgs(args: string[]): CliOptions {
  // Generate timestamp for log file: YYYY-MM-DD_HH-MM-SS
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultLogPath = `./logs/swarm-${timestamp}.log`;

  const options: CliOptions = {
    configPath: process.env.SWARM_CONFIG ?? './swarm-config.json',
    logPath: process.env.SWARM_LOG ?? defaultLogPath,
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg: string | undefined = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--config' || arg === '-c') {
      options.configPath = args[++i] ?? options.configPath;
    } else if (arg === '--log' || arg === '-l') {
      options.logPath = args[++i] ?? options.logPath;
    } else if (arg && !arg.startsWith('-')) {
      // Positional argument - treat as config path
      options.configPath = arg;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
stdio_bus Swarm Coordinator v${VERSION}

Usage:
  swarm [options] [config-path]

Arguments:
  config-path           Path to swarm configuration JSON file
                        (default: ./swarm-config.json or $SWARM_CONFIG)

Options:
  -c, --config <path>   Path to configuration file
  -l, --log <path>      Path to log file (default: ./swarm.log or $SWARM_LOG)
  -h, --help            Show this help message
  -v, --version         Show version number

Environment Variables:
  SWARM_CONFIG          Alternative way to specify config path
  SWARM_LOG             Path to log file

The coordinator reads JSON-RPC messages from stdin and writes responses to stdout.
Progress reports are written to stderr. All operations are logged to the log file.

Example:
  # Start with default config
  swarm

  # Start with custom config
  swarm ./my-config.json

  # Use with stdio_bus
  stdio_bus | swarm | stdio_bus
`);
}

function printVersion(): void {
  console.log(`swarm v${VERSION}`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.version) {
    printVersion();
    process.exit(0);
  }

  // Resolve config path
  const configPath = path.resolve(options.configPath);
  const logPath = path.resolve(options.logPath);

  // Check if config file exists
  if (!fs.existsSync(configPath)) {
    console.error(`Error: Configuration file not found: ${configPath}`);
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  // Load and validate configuration
  let configContent: string;
  try {
    configContent = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    console.error(`Error reading configuration file: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const validationResult = parseAndValidateConfig(configContent);
  if (!validationResult.valid || !validationResult.config) {
    console.error('Configuration validation failed:');
    console.error(formatValidationErrors(validationResult.errors));
    process.exit(1);
  }

  const config = validationResult.config;

  // Determine working directory: use config.swarm.workDir if specified, otherwise config file directory
  let workDir = path.dirname(configPath);
  if (config.swarm.workDir) {
    // If workDir is relative, resolve it relative to config file directory
    workDir = path.isAbsolute(config.swarm.workDir)
      ? config.swarm.workDir
      : path.resolve(path.dirname(configPath), config.swarm.workDir);
  }

  // Ensure log directory exists
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Create file logger
  const fileLogger = new FileLogger(logPath);

  // Create coordinator with stderr for progress (keeps stdout clean for JSON-RPC)
  const coordinator = createSwarmCoordinator({
    fileLogger,
    workDir,
  });

  // Set progress writer to stderr (stdout is for JSON-RPC messages)
  coordinator.setProgressWriter((message: string) => {
    process.stderr.write(message + '\n');
  });

  // Initialize message handler for stdin processing
  coordinator.initializeMessageHandler();

  // Handle graceful shutdown
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    process.stderr.write(`\nReceived ${signal}, shutting down gracefully...\n`);
    fileLogger.info(`Received ${signal}, initiating shutdown`);

    try {
      await coordinator.stop();
      process.stderr.write('Swarm coordinator stopped.\n');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle stdin data
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    const accepted = coordinator.processIncomingData(chunk);
    if (!accepted) {
      // Backpressure active - log to stderr
      process.stderr.write('[WARN] Input backpressure active, data rejected\n');
    }
  });

  process.stdin.on('end', () => {
    coordinator.flushParser();
    if (!isShuttingDown) {
      process.stderr.write('stdin closed, shutting down...\n');
      shutdown('stdin-close').catch(console.error);
    }
  });

  process.stdin.on('error', (error) => {
    console.error('stdin error:', error);
    if (!isShuttingDown) {
      shutdown('stdin-error').catch(console.error);
    }
  });

  // Start the coordinator
  try {
    process.stderr.write(`Starting swarm coordinator with config: ${configPath}\n`);
    process.stderr.write(`Log file: ${logPath}\n`);
    process.stderr.write(`GPUs: ${config.swarm.gpuIds.join(', ')}\n`);

    await coordinator.start(config);

    process.stderr.write(`Swarm coordinator started with ${config.swarm.gpuIds.length} GPU(s)\n`);
    process.stderr.write('Ready to receive JSON-RPC messages on stdin...\n');
  } catch (error) {
    console.error('Failed to start swarm coordinator:', error);
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
