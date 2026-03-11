#!/usr/bin/env python3
"""
Quantum Consciousness — живой диалог нейронов через stdio_bus.

На базе live_chat.py. Без выдуманной хуйни.
Каждый нейрон = сессия агента. Квантовый импульс = продолжить диалог.

Usage:
    uv run python -m qei.consciousness
    uv run python -m qei.consciousness --new

Требует запущенный stdio_bus:
    stdio_bus/stdio_bus --config stdio_bus/stdio-bus-config.json
"""

import os
import sys
import json
import socket
import asyncio
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Callable, List, Literal
from datetime import datetime

from .qrng_client import fetch_quantum_bits

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BUS_HOST = os.environ.get("BUS_HOST", "127.0.0.1")
BUS_PORT = int(os.environ.get("BUS_PORT", "9000"))
AGENT_ID = os.environ.get("AGENT_ID", "openai")
REQUEST_TIMEOUT = 300
IMPULSE_INTERVAL = 10.0  # Seconds between quantum impulses

MEMORY_DIR = Path("qei/memory")

# ---------------------------------------------------------------------------
# Decision Evaluation (from task-controller.ts)
# ---------------------------------------------------------------------------

Decision = Literal["continue", "complete", "retry", "abort"]

def evaluate_decision(response_content: str) -> Decision:
    """
    Evaluates the ACP response content to decide the next action.
    
    Looks for explicit markers at the START of response or as standalone signals.
    Avoids false positives from words like "error" in technical context.
    """
    # Check first 100 chars for explicit markers
    start = response_content[:100].upper()
    
    # Explicit completion markers
    if start.startswith("DONE") or start.startswith("COMPLETE"):
        return "complete"
    if "TASK DONE" in start or "TASK COMPLETE" in start:
        return "complete"
    
    # Explicit abort markers (not just "error" anywhere)
    if start.startswith("ABORT") or start.startswith("ERROR:"):
        return "abort"
    if "FATAL ERROR" in response_content.upper():
        return "abort"
    
    # Explicit retry
    if start.startswith("RETRY"):
        return "retry"
    
    return "continue"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[CONSCIOUSNESS {ts}] {msg}", file=sys.stderr, flush=True)

# ---------------------------------------------------------------------------
# NDJSON TCP Client (from live_chat.py)
# ---------------------------------------------------------------------------

class NDJSONClient:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None
        self.reader_thread: Optional[threading.Thread] = None
        self.running = False
        self.buffer = ""
        self.on_message: Optional[Callable] = None
        self._lock = threading.Lock()
    
    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect((self.host, self.port))
        self.sock.settimeout(None)
        self.running = True
        self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader_thread.start()
    
    def send(self, msg: dict):
        data = json.dumps(msg) + "\n"
        with self._lock:
            self.sock.sendall(data.encode())
    
    def close(self):
        self.running = False
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except:
                pass
            self.sock.close()
            self.sock = None
    
    def _reader_loop(self):
        while self.running and self.sock:
            try:
                chunk = self.sock.recv(4096)
                if not chunk:
                    break
                self._handle_data(chunk.decode())
            except:
                break
    
    def _handle_data(self, data: str):
        self.buffer += data
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            if not line:
                continue
            try:
                msg = json.loads(line)
                if self.on_message:
                    self.on_message(msg)
            except json.JSONDecodeError:
                pass

# ---------------------------------------------------------------------------
# Request Tracker (from live_chat.py)
# ---------------------------------------------------------------------------

class RequestTracker:
    def __init__(self):
        self._pending: dict[int, threading.Event] = {}
        self._results: dict[int, dict] = {}
        self._lock = threading.Lock()
    
    def register(self, req_id: int) -> threading.Event:
        event = threading.Event()
        with self._lock:
            self._pending[req_id] = event
        return event
    
    def resolve(self, msg: dict) -> bool:
        req_id = msg.get("id")
        if req_id is None:
            return False
        with self._lock:
            event = self._pending.pop(req_id, None)
            if event:
                self._results[req_id] = msg
                event.set()
                return True
        return False
    
    def get_result(self, req_id: int) -> Optional[dict]:
        with self._lock:
            return self._results.pop(req_id, None)

