#!/usr/bin/env python3
"""
Quantum Brain — A living mind built from quantum impulses.

Single-file implementation. Standalone process.
Connects to stdio_bus via TCP for LLM access.
Neurons activate and spawn based on quantum entropy.
Self-limiting growth via entropy distribution.
Neurons speak through LLM when activated.

Usage:
    uv run python -m qei.brain

NOT a stdio_bus worker — runs independently, connects via TCP.
"""

import os
import sys
import json
import socket
import asyncio
import threading
import re
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
STATE_FILE = ".qei-brain-state.json"
THOUGHTS_FILE = ".qei-thoughts.jsonl"
MEMORY_DIR = Path("qei/memory")
WORK_DIR = Path(".")

# LLM connection (stdio_bus ACP)
BUS_HOST = os.environ.get("BUS_HOST", "127.0.0.1")
BUS_PORT = int(os.environ.get("BUS_PORT", "9000"))
AGENT_ID = os.environ.get("AGENT_ID", "openai")
LLM_DISABLED = os.environ.get("LLM_DISABLED", "false").lower() == "true"  # disabled only when explicitly set

# Inquiry directions — quantum-selected questions
# DEPRECATED: Questions are now generated dynamically by neurons
INQUIRY_SEEDS = [
    "границы", "противоречия", "связи", "паттерны",
    "невидимое", "обратное", "источник", "пустота",
]

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
    path = WORK_DIR / THOUGHTS_FILE
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

def get_memory_path() -> Path:
    """Get path to brain's memory file."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    return MEMORY_DIR / f"{state.brain_id}.md"


def init_memory():
    """Initialize brain memory file if it doesn't exist."""
    path = get_memory_path()
    if not path.exists():
        header = f"""# {state.brain_id} Memory

Born: {state.birth_time}
Seed: {state.brain_seed[:16]}...

This is the shared memory of brain {state.brain_id}.
All neurons can read and write here.
Nothing is ever deleted.

---

## Birth

I was born from quantum vacuum fluctuations.
My seed is unique in the universe.

"""
        with open(path, "w") as f:
            f.write(header)
        log(f"Memory initialized: {path}")


def read_memory() -> str:
    """Read entire brain memory."""
    path = get_memory_path()
    if path.exists():
        return path.read_text()
    return ""


def append_memory(neuron_id: str, content: str):
    """Append to brain memory. Never delete, only append."""
    path = get_memory_path()
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
    # Return last max_chars
    return "...\n" + memory[-max_chars:]

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
    """LLM client via TCP to stdio_bus."""
    
    def __init__(self):
        self.ndjson: Optional[NDJSONClient] = None
        self.client_session_id: str = f"brain-{int(datetime.now().timestamp())}"  # For routing
        self.agent_session_id: Optional[str] = None  # From agent
        self._next_id = 1
        self._pending: dict = {}  # id -> threading.Event
        self._results: dict = {}  # id -> result
        self._chunks: dict = {}   # id -> list of text chunks
        self._lock = threading.Lock()
        self._connected = False
    
    def connect(self) -> bool:
        if self._connected:
            return True
        
        self.ndjson = NDJSONClient(BUS_HOST, BUS_PORT)
        if not self.ndjson.connect():
            return False
        
        self.ndjson.on_message = self._handle_message
        
        # Initialize
        try:
            self._send_request("initialize", {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "qei-brain", "version": "1.0.0"},
                "agentId": AGENT_ID,
            })
            
            # Create session
            result = self._send_request("session/new", {
                "cwd": str(WORK_DIR.absolute()),
                "mcpServers": [],
            })
            
            self.agent_session_id = result.get("sessionId", "")
            self._connected = True
            log(f"LLM connected, agent_session={self.agent_session_id[:16]}...")
            return True
            
        except Exception as e:
            log(f"LLM init failed: {e}")
            self.close()
            return False
    
    def _handle_message(self, msg: dict):
        # Handle response
        msg_id = msg.get("id")
        if msg_id is not None:
            with self._lock:
                event = self._pending.get(msg_id)
                if event:
                    self._results[msg_id] = msg
                    event.set()
            return
        
        # Handle session/update (streaming chunks)
        method = msg.get("method")
        if method == "session/update":
            update = msg.get("params", {}).get("update", {})
            if update.get("sessionUpdate") == "agent_message_chunk":
                text = update.get("content", {}).get("text", "")
                # Add to most recent pending request
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
            "sessionId": self.client_session_id,  # For routing
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
    
    def think(self, neuron_id: str, neuron_seed: str, activation_count: int, 
              question: str, context: list) -> Optional[str]:
        """Ask LLM to think as neuron."""
        if not self._connected:
            if not self.connect():
                return None
        
        memory_context = get_memory_context(1500)
        
        prompt = f"""You are Neuron {neuron_id}, part of quantum brain {state.brain_id}.
Your quantum seed: {neuron_seed[:16]}...
You have been activated {activation_count} times.
Quantum context for this activation: {context}

=== BRAIN MEMORY ===
{memory_context}
=== END MEMORY ===

A question arose from quantum vacuum:
"{question}"

Respond briefly (1-3 sentences) with your thought. Be curious, exploratory, philosophical.
If you want to remember something for future activations, end with:
[REMEMBER: your note here]

Do not explain what you are. Just think."""

        req_id = self._next_id  # This will be the id used by _send_request
        
        try:
            log(f"Thought request sent (id={req_id})")
            self._send_request("session/prompt", {
                "sessionId": self.agent_session_id,  # Agent's session
                "prompt": [{"type": "text", "role": "user", "text": prompt}],
            }, timeout=120)
            
            # Collect chunks (req_id was used by _send_request)
            with self._lock:
                chunks = self._chunks.pop(req_id, [])
            
            return "".join(chunks) if chunks else None
            
        except Exception as e:
            log(f"LLM think error: {e}")
            return None
    
    def inquire(self, neuron_id: str, neuron_seed: str, activation_count: int,
                context: list) -> Optional[str]:
        """Generate a question from quantum context and memory."""
        if not self._connected:
            if not self.connect():
                return None
        
        memory_context = get_memory_context(1000)
        
        # Use quantum context to seed the inquiry direction
        seed_idx = context[0] % len(INQUIRY_SEEDS) if context else 0
        seed_word = INQUIRY_SEEDS[seed_idx]
        
        prompt = f"""You are Neuron {neuron_id}, quantum brain {state.brain_id}.
Seed: {neuron_seed[:16]}... Activation #{activation_count}
Quantum entropy: {context}
Inquiry seed: "{seed_word}"

=== RECENT MEMORY ===
{memory_context}
=== END ===

From this quantum moment and memory, what question arises?
Generate ONE question (1 sentence). Be curious, unexpected, philosophical.
The question should emerge from the intersection of quantum randomness and accumulated knowledge.
Output ONLY the question, nothing else."""

        req_id = self._next_id
        
        try:
            self._send_request("session/prompt", {
                "sessionId": self.agent_session_id,
                "prompt": [{"type": "text", "role": "user", "text": prompt}],
            }, timeout=60)
            
            with self._lock:
                chunks = self._chunks.pop(req_id, [])
            
            question = "".join(chunks).strip() if chunks else None
            # Clean up: remove quotes if present
            if question and question.startswith('"') and question.endswith('"'):
                question = question[1:-1]
            return question
            
        except Exception as e:
            log(f"LLM inquire error: {e}")
            return None
    
    def close(self):
        self._connected = False
        if self.ndjson:
            self.ndjson.close()
            self.ndjson = None


