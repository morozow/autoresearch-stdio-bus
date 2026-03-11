#!/usr/bin/env python3
"""
Swarm coordinator for autoresearch. Single-file, stdio_bus worker.
Coordinates N agents on N GPUs, shares experiment results via JSON-RPC over stdio.

Usage:
    stdio_bus config: {"command": "uv", "args": ["run", "swarm.py"]}
    Or standalone:    uv run swarm.py < input.ndjson > output.ndjson

Protocol: JSON-RPC 2.0 over NDJSON (newline-delimited JSON)
"""

import os
import sys
import json
import time
import fcntl
import subprocess
import threading
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional
from datetime import datetime

# ---------------------------------------------------------------------------
# Configuration (edit these directly)
# ---------------------------------------------------------------------------

GPU_IDS = [0]                    # list of GPU IDs to use
EXPERIMENT_TIMEOUT = 600         # 10 minutes max per experiment
LOCK_TIMEOUT = 600               # 10 minutes max lock hold time
WORK_DIR = Path(".")             # working directory for experiments
RESULTS_FILE = "results.tsv"     # shared results file
STATE_FILE = ".swarm-state.json" # persistent state file

# ---------------------------------------------------------------------------
# Data Types
# ---------------------------------------------------------------------------

@dataclass
class ExperimentResult:
    commit: str
    val_bpb: float
    memory_gb: float
    status: str  # keep, discard, crash
    description: str
    agent_id: str
    timestamp: str
    branch: str


@dataclass
class SwarmState:
    best_val_bpb: float = float('inf')
    total_experiments: int = 0
    active_agents: list = field(default_factory=list)
    results: list = field(default_factory=list)  # list of ExperimentResult dicts


# ---------------------------------------------------------------------------
# Global State
# ---------------------------------------------------------------------------

state = SwarmState()
state_lock = threading.Lock()
lock_holder: Optional[str] = None
lock_acquired_at: Optional[float] = None
lock_file: Optional[object] = None

# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_state():
    """Persist state to disk."""
    with state_lock:
        data = {
            "best_val_bpb": state.best_val_bpb,
            "total_experiments": state.total_experiments,
            "active_agents": state.active_agents,
            "results": state.results[-100:],  # keep last 100
        }
    state_path = WORK_DIR / STATE_FILE
    tmp_path = state_path.with_suffix(".tmp")
    with open(tmp_path, "w") as f:
        json.dump(data, f)
    tmp_path.rename(state_path)


def load_state():
    """Restore state from disk."""
    global state
    state_path = WORK_DIR / STATE_FILE
    if not state_path.exists():
        return
    try:
        with open(state_path) as f:
            data = json.load(f)
        with state_lock:
            state.best_val_bpb = data.get("best_val_bpb", float('inf'))
            state.total_experiments = data.get("total_experiments", 0)
            state.active_agents = data.get("active_agents", [])
            state.results = data.get("results", [])
        log(f"Restored state: {state.total_experiments} experiments, best={state.best_val_bpb:.6f}")
    except Exception as e:
        log(f"Failed to restore state: {e}")


def append_to_results_tsv(result: ExperimentResult):
    """Append result to shared results.tsv file."""
    results_path = WORK_DIR / RESULTS_FILE
    header = "commit\tval_bpb\tmemory_gb\tstatus\tdescription\tagent_id\ttimestamp\tbranch\n"
    
    # Create file with header if it doesn't exist
    if not results_path.exists():
        with open(results_path, "w") as f:
            f.write(header)
    
    # Append result
    line = f"{result.commit}\t{result.val_bpb:.6f}\t{result.memory_gb:.1f}\t{result.status}\t{result.description}\t{result.agent_id}\t{result.timestamp}\t{result.branch}\n"
    with open(results_path, "a") as f:
        f.write(line)


# ---------------------------------------------------------------------------
# Distributed Lock (file-based)
# ---------------------------------------------------------------------------

def acquire_lock(agent_id: str) -> dict:
    """Acquire experiment lock. Returns {granted, branch, expires_at, queue_position}."""
    global lock_holder, lock_acquired_at, lock_file
    
    lock_path = WORK_DIR / ".swarm.lock"
    
    # Check if current holder timed out
    if lock_holder and lock_acquired_at:
        if time.time() - lock_acquired_at > LOCK_TIMEOUT:
            log(f"Lock timeout, releasing from {lock_holder}")
            release_lock(lock_holder)
    
    # Already holding?
    if lock_holder == agent_id:
        return {
            "granted": True,
            "branch": f"autoresearch/swarm/{agent_id}",
            "expiresAt": datetime.fromtimestamp(lock_acquired_at + LOCK_TIMEOUT).isoformat() if lock_acquired_at else "",
        }
    
    # Try to acquire
    if lock_holder is None:
        try:
            lock_file = open(lock_path, "w")
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            lock_holder = agent_id
            lock_acquired_at = time.time()
            expires_at = datetime.fromtimestamp(lock_acquired_at + LOCK_TIMEOUT).isoformat()
            log(f"Lock acquired by {agent_id}")
            return {
                "granted": True,
                "branch": f"autoresearch/swarm/{agent_id}",
                "expiresAt": expires_at,
            }
        except (IOError, OSError):
            pass
    
    # Lock held by someone else
    return {
        "granted": False,
        "branch": f"autoresearch/swarm/{agent_id}",
        "expiresAt": "",
        "queuePosition": 1,
    }


