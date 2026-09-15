"""Reading and writing kinv's JSON state the way the TypeScript version does, to the byte.

The catalog is shared by every board and the ``.kinv`` files are committed to
git, so a file written by one version must be byte-identical to the same file
written by the other — or switching versions would show up as a diff of
nothing.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from kinv.js import code_units, num_str, stringify


def read_json_text(path: str | os.PathLike[str]) -> str:
    return Path(path).read_bytes().decode("utf8", errors="replace")


def write_text(path: str | os.PathLike[str], text: str) -> None:
    """Exactly these bytes: no newline translation, UTF-8."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf8"))


def sorted_keys(value: Any) -> Any:
    """The ``orderedKeys`` replacer: every object's keys in code-unit order, recursively."""
    if isinstance(value, dict):
        return {k: sorted_keys(value[k]) for k in sorted(value, key=code_units)}
    if isinstance(value, list):
        return [sorted_keys(v) for v in value]
    return value


def pretty(value: Any) -> str:
    """``JSON.stringify(value, null, 2) + "\\n"``."""
    return stringify(value, indent=2) + "\n"


def stat_signature(path: str | os.PathLike[str]) -> str:
    """``${stat.mtimeMs}:${stat.size}``, or "" when there is no file.

    Only compared with itself between two polls of the same process, so it
    need not match the TypeScript string — but it is kept the same shape.
    """
    try:
        stat = os.stat(path)
    except OSError:
        return ""
    return f"{num_str(stat.st_mtime_ns / 1e6)}:{stat.st_size}"
