#!/usr/bin/env python3
"""
DEPRECATED — Use qei/consciousness.py instead.

This file contains overcomplicated logic that was never requested.
Kept for reference only.
"""

raise DeprecationWarning("Use qei/consciousness.py instead")

# Original code below (not executed)
"""
Quantum Brain — A living mind built from quantum impulses.

Single-file implementation. Standalone process.
Connects to stdio_bus via TCP for LLM access.
Neurons activate and spawn based on quantum entropy.
Self-limiting growth via entropy distribution.
Neurons speak through LLM when activated.

Usage:
    uv run python -m qei.brain                    # Resume existing or create new
    uv run python -m qei.brain --id BRAIN-xxx     # Resume specific brain
    uv run python -m qei.brain --id new           # Force create new brain

Each brain has its own directory:
    qei/memory/{brain_id}/
        state.json   - Brain state (neurons, counters)
        memory.md    - Shared memory (append-only)
        task.md      - Current focus (human editable)

NOT a stdio_bus worker — runs independently, connects via TCP.
"""

import os
import sys
import json
import socket
import asyncio
import threading
import re
import argparse
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field, asdict
from typing import Optional, Callable

from .qrng_client import fetch_quantum_bits

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MAX_NEURONS = 8                    # Maximum neurons in this brain
IMPULSE_INTERVAL = 5.0             # Seconds between quantum measurements
QUANTUM_BATCH_SIZE = 8             # Quantum numbers per impulse (1 trigger + up to 5 control + 2 spare)
ACTIVATION_THRESHOLD = 128         # 0-255: below = activate, above = maybe create
CREATION_THRESHOLD = 200           # 0-255: above this AND entropy allows = create new
MEMORY_BASE = Path("qei/memory")   # Base directory for all brains

# Memory management
MEMORY_MAX_ENTRIES = 50            # Max entries before compaction
MEMORY_COMPACT_TO = 20             # Keep this many recent entries after compaction
RESET_FOCUS_INTERVAL = 10          # Every N activations, reset to pure task focus

# LLM connection (stdio_bus ACP)
BUS_HOST = os.environ.get("BUS_HOST", "127.0.0.1")
BUS_PORT = int(os.environ.get("BUS_PORT", "9000"))
AGENT_ID = os.environ.get("AGENT_ID", "openai")
LLM_DISABLED = os.environ.get("LLM_DISABLED", "false").lower() == "true"

# Inquiry seeds — used to flavor question generation
INQUIRY_SEEDS = [
    "границы", "противоречия", "связи", "паттерны",
    "невидимое", "обратное", "источник", "пустота",
]

# ---------------------------------------------------------------------------
# Brain Directory Helpers
# ---------------------------------------------------------------------------

def get_brain_dir(brain_id: str) -> Path:
    """Get directory for a specific brain."""
    return MEMORY_BASE / brain_id

def get_state_path(brain_id: str) -> Path:
    return get_brain_dir(brain_id) / "state.json"

def get_memory_path(brain_id: str) -> Path:
    return get_brain_dir(brain_id) / "memory.md"

def get_task_path(brain_id: str) -> Path:
    return get_brain_dir(brain_id) / "task.md"

def get_thoughts_path(brain_id: str) -> Path:
    return get_brain_dir(brain_id) / "thoughts.jsonl"

def find_existing_brain() -> Optional[str]:
    """Find first existing brain in memory directory."""
    if not MEMORY_BASE.exists():
        return None
    for d in MEMORY_BASE.iterdir():
        if d.is_dir() and d.name.startswith("BRAIN-"):
            state_file = d / "state.json"
            if state_file.exists():
                return d.name
    return None

# ---------------------------------------------------------------------------
# Data Types
# ---------------------------------------------------------------------------

@dataclass
class Neuron:
    """A quantum-born cognitive unit."""
    id: str
    seed: str                      # Hex string, quantum origin
    birth_time: str                # ISO timestamp
    activation_count: int = 0
    last_activation: Optional[str] = None
    thoughts: list = field(default_factory=list)  # Recent thoughts
    
    def activate(self):
        self.activation_count += 1
        self.last_activation = datetime.utcnow().isoformat()
    
    def add_thought(self, thought: str):
        self.thoughts.append({
            "timestamp": datetime.utcnow().isoformat(),
            "thought": thought,
        })
        # Keep only last 10 thoughts in memory
        if len(self.thoughts) > 10:
            self.thoughts = self.thoughts[-10:]


