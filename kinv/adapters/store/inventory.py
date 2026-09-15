"""The catalog: one directory for every board, not one per project.

A part chosen once should be reused everywhere — the second board asks nothing
about 10k 0603. ``KINV_HOME`` moves it, which is what makes it testable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from kinv.adapters.store.files import pretty, read_json_text, sorted_keys, stat_signature, write_text
from kinv.js import code_units


def inventory_home() -> str:
    return os.environ.get("KINV_HOME") or os.path.join(str(Path.home()), ".kinv")


def catalog_path() -> str:
    return os.path.join(inventory_home(), "catalog.json")


def assignments_path() -> str:
    return os.path.join(inventory_home(), "assignments.json")


def _read_list(path: str, key: str) -> list:
    try:
        if not os.path.exists(path):
            return []
        parsed = json.loads(read_json_text(path))
        items = parsed.get(key) if isinstance(parsed, dict) else None
        # A half-written or hand-edited file means "nothing recorded", never a
        # crash: this sits under every report the tool produces.
        return items if isinstance(items, list) else []
    except (OSError, ValueError):
        return []


def read_catalog() -> list[dict]:
    return [p for p in _read_list(catalog_path(), "parts") if isinstance(p, dict) and isinstance(p.get("id"), str)]


def read_assignments() -> list[dict]:
    return [
        a
        for a in _read_list(assignments_path(), "assignments")
        if isinstance(a, dict) and isinstance(a.get("key"), str) and isinstance(a.get("partId"), str)
    ]


def _write_canonical(path: str, value: dict) -> None:
    """Sorted keys and a stable order, so a one-part change is a one-line diff."""
    write_text(path, pretty(sorted_keys(value)))


def write_catalog(parts: list[dict]) -> None:
    ordered = sorted(parts, key=lambda p: code_units(p["id"]))
    _write_canonical(catalog_path(), {"parts": ordered})


def write_assignments(assignments: list[dict]) -> None:
    ordered = sorted(assignments, key=lambda a: code_units(a["key"]))
    _write_canonical(assignments_path(), {"assignments": ordered})


def inventory_signature() -> str:
    """Assigning a part changes no schematic; without this the page would serve a stale report."""
    return f"{stat_signature(catalog_path())}|{stat_signature(assignments_path())}"


def init_inventory() -> str:
    """Creates the directory and both files, so there is somewhere to look."""
    home = inventory_home()
    os.makedirs(home, exist_ok=True)
    if not os.path.exists(catalog_path()):
        write_catalog([])
    if not os.path.exists(assignments_path()):
        write_assignments([])
    return home
