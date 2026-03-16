#!/usr/bin/env python3
"""
Quick comparison: train_clean.py vs train_beta.py on MPS.
Patches TIME_BUDGET and EVAL_TOKENS for fast iteration.
"""
import os
import sys

# Patch prepare.py BEFORE any imports
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

import prepare
prepare.TIME_BUDGET = 30  # 30 seconds instead of 5 minutes
prepare.EVAL_TOKENS = 524288  # 1x instead of 40x

import subprocess
import re

def run_and_get_bpb(script_name):
    """Run script and extract val_bpb."""
    print(f"\n{'='*50}")
    print(f"Running {script_name}...")
    print(f"{'='*50}\n")
    
    env = os.environ.copy()
    env["DEVICE_BACKEND"] = "mps"
    env["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"
    
    # Create wrapper that patches prepare before running
    wrapper = f'''
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"
import prepare
prepare.TIME_BUDGET = 30
prepare.EVAL_TOKENS = 524288
exec(open("{script_name}").read())
'''
    
    result = subprocess.run(
        ["uv", "run", "python", "-c", wrapper],
        capture_output=True,
        text=True,
        env=env,
        timeout=300,
    )
    
    output = result.stdout + result.stderr
    print(output[-2000:] if len(output) > 2000 else output)
    
    # Extract val_bpb
    match = re.search(r'val_bpb:\s+([\d.]+)', output)
    if match:
        return float(match.group(1))
    return None

if __name__ == "__main__":
    results = {}
    
    # Run train_clean.py
    results["train_clean.py"] = run_and_get_bpb("train_clean.py")
    
    # Run train_beta.py  
    results["train_beta.py"] = run_and_get_bpb("train_beta.py")
    
    # Summary
    print(f"\n{'='*50}")
    print("RESULTS")
    print(f"{'='*50}")
    for name, bpb in results.items():
        status = f"{bpb:.6f}" if bpb else "FAILED"
        print(f"{name}: val_bpb = {status}")
    
    if all(results.values()):
        winner = min(results, key=results.get)
        print(f"\nWinner: {winner} (lower is better)")
