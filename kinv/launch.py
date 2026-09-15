"""Opening kinv for a board from somewhere that is not a terminal: the KiCad plugin.

One server per project. Every running ``kinv ui`` records its address in
``KINV_HOME/servers/<id>.json``; :func:`open_ui` asks that address which board
it serves (``/api/hello``) and reuses it, so pressing the button twice opens
the same page twice rather than a second server. Otherwise it starts one in the
background on the first free port from 7373, detached from the caller so it
outlives the plugin process, and lets it stop by itself once no tab has asked
it anything for a while.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

from kinv.adapters.store.inventory import inventory_home

DEFAULT_PORT = 7373
IDLE_MINUTES = 10


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _record_base(project: str) -> str:
    ident = hashlib.sha1(os.path.normcase(os.path.abspath(project)).encode("utf8")).hexdigest()[:16]
    return os.path.join(inventory_home(), "servers", ident)


def record_path(project: str) -> str:
    return _record_base(project) + ".json"


def log_path(project: str) -> str:
    return _record_base(project) + ".log"


def write_record(project: str, url: str) -> None:
    path = record_path(project)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    record = {"project": os.path.abspath(project), "url": url, "pid": os.getpid()}
    with open(path, "w", encoding="utf8") as file:
        json.dump(record, file)


def clear_record(project: str, url: str) -> None:
    """Only this server's own record: another may have taken the project over since."""
    path = record_path(project)
    try:
        with open(path, encoding="utf8") as file:
            if json.load(file).get("url") != url:
                return
        os.remove(path)
    except (OSError, ValueError):
        pass


def running_url(project: str, timeout: float = 1.0) -> str | None:
    """The address of a kinv serving this project right now, or None."""
    try:
        with open(record_path(project), encoding="utf8") as file:
            url = json.load(file)["url"]
        with urllib.request.urlopen(url + "api/hello", timeout=timeout) as response:
            hello = json.loads(response.read())
    except (OSError, ValueError, KeyError, TypeError):
        return None
    # A stale record can point at a port some other board's kinv has since taken.
    return url if _same_path(hello.get("project", ""), project) else None


def free_port(start: int = DEFAULT_PORT, tries: int = 50) -> int:
    """The first port from ``start`` nothing listens on; 0 (any) when all are taken."""
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return 0


def _spawn(command: list[str], log, env: dict) -> subprocess.Popen:
    options: dict = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": subprocess.STDOUT, "env": env, "close_fds": True}
    if os.name != "nt":
        return subprocess.Popen(command, start_new_session=True, **options)
    # A hidden console rather than none, so the kicad-cli and git it runs
    # inherit it instead of each flashing a window of their own. Out of the
    # caller's job where the job allows it, so closing KiCad does not take the
    # server with it mid-write.
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        return subprocess.Popen(command, creationflags=flags | 0x01000000, **options)  # CREATE_BREAKAWAY_FROM_JOB
    except OSError:
        return subprocess.Popen(command, creationflags=flags, **options)


def open_ui(
    project: str, python: str | None = None, env: dict | None = None, wait: float = 20.0, browser: bool = True
) -> str:
    """Opens the page for ``project`` in the browser, starting a server if none runs; returns its address.

    ``env`` is added to the server's environment (``KINV_KICAD_CLI``, say).
    Raises ``RuntimeError`` with the server's own output when it does not come up.
    """
    project = os.path.abspath(project)
    url = running_url(project)
    if url:
        if browser:
            webbrowser.open(url)
        return url

    package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    child_env = {**os.environ, **(env or {})}
    child_env["PYTHONPATH"] = os.pathsep.join(p for p in (package_root, child_env.get("PYTHONPATH")) if p)
    child_env["PYTHONUNBUFFERED"] = "1"
    command = [
        python or sys.executable, "-m", "kinv", "ui", project,
        "--port", str(free_port()), "--idle-exit", str(IDLE_MINUTES),
    ] + ([] if browser else ["--no-open"])  # fmt: skip

    log_file = log_path(project)
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    with open(log_file, "wb") as log:
        process = _spawn(command, log, child_env)

    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        url = running_url(project)
        if url:
            process.returncode = 0  # left running on purpose: not ours to wait for
            return url  # the server opens the browser itself, as `kinv ui` does
        if process.poll() is not None:
            break
        time.sleep(0.2)
    try:
        with open(log_file, encoding="utf8", errors="replace") as file:
            output = file.read().strip()
    except OSError:
        output = ""
    if process.poll() is None:
        raise RuntimeError(f"kinv did not answer within {wait:.0f} s.\n\n{output}\n\nLog: {log_file}")
    raise RuntimeError(f"kinv stopped before it started.\n\n{output}\n\nLog: {log_file}")