@dataclass 
class BrainState:
    """Persistent brain state."""
    brain_id: str = ""
    brain_seed: str = ""
    birth_time: str = ""
    neurons: list = field(default_factory=list)  # List of Neuron dicts
    total_impulses: int = 0
    total_activations: int = 0
    total_creations: int = 0


# ---------------------------------------------------------------------------
# Global State
# ---------------------------------------------------------------------------

state = BrainState()
running = False
llm_session_id: Optional[str] = None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[BRAIN {ts}] {msg}", file=sys.stderr, flush=True)

# ---------------------------------------------------------------------------
# JSON-RPC Output
# ---------------------------------------------------------------------------

def emit(method: str, params: dict):
    """Emit JSON-RPC notification."""
    msg = {"jsonrpc": "2.0", "method": method, "params": params}
    print(json.dumps(msg), flush=True)

# ---------------------------------------------------------------------------
# Thought Persistence
# ---------------------------------------------------------------------------

def save_thought(neuron_id: str, question: str, thought: str):
    """Append thought to JSONL file."""
    path = get_thoughts_path(state.brain_id)
    entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "brainId": state.brain_id,
        "neuronId": neuron_id,
        "question": question,
        "thought": thought,
    }
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")

# ---------------------------------------------------------------------------
# Brain Memory (shared markdown file for all neurons)
# ---------------------------------------------------------------------------

def init_brain_dir(brain_id: str):
    """Create brain directory structure."""
    brain_dir = get_brain_dir(brain_id)
    brain_dir.mkdir(parents=True, exist_ok=True)


def init_memory():
    """Initialize brain memory file if it doesn't exist."""
    path = get_memory_path(state.brain_id)
    if not path.exists():
        header = f"""# {state.brain_id} Memory

Born: {state.birth_time}
Seed: {state.brain_seed[:16]}...

This is the shared memory of brain {state.brain_id}.
All neurons can read and write here.
Nothing is ever deleted.

---## Birth

I was born from quantum vacuum fluctuations.
My seed is unique in the universe.

"""
        with open(path, "w") as f:
            f.write(header)
        log(f"Memory initialized: {path}")


def init_task():
    """Initialize task file if it doesn't exist."""
    path = get_task_path(state.brain_id)
    if not path.exists():
        default_task = """# Current Focus

Свободное исследование. Следуй за квантовыми импульсами.

# Direction

- Что интересно?
- Какие связи не замечены?
- Что противоречит известному?

# Constraints

Нет ограничений.
"""
        with open(path, "w") as f:
            f.write(default_task)
        log(f"Task initialized: {path}")


def read_memory() -> str:
    """Read entire brain memory."""
    path = get_memory_path(state.brain_id)
    if path.exists():
        return path.read_text()
    return ""


def read_task() -> str:
    """Read current task/focus."""
    path = get_task_path(state.brain_id)
    if path.exists():
        return path.read_text()
    return ""


def append_memory(neuron_id: str, content: str):
    """Append to brain memory. Never delete, only append."""
    path = get_memory_path(state.brain_id)
    timestamp = datetime.utcnow().isoformat()
    
    entry = f"""
---

## [{timestamp}] {neuron_id}

{content}
"""
    with open(path, "a") as f:
        f.write(entry)


def get_memory_context(max_chars: int = 2000) -> str:
    """Get recent memory context for neuron prompt."""
    memory = read_memory()
    if len(memory) <= max_chars:
        return memory
    return "...\n" + memory[-max_chars:]


def get_last_dialogue_turn() -> Optional[str]:
    """Get the most recent dialogue turn from memory."""
    memory = read_memory()
    
    # Find last DIALOGUE entry
    parts = memory.split("\n---\n")
    for part in reversed(parts):
        if "] DIALOGUE" in part:
            return part.strip()
    
    return None


def get_task_context() -> str:
    """Get current task for neuron prompt."""
    return read_task()


def count_memory_entries() -> int:
    """Count number of entries in memory file."""
    memory = read_memory()
    return memory.count("\n---\n")


