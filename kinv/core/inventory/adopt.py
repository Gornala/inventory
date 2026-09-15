"""Reading back what the schematic already says about a part.

The other half of writing ``MPN``, ``Manufacturer``, ``Supplier`` and
``Supplier#`` onto the symbols. Nothing here is automatic: reading a file is
not permission to write a catalog that outlives the board, so this produces a
plan, and applying it is a separate, explicit act.
"""

from __future__ import annotations

from typing import Callable, Iterable

from kinv.core.consolidate.findings import FIELD_JOIN
from kinv.core.inventory.resolve import now_iso, part_id
from kinv.core.parse.spec import PART_NUMBER_FIELDS

# What each fact can be called on a symbol. The first name is the one we write.
_MANUFACTURER_FIELDS = ["Manufacturer", "Mfr", "Mfg", "MFR"]
_SUPPLIER_FIELDS = ["Supplier", "Vendor", "Distributor"]
_ORDER_NUMBER_FIELDS = ["Supplier#", "SupplierPN", "Supplier Part Number", "Vendor#"]


def _field_value(fields: dict[str, str], names: list[str]) -> str:
    """One field's value by any of its names — but a merged disagreement is a question, not a value."""
    lookup = {k.lower(): v for k, v in fields.items()}
    for name in names:
        raw = lookup.get(name.lower())
        if raw is None:
            continue
        value = raw.strip()
        if value == "" or FIELD_JOIN.strip() in value:
            continue
        return value
    return ""


def schematic_part(part: dict) -> dict:
    return {
        "mpn": _field_value(part["fields"], PART_NUMBER_FIELDS),
        "manufacturer": _field_value(part["fields"], _MANUFACTURER_FIELDS),
        "supplier": _field_value(part["fields"], _SUPPLIER_FIELDS),
        "orderNumber": _field_value(part["fields"], _ORDER_NUMBER_FIELDS),
    }


def plan_adopt(parts: Iterable[dict], catalog: Iterable[dict], assignments: Iterable[dict]) -> dict:
    """What the board's own fields would add to the catalog. A read, and only a read."""
    by_key = {a["key"]: a for a in assignments}
    by_id = {p["id"]: p for p in catalog}
    silent = 0
    entries: list[dict] = []

    for part in parts:
        said = schematic_part(part)
        # No part number means nothing to hang the rest on.
        if said["mpn"] == "":
            silent += 1
            continue

        entry = {"key": part["key"], "refs": part["refs"], "mpn": said["mpn"], "status": "new", "fills": {}, "disagrees": []}
        assignment = by_key.get(part["key"])
        assigned = None if assignment is None else by_id.get(assignment["partId"])

        if assigned is not None and assigned["id"] != part_id(said["mpn"]):
            entry["status"] = "conflict"
            entry["disagrees"].append({"field": "MPN", "schematic": said["mpn"], "catalog": assigned["mpn"]})
            entries.append(entry)
            continue

        # The catalog row this MPN already has, whether or not this key points at it.
        existing = assigned if assigned is not None else by_id.get(part_id(said["mpn"]))

        def compare(field: str, source: str, had: str | None) -> None:
            if source == "":
                return
            current = (had or "").strip()
            if current == "":
                entry["fills"][field] = source
            elif current != source:
                entry["disagrees"].append({"field": field, "schematic": source, "catalog": current})

        compare("manufacturer", said["manufacturer"], existing.get("manufacturer") if existing else None)
        compare("supplier", said["supplier"], existing.get("supplier") if existing else None)
        compare("orderNumber", said["orderNumber"], existing.get("orderNumber") if existing else None)

        entry["status"] = "new" if assignment is None else ("fills" if entry["fills"] else "agrees")
        entries.append(entry)

    return {"entries": entries, "silent": silent}


def apply_adopt(plan: dict, catalog: list[dict], assignments: list[dict], now: Callable[[], str] = now_iso) -> dict:
    """Applies a plan: detail fills a gap and never overwrites; ``by: "rule"``, because a file said it."""
    next_catalog = list(catalog)
    next_assignments = list(assignments)
    adopted: list[str] = []
    filled: list[str] = []

    for entry in plan["entries"]:
        if entry["status"] in ("conflict", "agrees"):
            continue
        ident = part_id(entry["mpn"])
        if ident == "":
            continue

        existing = next((p for p in next_catalog if p["id"] == ident), None)
        part = dict(existing) if existing is not None else {
            "id": ident,
            "mpn": entry["mpn"],
            "manufacturer": "",
            "firstKey": entry["key"],
            "addedAt": now(),
        }
        for field, value in entry["fills"].items():
            if field in ("manufacturer", "supplier", "orderNumber"):
                part[field] = value

        next_catalog = [*(p for p in next_catalog if p["id"] != ident), part]
        if entry["fills"]:
            filled.append(entry["key"])

        if entry["status"] == "new":
            next_assignments = [
                *(a for a in next_assignments if a["key"] != entry["key"]),
                {"key": entry["key"], "partId": ident, "decidedAt": now(), "by": "rule"},
            ]
            adopted.append(entry["key"])

    return {"catalog": next_catalog, "assignments": next_assignments, "adopted": adopted, "filled": filled}
