#!/usr/bin/env npx tsx
// ============================================================================
// Start Autoresearch — sends program.md + program-swarm.md to agent
// ============================================================================
// Usage:
//   npx tsx live-chat/start-autoresearch.ts
//
// Reads program.md and .kiro/steering/program-swarm.md, combines them,
// and sends to the agent via stdio_bus to start autonomous experimentation.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NDJSONClient } from './ndjson-client';
import { createStdioBusACPClient, type SessionUpdate } from './stdio-bus-client';

const BUS_ADDRESS = process.env.BUS_ADDRESS ?? '127.0.0.1:9000';
const AGENT_ID = process.env.AGENT_ID ?? 'openai';

// Paths relative to project root (parent of stdio_bus)
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PROGRAM_MD = path.join(PROJECT_ROOT, 'program.md');
const PROGRAM_SWARM_MD = path.join(PROJECT_ROOT, 'program-swarm.md');

async function main() {
  // Read program files
  console.error('Reading program files...');

  if (!fs.existsSync(PROGRAM_MD)) {
    console.error(`ERROR: ${PROGRAM_MD} not found`);
    process.exit(1);
  }
  if (!fs.existsSync(PROGRAM_SWARM_MD)) {
    console.error(`ERROR: ${PROGRAM_SWARM_MD} not found`);
    process.exit(1);
  }

  const programMd = fs.readFileSync(PROGRAM_MD, 'utf-8');
  const programSwarmMd = fs.readFileSync(PROGRAM_SWARM_MD, 'utf-8');

  const combinedPrompt = `${programMd}\n\n---\n\n${programSwarmMd}\n\n---\n\nYou are agent-0. Start the autoresearch experiment loop now. Begin by establishing the baseline.`;

  console.error(`Combined prompt: ${combinedPrompt.length} chars`);

  // Connect to stdio_bus
  const ndjsonClient = new NDJSONClient({
    address: BUS_ADDRESS,
    connectionType: 'tcp',
    maxReconnectAttempts: 3,
    baseReconnectDelayMs: 500,
    maxReconnectDelayMs: 5000,
  });

  try {
    await ndjsonClient.connect();
    console.error(`Connected to stdio Bus at ${BUS_ADDRESS}`);

    const client = createStdioBusACPClient(ndjsonClient, {
      agentId: AGENT_ID,
      requestTimeoutMs: 30 * 60 * 1000, // 30 min for long experiments
      clientInfo: { name: 'autoresearch-starter', version: '1.0.0' },
    });

    // Stream agent responses to stdout
    client.on('update', (_sid: string, update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        process.stdout.write(update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        console.error(`\n[TOOL] ${update.title} (${update.kind})`);
      } else if (update.sessionUpdate === 'tool_call_update') {
        console.error(`[TOOL_UPDATE] ${update.toolCallId}: ${update.status}`);
      }
    });

    const initResult = await client.initialize();
    console.error(`Initialized: agent=${initResult.agentInfo?.name ?? 'unknown'}`);
    console.error(`CLIENT_SESSION_ID=${client.clientSessionId}`);

    // Create new session
    const session = await client.sessionNew();
    console.error(`AGENT_SESSION_ID=${session.sessionId}`);
    console.error('');
    console.error('='.repeat(60));
    console.error('STARTING AUTORESEARCH');
    console.error('='.repeat(60));
    console.error('');

    // Send the combined program as initial prompt
    const result = await client.sessionPrompt(session.sessionId, combinedPrompt);

    console.error('');
    console.error('='.repeat(60));
    console.error(`STOP_REASON=${result.stopReason}`);
    console.error(`UPDATES=${result.updates.length}`);
    console.error('='.repeat(60));

  } catch (err) {
    const error = err as Error;
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await ndjsonClient.close();
  }
}

main();
