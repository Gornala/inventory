"""Step 2: the real part each generic is bought as."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Callable, Iterable


def now_iso() -> str:
    """``new Date().toISOString()``: UTC, milliseconds, a ``Z``."""
    moment = datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def part_id(mpn: str) -> str:
    """A stable id from a manufacturer part number.

    The MPN is the identity — two catalog entries for ``RC0603FR-0710KL`` are a
    bug. Case and punctuation vary in how people type it, so the id folds both.
    """
    folded = re.sub(r"[^a-z0-9]+", "-", mpn.strip().lower())
    return re.sub(r"^-|-\Z", "", folded)


def _fill(typed: str | None, had: str | None) -> str | None:
    """Typed detail fills a gap; it never overwrites what the catalog already has."""
    trimmed = typed.strip() if typed is not None else ""
    return trimmed or had


def assign_part(
    key: str,
    entry: dict,
    catalog: list[dict],
    assignments: list[dict],
    now: Callable[[], str] = now_iso,
) -> dict:
    """Records "this generic is bought as this part", adding the part to the catalog if new."""
    mpn = (entry.get("mpn") or "").strip()
    if mpn == "":
        raise ValueError("an assignment needs an MPN")

    ident = part_id(mpn)
    if ident == "":
        raise ValueError(f'"{mpn}" has nothing usable as a part number')

    existing = next((p for p in catalog if p["id"] == ident), None)
    had = existing or {}

    def kept(field: str, fallback):
        """``existing?.field ?? fallback``."""
        value = had.get(field)
        return value if value is not None else fallback

    manufacturer = _fill(entry.get("manufacturer"), had.get("manufacturer"))
    part: dict = {
        "id": ident,
        "mpn": kept("mpn", mpn),
        "manufacturer": manufacturer if manufacturer is not None else "",
    }
    for field in ("supplier", "orderNumber", "package", "datasheet", "notes"):
        value = _fill(entry.get(field), had.get(field))
        if value is not None:
            part[field] = value
    part["firstKey"] = kept("firstKey", key)
    part["addedAt"] = had["addedAt"] if had.get("addedAt") is not None else now()

    return {
        "catalog": [*(p for p in catalog if p["id"] != ident), part],
        "assignments": [
            *(a for a in assignments if a["key"] != key),
            {"key": key, "partId": ident, "decidedAt": now(), "by": "user"},
        ],
        "part": part,
    }


def unassign(key: str, assignments: Iterable[dict]) -> list[dict]:
    return [a for a in assignments if a["key"] != key]


def resolve_parts(parts: Iterable[dict], catalog: Iterable[dict], assignments: Iterable[dict]) -> list[dict]:
    """What each part on the board currently resolves to.

    A part whose value is already an MPN is *offered* that MPN, never assigned
    it: entering something in a catalog that outlives the board is a decision,
    and the tool does not make decisions on a read.
    """
    by_key = {a["key"]: a for a in assignments}
    by_id = {p["id"]: p for p in catalog}
    out = []
    for part in parts:
        assignment = by_key.get(part["key"])
        out.append(
            {
                "key": part["key"],
                "assignment": assignment,
                "part": None if assignment is None else by_id.get(assignment["partId"]),
                "suggestedMpn": part["value"] if part["resolved"] else None,
            }
        )
    return out


def unresolved(resolutions: Iterable[dict]) -> list[dict]:
    """Parts with no assignment yet."""
    return [r for r in resolutions if r["assignment"] is None]


def set_supplier(key: str, entry: dict, catalog: list[dict], assignments: list[dict]) -> dict:
    """Changes who a part is bought from — overwriting, and a blank clears it.

    Unlike ``assign_part``, which fills gaps: a vendor column you cannot
    correct is a column you cannot use, and "I have not decided after all"
    has to be sayable too.
    """
    assignment = next((a for a in assignments if a["key"] == key), None)
    if assignment is None:
        raise ValueError(f"{key} has no part yet — give it an MPN first")
    existing = next((p for p in catalog if p["id"] == assignment["partId"]), None)
    if existing is None:
        raise ValueError(f"{key} points at a part the catalog does not have")

    supplier = (entry.get("supplier") or "").strip()
    order_number = (entry.get("orderNumber") or "").strip()
    # A cleared field is *absent*, not an empty string.
    part = dict(existing)
    if supplier == "":
        part.pop("supplier", None)
    else:
        part["supplier"] = supplier
    if order_number == "":
        part.pop("orderNumber", None)
    else:
        part["orderNumber"] = order_number

    return {"catalog": [*(p for p in catalog if p["id"] != existing["id"]), part], "part": part}
