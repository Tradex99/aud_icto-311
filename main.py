#!/usr/bin/env python3
"""
main.py - Root module runner.
Usage: python3 main.py                run the full pipeline, one script after another
       python3 main.py <script>       run only one script from /engine
       python3 main.py <script> <args>   run one script with extra arguments
Example: python3 main.py follower.js
         python3 main.py follower.js id=2     (follower booster, runs until stopped)
         python3 main.py repost.js
         python3 main.py tastemaker.js        (runs tastemaker standalone)
"""

import asyncio
import importlib
import sys
import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

STREAM_ENABLED = True  

STREAM_SHOW_LOGS = False

BOOST_ENABLED = True

BOOST_SHOW_LOGS = False

# Prefix added to every follower.js id=2 log line so it is easy to tell apart ("" to disable)
BOOST_LOG_PREFIX = "[boost] "

TASTEMAKER_ENABLED = True
TASTEMAKER_SHOW_LOGS = True

PIPELINE_SHOW_LOGS = False

PIPELINE = [
    ("upload_track.js", True),
    ("follower.js", True),
    ("favorite.js", True),
    ("repost.js", True),
    ("comment.js", True),
]

async def stream_reader(stream, is_stderr=False, silent=False, prefix=""):
    """Reads stdout/stderr from the subprocess line-by-line and prints immediately."""
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode(errors="replace").rstrip()

        # Read everything from the buffer to prevent the subprocess from hanging,
        # but skip printing if silent mode is enabled.
        if silent:
            continue

        if "bigint: Failed to load bindings" in text:
            continue
        if not text:
            continue

        if is_stderr:
            print(prefix + text, file=sys.stderr, flush=True)
        else:
            print(prefix + text, flush=True)

async def run_module(module_name: str, silent: bool = False, args=None, holder=None, prefix: str = "") -> int:
    args = args or []
    if not silent:
        print(f"{prefix}[*] Loading module: {module_name}" + (f" {' '.join(args)}" if args else ""), flush=True)

    if module_name.endswith(".js"):
        js_path = ROOT_DIR / "engine" / module_name
        if not js_path.exists():
            if not silent:
                print(f"[!] JS Module '{module_name}' not found in /engine folder.", flush=True)
            return 1

        env = {**os.environ, "NODE_NO_WARNINGS": "1"}

        proc = await asyncio.create_subprocess_exec(
            "node", str(js_path), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )
        if holder is not None:
            holder["proc"] = proc

        try:
            await asyncio.gather(
                stream_reader(proc.stdout, is_stderr=False, silent=silent, prefix=prefix),
                stream_reader(proc.stderr, is_stderr=True, silent=silent, prefix=prefix)
            )
            code = await proc.wait()
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except BaseException:
                    proc.kill()

        stopping = bool(holder and holder.get("stopping"))
        if code != 0 and not silent and not stopping:
            print(f"{prefix}[!] {module_name} exited with code {code}", flush=True)
        return code

    try:
        mod = importlib.import_module(f"engine.{module_name}")
    except ModuleNotFoundError:
        if not silent:
            print(f"[!] Python Module '{module_name}' not found in /engine folder.", flush=True)
        return 1

    if hasattr(mod, "run"):
        if not silent:
            print(f"[*] Executing {module_name}...", flush=True)
        await mod.run()
        return 0

    if not silent:
        print(f"[!] Module '{module_name}' does not have a 'run()' function.", flush=True)
    return 1

async def stop_background(task, holder, label: str, show: bool):
    """Stops a background module (SIGTERM, then SIGKILL after 10s) and waits for it to exit."""
    proc = holder.get("proc")
    if proc is not None and proc.returncode is None:
        holder["stopping"] = True
        if show:
            print(f"[*] Stopping {label}...", flush=True)
        proc.terminate()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except asyncio.TimeoutError:
            proc.kill()
    try:
        await task
    except Exception:
        pass

async def stop_when_done(stream_task, boost_task, holder, show: bool):
    """Stops the follower booster the moment stream.js completes (success or failure)."""
    try:
        await stream_task
    except Exception:
        pass
    await stop_background(boost_task, holder, "follower.js id=2", show)

def start_boost(stream_task, holder):
    """Starts follower.js id=2 in the background (unless stream.js has already completed)."""
    if stream_task is not None and stream_task.done():
        if BOOST_SHOW_LOGS:
            print("[*] stream.js already completed; follower.js id=2 not started.", flush=True)
        return None, None

    if BOOST_SHOW_LOGS:
        print(f"[*] Starting follower.js id=2 in the background...", flush=True)

    task = asyncio.create_task(
        run_module("follower.js", silent=not BOOST_SHOW_LOGS, args=["id=2"],
                   holder=holder, prefix=BOOST_LOG_PREFIX)
    )

    # When stream.js completes, main.py exits follower.js id=2 right away
    stopper = None
    if stream_task is not None:
        stopper = asyncio.create_task(stop_when_done(stream_task, task, holder, BOOST_SHOW_LOGS))
    return task, stopper