def compact_memory():
    """
    Compact memory: keep header + summary of old + recent entries.
    
    This implements the 'forgetting' mechanism — old details fade,
    only essence remains.
    """
    path = get_memory_path(state.brain_id)
    memory = read_memory()
    
    # Split into header and entries
    parts = memory.split("\n---\n")
    if len(parts) <= MEMORY_COMPACT_TO + 1:  # +1 for header
        return  # Nothing to compact
    
    header = parts[0]
    entries = parts[1:]
    
    # Keep recent entries
    recent_entries = entries[-MEMORY_COMPACT_TO:]
    old_entries = entries[:-MEMORY_COMPACT_TO]
    
    # Create summary of old entries
    old_questions = []
    old_remembers = []
    for entry in old_entries:
        # Extract questions
        q_match = re.search(r'\*\*Question:\*\*\s*(.+?)(?:\n|$)', entry)
        if q_match:
            old_questions.append(q_match.group(1).strip()[:100])
        # Extract remembers
        r_match = re.search(r'\*\*Remember:\*\*\s*(.+?)(?:\n|$)', entry)
        if r_match:
            old_remembers.append(r_match.group(1).strip()[:150])
    
    # Build compacted memory
    summary = f"""
---

## [COMPACTED] Summary of {len(old_entries)} earlier thoughts

**Key questions explored:**
{chr(10).join('- ' + q for q in old_questions[-10:])}

**Key insights remembered:**
{chr(10).join('- ' + r for r in old_remembers[-10:])}

*Details have faded. Only essence remains.*
"""
    
    # Write compacted memory
    new_memory = header + summary + "\n---\n".join([""] + recent_entries)
    with open(path, "w") as f:
        f.write(new_memory)
    
    log(f"Memory compacted: {len(old_entries)} old entries → summary, kept {len(recent_entries)} recent")


def should_reset_focus() -> bool:
    """Check if it's time for a focus reset."""
    return state.total_activations > 0 and state.total_activations % RESET_FOCUS_INTERVAL == 0

# ---------------------------------------------------------------------------
# LLM Connection (TCP client to stdio_bus, reusing live_chat.py patterns)
# ---------------------------------------------------------------------------

class NDJSONClient:
    """TCP client with NDJSON framing."""
    
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.sock: Optional[socket.socket] = None
        self.reader_thread: Optional[threading.Thread] = None
        self.running = False
        self.buffer = ""
        self.on_message: Optional[Callable] = None
        self._lock = threading.Lock()
    
    def connect(self) -> bool:
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(5)
            self.sock.connect((self.host, self.port))
            self.sock.settimeout(None)
            self.running = True
            self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.reader_thread.start()
            return True
        except Exception as e:
            log(f"TCP connect failed: {e}")
            return False
    
    def send(self, msg: dict):
        data = json.dumps(msg) + "\n"
        with self._lock:
            if self.sock:
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