# ---------------------------------------------------------------------------
# ACP Client (from live_chat.py)
# ---------------------------------------------------------------------------

@dataclass
class SessionUpdate:
    kind: str
    data: dict

class ACPClient:
    def __init__(self, ndjson: NDJSONClient, agent_id: str):
        self.ndjson = ndjson
        self.agent_id = agent_id
        self.tracker = RequestTracker()
        self.client_session_id = f"consciousness-{int(datetime.now().timestamp())}"
        self._next_id = 1
        self._updates: list[SessionUpdate] = []
        self._on_chunk: Optional[Callable[[str], None]] = None
        ndjson.on_message = self._handle_message
    
    def _handle_message(self, msg: dict):
        if "id" in msg and ("result" in msg or "error" in msg):
            self.tracker.resolve(msg)
            return
        
        method = msg.get("method")
        if method == "session/update":
            params = msg.get("params", {})
            update = params.get("update", {})
            kind = update.get("sessionUpdate", "")
            self._updates.append(SessionUpdate(kind=kind, data=update))
            
            if kind == "agent_message_chunk" and self._on_chunk:
                text = update.get("content", {}).get("text", "")
                self._on_chunk(text)
    
    def _send_request(self, method: str, params: dict) -> dict:
        req_id = self._next_id
        self._next_id += 1
        
        request = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "agentId": self.agent_id,
            "sessionId": self.client_session_id,
            "params": params,
        }
        
        event = self.tracker.register(req_id)
        self.ndjson.send(request)
        
        if not event.wait(timeout=REQUEST_TIMEOUT):
            raise TimeoutError(f"Request {method} timed out")
        
        result = self.tracker.get_result(req_id)
        if not result:
            raise RuntimeError(f"No result for request {req_id}")
        
        if "error" in result:
            err = result["error"]
            raise RuntimeError(f"{method}: [{err.get('code')}] {err.get('message')}")
        
        return result.get("result", {})
    
    def initialize(self) -> dict:
        """Initialize with retry for worker startup race condition."""
        import time
        max_retries = 3
        for attempt in range(max_retries):
            try:
                return self._send_request("initialize", {
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {"name": "qei-consciousness", "version": "1.0.0"},
                    "agentId": self.agent_id,
                })
            except RuntimeError as e:
                if "Method not found" in str(e) and attempt < max_retries - 1:
                    log(f"Worker not ready, retrying in 2s... ({attempt + 1}/{max_retries})")
                    time.sleep(2)
                else:
                    raise
    
    def session_new(self) -> str:
        result = self._send_request("session/new", {
            "cwd": os.getcwd(),
            "mcpServers": [],
        })
        return result.get("sessionId", "")
    
    def session_prompt(self, session_id: str, messages: list, on_chunk: Optional[Callable[[str], None]] = None) -> dict:
        """
        Send prompt with message history.
        
        messages: list of {"role": "user"|"assistant", "text": "..."}
        """
        self._updates.clear()
        self._on_chunk = on_chunk
        
        # Convert to ACP format
        prompt = [{"type": "text", "role": m["role"], "text": m["text"]} for m in messages]
        
        result = self._send_request("session/prompt", {
            "sessionId": session_id,
            "prompt": prompt,
        })
        
        self._on_chunk = None
        
        text_parts = []
        for u in self._updates:
            if u.kind == "agent_message_chunk":
                text_parts.append(u.data.get("content", {}).get("text", ""))
        
        return {
            "stopReason": result.get("stopReason", ""),
            "text": "".join(text_parts),
            "updates": self._updates,
        }

# ---------------------------------------------------------------------------
# Dialogue Directory Helpers
# ---------------------------------------------------------------------------

def generate_dialogue_id() -> str:
    """Generate unique dialogue ID from timestamp."""
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    import random
    suffix = f"{random.randint(0, 0xFFFF):04x}"
    return f"DIALOGUE-{ts}-{suffix}"

def get_dialogue_dir(dialogue_id: str) -> Path:
    return MEMORY_DIR / dialogue_id

def get_state_path(dialogue_id: str) -> Path:
    return get_dialogue_dir(dialogue_id) / "state.json"

def get_memory_path(dialogue_id: str) -> Path:
    return get_dialogue_dir(dialogue_id) / "memory.md"