async def run_pipeline():
    failed = []
    stream_task = None
    boost_task = None
    boost_stopper = None
    boost_holder = {}
    boost_started = False

    tastemaker_task = None
    tastemaker_holder = {}

    # Determine if the pipeline should be silent based on the toggle
    pipeline_silent = not PIPELINE_SHOW_LOGS

    follower_step_enabled = any(n == "follower.js" and en for n, en in PIPELINE)

    for name, enabled in PIPELINE:
        if not enabled:
            if not pipeline_silent:
                print(f"[*] Skipping {name} (disabled)", flush=True)
            continue

        # At upload_track.js: launch stream.js and tastemaker.js together in the background
        if name == "upload_track.js":
            if STREAM_ENABLED:
                if not pipeline_silent or STREAM_SHOW_LOGS:
                    print(f"[*] Starting stream.js in the background...", flush=True)
                    if not STREAM_SHOW_LOGS:
                        print(f"[*] (stream.js logs are muted)", flush=True)

                # Create the background task without blocking the loop
                stream_task = asyncio.create_task(
                    run_module("stream.js", silent=not STREAM_SHOW_LOGS)
                )

            if TASTEMAKER_ENABLED:
                if not pipeline_silent or TASTEMAKER_SHOW_LOGS:
                    print(f"[*] Starting tastemaker.js in the background...", flush=True)
                    if not TASTEMAKER_SHOW_LOGS:
                        print(f"[*] (tastemaker.js logs are muted)", flush=True)

                tastemaker_task = asyncio.create_task(
                    run_module("tastemaker.js", silent=not TASTEMAKER_SHOW_LOGS,
                               holder=tastemaker_holder)
                )

        # With the normal follower.js step disabled there is nothing to conflict with,
        # so the booster can start right away
        if BOOST_ENABLED and not boost_started and not follower_step_enabled:
            boost_started = True
            boost_task, boost_stopper = start_boost(stream_task, boost_holder)

        # Run the main pipeline module (blocks until finished)
        code = await run_module(name, silent=pipeline_silent)
        if code != 0:
            failed.append(name)

        # Normal follower.js has completed: now it is safe to start follower.js id=2
        if name == "follower.js" and BOOST_ENABLED and not boost_started:
            boost_started = True
            boost_task, boost_stopper = start_boost(stream_task, boost_holder)

    # Wait for the background stream.js to finish before exiting entirely
    if stream_task:
        # Only print this status message if at least one logging channel is active
        if not pipeline_silent or STREAM_SHOW_LOGS:
            print(f"\n[*] Main pipeline finished. Waiting for background stream.js to complete...", flush=True)

        try:
            stream_code = await stream_task
            if stream_code != 0:
                if not pipeline_silent or STREAM_SHOW_LOGS:
                    print(f"[!] stream.js exited with code {stream_code}", flush=True)
            else:
                if not pipeline_silent or STREAM_SHOW_LOGS:
                    print(f"[+] stream.js completed successfully.", flush=True)
        except Exception as e:
            if not pipeline_silent or STREAM_SHOW_LOGS:
                print(f"[!] Error in background stream.js: {e}", flush=True)

    # stream.js is done (or was never started): stop all background tasks.
    # Tastemaker and the follower booster both run until stream.js finishes,
    # so we stop them in parallel here for a fast shutdown.
    background_stops = []
    if tastemaker_task:
        background_stops.append(
            stop_background(tastemaker_task, tastemaker_holder, "tastemaker.js", TASTEMAKER_SHOW_LOGS)
        )
    if boost_task:
        if boost_stopper:
            background_stops.append(boost_stopper)
        else:
            background_stops.append(
                stop_background(boost_task, boost_holder, "follower.js id=2", BOOST_SHOW_LOGS)
            )

    if background_stops:
        await asyncio.gather(*background_stops)

    if failed and not pipeline_silent:
        print(f"[!] Pipeline finished with errors in: {', '.join(failed)}", flush=True)

def resolve_name(name: str) -> str:
    name = Path(name).name
    if "." not in name and (ROOT_DIR / "engine" / f"{name}.js").exists():
        return f"{name}.js"
    return name

if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if not args:
            asyncio.run(run_pipeline())
        else:
            asyncio.run(run_module(resolve_name(args[0]), args=args[1:]))
    except KeyboardInterrupt:
        print("\n[*] Stopped.", flush=True)