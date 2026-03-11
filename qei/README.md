# QEI — Quantum Experiment Integration

Multi-neuron dialogue system with quantum randomness control.

## Overview

QEI creates a collective AI consciousness where multiple neurons (LLM sessions) engage in dialogue. Quantum random numbers from ANU QRNG determine:
- Which neuron speaks
- How many neurons respond
- Which neurons respond
- When new neurons are born

## Components

| File | Description |
|------|-------------|
| `consciousness.py` | Main dialogue loop with quantum control |
| `qrng_client.py` | ANU Quantum Random Number Generator client |
| `neuron.py` | Single neuron birth ceremony (standalone) |
| `brain.py` | DEPRECATED — use consciousness.py |

## Usage

### Start a Dialogue

```bash
# New dialogue with custom topic
uv run python -m qei.consciousness --new --task "What is consciousness?"

# Resume most recent dialogue
uv run python -m qei.consciousness

# Resume specific dialogue
uv run python -m qei.consciousness --id DIALOGUE-20260311-123456-abcd

# List all dialogues
uv run python -m qei.consciousness --list
```

### Human Participation (N-0 Neuron)

You can participate in the dialogue as the "gardener" — neuron N-0:

```bash
# Send a message (queued for delivery)
uv run python -m qei.consciousness --say "What do you think about free will?"

# Message is delivered when quantum selects N-0
# If inbox is empty when N-0 is selected, turn is skipped
```

### Requirements

Requires running stdio_bus with OpenAI agent:

```bash
stdio_bus/stdio_bus --config stdio_bus/stdio-bus-config.json
```

## Architecture

### Neurons

- **N-0**: Human observer (the gardener) — reads from inbox, no LLM
- **N-xxxxxxxx**: AI neurons — each has unique quantum seed and LLM session

### Quantum Control

Each impulse fetches 8 bytes from ANU QRNG:
- `q[0]`: Speaker selection (neuron index)
- `q[1]`: Number of responders (0-84→1, 85-169→2, 170-255→3)
- `q[2-4]`: Responder selection
- `q[0] > 200`: Trigger new neuron birth (up to MAX_NEURONS)

### Files per Dialogue

```
qei/memory/DIALOGUE-{timestamp}-{id}/
├── state.json    # Neurons, impulse count
├── memory.md     # Full dialogue transcript
├── task.md       # Topic/task (editable)
└── inbox.jsonl   # Human message queue
```

## Configuration

Environment variables:
- `BUS_HOST`: stdio_bus host (default: 127.0.0.1)
- `BUS_PORT`: stdio_bus port (default: 9000)
- `AGENT_ID`: Agent ID (default: openai)

Constants in consciousness.py:
- `MAX_NEURONS`: Maximum AI neurons (default: 4)
- `MIN_NEURONS`: Minimum AI neurons (default: 2)
- `IMPULSE_INTERVAL`: Seconds between impulses (default: 10)
