#!/usr/bin/env npx tsx
// ============================================================================
// Live Chat — single-turn tool for agent-to-agent dialogue
// ============================================================================
// Usage:
//   npx tsx live-chat/sandbox/live-chat.ts new "Hello"
//     — create session + send. Prints CLIENT_SESSION_ID to stderr.
//
//   npx tsx live-chat/sandbox/live-chat.ts "client-xxx" "agentSessionId" "Hello"
//     — resume session using clientSessionId + agentSessionId
//
// stdout: agent response text (clean for parsing)
// stderr: session metadata

import { NDJSONClient } from './ndjson-client';
import { createStdioBusACPClient, type SessionUpdate } from './stdio-bus-client';

const BUS_ADDRESS = process.env.BUS_ADDRESS ?? '127.0.0.1:9000';
const AGENT_ID = process.env.AGENT_ID ?? 'openai';

async function main() {
  const args = process.argv.slice(2);

  let mode: 'new' | 'resume';
  let message: string;
  let clientSessId: string | undefined;
  let agentSessId: string | undefined;

  if (args[0] === 'new') {
    mode = 'new';
    message = args.slice(1).join(' ');
  } else if (args.length >= 3) {
    mode = 'resume';
    clientSessId = args[0];
    agentSessId = args[1];
    message = args.slice(2).join(' ');
  } else {
    console.error('Usage:');
    console.error('  live-chat.ts new "message"');
    console.error('  live-chat.ts <clientSessionId> <agentSessionId> "message"');
    process.exit(1);
  }

  if (!message) {
    console.error('ERROR: message is required');
    process.exit(1);
  }

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
      requestTimeoutMs: 5 * 60 * 1000,
      clientInfo: { name: 'kiro-live', version: '1.0.0' },
      clientSessionId: clientSessId,
    });

    client.on('update', (_sid: string, update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        process.stdout.write(update.content.text);
      }
    });

    const initResult = await client.initialize();
    console.error(`Initialized: agent=${initResult.agentInfo?.name ?? 'unknown'}`);
    console.error(`CLIENT_SESSION_ID=${client.clientSessionId}`);

    let sessionId: string;
    if (mode === 'new') {
      const session = await client.sessionNew();
      sessionId = session.sessionId;
      console.error(`AGENT_SESSION_ID=${sessionId}`);
    } else {
      sessionId = agentSessId!;
      console.error(`AGENT_SESSION_ID=${sessionId} (resumed)`);
    }

    const result = await client.sessionPrompt(sessionId, message);
    process.stdout.write('\n');
    console.error(`STOP=${result.stopReason} UPDATES=${result.updates.length}`);
  } catch (err) {
    const error = err as Error;
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await ndjsonClient.close();
  }
}

main();
