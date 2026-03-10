# Swarm Coordinator Runbook

This runbook provides step-by-step instructions for launching and operating the stdio_bus swarm coordinator for autoresearch.

## Prerequisites

### Hardware
- Machine with N NVIDIA GPUs (minimum 1 for single-agent mode)
- Sufficient RAM (8GB+ recommended)
- SSD storage for experiment logs

### Software
- Node.js 18+ (`node --version`)
- npm or yarn
- `uv` Python package manager (for running train.py)
- CUDA toolkit (for GPU experiments)

## Quick Start

### 1. Build the Swarm Coordinator

```bash
cd swarm
npm install
npm run build
```

### 2. Configure the Swarm

Edit `swarm-config.json` to match your hardware:

```json
{
  "pools": [
    {
      "id": "gpu-worker",
      "command": "node",
      "args": ["./dist/worker/gpu-worker.js"],
      "instances": 4
    }
  ],
  "swarm": {
    "gpuIds": [0, 1, 2, 3],
    "experimentTimeout": 10,
    "lockTimeout": 10
  },
  "limits": {
    "max_input_buffer": 4194304,
    "max_output_queue": 16777216
  }
}
```

Key settings:
- `gpuIds`: Array of GPU IDs to use (e.g., `[0]` for single GPU, `[0,1,2,3]` for 4 GPUs)
- `instances`: Should match the number of GPUs
- `experimentTimeout`: Maximum time per experiment in minutes
- `lockTimeout`: Maximum time to hold the experiment lock

### 3. Launch the Coordinator

```bash
# Direct launch
node dist/cli.js --config swarm-config.json

# Or with custom log path
node dist/cli.js --config swarm-config.json --log /path/to/swarm.log
```

### 4. Verify Operation

Send a status request:
```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.status","params":{}}' | node dist/cli.js
```

Expected response:
```json
{"jsonrpc":"2.0","id":"1","result":{"activeAgents":4,"totalExperiments":0,"bestValBpb":null,"experimentsPerHour":0}}
```

## Platform-Specific Instructions

### macOS

```bash
# Install Node.js via Homebrew
brew install node

# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Build and run
cd swarm
npm install
npm run build
node dist/cli.js
```

Note: macOS typically doesn't have NVIDIA GPUs. Use mock mode for testing.

### Linux (Ubuntu/Debian)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install CUDA (if not present)
# Follow NVIDIA's installation guide for your distribution

# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Build and run
cd swarm
npm install
npm run build
node dist/cli.js
```

### Docker

```bash
# Build Docker image
docker build -t swarm-coordinator .

# Run with GPU support
docker run --gpus all -v $(pwd):/workspace swarm-coordinator

# Or use stdio_bus Docker image
docker run -i stdiobus/stdiobus:latest
```

## Using with stdio_bus

### Option 1: Direct stdio_bus Integration

```bash
# Create stdio-bus-config.json
cat > stdio-bus-config.json << 'EOF'
{
  "pools": [
    {
      "id": "swarm-coordinator",
      "command": "node",
      "args": ["./swarm/dist/cli.js", "--config", "./swarm/swarm-config.json"],
      "instances": 1
    }
  ]
}
EOF

# Launch via stdio_bus
./stdio_bus --config stdio-bus-config.json
```

### Option 2: Pipe Mode

```bash
# stdio_bus as message router
cat messages.ndjson | ./stdio_bus | node swarm/dist/cli.js | ./stdio_bus
```

## Operations

### Check Swarm Status

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.status","params":{}}' | node dist/cli.js
```

### Pause All Agents

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.pause","params":{}}' | node dist/cli.js
```

### Resume Operations

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.resume","params":{}}' | node dist/cli.js
```

### Get Experiment History

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.history","params":{"limit":50}}' | node dist/cli.js
```

### Sync State

```bash
echo '{"jsonrpc":"2.0","id":"1","method":"swarm.sync","params":{}}' | node dist/cli.js
```

## Troubleshooting

### Coordinator Won't Start

1. Check Node.js version: `node --version` (requires 18+)
2. Verify build: `ls dist/cli.js`
3. Check config syntax: `node -e "console.log(JSON.parse(require('fs').readFileSync('swarm-config.json')))"`

### GPU Not Detected

1. Check CUDA: `nvidia-smi`
2. Verify GPU IDs in config match available GPUs
3. Check CUDA_VISIBLE_DEVICES isn't restricting access

### Experiments Timing Out

1. Increase `experimentTimeout` in config
2. Check GPU memory: `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`
3. Review `swarm.log` for error details

### Lock Contention

1. Check lock status via `swarm.status`
2. Increase `lockTimeout` if experiments are long
3. Review `swarm.log` for lock acquisition patterns

### State Not Persisting

1. Check write permissions for `results.tsv`
2. Verify graceful shutdown (SIGTERM, not SIGKILL)
3. Check disk space

## Monitoring

### Log Files

- `swarm.log`: Main coordinator log with all operations
- `results.tsv`: Experiment results in TSV format
- `run.log`: Individual experiment output (per worker)

### Key Metrics

- `activeAgents`: Number of running agents
- `totalExperiments`: Total experiments completed
- `bestValBpb`: Current best validation BPB
- `experimentsPerHour`: Throughput metric

### Health Checks

```bash
# Quick health check
echo '{"jsonrpc":"2.0","id":"health","method":"swarm.status","params":{}}' | \
  node dist/cli.js 2>/dev/null | \
  grep -o '"activeAgents":[0-9]*'
```

## Shutdown

### Graceful Shutdown

```bash
# Send SIGTERM for graceful shutdown
kill -TERM <coordinator_pid>
```

The coordinator will:
1. Stop accepting new experiments
2. Wait for running experiments to complete
3. Persist state to `results.tsv`
4. Exit cleanly

### Emergency Shutdown

```bash
# Force kill (state may not persist)
kill -9 <coordinator_pid>
```

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `swarm.gpuIds` | `[0,1,2,3]` | GPU IDs to use |
| `swarm.experimentTimeout` | `10` | Max experiment time (minutes) |
| `swarm.lockTimeout` | `10` | Max lock hold time (minutes) |
| `limits.max_input_buffer` | `4194304` | Input buffer size (bytes) |
| `limits.max_output_queue` | `16777216` | Output queue size (bytes) |
| `limits.max_restarts` | `10` | Max worker restarts |
| `limits.restart_window_sec` | `120` | Restart window (seconds) |
