#!/bin/bash
# Send autoresearch prompt to the AI agent via stdio_bus TCP
# Run start-autoresearch.sh first to start the bus

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$SWARM_DIR")"
PORT=9000
HOST=localhost

# Generate unique session ID
SESSION_ID="autoresearch-$(date +%s)"

echo "Connecting to stdio_bus at $HOST:$PORT..."
echo "Session ID: $SESSION_ID"
echo ""

# Read program files
PROGRAM_MD=$(cat "$PROJECT_ROOT/program.md")
PROGRAM_SWARM_MD=$(cat "$SWARM_DIR/docs/program-swarm.md")

# Create the full prompt
FULL_PROMPT="You are an autonomous ML researcher. Read the following instructions carefully:

--- PROGRAM.MD ---
$PROGRAM_MD

--- PROGRAM-SWARM.MD ---
$PROGRAM_SWARM_MD

You are agent-0 in a swarm. Begin the experiment loop now:
1. First establish baseline by running: uv run train.py > run.log 2>&1
2. Check results: grep '^val_bpb:' run.log
3. Record in results.tsv
4. Then iterate to minimize val_bpb by modifying train.py
5. NEVER STOP until manually interrupted."

# Escape for JSON
ESCAPED_PROMPT=$(echo "$FULL_PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

# Step 1: Initialize session
echo "Step 1: Initializing session with openai agent..."
INIT_MSG='{"jsonrpc":"2.0","id":"init-1","method":"initialize","params":{"agentId":"openai","clientInfo":{"name":"autoresearch","version":"1.0"}}}'
echo "$INIT_MSG"
echo "$INIT_MSG" | nc -w 5 $HOST $PORT
echo ""

# Step 2: Send the prompt
echo "Step 2: Sending autoresearch prompt..."
PROMPT_MSG='{"jsonrpc":"2.0","id":"prompt-1","method":"sampling/createMessage","params":{"messages":[{"role":"user","content":{"type":"text","text":'"$ESCAPED_PROMPT"'}}],"maxTokens":4096}}'
echo "$PROMPT_MSG" | head -c 500
echo "..."
echo ""

# Send and keep connection open for streaming response
echo "$PROMPT_MSG" | nc $HOST $PORT