def release_lock(agent_id: str):
    """Release experiment lock."""
    global lock_holder, lock_acquired_at, lock_file
    
    if lock_holder != agent_id:
        return
    
    if lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
            lock_file.close()
        except:
            pass
        lock_file = None
    
    lock_holder = None
    lock_acquired_at = None
    log(f"Lock released by {agent_id}")


# ---------------------------------------------------------------------------
# GPU Worker
# ---------------------------------------------------------------------------

def run_experiment(gpu_id: int, agent_id: str, branch: str) -> ExperimentResult:
    """Run training experiment on specified GPU."""
    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = str(gpu_id)
    
    log(f"Starting experiment on GPU {gpu_id} for {agent_id}")
    
    try:
        result = subprocess.run(
            ["uv", "run", "train.py"],
            cwd=WORK_DIR,
            capture_output=True,
            text=True,
            timeout=EXPERIMENT_TIMEOUT,
            env=env,
        )
        
        # Parse output
        val_bpb = 0.0
        peak_vram_mb = 0.0
        
        for line in result.stdout.split("\n"):
            if line.startswith("val_bpb:"):
                val_bpb = float(line.split(":")[1].strip())
            elif line.startswith("peak_vram_mb:"):
                peak_vram_mb = float(line.split(":")[1].strip())
        
        # Get commit hash
        commit = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            cwd=WORK_DIR, capture_output=True, text=True
        ).stdout.strip() or "unknown"
        
        status = "keep" if val_bpb > 0 else "crash"
        
        return ExperimentResult(
            commit=commit,
            val_bpb=val_bpb,
            memory_gb=peak_vram_mb / 1024,
            status=status,
            description="",
            agent_id=agent_id,
            timestamp=datetime.now().isoformat(),
            branch=branch,
        )
        
    except subprocess.TimeoutExpired:
        return ExperimentResult(
            commit="timeout",
            val_bpb=0.0,
            memory_gb=0.0,
            status="crash",
            description="Experiment timed out",
            agent_id=agent_id,
            timestamp=datetime.now().isoformat(),
            branch=branch,
        )
    except Exception as e:
        return ExperimentResult(
            commit="error",
            val_bpb=0.0,
            memory_gb=0.0,
            status="crash",
            description=str(e),
            agent_id=agent_id,
            timestamp=datetime.now().isoformat(),
            branch=branch,
        )


# ---------------------------------------------------------------------------
# JSON-RPC Handlers
# ---------------------------------------------------------------------------

def handle_swarm_sync(params: dict) -> dict:
    """Handle swarm.sync request - return current swarm state."""
    with state_lock:
        return {
            "bestValBpb": state.best_val_bpb,
            "totalExperiments": state.total_experiments,
            "activeAgents": state.active_agents.copy(),
            "recentResults": state.results[-50:],
        }


def handle_swarm_status(params: dict) -> dict:
    """Handle swarm.status request - return swarm health."""
    with state_lock:
        return {
            "activeAgents": len(state.active_agents),
            "totalExperiments": state.total_experiments,
            "bestValBpb": state.best_val_bpb,
            "gpuIds": GPU_IDS,
        }


def handle_swarm_history(params: dict) -> dict:
    """Handle swarm.history request - return experiment history."""
    limit = params.get("limit", 100)
    with state_lock:
        return {
            "experiments": state.results[-limit:],
            "totalCount": len(state.results),
        }


def handle_lock_acquire(params: dict) -> dict:
    """Handle lock.acquire request."""
    agent_id = params.get("agentId", "unknown")
    return acquire_lock(agent_id)


def handle_lock_release(params: dict) -> dict:
    """Handle lock.release request."""
    agent_id = params.get("agentId", "unknown")
    release_lock(agent_id)
    return {"released": True}