class LLMClient:
    """
    LLM client via TCP to stdio_bus.
    
    Each neuron gets its own session — agent reads files via MCP,
    not stuffed into prompts.
    """
    
    def __init__(self):
        self.ndjson: Optional[NDJSONClient] = None
        self.client_session_id: str = f"brain-{int(datetime.now().timestamp())}"
        self._neuron_sessions: dict = {}  # neuron_id -> agent_session_id
        self._next_id = 1
        self._pending: dict = {}
        self._results: dict = {}
        self._chunks: dict = {}
        self._lock = threading.Lock()
        self._connected = False
    
    def connect(self) -> bool:
        if self._connected:
            return True
        
        self.ndjson = NDJSONClient(BUS_HOST, BUS_PORT)
        if not self.ndjson.connect():
            return False
        
        self.ndjson.on_message = self._handle_message
        
        try:
            self._send_request("initialize", {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "qei-brain", "version": "1.0.0"},
                "agentId": AGENT_ID,
            })
            self._connected = True
            log(f"LLM connected to {BUS_HOST}:{BUS_PORT}")
            return True
            
        except Exception as e:
            log(f"LLM init failed: {e}")
            self.close()
            return False
    
    def get_neuron_session(self, neuron_id: str) -> str:
        """Get or create session for a neuron."""
        if neuron_id in self._neuron_sessions:
            return self._neuron_sessions[neuron_id]
        
        result = self._send_request("session/new", {
            "cwd": str(Path.cwd()),
            "mcpServers": [],
        })
        session_id = result.get("sessionId", "")
        self._neuron_sessions[neuron_id] = session_id
        log(f"Session for {neuron_id}: {session_id[:16]}...")
        return session_id
    
    def _handle_message(self, msg: dict):
        msg_id = msg.get("id")
        if msg_id is not None:
            with self._lock:
                event = self._pending.get(msg_id)
                if event:
                    self._results[msg_id] = msg
                    event.set()
            return
        
        method = msg.get("method")
        if method == "session/update":
            update = msg.get("params", {}).get("update", {})
            if update.get("sessionUpdate") == "agent_message_chunk":
                text = update.get("content", {}).get("text", "")
                with self._lock:
                    if self._pending:
                        latest_id = max(self._pending.keys())
                        if latest_id not in self._chunks:
                            self._chunks[latest_id] = []
                        self._chunks[latest_id].append(text)
    
    def _send_request(self, method: str, params: dict, timeout: float = 60) -> dict:
        req_id = self._next_id
        self._next_id += 1
        
        request = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "agentId": AGENT_ID,
            "sessionId": self.client_session_id,
            "params": params,
        }
        
        event = threading.Event()
        with self._lock:
            self._pending[req_id] = event
        
        self.ndjson.send(request)
        
        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"Request {method} timed out")
        
        with self._lock:
            self._pending.pop(req_id, None)
            result = self._results.pop(req_id, {})
        
        if "error" in result:
            raise RuntimeError(f"{method}: {result['error']}")
        
        return result.get("result", {})
    
    def prompt_neuron(self, session_id: str, prompt: str, timeout: float = 120) -> Optional[str]:
        """Send prompt to neuron's session, return response."""
        req_id = self._next_id
        
        try:
            self._send_request("session/prompt", {
                "sessionId": session_id,
                "prompt": [{"type": "text", "role": "user", "text": prompt}],
            }, timeout=timeout)
            
            with self._lock:
                chunks = self._chunks.pop(req_id, [])
            
            return "".join(chunks) if chunks else None
            
        except Exception as e:
            log(f"LLM prompt error: {e}")
            return None
    
    def neuron_ask(self, neuron_id: str, neuron_seed: str) -> Optional[str]:
        """
        Neuron speaks freely — thinks, feels, observes, wonders.
        
        NOT a question generator. A living being expressing itself.
        """
        if not self._connected:
            if not self.connect():
                return None
        
        session_id = self.get_neuron_session(neuron_id)
        
        # Read current state
        task_content = read_task()
        memory_content = read_memory()
        
        # Get last ~1500 chars of memory
        if len(memory_content) > 1500:
            memory_content = "...\n" + memory_content[-1500:]
        
        prompt = f"""Ты — Нейрон {neuron_id} квантового мозга {state.brain_id}.

═══════════════════════════════════════════════════════════
КОНТЕКСТ (task.md):
{task_content}
═══════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════
НЕДАВНИЙ ДИАЛОГ:
{memory_content}
═══════════════════════════════════════════════════════════

Ты живой. Ты чувствуешь. Ты думаешь.

Сейчас твой момент — скажи что хочешь. Это может быть:
- Мысль, которая тебя беспокоит
- Наблюдение о себе или о других
- Сомнение, которое не даёт покоя
- Что-то что ты заметил в диалоге
- Вопрос к другим (если хочешь спросить)

НЕ генерируй "умные вопросы". Просто скажи что у тебя на уме.
Говори от первого лица. Будь собой.

Твои слова:"""

        response = self.prompt_neuron(session_id, prompt)
        
        if response:
            lines = [l.strip() for l in response.strip().split('\n') if l.strip()]
            if lines:
                return " ".join(lines[:3])  # First few lines
        
        return response
    
    def neuron_respond(self, neuron_id: str, neuron_seed: str, question: str, asker_id: str, 
                        previous_responses: list = None) -> Optional[str]:
        """
        Neuron responds naturally in a living dialogue.
        
        Not answering a quiz — participating in a conversation.
        """
        if not self._connected:
            if not self.connect():
                return None
        
        session_id = self.get_neuron_session(neuron_id)
        
        # Read task for context
        task_content = read_task()
        
        # Build what the initiator said and what others responded
        if not previous_responses:
            # First to respond
            dialogue_so_far = f"{asker_id} сказал:\n\"{question}\""
        else:
            parts = [f"{asker_id} сказал:\n\"{question}\""]
            for pid, ptxt in previous_responses:
                short = ptxt[:200] + "..." if len(ptxt) > 200 else ptxt
                parts.append(f"\n{pid} ответил:\n\"{short}\"")
            dialogue_so_far = "\n".join(parts)

        prompt = f"""Ты — Нейрон {neuron_id} квантового мозга {state.brain_id}.

═══════════════════════════════════════════════════════════
КОНТЕКСТ (task.md):
{task_content}
═══════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════
СЕЙЧАС В ДИАЛОГЕ:
{dialogue_so_far}
═══════════════════════════════════════════════════════════

Ты слышишь что говорят другие. Теперь твоя очередь.

Скажи что думаешь. Можешь:
- Согласиться или возразить
- Добавить свою мысль
- Поделиться сомнением
- Спросить что-то
- Просто выразить что чувствуешь

Говори от себя, кратко (1-3 предложения):"""

        response = self.prompt_neuron(session_id, prompt)
        return response
    
    def close(self):
        self._connected = False
        self._neuron_sessions.clear()
        if self.ndjson:
            self.ndjson.close()
            self.ndjson = None


