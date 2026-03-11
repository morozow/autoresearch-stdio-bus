#!/usr/bin/env python3
"""
Live chat client for stdio_bus. Single-file, Karpathy style.
Connects to stdio_bus kernel via TCP, speaks ACP protocol over NDJSON.

Usage:
    # New session
    uv run live_chat.py "Hello, what can you do?"
    
    # Resume session
    uv run live_chat.py --session <agent_session_id> "Continue from where we left off"
    
    # Start autoresearch
    uv run live_chat.py --autoresearch

Protocol: JSON-RPC 2.0 over NDJSON (TCP)
"""

import os
import sys
import json
import socket
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Callable
from datetime import datetime

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BUS_HOST = os.environ.get("BUS_HOST", "127.0.0.1")
BUS_PORT = int(os.environ.get("BUS_PORT", "9000"))
AGENT_ID = os.environ.get("AGENT_ID", "openai")
REQUEST_TIMEOUT = 300  # 5 minutes for long agent responses
CONNECT_TIMEOUT = 10

# ---------------------------------------------------------------------------
# Logging (stderr, keeps stdout clean for agent output)
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)

# ---------------------------------------------------------------------------
# NDJSON TCP Client
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
    
    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(CONNECT_TIMEOUT)
        self.sock.connect((self.host, self.port))
        self.sock.settimeout(None)  # blocking mode for reader
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
# Request Tracker (correlate request id -> response)
# ---------------------------------------------------------------------------

class RequestTracker:
    """Track pending requests, resolve by id."""
    
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
# ACP Client (stdio_bus protocol)
# ---------------------------------------------------------------------------

@dataclass
class SessionUpdate:
    kind: str  # agent_message_chunk, tool_call, tool_call_update, plan
    data: dict

class ACPClient:
    """ACP protocol client over NDJSON."""
    
    def __init__(self, ndjson: NDJSONClient, agent_id: str):
        self.ndjson = ndjson
        self.agent_id = agent_id
        self.tracker = RequestTracker()
        self.client_session_id = f"client-{int(datetime.now().timestamp())}"
        self._next_id = 1
        self._updates: list[SessionUpdate] = []
        self._on_chunk: Optional[Callable[[str], None]] = None
        
        # Wire up message handler
        ndjson.on_message = self._handle_message
    
    def _handle_message(self, msg: dict):
        # JSON-RPC response (has id)
        if "id" in msg and ("result" in msg or "error" in msg):
            self.tracker.resolve(msg)
            return
        
        # JSON-RPC notification (session/update)
        method = msg.get("method")
        if method == "session/update":
            params = msg.get("params", {})
            update = params.get("update", {})
            kind = update.get("sessionUpdate", "")
            
            self._updates.append(SessionUpdate(kind=kind, data=update))
            
            # Stream agent text chunks to callback
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
        return self._send_request("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "live-chat-py", "version": "1.0.0"},
            "agentId": self.agent_id,
        })
    
    def session_new(self) -> str:
        result = self._send_request("session/new", {
            "cwd": os.getcwd(),
            "mcpServers": [],
        })
        return result.get("sessionId", "")
    
    def session_prompt(self, session_id: str, text: str, on_chunk: Optional[Callable[[str], None]] = None) -> dict:
        self._updates.clear()
        self._on_chunk = on_chunk
        
        result = self._send_request("session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "role": "user", "text": text}],
        })
        
        self._on_chunk = None
        
        # Collect text from updates
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
# CLI Commands
# ---------------------------------------------------------------------------

def cmd_chat(message: str, session_id: Optional[str] = None):
    """Send a message, print response."""
    ndjson = NDJSONClient(BUS_HOST, BUS_PORT)
    
    try:
        ndjson.connect()
        log(f"Connected to stdio_bus at {BUS_HOST}:{BUS_PORT}")
        
        client = ACPClient(ndjson, AGENT_ID)
        
        init = client.initialize()
        agent_name = init.get("agentInfo", {}).get("name", "unknown")
        log(f"Agent: {agent_name}")
        log(f"CLIENT_SESSION_ID={client.client_session_id}")
        
        if session_id:
            log(f"AGENT_SESSION_ID={session_id} (resumed)")
        else:
            session_id = client.session_new()
            log(f"AGENT_SESSION_ID={session_id}")
        
        # Stream chunks to stdout
        result = client.session_prompt(session_id, message, on_chunk=lambda t: print(t, end="", flush=True))
        print()  # newline after streaming
        
        log(f"STOP={result['stopReason']} UPDATES={len(result['updates'])}")
        
    finally:
        ndjson.close()


def cmd_autoresearch():
    """Start autoresearch loop with program.md + program-swarm.md."""
    project_root = Path(__file__).parent
    program_md = project_root / "program.md"
    program_swarm_md = project_root / "program-swarm.md"
    
    if not program_md.exists():
        log(f"ERROR: {program_md} not found")
        sys.exit(1)
    if not program_swarm_md.exists():
        log(f"ERROR: {program_swarm_md} not found")
        sys.exit(1)
    
    program = program_md.read_text()
    program_swarm = program_swarm_md.read_text()
    
    prompt = f"""{program}

---

{program_swarm}

---

You are agent-0. Start the autoresearch experiment loop now. Begin by establishing the baseline."""
    
    log(f"Combined prompt: {len(prompt)} chars")
    
    ndjson = NDJSONClient(BUS_HOST, BUS_PORT)
    
    try:
        ndjson.connect()
        log(f"Connected to stdio_bus at {BUS_HOST}:{BUS_PORT}")
        
        client = ACPClient(ndjson, AGENT_ID)
        
        init = client.initialize()
        agent_name = init.get("agentInfo", {}).get("name", "unknown")
        log(f"Agent: {agent_name}")
        log(f"CLIENT_SESSION_ID={client.client_session_id}")
        
        session_id = client.session_new()
        log(f"AGENT_SESSION_ID={session_id}")
        
        log("")
        log("=" * 60)
        log("STARTING AUTORESEARCH")
        log("=" * 60)
        log("")
        
        result = client.session_prompt(session_id, prompt, on_chunk=lambda t: print(t, end="", flush=True))
        print()
        
        log("")
        log("=" * 60)
        log(f"STOP_REASON={result['stopReason']}")
        log(f"UPDATES={len(result['updates'])}")
        log("=" * 60)
        
    finally:
        ndjson.close()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    
    if not args:
        print(__doc__)
        sys.exit(0)
    
    if args[0] == "--autoresearch":
        cmd_autoresearch()
    elif args[0] == "--session" and len(args) >= 3:
        session_id = args[1]
        message = " ".join(args[2:])
        cmd_chat(message, session_id)
    else:
        message = " ".join(args)
        cmd_chat(message)


if __name__ == "__main__":
    main()