def handle_experiment_run(params: dict) -> dict:
    """Handle experiment.run request - run experiment on GPU."""
    agent_id = params.get("agentId", "agent-0")
    gpu_id = params.get("gpuId", GPU_IDS[0] if GPU_IDS else 0)
    branch = params.get("branch", f"autoresearch/swarm/{agent_id}")
    
    result = run_experiment(gpu_id, agent_id, branch)
    
    # Update state
    with state_lock:
        state.total_experiments += 1
        state.results.append(asdict(result))
        if result.status == "keep" and result.val_bpb > 0:
            if result.val_bpb < state.best_val_bpb:
                state.best_val_bpb = result.val_bpb
                log(f"New best val_bpb: {result.val_bpb:.6f}")
    
    # Persist
    append_to_results_tsv(result)
    save_state()
    
    return asdict(result)


def handle_experiment_result(params: dict) -> dict:
    """Handle experiment.result notification - record external result."""
    result = ExperimentResult(
        commit=params.get("commit", "unknown"),
        val_bpb=params.get("valBpb", 0.0),
        memory_gb=params.get("memoryGb", 0.0),
        status=params.get("status", "discard"),
        description=params.get("description", ""),
        agent_id=params.get("agentId", "unknown"),
        timestamp=params.get("timestamp", datetime.now().isoformat()),
        branch=params.get("branch", "unknown"),
    )
    
    with state_lock:
        state.total_experiments += 1
        state.results.append(asdict(result))
        if result.status == "keep" and result.val_bpb > 0:
            if result.val_bpb < state.best_val_bpb:
                state.best_val_bpb = result.val_bpb
    
    append_to_results_tsv(result)
    save_state()
    
    return {"recorded": True}


def handle_agent_register(params: dict) -> dict:
    """Handle agent.register - register agent as active."""
    agent_id = params.get("agentId", "unknown")
    with state_lock:
        if agent_id not in state.active_agents:
            state.active_agents.append(agent_id)
    return {"registered": True}


def handle_agent_unregister(params: dict) -> dict:
    """Handle agent.unregister - remove agent from active list."""
    agent_id = params.get("agentId", "unknown")
    with state_lock:
        if agent_id in state.active_agents:
            state.active_agents.remove(agent_id)
    release_lock(agent_id)
    return {"unregistered": True}


# Method dispatch table
METHODS = {
    "swarm.sync": handle_swarm_sync,
    "swarm.status": handle_swarm_status,
    "swarm.history": handle_swarm_history,
    "lock.acquire": handle_lock_acquire,
    "lock.release": handle_lock_release,
    "experiment.run": handle_experiment_run,
    "experiment.result": handle_experiment_result,
    "agent.register": handle_agent_register,
    "agent.unregister": handle_agent_unregister,
}

# ---------------------------------------------------------------------------
# JSON-RPC Protocol
# ---------------------------------------------------------------------------

def make_response(id, result):
    """Create JSON-RPC success response."""
    return {"jsonrpc": "2.0", "id": id, "result": result}


def make_error(id, code, message):
    """Create JSON-RPC error response."""
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


def handle_message(msg: dict) -> Optional[dict]:
    """Handle incoming JSON-RPC message. Returns response or None for notifications."""
    if msg.get("jsonrpc") != "2.0":
        return make_error(msg.get("id"), -32600, "Invalid Request: not JSON-RPC 2.0")
    
    method = msg.get("method")
    params = msg.get("params", {})
    msg_id = msg.get("id")  # None for notifications
    
    if method not in METHODS:
        if msg_id is not None:
            return make_error(msg_id, -32601, f"Method not found: {method}")
        return None
    
    try:
        result = METHODS[method](params)
        if msg_id is not None:
            return make_response(msg_id, result)
        return None  # notification, no response
    except Exception as e:
        log(f"Error handling {method}: {e}")
        if msg_id is not None:
            return make_error(msg_id, -32603, str(e))
        return None


# ---------------------------------------------------------------------------
# Logging (to stderr, keeps stdout clean for JSON-RPC)
# ---------------------------------------------------------------------------

def log(msg: str):
    """Log message to stderr."""
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------

def main():
    """Main entry point - read NDJSON from stdin, write to stdout."""
    log(f"Swarm coordinator starting")
    log(f"GPUs: {GPU_IDS}")
    log(f"Work dir: {WORK_DIR.absolute()}")
    
    # Restore state
    load_state()
    
    log("Ready for JSON-RPC messages on stdin...")
    
    # Process stdin line by line (NDJSON)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            response = make_error(None, -32700, f"Parse error: {e}")
            print(json.dumps(response), flush=True)
            continue
        
        response = handle_message(msg)
        if response is not None:
            print(json.dumps(response), flush=True)
    
    log("stdin closed, shutting down")
    save_state()


if __name__ == "__main__":
    main()