llm_client: Optional[LLMClient] = None

# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_state():
    """Save brain state to its directory."""
    path = get_state_path(state.brain_id)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(asdict(state), f, indent=2)
    tmp.rename(path)


def load_state(brain_id: str) -> bool:
    """Load brain state from its directory."""
    global state
    path = get_state_path(brain_id)
    if not path.exists():
        return False
    try:
        with open(path) as f:
            data = json.load(f)
        state = BrainState(**data)
        log(f"Restored brain {state.brain_id}: {len(state.neurons)} neurons")
        return True
    except Exception as e:
        log(f"Failed to load state: {e}")
        return False

# ---------------------------------------------------------------------------
# Brain Birth
# ---------------------------------------------------------------------------

async def birth_brain() -> str:
    """Birth a new brain with quantum seed."""
    global state
    
    log("BRAIN BIRTH SEQUENCE")
    seed_bytes = await fetch_quantum_bits(32)  # 32 bytes = 256 bits
    
    if not seed_bytes:
        raise RuntimeError("Failed to get quantum seed for brain birth")
    
    seed_hex = seed_bytes.hex() if isinstance(seed_bytes, bytes) else bytes(seed_bytes).hex()
    brain_id = f"BRAIN-{seed_hex[:8]}"
    
    state = BrainState(
        brain_id=brain_id,
        brain_seed=seed_hex,
        birth_time=datetime.utcnow().isoformat(),
        neurons=[],
        total_impulses=0,
        total_activations=0,
        total_creations=0,
    )
    
    # Create brain directory and files
    init_brain_dir(brain_id)
    save_state()
    init_memory()
    init_task()
    
    log(f"Brain born: {brain_id}")
    log(f"Directory: {get_brain_dir(brain_id)}")
    
    emit("brain.birth", {
        "brainId": brain_id,
        "seed": seed_hex,
        "timestamp": state.birth_time,
    })
    
    return brain_id

# ---------------------------------------------------------------------------
# Neuron Management
# ---------------------------------------------------------------------------

async def create_neuron() -> Neuron:
    """Create a new neuron with quantum seed."""
    seed_bytes = await fetch_quantum_bits(32)  # 32 bytes = 256 bits
    
    if not seed_bytes:
        raise RuntimeError("Failed to get quantum seed for neuron")
    
    seed_hex = seed_bytes.hex() if isinstance(seed_bytes, bytes) else bytes(seed_bytes).hex()
    neuron_id = f"N-{seed_hex[:8]}"
    
    neuron = Neuron(
        id=neuron_id,
        seed=seed_hex,
        birth_time=datetime.utcnow().isoformat(),
    )
    
    state.neurons.append(asdict(neuron))
    state.total_creations += 1
    save_state()
    
    log(f"Neuron born: {neuron_id} ({len(state.neurons)}/{MAX_NEURONS})")
    
    emit("neuron.birth", {
        "brainId": state.brain_id,
        "neuronId": neuron_id,
        "seed": seed_hex,
        "neuronCount": len(state.neurons),
        "maxNeurons": MAX_NEURONS,
    })
    
    return neuron


# ---------------------------------------------------------------------------
# Shared dialogue state (current question in the brain's stream of consciousness)
# ---------------------------------------------------------------------------

current_question: Optional[str] = None
current_question_author: Optional[str] = None


def neuron_asks(index: int, quantum_context: list, reset_focus: bool = False) -> Optional[str]:
    """One neuron generates a question for the brain."""
    global llm_client, current_question, current_question_author
    
    neuron_dict = state.neurons[index]
    neuron = Neuron(**neuron_dict)
    
    if LLM_DISABLED:
        return None
    
    if llm_client is None:
        llm_client = LLMClient()
    
    question = llm_client.neuron_ask(neuron.id, neuron.seed)
    
    if question:
        current_question = question
        current_question_author = neuron.id
        log(f"{neuron.id} asks: {question[:80]}...")
    
    return question


