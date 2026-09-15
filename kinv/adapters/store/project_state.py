"""Per-board decisions, kept beside the project in ``.kinv/``.

Settled findings (``solved.json``) and buy / do-not-buy choices
(``buy.json``): plain JSON written canonically, so ``git diff`` says what you
decided and when. No database, and nothing hidden in a browser that a second
machine or ``kinv check`` cannot see.
"""

from __future__ import annotations

import json
import os

from kinv.adapters.store.files import pretty, read_json_text, stat_signature, write_text
from kinv.js import code_units


def _state_path(project: str, name: str) -> str:
    return os.path.join(os.path.dirname(project), ".kinv", name)


def _read(path: str, key: str) -> list:
    try:
        if not os.path.exists(path):
            return []
        parsed = json.loads(read_json_text(path))
        items = parsed.get(key) if isinstance(parsed, dict) else None
        return items if isinstance(items, list) else []
    except (OSError, ValueError):
        return []


# --- solved findings ----------------------------------------------------------


def solved_path(project: str) -> str:
    return _state_path(project, "solved.json")


def read_solved(project: str) -> list[dict]:
    return [m for m in _read(solved_path(project), "solved") if isinstance(m, dict) and isinstance(m.get("id"), str)]


def write_solved(project: str, marks: list[dict]) -> None:
    ordered = sorted(marks, key=lambda m: code_units(m["id"]))
    write_text(solved_path(project), pretty({"solved": ordered}))


def set_solved(project: str, mark: dict, solved: bool) -> list[dict]:
    """Adds, replaces or removes one mark, and returns the file as it now stands."""
    kept = [m for m in read_solved(project) if m["id"] != mark["id"]]
    marks = [*kept, mark] if solved else kept
    write_solved(project, marks)
    return marks


def clear_solved(project: str) -> None:
    write_solved(project, [])


def solved_signature(project: str) -> str:
    return stat_signature(solved_path(project))


# --- buy / do not buy ---------------------------------------------------------


def buy_path(project: str) -> str:
    return _state_path(project, "buy.json")


def read_buy_choices(project: str) -> list[dict]:
    return [
        c
        for c in _read(buy_path(project), "choices")
        if isinstance(c, dict) and isinstance(c.get("key"), str) and isinstance(c.get("buy"), bool)
    ]


def write_buy_choices(project: str, choices: list[dict]) -> None:
    ordered = sorted(choices, key=lambda c: code_units(c["key"]))
    write_text(buy_path(project), pretty({"choices": ordered}))


def set_buy_choice(project: str, key: str, buy: bool, at: str) -> list[dict]:
    """Records one decision. Both answers are written down, including the one the rules agree with."""
    kept = [c for c in read_buy_choices(project) if c["key"] != key]
    choices = [*kept, {"key": key, "buy": buy, "at": at}]
    write_buy_choices(project, choices)
    return choices


def clear_buy_choice(project: str, key: str) -> list[dict]:
    """Forgets one decision, leaving the rules to answer for that part again."""
    choices = [c for c in read_buy_choices(project) if c["key"] != key]
    write_buy_choices(project, choices)
    return choices


def buy_signature(project: str) -> str:
    return stat_signature(buy_path(project))
