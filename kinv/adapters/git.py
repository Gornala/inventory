"""Which files git already has uncommitted changes to.

Not to police your working tree: after a write, ``git diff`` should show *only*
what the tool did. A directory that is not a repository, or a machine with no
git, returns nothing — the guard exists where it can help and is silent where
it cannot.
"""

from __future__ import annotations

import os
import subprocess


def dirty_files(files: list[str]) -> list[str]:
    if not files:
        return []
    cwd = os.path.dirname(files[0]) or "."
    try:
        creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            ["git", "status", "--porcelain", "--", *files],
            cwd=cwd,
            # Never the server's own stdin: on Windows, git's runtime probes the
            # handle it inherits, and a pipe with a read pending on it blocks the
            # probe — which hung every schematic write in the browser tests.
            stdin=subprocess.DEVNULL,
            capture_output=True,
            creationflags=creation,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []

    changed = set()
    for line in result.stdout.decode("utf8", errors="replace").split("\n"):
        entry = line[3:].strip()
        if entry == "":
            continue
        # `XY path`, and ` -> ` for a rename; the path is what matters here.
        if " -> " in entry:
            entry = entry.split(" -> ")[1]
        changed.add(os.path.normcase(os.path.abspath(os.path.join(cwd, entry.strip('"')))))
    return [f for f in files if os.path.normcase(os.path.abspath(f)) in changed]
