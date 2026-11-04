#!/usr/bin/env python3
"""
main.py - Root module runner.
Usage: python3 main.py <module_name>
Example: python3 main.py balance_checker
"""

import asyncio
import importlib
import sys
from pathlib import Path

# Add the project root to sys.path so modules can import rpc, etc.
ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

async def run_module(module_name: str):
    print(f"[*] Loading module: {module_name}")
    try:
        # Dynamically import module.module_name
        mod = importlib.import_module(f"module.{module_name}")
    except ModuleNotFoundError:
        print(f"[!] Module '{module_name}' not found in /module folder.")
        return

    if hasattr(mod, "run"):
        print(f"[*] Executing {module_name}...")
        await mod.run()
    else:
        print(f"[!] Module '{module_name}' does not have a 'run()' function.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 main.py <module_name>")
        sys.exit(1)
    
    module_name = sys.argv[1]
    asyncio.run(run_module(module_name))
