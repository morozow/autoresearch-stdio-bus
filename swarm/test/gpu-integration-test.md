# GPU Integration Test Guide

This document describes how to run the GPU integration tests for the swarm coordinator.

## Prerequisites

1. **Hardware**: Machine with N NVIDIA GPUs (minimum 1)
2. **Software**:
   - `uv` Python package manager
   - Python 3.10+
   - CUDA toolkit
   - autoresearch dependencies (see pyproject.toml)

## Environment Setup

```bash
# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python dependencies
uv sync

# Verify GPU availability
nvidia-smi
```

## Test 24.2: Run swarm with 1 GPU

```bash
# Create single-GPU config
cat > swarm/test/single-gpu-config.json << 'EOF'
{
  "pools": [{"id": "gpu-worker", "command": "node", "args": ["./dist/worker/gpu-worker.js"], "instances": 1}],
  "swarm": {"gpuIds": [0], "experimentTimeout": 10, "lockTimeout": 10},
  "limits": {"max_input_buffer": 4194304, "max_output_queue": 16777216}
}
EOF

# Start the swarm coordinator
cd swarm
node dist/cli.js --config test/single-gpu-config.json

# In another terminal, send a test experiment
echo '{"jsonrpc":"2.0","id":"test","method":"swarm.status","params":{}}' | nc localhost 8080
```

## Test 24.3: Verify results

After running an experiment:

1. Check `results.tsv` contains the experiment:
   ```bash
   cat results.tsv
   ```

2. Verify TSV format has all columns:
   - commit, val_bpb, memory_gb, status, description, agent_id, timestamp, branch

3. Check `swarm.log` for execution entries:
   ```bash
   tail -50 swarm.log
   ```

## Test 24.4: Run swarm with N GPUs

```bash
# Create multi-GPU config (adjust gpuIds for your hardware)
cat > swarm/test/multi-gpu-config.json << 'EOF'
{
  "pools": [{"id": "gpu-worker", "command": "node", "args": ["./dist/worker/gpu-worker.js"], "instances": 4}],
  "swarm": {"gpuIds": [0, 1, 2, 3], "experimentTimeout": 10, "lockTimeout": 10},
  "limits": {"max_input_buffer": 4194304, "max_output_queue": 16777216}
}
EOF

# Start the swarm
node dist/cli.js --config test/multi-gpu-config.json
```

## Expected Results

- [ ] val_bpb recorded in results.tsv
- [ ] TSV format correct (all columns present)
- [ ] swarm.log contains execution entries
- [ ] Multiple agents execute experiments in parallel
- [ ] Results are broadcast between agents

## Troubleshooting

### GPU not detected
```bash
# Check CUDA installation
nvidia-smi
nvcc --version
```

### Worker fails to start
```bash
# Check GPU availability
CUDA_VISIBLE_DEVICES=0 python -c "import torch; print(torch.cuda.is_available())"
```

### Experiment timeout
- Default timeout is 10 minutes
- Increase `experimentTimeout` in config if needed
