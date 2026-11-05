#!/usr/bin/env python3
"""
main.py - Root module runner.
Usage: python3 main.py <module_name>
Example: python3 main.py balance_checker.py
         python3 main.py balance_checker.js
         python3 main.py com_profile.js
"""

import asyncio
import importlib
import sys
import os
from pathlib import Path

# Add the project root to sys.path so modules can import rpc, etc.
ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

async def stream_reader(stream, is_stderr=False):
    """Reads stdout/stderr from the subprocess line-by-line and prints immediately."""
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode(errors="replace").rstrip()
        
        # Filter the bigint warning that Node.js sometimes outputs
        if "bigint: Failed to load bindings" in text:
            continue
        if not text:
            continue

        if is_stderr:
            print(text, file=sys.stderr, flush=True)
        else:
            print(text, flush=True)

async def run_module(module_name: str):
    print(f"[*] Loading module: {module_name}")
    
    # 1. Check if it's a JavaScript module
    if module_name.endswith(".js"):
        js_path = ROOT_DIR / "module" / module_name
        if not js_path.exists():
            print(f"[!] JS Module '{module_name}' not found in /module folder.")
            return
        
        # Suppress Node.js warnings
        env = {**os.environ, "NODE_NO_WARNINGS": "1"}
        
        proc = await asyncio.create_subprocess_exec(
            "node", str(js_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )
        
        # Stream output in real-time to prevent buffering delays
        await asyncio.gather(
            stream_reader(proc.stdout, is_stderr=False),
            stream_reader(proc.stderr, is_stderr=True)
        )
        
        await proc.wait()
        return

    # 2. Otherwise, treat as Python module
    try:
        mod = importlib.import_module(f"module.{module_name}")
    except ModuleNotFoundError:
        print(f"[!] Python Module '{module_name}' not found in /module folder.")
        return

    if hasattr(mod, "run"):
        print(f"[*] Executing {module_name}...")
        await mod.run()
    else:
        print(f"[!] Module '{module_name}' does not have a 'run()' function.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 main.py <module_name>")
        print("Example: python3 main.py balance_checker")
        print("         python3 main.py balance_checker.js")
        print("         python3 main.py com_profile.js")
        sys.exit(1)
    
    module_name = sys.argv[1]
    asyncio.run(run_module(module_name))