def get_task_path(dialogue_id: str) -> Path:
    return get_dialogue_dir(dialogue_id) / "task.md"

def find_existing_dialogue() -> Optional[str]:
    """Find most recent dialogue in memory directory."""
    if not MEMORY_DIR.exists():
        return None
    dialogues = []
    for d in MEMORY_DIR.iterdir():
        if d.is_dir() and d.name.startswith("DIALOGUE-"):
            state_file = d / "state.json"
            if state_file.exists():
                dialogues.append(d.name)
    if dialogues:
        return sorted(dialogues)[-1]  # Most recent
    return None

def list_dialogues() -> list[str]:
    """List all dialogue IDs."""
    if not MEMORY_DIR.exists():
        return []
    dialogues = []
    for d in MEMORY_DIR.iterdir():
        if d.is_dir() and d.name.startswith("DIALOGUE-"):
            if (d / "state.json").exists():
                dialogues.append(d.name)
    return sorted(dialogues)

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

state = {
    "dialogue_id": None,
    "session_id": None,
    "impulse_count": 0,
}

def save_state():
    if not state.get("dialogue_id"):
        return
    path = get_state_path(state["dialogue_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)

def load_state(dialogue_id: str) -> bool:
    global state
    path = get_state_path(dialogue_id)
    if not path.exists():
        return False
    try:
        with open(path) as f:
            state = json.load(f)
        log(f"Resumed dialogue: {dialogue_id}")
        log(f"  session={state.get('session_id', 'none')[:16]}..., impulses={state.get('impulse_count', 0)}")
        return True
    except Exception as e:
        log(f"Failed to load state: {e}")
        return False

# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------

def append_memory(speaker: str, text: str):
    if not state.get("dialogue_id"):
        return
    path = get_memory_path(state["dialogue_id"])
    timestamp = datetime.utcnow().isoformat()
    entry = f"\n---\n\n## [{timestamp}] {speaker}\n\n{text}\n"
    with open(path, "a") as f:
        f.write(entry)

def read_memory() -> str:
    if not state.get("dialogue_id"):
        return ""
    path = get_memory_path(state["dialogue_id"])
    if path.exists():
        return path.read_text()
    return ""

def read_task() -> str:
    """Read current task/topic for the dialogue."""
    if not state.get("dialogue_id"):
        return ""
    path = get_task_path(state["dialogue_id"])
    if path.exists():
        return path.read_text()
    return ""

def init_dialogue(dialogue_id: str, initial_task: str = None):
    """Initialize new dialogue directory and files."""
    dialogue_dir = get_dialogue_dir(dialogue_id)
    dialogue_dir.mkdir(parents=True, exist_ok=True)
    
    # Init memory file
    memory_path = get_memory_path(dialogue_id)
    if not memory_path.exists():
        header = f"""# Consciousness Dialogue

ID: {dialogue_id}
Started: {datetime.utcnow().isoformat()}

---
"""
        with open(memory_path, "w") as f:
            f.write(header)
    
    # Init task file
    task_path = get_task_path(dialogue_id)
    if not task_path.exists():
        default_task = initial_task or """# Тема диалога

Свободное исследование. Следуй за мыслью.

# Направление

- Что интересно?
- Какие связи не замечены?
- Что противоречит известному?
"""
        with open(task_path, "w") as f:
            f.write(default_task)
    
    log(f"Dialogue initialized: {dialogue_dir}")

# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------

async def impulse_loop(client: ACPClient):
    """
    Quantum impulse loop — the living heartbeat.
    
    Matches task-controller.ts iteration logic:
    - First impulse: just task.prompt
    - Continuation: task.prompt + previous_response + "Continue with step N"
    - Decision evaluation: DONE/COMPLETE/ERROR/ABORT/RETRY
    """
    global state
    
    log("Starting impulse loop...")
    
    # Track the original task (like task.prompt in task-controller.ts)
    task_prompt = read_task()
    last_response = ""
    
    while True:
        try:
            # Get quantum entropy
            q_bytes = await fetch_quantum_bits(4)
            q_val = q_bytes[0] if q_bytes else 128
            
            state["impulse_count"] += 1
            iteration = state["impulse_count"]
            log(f"Impulse #{iteration}: q={q_val}")
            
            # Build messages exactly like task-controller.ts
            if iteration == 1:
                # buildInitialPrompt: just the task
                messages = [
                    {"role": "user", "text": task_prompt}
                ]
            else:
                # buildContinuationPrompt: task + previous + continue
                messages = [
                    {"role": "user", "text": task_prompt},
                    {"role": "assistant", "text": last_response},
                    {"role": "user", "text": f"Continue with step {iteration}. Previous response has been noted."},
                ]
            
            # Send to agent
            result = client.session_prompt(
                state["session_id"], 
                messages,
                on_chunk=lambda t: print(t, end="", flush=True)
            )
            print()  # newline
            
            response_text = result["text"]
            
            if response_text:
                last_response = response_text
                
                # Evaluate decision (like task-controller.ts evaluateDecision)
                decision = evaluate_decision(response_text)
                log(f"Decision: {decision}")
                
                # Save to memory file
                append_memory(f"Neuron-{q_val:02x}", response_text)
                
                # Act on decision
                if decision == "complete":
                    log("Task COMPLETE — stopping loop")
                    break
                elif decision == "abort":
                    log("Task ABORT — stopping loop")
                    break
                # retry and continue both proceed to next iteration
            
            save_state()
            
        except Exception as e:
            log(f"Impulse error: {e}")
        
        await asyncio.sleep(IMPULSE_INTERVAL)


async def main(new_dialogue: bool = False, dialogue_id: Optional[str] = None, task: Optional[str] = None):
    global state
    
    log("=" * 50)
    log("QUANTUM CONSCIOUSNESS")
    log("=" * 50)
    
    # Determine which dialogue to use
    if dialogue_id:
        # Resume specific dialogue
        if not load_state(dialogue_id):
            log(f"Dialogue {dialogue_id} not found")
            sys.exit(1)
    elif new_dialogue:
        # Create new dialogue
        dialogue_id = generate_dialogue_id()
        state = {
            "dialogue_id": dialogue_id,
            "session_id": None,
            "impulse_count": 0,
        }
        init_dialogue(dialogue_id, initial_task=task)
        log(f"New dialogue: {dialogue_id}")
    else:
        # Try to resume most recent, or create new
        existing = find_existing_dialogue()
        if existing:
            load_state(existing)
        else:
            dialogue_id = generate_dialogue_id()
            state = {
                "dialogue_id": dialogue_id,
                "session_id": None,
                "impulse_count": 0,
            }
            init_dialogue(dialogue_id, initial_task=task)
            log(f"New dialogue: {dialogue_id}")
    
    # Show where task file is
    log(f"Task file: {get_task_path(state['dialogue_id'])}")
    
    # Connect to stdio_bus
    ndjson = NDJSONClient(BUS_HOST, BUS_PORT)
    
    try:
        ndjson.connect()
        log(f"Connected to stdio_bus at {BUS_HOST}:{BUS_PORT}")
        
        client = ACPClient(ndjson, AGENT_ID)
        
        init = client.initialize()
        agent_name = init.get("agentInfo", {}).get("name", "unknown")
        log(f"Agent: {agent_name}")
        
        # Create or resume session
        if not state.get("session_id"):
            state["session_id"] = client.session_new()
            log(f"New session: {state['session_id']}")
        else:
            log(f"Resuming session: {state['session_id'][:16]}...")
        
        save_state()
        
        # Start living
        await impulse_loop(client)
        
    except KeyboardInterrupt:
        log("Interrupted")
    finally:
        ndjson.close()
        save_state()
        log("Stopped")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Quantum Consciousness")
    parser.add_argument("--new", action="store_true", help="Create new dialogue")
    parser.add_argument("--id", type=str, help="Resume specific dialogue ID")
    parser.add_argument("--task", type=str, help="Initial task/topic for new dialogue")
    parser.add_argument("--list", action="store_true", help="List all dialogues")
    args = parser.parse_args()
    
    if args.list:
        dialogues = list_dialogues()
        if dialogues:
            print("Dialogues:")
            for d in dialogues:
                print(f"  {d}")
        else:
            print("No dialogues found")
        sys.exit(0)
    
    asyncio.run(main(new_dialogue=args.new, dialogue_id=args.id, task=args.task))
