#!/usr/bin/env npx tsx
// ============================================================================
// Autoresearch Loop — Kiro as executor for LLM researcher
// ============================================================================
// The LLM (GPT-OSS via Bedrock) thinks and proposes experiments.
// This script executes: file edits, bash commands, reads results.
// Results are sent back to LLM for next iteration.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NDJSONClient } from './ndjson-client';
import { createStdioBusACPClient, type SessionUpdate } from './stdio-bus-client';

const BUS_ADDRESS = process.env.BUS_ADDRESS ?? '127.0.0.1:9000';
const AGENT_ID = process.env.AGENT_ID ?? 'openai';
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Read program files
function loadPrograms(): string {
  const programMd = fs.readFileSync(path.join(PROJECT_ROOT, 'program.md'), 'utf-8');
  const programSwarmMd = fs.readFileSync(path.join(PROJECT_ROOT, 'swarm/docs/program-swarm.md'), 'utf-8');
  return `${programMd}\n\n---\n\n${programSwarmMd}`;
}

// Execute bash command and return output
function runCommand(cmd: string, cwd: string = PROJECT_ROOT): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 600000, // 10 min for training
      maxBuffer: 10 * 1024 * 1024
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.message + '\n' + (err.stdout || '') + (err.stderr || '') };
  }
}

// Read file content
function readFile(filePath: string): string {
  const fullPath = path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(fullPath)) return `[File not found: ${filePath}]`;
  return fs.readFileSync(fullPath, 'utf-8');
}

// Write file content
function writeFile(filePath: string, content: string): string {
  const fullPath = path.resolve(PROJECT_ROOT, filePath);
  fs.writeFileSync(fullPath, content, 'utf-8');
  return `[Written: ${filePath}]`;
}

// Parse LLM response for actions
interface Action {
  type: 'bash' | 'read' | 'write' | 'edit';
  target?: string;
  content?: string;
  command?: string;
}

function parseActions(response: string): Action[] {
  const actions: Action[] = [];

  // Look for code blocks with bash commands
  const bashMatches = response.matchAll(/```bash\n([\s\S]*?)```/g);
  for (const match of bashMatches) {
    actions.push({ type: 'bash', command: match[1].trim() });
  }

  // Look for file edits (diff format)
  const diffMatches = response.matchAll(/```diff\n([\s\S]*?)```/g);
  for (const match of diffMatches) {
    actions.push({ type: 'edit', content: match[1].trim() });
  }

  return actions;
}

// Execute actions and collect results
function executeActions(actions: Action[]): string {
  const results: string[] = [];

  for (const action of actions) {
    switch (action.type) {
      case 'bash':
        if (action.command) {
          console.error(`[EXEC] ${action.command}`);
          const { success, output } = runCommand(action.command);
          results.push(`$ ${action.command}\n${output}\n[${success ? 'OK' : 'FAILED'}]`);
        }
        break;
      case 'read':
        if (action.target) {
          results.push(`[${action.target}]\n${readFile(action.target)}`);
        }
        break;
      case 'write':
        if (action.target && action.content) {
          results.push(writeFile(action.target, action.content));
        }
        break;
    }
  }

  return results.join('\n\n');
}

async function main() {
  const ndjsonClient = new NDJSONClient({
    address: BUS_ADDRESS,
    connectionType: 'tcp',
    maxReconnectAttempts: 3,
    baseReconnectDelayMs: 500,
    maxReconnectDelayMs: 5000,
  });

  await ndjsonClient.connect();
  console.error(`Connected to stdio Bus at ${BUS_ADDRESS}`);

  const client = createStdioBusACPClient(ndjsonClient, {
    agentId: AGENT_ID,
    requestTimeoutMs: 30 * 60 * 1000,
    clientInfo: { name: 'autoresearch-executor', version: '1.0.0' },
  });

  let fullResponse = '';
  client.on('update', (_sid: string, update: SessionUpdate) => {
    if (update.sessionUpdate === 'agent_message_chunk') {
      process.stdout.write(update.content.text);
      fullResponse += update.content.text;
    }
  });

  const initResult = await client.initialize();
  console.error(`Initialized: agent=${initResult.agentInfo?.name ?? 'unknown'}`);

  const session = await client.sessionNew();
  console.error(`Session: ${session.sessionId}`);

  // Initial prompt with programs
  const initialPrompt = loadPrograms() + `

---

You are agent-0 in the autoresearch swarm. I am your executor — I will run the commands you specify.

IMPORTANT: You must give me explicit commands to execute. Use code blocks:
- \`\`\`bash for shell commands
- \`\`\`python for code to write

After each command I execute, I will send you the output. Then you decide the next step.

Start now: What is your first command? (e.g., check git status, read train.py, run baseline)`;

  console.error('\n=== STARTING AUTORESEARCH LOOP ===\n');

  // Send initial prompt
  fullResponse = '';
  await client.sessionPrompt(session.sessionId, initialPrompt);

  // Main loop
  while (true) {
    const actions = parseActions(fullResponse);

    if (actions.length === 0) {
      console.error('\n[No actions found in response, asking for clarification]');
      fullResponse = '';
      await client.sessionPrompt(session.sessionId,
        'I did not find any executable commands in your response. Please provide explicit bash commands in ```bash code blocks.');
      continue;
    }

    console.error(`\n[Executing ${actions.length} actions]`);
    const results = executeActions(actions);

    console.error('\n[Sending results back to LLM]');
    fullResponse = '';
    await client.sessionPrompt(session.sessionId,
      `Execution results:\n\n${results}\n\nWhat is your next step?`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