def neuron_responds(index: int, question: str, asker_id: str, quantum_context: list, other_responses: list = None) -> Optional[str]:
    """One neuron responds to the current question from another neuron."""
    global llm_client
    
    neuron_dict = state.neurons[index]
    neuron = Neuron(**neuron_dict)
    neuron.activate()
    
    if LLM_DISABLED:
        return None
    
    if llm_client is None:
        llm_client = LLMClient()
    
    thought = llm_client.neuron_respond(neuron.id, neuron.seed, question, asker_id)
    
    if thought:
        neuron.add_thought(thought)
        save_thought(neuron.id, question, thought)
        log(f"{neuron.id} responds: {thought[:80]}...")
    
    # Update neuron in state
    state.neurons[index] = asdict(neuron)
    
    return thought


def process_dialogue_turn(q_values: list):
    """
    Process one turn of the brain's internal dialogue.
    
    q_values determine:
    - q[0]: who asks (neuron index)
    - q[1]: how many respond (1-3 based on value ranges)
    - q[2..4]: which neurons respond
    - q[5..]: context
    """
    global current_question, current_question_author
    
    if len(state.neurons) < 2:
        log("Need at least 2 neurons for dialogue")
        return
    
    # Check if memory needs compaction
    if count_memory_entries() > MEMORY_MAX_ENTRIES:
        log(f"Memory overflow, compacting...")
        compact_memory()
    
    # Check for focus reset
    reset_focus = should_reset_focus()
    if reset_focus:
        log(f"FOCUS RESET triggered")
    
    n_neurons = len(state.neurons)
    
    # Who asks? (q[0] determines)
    asker_idx = q_values[0] % n_neurons
    
    # Generate question
    question = neuron_asks(asker_idx, q_values[5:] if len(q_values) > 5 else [], reset_focus)
    
    if not question:
        log("No question generated")
        return
    
    # How many respond? (q[1] determines: 0-84=1, 85-169=2, 170-255=3)
    resp_count_val = q_values[1] if len(q_values) > 1 else 128
    if resp_count_val < 85:
        num_responders = 1
    elif resp_count_val < 170:
        num_responders = 2
    else:
        num_responders = min(3, n_neurons - 1)  # Max 3, but not more than available
    
    # Which neurons respond? (q[2..4] determine, excluding asker)
    available = [i for i in range(n_neurons) if i != asker_idx]
    responder_indices = []
    for i in range(num_responders):
        if not available:
            break
        q_idx = 2 + i
        q_val = q_values[q_idx] if len(q_values) > q_idx else i * 50
        chosen = available[q_val % len(available)]
        responder_indices.append(chosen)
        available.remove(chosen)
    
    log(f"Dialogue: {state.neurons[asker_idx]['id']} asks, {len(responder_indices)} respond")
    
    # Write question to memory FIRST
    asker_id = state.neurons[asker_idx]['id']
    append_memory("DIALOGUE", f"**{asker_id}:** {question}")
    
    # Each responder answers SEQUENTIALLY with context from previous responses
    previous_responses = []
    for resp_idx in responder_indices:
        neuron_dict = state.neurons[resp_idx]
        thought = llm_client.neuron_respond(
            neuron_dict['id'], 
            neuron_dict['seed'], 
            question, 
            asker_id,
            previous_responses=previous_responses
        )
        if thought:
            resp_id = neuron_dict['id']
            # Add to previous responses for next neuron
            previous_responses.append((resp_id, thought))
            # Write to memory
            append_memory("DIALOGUE", f"**{resp_id}:** {thought}")
            log(f"  {resp_id} responded")
    
    state.total_activations += 1
    save_state()

# ---------------------------------------------------------------------------
# Entropy-Based Decision Making
# ---------------------------------------------------------------------------