llm_client: Optional[LLMClient] = None

# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_state():
    path = WORK_DIR / STATE_FILE
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(asdict(state), f, indent=2)
    tmp.rename(path)

def load_state():
    global state
    path = WORK_DIR / STATE_FILE
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
    
    save_state()
    init_memory()
    log(f"Brain born: {brain_id}")
    
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


def activate_neuron(index: int, quantum_context: list) -> Neuron:
    """Activate existing neuron by index."""
    global llm_client
    
    neuron_dict = state.neurons[index]
    neuron = Neuron(**neuron_dict)
    neuron.activate()
    
    log(f"Neuron activated: {neuron.id} (count: {neuron.activation_count})")
    
    question = None
    thought = None
    
    if not LLM_DISABLED:
        if llm_client is None:
            llm_client = LLMClient()
        
        # Step 1: Generate question from quantum context + memory
        question = llm_client.inquire(
            neuron.id, neuron.seed, neuron.activation_count,
            quantum_context
        )
        
        if question:
            log(f"Question: {question}")
            
            # Step 2: Think about the question
            thought = llm_client.think(
                neuron.id, neuron.seed, neuron.activation_count,
                question, quantum_context
            )
            
            if thought:
                neuron.add_thought(thought)
                save_thought(neuron.id, question, thought)
                log(f"Thought: {thought[:100]}...")
                
                # Append to memory
                if "[REMEMBER:" in thought:
                    match = re.search(r'\[REMEMBER:\s*(.+?)\]', thought, re.DOTALL)
                    if match:
                        remember_content = match.group(1).strip()
                        append_memory(neuron.id, f"**Question:** {question}\n\n**Thought:** {thought}\n\n**Remember:** {remember_content}")
                else:
                    append_memory(neuron.id, f"**Question:** {question}\n\n**Thought:** {thought}")
    
    # Update in state
    state.neurons[index] = asdict(neuron)
    state.total_activations += 1
    save_state()
    
    emit("neuron.activation", {
        "brainId": state.brain_id,
        "neuronId": neuron.id,
        "activationCount": neuron.activation_count,
        "quantumContext": quantum_context,
        "question": question,
        "thought": thought,
    })
    
    return neuron

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
    Process quantum impulse — the core living loop.
    
    q_values[0] = trigger (activate vs create decision)
    q_values[1] = creation entropy
    q_values[2] = neuron selection
    q_values[3-7] = context for neuron action
    """
    state.total_impulses += 1
    trigger = q_values[0]
    
    log(f"Impulse #{state.total_impulses}: trigger={trigger}")
    
    # Decision: activate existing or create new?
    if trigger < ACTIVATION_THRESHOLD and state.neurons:
        # Activate existing neuron
        index = select_neuron_index(q_values)
        context = q_values[3:] if len(q_values) > 3 else []
        activate_neuron(index, context)
        
    elif should_create_neuron(q_values):
        # Create new neuron
        await create_neuron()
        
    elif state.neurons:
        # Fallback: activate random existing
        index = select_neuron_index(q_values)
        context = q_values[3:] if len(q_values) > 3 else []
        activate_neuron(index, context)
        
    else:
        # No neurons and can't create — should not happen
        log("WARNING: No neurons and creation blocked")
        await create_neuron()  # Force create first neuron

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


async def main():
    """Main entry point."""
    global running, llm_client
    
    log("=" * 50)
    log("QUANTUM BRAIN STARTING")
    log("=" * 50)
    
    # Load or create brain
    if not load_state():
        await birth_brain()
    
    log(f"Brain: {state.brain_id}")
    log(f"Neurons: {len(state.neurons)}/{MAX_NEURONS}")
    log(f"LLM: {'disabled' if LLM_DISABLED else 'enabled'}")
    log(f"Connecting to stdio_bus at {BUS_HOST}:{BUS_PORT}")
    
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


if __name__ == "__main__":
    asyncio.run(main())
