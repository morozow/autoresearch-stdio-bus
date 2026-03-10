#!/usr/bin/env python3
"""
Mock train.py for E2E testing without GPU.

Emulates the behavior of the real train.py:
- Sleeps for a configurable duration
- Outputs val_bpb and peak_vram_mb to stdout
- Supports different results via environment variables

Environment Variables:
  MOCK_VAL_BPB      - val_bpb to output (default: 0.995)
  MOCK_MEMORY_GB    - peak memory in GB (default: 44.0)
  MOCK_SLEEP_SEC    - sleep duration in seconds (default: 1)
  MOCK_STATUS       - 'success', 'crash', or 'oom' (default: success)
  MOCK_DESCRIPTION  - experiment description (default: "mock experiment")

Usage:
  python mock-train.py
  MOCK_VAL_BPB=0.990 MOCK_SLEEP_SEC=2 python mock-train.py
"""

import os
import sys
import time

def main():
    # Read configuration from environment
    val_bpb = float(os.environ.get('MOCK_VAL_BPB', '0.995'))
    memory_gb = float(os.environ.get('MOCK_MEMORY_GB', '44.0'))
    sleep_sec = float(os.environ.get('MOCK_SLEEP_SEC', '1'))
    status = os.environ.get('MOCK_STATUS', 'success')
    description = os.environ.get('MOCK_DESCRIPTION', 'mock experiment')
    
    # Simulate training time
    print(f"[mock-train] Starting mock training...", file=sys.stderr)
    print(f"[mock-train] Config: val_bpb={val_bpb}, memory_gb={memory_gb}, sleep={sleep_sec}s, status={status}", file=sys.stderr)
    
    time.sleep(sleep_sec)
    
    # Handle different statuses
    if status == 'crash':
        print(f"[mock-train] Simulating crash!", file=sys.stderr)
        raise RuntimeError("Simulated crash for testing")
    
    if status == 'oom':
        print(f"[mock-train] Simulating OOM!", file=sys.stderr)
        raise MemoryError("CUDA out of memory. Tried to allocate 48.00 GiB")
    
    if status == 'timeout':
        print(f"[mock-train] Simulating timeout (sleeping forever)...", file=sys.stderr)
        while True:
            time.sleep(60)
    
    # Output results in the expected format
    # The real train.py outputs these values which are parsed by the worker
    print(f"val_bpb: {val_bpb:.6f}")
    print(f"peak_vram_mb: {memory_gb * 1024:.1f}")
    print(f"description: {description}")
    
    print(f"[mock-train] Training complete!", file=sys.stderr)
    return 0

if __name__ == '__main__':
    sys.exit(main())