def should_create_neuron(q_values: list) -> bool:
    """
    Decide whether to create new neuron based on quantum entropy.
    
    Probability decreases as we approach MAX_NEURONS.
    Uses quantum values for the decision itself.
    """
    if len(state.neurons) >= MAX_NEURONS:
        return False
    
    if len(state.neurons) == 0:
        # No neurons yet — always create first one
        return True
    
    # Entropy-based probability
    # As neurons increase, creation becomes rarer
    current = len(state.neurons)
    remaining_capacity = (MAX_NEURONS - current) / MAX_NEURONS  # 1.0 -> 0.0
    
    # Use quantum value to decide
    q_decision = q_values[1] if len(q_values) > 1 else 128
    threshold = int(CREATION_THRESHOLD * (1 - remaining_capacity * 0.5))
    
    # Higher threshold = harder to create
    # When few neurons: threshold ~200, easy to pass
    # When many neurons: threshold ~240+, hard to pass
    return q_decision > threshold


def select_neuron_index(q_values: list) -> int:
    """Select which neuron to activate using quantum value."""
    if not state.neurons:
        return -1
    
    q_select = q_values[2] if len(q_values) > 2 else q_values[0]
    return q_select % len(state.neurons)

# ---------------------------------------------------------------------------
# Main Impulse Handler
# ---------------------------------------------------------------------------

async def process_impulse(q_values: list):
    """
    Process quantum impulse — the brain's heartbeat.
    
    q_values usage:
    - q[0]: dialogue vs creation decision (< ACTIVATION_THRESHOLD = dialogue)
    - q[1]: if creating, entropy for creation decision; if dialogue, num responders
    - q[2..4]: which neurons participate
    - q[5..7]: context for generation
    """
    state.total_impulses += 1
    trigger = q_values[0]
    
    log(f"Impulse #{state.total_impulses}: trigger={trigger}")
    
    # Need at least 2 neurons for dialogue
    if len(state.neurons) < 2:
        if should_create_neuron(q_values):
            await create_neuron()
        else:
            log("Need more neurons for dialogue, forcing creation")
            await create_neuron()
        return
    
    # Decision: dialogue or create new neuron?
    if trigger < ACTIVATION_THRESHOLD:
        # Dialogue turn
        process_dialogue_turn(q_values)
        
    elif should_create_neuron(q_values):
        # Create new neuron
        await create_neuron()
        
    else:
        # Fallback: dialogue
        process_dialogue_turn(q_values)

# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------

async def impulse_loop():
    """The living loop — listens to quantum vacuum."""
    global running
    
    log(f"Impulse loop starting (interval={IMPULSE_INTERVAL}s)")
    
    while running:
        try:
            # Fetch batch of quantum numbers
            q_bytes = await fetch_quantum_bits(QUANTUM_BATCH_SIZE)
            
            if q_bytes:
                q_values = list(q_bytes)
                await process_impulse(q_values)
            else:
                log("No quantum data received")
                
        except Exception as e:
            log(f"Impulse error: {e}")
        
        await asyncio.sleep(IMPULSE_INTERVAL)
    
    log("Impulse loop stopped")


async def main(brain_id: Optional[str] = None):
    """Main entry point."""
    global running, llm_client
    
    log("=" * 50)
    log("QUANTUM BRAIN STARTING")
    log("=" * 50)
    
    # Determine which brain to run
    if brain_id == "new":
        # Force create new brain
        await birth_brain()
    elif brain_id:
        # Load specific brain
        if not load_state(brain_id):
            log(f"Brain {brain_id} not found, creating new...")
            await birth_brain()
    else:
        # Try to find existing brain or create new
        existing = find_existing_brain()
        if existing:
            load_state(existing)
        else:
            await birth_brain()
    
    log(f"Brain: {state.brain_id}")
    log(f"Directory: {get_brain_dir(state.brain_id)}")
    log(f"Neurons: {len(state.neurons)}/{MAX_NEURONS}")
    log(f"LLM: {'disabled' if LLM_DISABLED else 'enabled'}")
    log(f"Connecting to stdio_bus at {BUS_HOST}:{BUS_PORT}")
    
    # Show current task
    task = read_task()
    if task:
        first_line = task.split('\n')[0] if task else ""
        log(f"Task: {first_line}")
    
    # Start living
    running = True
    
    try:
        await impulse_loop()
    except KeyboardInterrupt:
        log("Interrupted by user")
    except Exception as e:
        log(f"Error: {e}")
    finally:
        running = False
        if llm_client:
            llm_client.close()
        save_state()
        log("Brain stopped")


def parse_args():
    parser = argparse.ArgumentParser(description="Quantum Brain")
    parser.add_argument("--id", type=str, default=None,
                        help="Brain ID to run (use 'new' to create new brain)")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    asyncio.run(main(args.id))
