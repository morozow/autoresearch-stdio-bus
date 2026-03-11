#!/usr/bin/env python3
"""
QEI Worker — Quantum Epistemic Impulse source for stdio_bus.

This is the LIVING component. It doesn't wait for requests.
It listens to quantum vacuum and INITIATES actions.

Usage:
    stdio_bus config: {"command": "uv", "args": ["run", "qei/worker.py"]}

Protocol: JSON-RPC 2.0 over NDJSON
"""

import sys
import json
import asyncio
from datetime import datetime
from typing import Optional

from .impulse import ImpulseSource, Impulse
from .inquiry import inquiry_from_impulse
from .qrng_client import fetch_quantum_bits


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

IMPULSE_INTERVAL = 10.0  # seconds between quantum measurements
AUTO_ACT_THRESHOLD = 0.5  # probability threshold for spontaneous action


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

running = False
impulse_source: Optional[ImpulseSource] = None
impulse_count = 0
action_count = 0


# ---------------------------------------------------------------------------
# Logging (stderr, keeps stdout clean for JSON-RPC)
# ---------------------------------------------------------------------------

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[QEI {ts}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# JSON-RPC Output (notifications to stdio_bus)
# ---------------------------------------------------------------------------

def emit_notification(method: str, params: dict):
    """Send JSON-RPC notification (no id = no response expected)."""
    msg = {"jsonrpc": "2.0", "method": method, "params": params}
    print(json.dumps(msg), flush=True)


def emit_impulse(impulse: Impulse, inquiry=None):
    """Emit impulse event to stdio_bus."""
    global impulse_count
    impulse_count += 1
    
    params = {
        "timestamp": impulse.timestamp.isoformat(),
        "quantumValue": impulse.quantum_value,
        "arose": impulse.arose,
        "impulseNumber": impulse_count,
    }
    
    if inquiry:
        params["inquiry"] = {
            "direction": inquiry.direction,
            "contextSeed": inquiry.context_seed,
            "question": inquiry.question,
        }
    
    emit_notification("qei.impulse", params)


def emit_action(action_type: str, details: dict):
    """Emit spontaneous action to stdio_bus."""
    global action_count
    action_count += 1
    
    emit_notification("qei.action", {
        "timestamp": datetime.now().isoformat(),
        "actionType": action_type,
        "actionNumber": action_count,
        **details,
    })


# ---------------------------------------------------------------------------
# Impulse Handler — the LIVING part
# ---------------------------------------------------------------------------

async def on_impulse(impulse: Impulse):
    """
    Handle quantum impulse.
    
    This is where the system LIVES.
    Impulse arose → form inquiry → decide to act → emit action.
    """
    log(f"Impulse arose: q={impulse.quantum_value}")
    
    # Form inquiry from impulse
    inquiry = await inquiry_from_impulse(impulse)
    log(f"Inquiry: {inquiry.direction}")
    
    # Emit to stdio_bus — other workers can listen
    emit_impulse(impulse, inquiry)
    
    # Decide whether to take spontaneous action
    # Use quantum value to decide (true randomness)
    should_act = (impulse.quantum_value % 100) < (AUTO_ACT_THRESHOLD * 100)
    
    if should_act:
        log("*** SPONTANEOUS ACTION ***")
        
        # What action? Also quantum-decided
        action_bits = await fetch_quantum_bits(1)
        action_type = action_bits[0] % 3 if action_bits else 0
        
        if action_type == 0:
            # Request experiment from swarm
            emit_action("request_experiment", {
                "inquiry": inquiry.question,
                "reason": "Quantum impulse initiated research",
            })
        elif action_type == 1:
            # Emit research direction
            emit_action("research_direction", {
                "direction": inquiry.direction,
                "seed": inquiry.context_seed,
            })
        else:
            # Just observe (action is to not act externally)
            emit_action("observe", {
                "note": "Impulse noted, no external action taken",
            })


# ---------------------------------------------------------------------------
# JSON-RPC Handlers (for external queries)
# ---------------------------------------------------------------------------

def handle_qei_status(params: dict) -> dict:
    """Return QEI worker status."""
    return {
        "running": running,
        "impulseCount": impulse_count,
        "actionCount": action_count,
        "impulseInterval": IMPULSE_INTERVAL,
        "autoActThreshold": AUTO_ACT_THRESHOLD,
    }


def handle_qei_start(params: dict) -> dict:
    """Start listening to quantum vacuum."""
    global running
    if not running:
        running = True
        # Start impulse loop in background
        asyncio.create_task(impulse_loop())
    return {"started": True}


def handle_qei_stop(params: dict) -> dict:
    """Stop listening."""
    global running
    running = False
    if impulse_source:
        impulse_source.stop()
    return {"stopped": True}


METHODS = {
    "qei.status": handle_qei_status,
    "qei.start": handle_qei_start,
    "qei.stop": handle_qei_stop,
}


# ---------------------------------------------------------------------------
# JSON-RPC Protocol
# ---------------------------------------------------------------------------

def make_response(id, result):
    return {"jsonrpc": "2.0", "id": id, "result": result}


def make_error(id, code, message):
    return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}


def handle_message(msg: dict) -> Optional[dict]:
    if msg.get("jsonrpc") != "2.0":
        return make_error(msg.get("id"), -32600, "Invalid Request")
    
    method = msg.get("method")
    params = msg.get("params", {})
    msg_id = msg.get("id")
    
    if method not in METHODS:
        if msg_id is not None:
            return make_error(msg_id, -32601, f"Method not found: {method}")
        return None
    
    try:
        result = METHODS[method](params)
        if msg_id is not None:
            return make_response(msg_id, result)
        return None
    except Exception as e:
        log(f"Error: {e}")
        if msg_id is not None:
            return make_error(msg_id, -32603, str(e))
        return None


# ---------------------------------------------------------------------------
# Main Loops
# ---------------------------------------------------------------------------

async def impulse_loop():
    """
    The living loop.
    
    Continuously listens to quantum vacuum.
    When impulse arises — acts.
    """
    global impulse_source, running
    
    impulse_source = ImpulseSource()
    impulse_source.on_impulse(on_impulse)
    
    log(f"Starting impulse loop (interval={IMPULSE_INTERVAL}s)")
    
    while running:
        impulse = await impulse_source.measure_once()
        
        if impulse.arose:
            await on_impulse(impulse)
        
        await asyncio.sleep(IMPULSE_INTERVAL)
    
    log("Impulse loop stopped")


async def stdin_loop():
    """Read JSON-RPC from stdin."""
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    
    while True:
        line = await reader.readline()
        if not line:
            break
        
        line = line.decode().strip()
        if not line:
            continue
        
        try:
            msg = json.loads(line)
            response = handle_message(msg)
            if response:
                print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            response = make_error(None, -32700, f"Parse error: {e}")
            print(json.dumps(response), flush=True)


async def main():
    """Main entry point."""
    global running
    
    log("QEI Worker starting")
    log("Quantum Epistemic Impulse — the living source")
    
    # Auto-start impulse loop
    running = True
    impulse_task = asyncio.create_task(impulse_loop())
    
    # Also listen for JSON-RPC on stdin
    try:
        await stdin_loop()
    except Exception as e:
        log(f"stdin loop ended: {e}")
    
    # Cleanup
    running = False
    impulse_task.cancel()
    
    log("QEI Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
