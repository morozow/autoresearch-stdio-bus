#!/bin/bash
# Start autoresearch via stdio_bus with TCP interface
# This allows interactive communication with the AI agent

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$SWARM_DIR")"
BUS_DIR="$PROJECT_ROOT/stdio_bus/bus"
PORT=9000

# Check if stdio_bus binary exists
if [ ! -x "$BUS_DIR/stdio_bus" ]; then
    echo "Error: stdio_bus binary not found at $BUS_DIR/stdio_bus"
    exit 1
fi

# Check if swarm is built
if [ ! -f "$SWARM_DIR/dist/cli.js" ]; then
    echo "Building swarm..."
    (cd "$SWARM_DIR" && npm run build)
fi

echo "Starting stdio_bus on TCP port $PORT..."
echo "Press Ctrl+C to stop"
echo ""

cd "$BUS_DIR"
DEVICE_BACKEND=mps ./stdio_bus --config stdio-bus-config.json --tcp 0.0.0.0:$PORT
