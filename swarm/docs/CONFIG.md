# Swarm Configuration Reference

This document describes all configuration options for the stdio_bus swarm integration.

## Configuration File Format

The swarm configuration uses JSON format compatible with stdio_bus. The configuration file supports environment variable substitution using `${ENV_VAR}` syntax.

## Example Configuration

See `swarm-config.json` for a complete 4-GPU example.

## Configuration Sections

### pools (required)

Array of worker pool configurations. Each pool defines a type of process to spawn.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for the pool |
| `command` | string | Yes | Command to execute (e.g., "node") |
| `args` | string[] | No | Command-line arguments |
| `env` | object | No | Environment variables (key-value pairs) |
| `instances` | integer | Yes | Number of instances to spawn (≥1) |

**Example:**
```json
{
  "pools": [
    {
      "id": "gpu-worker",
      "command": "node",
      "args": ["./dist/worker/gpu-worker.js"],
      "env": {},
      "instances": 4
    }
  ]
}
```

**Note:** The swarm coordinator is started separately and manages the GPU workers. Only GPU worker pools should be defined here.

### swarm (required)

Swarm-specific settings for GPU assignment and agent configuration.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `gpuIds` | integer[] | Yes | - | GPU IDs to use (e.g., [0, 1, 2, 3]) |
| `agentModel` | string | No | "claude-acp" | Agent model from ACP registry |
| `apiKeys` | string | No | - | Path to api-keys.json or `${ENV_VAR}` reference |
| `experimentTimeout` | integer | No | 10 | Experiment timeout in minutes |
| `lockTimeout` | integer | No | 10 | Lock hold timeout in minutes |

**Example:**
```json
{
  "swarm": {
    "gpuIds": [0, 1, 2, 3],
    "agentModel": "claude-acp",
    "apiKeys": "${ANTHROPIC_API_KEY}",
    "experimentTimeout": 10,
    "lockTimeout": 10
  }
}
```

**Constraints:**
- Total pool instances must not exceed the number of GPUs (`N agents ≤ M GPUs`)
- GPU IDs must be non-negative integers
- At least one GPU ID must be specified

### limits (optional)

Resource limits for stdio_bus backpressure and restart handling.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_input_buffer` | integer | 1048576 (1MB) | Maximum input buffer size in bytes |
| `max_output_queue` | integer | 4194304 (4MB) | Maximum output queue size in bytes |
| `max_restarts` | integer | 5 | Maximum restarts within restart window |
| `restart_window_sec` | integer | 60 | Restart window duration in seconds |
| `backpressure_timeout_sec` | integer | 60 | Backpressure timeout in seconds |

**Example:**
```json
{
  "limits": {
    "max_input_buffer": 4194304,
    "max_output_queue": 16777216,
    "max_restarts": 10,
    "restart_window_sec": 120,
    "backpressure_timeout_sec": 120
  }
}
```

## Environment Variable Substitution

Configuration values can reference environment variables using `${VAR_NAME}` syntax:

```json
{
  "swarm": {
    "apiKeys": "${ANTHROPIC_API_KEY}"
  }
}
```

This is useful for:
- API keys and secrets (avoid committing to version control)
- Dynamic configuration based on deployment environment
- Sharing configuration across different machines

## Validation Rules

The configuration is validated on startup with the following rules:

1. **Required fields**: `pools` and `swarm.gpuIds` must be present
2. **Pool validation**: Each pool must have `id`, `command`, and `instances`
3. **GPU constraint**: Total agent instances ≤ number of GPUs
4. **Type validation**: All fields must match their expected types
5. **Range validation**: Numeric fields must be within valid ranges

All validation errors are reported before launching any agents.

## Common Configurations

### Single GPU Development

```json
{
  "pools": [
    { "id": "gpu-worker", "command": "node", "args": ["./dist/worker/gpu-worker.js"], "instances": 1 }
  ],
  "swarm": {
    "gpuIds": [0],
    "experimentTimeout": 5
  }
}
```

### 4-GPU Production

See `swarm-config.json` for the complete example.

### 8-GPU High-Performance

```json
{
  "pools": [
    { "id": "gpu-worker", "command": "node", "args": ["./dist/worker/gpu-worker.js"], "instances": 8 }
  ],
  "swarm": {
    "gpuIds": [0, 1, 2, 3, 4, 5, 6, 7],
    "agentModel": "claude-acp",
    "apiKeys": "${ANTHROPIC_API_KEY}",
    "experimentTimeout": 10,
    "lockTimeout": 10
  },
  "limits": {
    "max_input_buffer": 8388608,
    "max_output_queue": 33554432,
    "max_restarts": 15,
    "restart_window_sec": 180,
    "backpressure_timeout_sec": 180
  }
}
```

## Hot Reload

The swarm coordinator supports hot-reloading of configuration to add or remove agents without a full restart. Existing agents that remain in the configuration are preserved.
