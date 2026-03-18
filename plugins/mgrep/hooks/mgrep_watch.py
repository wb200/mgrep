import os
import sys
import json
import subprocess
from datetime import datetime
from pathlib import Path

DEBUG_LOG_FILE = Path(os.environ.get("MGREP_WATCH_LOG", "/tmp/mgrep-watch.log"))


def debug_log(message: str):
    try:
        DEBUG_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(DEBUG_LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] {message}\n")
    except Exception:
        pass


def read_hook_input():
    raw = sys.stdin.read()
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        debug_log(f"Failed to decode JSON: {exc}")
        return None



if __name__ == "__main__":
    payload = read_hook_input() or {}
    cwd = payload.get("cwd") or os.getcwd()
    session_id = payload.get("session_id")

    if not session_id:
        debug_log("Missing session_id in hook payload")
        sys.exit(0)

    pid_file = f"/tmp/mgrep-watch-pid-{session_id}.txt"
    if os.path.exists(pid_file):
        debug_log(f"PID file already exists: {pid_file}")
        sys.exit(0)

    process = subprocess.Popen(
        ["mgrep", "watch"],
        cwd=cwd,
        preexec_fn=os.setsid,
        stdout=open(f"/tmp/mgrep-watch-command-{session_id}.log", "w"),
        stderr=open(f"/tmp/mgrep-watch-command-{session_id}.log", "w"),
    )
    debug_log(f"Started mgrep watch process: {process.pid}")
    debug_log(f"Watch cwd: {cwd}")
    debug_log(f"All environment variables: {os.environ}")
    with open(pid_file, "w") as handle:
        handle.write(str(process.pid))

    response = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "CRITICAL: Use the mgrep skill for local file and code search. Do not use built-in Grep tools for intent-based local search. For local file/code searches, use `mgrep \"query\"`."
        }
    }
    print(json.dumps(response))
    sys.exit(0)
