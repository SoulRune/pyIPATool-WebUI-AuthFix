#!/usr/bin/env python3
"""Small wrapper around app.py for running pyIPATool WebUI as a background
server and stopping it again - cross-platform (POSIX and Windows).

Default behavior (POSIX):
    python serverctl.py
  is equivalent to:
    python app.py --daemon --pid-file ipatool-webui.pid --log-file ipatool-webui.log

Add --legacy and/or --debug as needed; they're passed straight through to
app.py. Stop the server with --kill-server (reads the PID from --pid-file,
same one used to start it).

Why this isn't just "python app.py --daemon" everywhere: app.py's --daemon
flag does a Unix double-fork (os.fork() + os.setsid()), which doesn't exist
on Windows at all. On POSIX this script simply invokes app.py --daemon and
lets it detach itself, since that's already tested and working. On Windows
there's no fork-based daemonizing available, so this script instead launches
app.py as a normal (non---daemon) process with CREATE_NEW_PROCESS_GROUP |
DETACHED_PROCESS, redirects its output to the log file itself, and writes
the PID file itself.

Intended usage: activate your venv, then run this script (or app.py
directly) from inside it - same as you'd already been doing.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
APP_PY = SCRIPT_DIR / "app.py"
DEFAULT_PID_FILE = SCRIPT_DIR / "ipatool-webui.pid"
DEFAULT_LOG_FILE = SCRIPT_DIR / "ipatool-webui.log"

IS_WINDOWS = os.name == "nt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start or stop pyIPATool WebUI as a background server."
    )
    parser.add_argument("--legacy", action="store_true", help="Passed through to app.py")
    parser.add_argument("--debug", action="store_true", help="Passed through to app.py")
    parser.add_argument("--port", type=int, default=None, help="Passed through to app.py")
    parser.add_argument("--host", default=None, help="Passed through to app.py")
    parser.add_argument(
        "--pid-file",
        default=str(DEFAULT_PID_FILE),
        help=f"PID file location (default: {DEFAULT_PID_FILE})",
    )
    parser.add_argument(
        "--log-file",
        default=str(DEFAULT_LOG_FILE),
        help=f"Log file location (default: {DEFAULT_LOG_FILE})",
    )
    parser.add_argument(
        "--kill-server",
        action="store_true",
        help="Stop a running background server (reads the PID from --pid-file) and exit.",
    )
    return parser.parse_args()


def read_pid(pid_file: Path) -> int | None:
    if not pid_file.exists():
        return None
    try:
        return int(pid_file.read_text().strip())
    except (ValueError, OSError):
        return None


def is_running(pid: int) -> bool:
    if IS_WINDOWS:
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"],
            capture_output=True,
            text=True,
        )
        return str(pid) in result.stdout
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def kill_server(pid_file: Path) -> None:
    pid = read_pid(pid_file)
    if pid is None:
        print(f"No (readable) PID file at {pid_file} - is the server running?")
        sys.exit(1)

    if not is_running(pid):
        print(f"PID {pid} (from {pid_file}) isn't running - stale PID file, cleaning up.")
        pid_file.unlink(missing_ok=True)
        return

    print(f"Stopping server (PID {pid})...")
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    else:
        import signal

        os.kill(pid, signal.SIGTERM)
        for _ in range(20):  # give it up to ~5s to shut down cleanly
            if not is_running(pid):
                break
            time.sleep(0.25)
        else:
            print("Still running after SIGTERM, sending SIGKILL...")
            os.kill(pid, signal.SIGKILL)

    pid_file.unlink(missing_ok=True)
    print("Stopped.")


def build_common_flags(args: argparse.Namespace) -> list[str]:
    flags: list[str] = []
    if args.legacy:
        flags.append("--legacy")
    if args.debug:
        flags.append("--debug")
    if args.port is not None:
        flags += ["--port", str(args.port)]
    if args.host is not None:
        flags += ["--host", args.host]
    return flags


def start_posix(args: argparse.Namespace, pid_file: Path, log_file: Path) -> None:
    # app.py's own --daemon already does the double-fork, redirects
    # stdout/stderr to log_file, and writes pid_file itself - just invoke it
    # and let it detach on its own.
    cmd = [
        sys.executable,
        str(APP_PY),
        "--daemon",
        "--pid-file",
        str(pid_file),
        "--log-file",
        str(log_file),
        *build_common_flags(args),
    ]
    subprocess.run(cmd, check=True)

    # The command above returns as soon as the *first* fork's parent exits,
    # which happens slightly before the final detached process gets around
    # to writing pid_file - poll briefly instead of assuming it's instant.
    pid = None
    for _ in range(30):
        pid = read_pid(pid_file)
        if pid:
            break
        time.sleep(0.1)

    if pid:
        print(f"Started (PID {pid}). Logs: {log_file}")
    else:
        print(f"Start command finished, but {pid_file} didn't appear within 3s - check {log_file}.")


def start_windows(args: argparse.Namespace, pid_file: Path, log_file: Path) -> None:
    # No os.fork() on Windows, so app.py's --daemon can't be used here at
    # all. Launch app.py as a normal (non-daemon) process instead, fully
    # detached via CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS, and handle
    # the log redirection and PID file here ourselves.
    cmd = [sys.executable, str(APP_PY), *build_common_flags(args)]

    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    log_handle = open(log_file, "a")
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=log_handle,
            stderr=log_handle,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=True,
        )
    finally:
        log_handle.close()

    pid_file.write_text(str(proc.pid))
    print(f"Started (PID {proc.pid}). Logs: {log_file}")


def start_server(args: argparse.Namespace) -> None:
    pid_file = Path(args.pid_file)
    log_file = Path(args.log_file)

    existing_pid = read_pid(pid_file)
    if existing_pid and is_running(existing_pid):
        print(
            f"Server already running (PID {existing_pid}, from {pid_file}). "
            f"Use --kill-server first if you want to restart it."
        )
        sys.exit(1)

    if IS_WINDOWS:
        start_windows(args, pid_file, log_file)
    else:
        start_posix(args, pid_file, log_file)


def main() -> None:
    args = parse_args()
    if args.kill_server:
        kill_server(Path(args.pid_file))
        return
    start_server(args)


if __name__ == "__main__":
    main()
