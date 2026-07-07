import argparse
import os
import sys

from ipatool_api import create_app


def parse_args():
    parser = argparse.ArgumentParser(description="pyIPATool WebUI")
    parser.add_argument(
        "--legacy",
        action="store_true",
        help=(
            "Serve the legacy-compatible UI (plain ES5 JS, prefixed/float-based "
            "CSS) for old browsers such as Mobile Safari on iOS 6, instead of "
            "the modern ES6+ / flexbox-grid UI."
        ),
    )
    parser.add_argument("--port", type=int, default=5002, help="Port to listen on (default: 5002)")
    parser.add_argument("--host", default="127.0.0.1", help="Host/interface to bind to (default: 127.0.0.1)")
    parser.add_argument("--debug", action="store_true", help="Run Flask in debug mode")
    parser.add_argument(
        "--daemon",
        action="store_true",
        help=(
            "Fully detach and keep running in the background, independent of "
            "the terminal session that started it - implemented as a plain "
            "double-fork (this is literally what nohup/setsid do under the "
            "hood), so it needs no external binaries at all. Useful on "
            "environments (e.g. some jailbreak setups) where nohup/setsid "
            "aren't installed."
        ),
    )
    parser.add_argument(
        "--pid-file",
        default="ipatool-webui.pid",
        help="Where to write the daemon's PID when using --daemon (default: ./ipatool-webui.pid)",
    )
    parser.add_argument(
        "--log-file",
        default="ipatool-webui.log",
        help="Where stdout/stderr go when using --daemon, since there's no terminal left to print to (default: ./ipatool-webui.log)",
    )
    return parser.parse_args()


def daemonize(log_path: str, pid_path: str) -> None:
    """Classic Unix double-fork daemonization, done with nothing but the
    stdlib os module - no nohup, setsid, or screen/tmux binary required.

    Why two forks: the first fork's child calls setsid() to become a new
    session leader with no controlling terminal at all - so when the
    terminal app that started this closes, there's no controlling terminal
    left to send SIGHUP to. The second fork ensures this process can never
    accidentally reacquire a controlling terminal later (only a session
    leader can do that, and the second fork's child is deliberately not
    one). Each fork's parent exits immediately, handing control back to the
    shell right away.
    """
    if os.fork() > 0:
        sys.exit(0)  # original process exits; shell gets its prompt back

    os.setsid()

    if os.fork() > 0:
        sys.exit(0)  # session leader exits too; child below has no controlling tty

    # From here on stdout/stdin/stderr point at a dead terminal - redirect
    # them before anything tries to write to them.
    sys.stdout.flush()
    sys.stderr.flush()

    devnull_fd = os.open(os.devnull, os.O_RDONLY)
    log_fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)

    os.dup2(devnull_fd, sys.stdin.fileno())
    os.dup2(log_fd, sys.stdout.fileno())
    os.dup2(log_fd, sys.stderr.fileno())

    with open(pid_path, "w") as pid_file:
        pid_file.write(str(os.getpid()))


args = parse_args()

if args.daemon:
    daemonize(args.log_file, args.pid_file)

app = create_app(legacy=args.legacy)

if __name__ == "__main__":
    app.run(debug=args.debug, host=args.host, port=args.port)
