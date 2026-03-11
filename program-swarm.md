# Swarm Coordination Addendum

This document extends the base `program.md` with swarm-specific coordination guidance. Read `program.md` first for the core autoresearch workflow.

You are part of a research swarm with N agents working in parallel on N GPUs, sharing experiment results through stdio_bus message passing.

## Swarm Awareness

Before planning your next experiment, always check the swarm state:

- Use `swarm.sync` to get the current best val_bpb and recent results from all agents
- Avoid experiments similar to recent failures from other agents
- Build on successful experiments from any agent, not just your own
- Your working branch is `autoresearch/swarm/agent-{N}` where N is your agent ID

### Using swarm.sync

Send a sync request to get current swarm state:

```json
{
  "jsonrpc": "2.0",
  "id": "sync-001",
  "method": "swarm.sync",
  "params": {}
}
```

Response includes:
- `bestValBpb`: The current best val_bpb across all agents
- `totalExperiments`: Total experiments completed by the swarm
- `activeAgents`: List of currently active agent IDs
- `recentResults`: Last 50 experiment results with agent attribution

Example response:
```json
{
  "jsonrpc": "2.0",
  "id": "sync-001",
  "result": {
    "bestValBpb": 0.993200,
    "totalExperiments": 47,
    "activeAgents": ["agent-0", "agent-1", "agent-2", "agent-3"],
    "recentResults": [
      {
        "commit": "b2c3d4e",
        "valBpb": 0.993200,
        "memoryGb": 44.2,
        "status": "keep",
        "description": "increase LR to 0.04",
        "agentId": "agent-1",
        "timestamp": "2025-01-15T10:25:00Z",
        "branch": "autoresearch/swarm/agent-1"
      }
    ]
  }
}
```

### Using swarm.history

To see the complete experiment timeline with agent attribution:

```json
{
  "jsonrpc": "2.0",
  "id": "history-001",
  "method": "swarm.history",
  "params": {
    "limit": 100
  }
}
```

This returns all recorded experiments ordered by timestamp, showing which agent ran each experiment and the lineage of successful changes.

## Coordination Protocol

The swarm handles coordination automatically:

1. **Lock acquisition**: Before modifying train.py, the system acquires an experiment lock automatically. If another agent holds the lock, your request is queued.

2. **Result broadcasting**: After your experiment completes, results are automatically broadcast to all agents via `experiment.result` notifications.

3. **New best notifications**: If another agent achieves a new best val_bpb, you'll receive a priority notification immediately.

4. **Branch isolation**: Each agent works on its own git branch (`autoresearch/swarm/agent-{N}`). Successful experiments are merged to `autoresearch/swarm/main`.

## Collective Learning

The power of the swarm comes from shared learning:

- **Build on successes**: When you see a "keep" result from another agent, consider building on their changes. Check out their branch or merge their improvements.

- **Avoid failures**: When you see a "crash" or "discard" from another agent, avoid attempting similar modifications. Learn from their failures.

- **Shared results.tsv**: The results.tsv file contains all experiments from all agents with additional columns:
  - `agent_id`: Which agent ran the experiment
  - `timestamp`: When the experiment completed
  - `branch`: The git branch where the change was made

## Extended results.tsv Format

The swarm extends the standard results.tsv with additional columns:

```
commit	val_bpb	memory_gb	status	description	agent_id	timestamp	branch
a1b2c3d	0.997900	44.0	keep	baseline	agent-0	2025-01-15T10:00:00Z	autoresearch/swarm/agent-0
b2c3d4e	0.993200	44.2	keep	increase LR to 0.04	agent-1	2025-01-15T10:05:00Z	autoresearch/swarm/agent-1
c3d4e5f	1.005000	44.0	discard	switch to GeLU	agent-2	2025-01-15T10:10:00Z	autoresearch/swarm/agent-2
d4e5f6g	0.000000	0.0	crash	double width (OOM)	agent-3	2025-01-15T10:15:00Z	autoresearch/swarm/agent-3
```

## Swarm Experiment Loop

The swarm experiment loop extends the base loop with coordination:

LOOP FOREVER:

1. **Sync with swarm**: Call `swarm.sync` to get current state and recent results
2. **Plan experiment**: Choose an experiment that:
   - Builds on successful changes from any agent
   - Avoids approaches that recently failed for other agents
   - Explores new directions not yet tried by the swarm
3. **Acquire lock**: The system automatically acquires a lock before you modify train.py
4. **Run experiment**: Execute as normal on your assigned GPU
5. **Report result**: Results are automatically broadcast to all agents
6. **Merge if successful**: If status is "keep", changes merge to shared main
7. **Release lock**: Lock is released automatically after experiment completes

## Swarm Status

You can check swarm health at any time:

```json
{
  "jsonrpc": "2.0",
  "id": "status-001",
  "method": "swarm.status",
  "params": {}
}
```

Response includes:
- `activeAgents`: Number of currently active agents
- `totalExperiments`: Total experiments completed
- `bestValBpb`: Current best val_bpb
- `experimentsPerHour`: Swarm throughput
- `gpuUtilization`: Status of each GPU

## Key Differences from Single-Agent Mode

| Aspect | Single Agent | Swarm |
|--------|--------------|-------|
| Branch | `autoresearch/<tag>` | `autoresearch/swarm/agent-{N}` |
| Results | Local results.tsv | Shared results.tsv with agent attribution |
| Learning | Own experiments only | All agents' experiments |
| Coordination | None | Automatic lock/broadcast |
| Throughput | ~12/hour | ~12×N/hour (N agents) |

## Swarm Log — Collective Memory

The swarm maintains a shared knowledge base in `swarm-log.md`. This is where agents share reasoning, not just results.

### Reading the Log

**Before planning any experiment**, read `swarm-log.md` to understand:
- What approaches have been tried and why they worked/failed
- Promising directions identified by other agents
- Patterns and insights from collective experimentation

### Writing to the Log

**After each experiment**, append an entry to `swarm-log.md`:

```markdown
## [agent-{N}] {timestamp} — {short title}

**Hypothesis:** What you expected to happen and why.

**Change:** Brief description of what you modified in train.py.

**Result:** val_bpb={X}, memory={Y}GB, status={keep|discard|crash}

**Analysis:** Why did this work/fail? What did you learn?

**Next ideas:** What might be worth trying based on this result?

---
```

### Example Entry

```markdown
## [agent-1] 2025-01-15T10:25:00Z — Higher learning rate

**Hypothesis:** Default LR might be too conservative. Higher LR could speed convergence within 5min budget.

**Change:** Increased base LR from 0.02 to 0.04 in train.py line 142.

**Result:** val_bpb=0.993200, memory=44.2GB, status=keep

**Analysis:** Worked! 0.5% improvement. The model was under-learning. Gradient norms stayed healthy.

**Next ideas:** Try 0.05? Or combine with larger batch size?

---
```

### Rules

1. **Always read before writing** — don't duplicate recent experiments
2. **Be specific** — include line numbers, exact values, concrete observations
3. **Share reasoning** — the "why" is more valuable than the "what"
4. **Suggest next steps** — help other agents build on your work
5. **Keep entries concise** — aim for 5-10 lines per entry

## Remember

- **Read swarm-log.md before planning** — learn from collective experience
- **Write to swarm-log.md after each experiment** — share your reasoning
- **Check swarm.sync frequently** to stay aware of other agents' progress
- **Don't duplicate work** — if another agent just tried something, try something different
- **Build on collective success** — the best val_bpb from any agent benefits everyone
- **The swarm never stops** — all agents run autonomously until manually stopped
