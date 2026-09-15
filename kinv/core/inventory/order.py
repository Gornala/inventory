"""Step 3: what to buy, grouped by who you buy it from."""

from __future__ import annotations

import re
from typing import Iterable

from kinv.js import collation_key

# One row of the sheet you fill in. Everything left of `supplier` is the tool
# describing the board; `mpn`, `supplier` and `order_number` are yours.
ORDER_COLUMNS = ["key", "value", "package", "used", "mpn", "manufacturer", "supplier", "order_number", "part_package", "refs"]


def order_rows(parts: Iterable[dict], resolutions: Iterable[dict]) -> list[dict]:
    """The board's parts, with whatever the catalog already knows filled in."""
    by_key = {r["key"]: r for r in resolutions}
    rows = []
    for part in parts:
        resolution = by_key.get(part["key"])
        catalogued = resolution["part"] if resolution else None

        def known(field: str) -> str:
            value = catalogued.get(field) if catalogued else None
            return value if value is not None else ""

        suggested = resolution["suggestedMpn"] if resolution else None
        mpn = catalogued["mpn"] if catalogued and catalogued.get("mpn") is not None else (suggested if suggested is not None else "")
        rows.append(
            {
                "key": part["key"],
                "value": part["value"],
                "package": part["pkg"],
                "used": part["placements"],
                # a part whose value is already a part number arrives with it suggested
                "mpn": mpn,
                "manufacturer": known("manufacturer"),
                "supplier": known("supplier"),
                "order_number": known("orderNumber"),
                "part_package": known("package"),
                "refs": " ".join(part["refs"]),
            }
        )
    return rows


def read_order_rows(records: list[dict], known: set[str]) -> dict:
    """Reads the sheet back, matched on the canonical key; a key the board lacks is reported."""
    rows: list[dict] = []
    problems: list[dict] = []
    for index, record in enumerate(records):
        line = index + 2  # 1-based, and the header is line 1

        def cell(name: str) -> str:
            return (record.get(name) or "").strip()

        key = cell("key")
        if key == "":
            continue
        if key not in known:
            problems.append({"row": line, "key": key, "reason": "no part on this board has this key"})
            continue

        mpn, supplier, order_number, pkg = cell("mpn"), cell("supplier"), cell("order_number"), cell("part_package")
        if mpn == "" and supplier == "" and order_number == "" and pkg == "":
            continue  # untouched
        if mpn == "":
            problems.append({"row": line, "key": key, "reason": "a supplier was given but no MPN"})
            continue
        rows.append(
            {
                "key": key,
                "mpn": mpn,
                "manufacturer": cell("manufacturer"),
                "supplier": supplier,
                "orderNumber": order_number,
                "package": cell("part_package"),
            }
        )
    return {"rows": rows, "problems": problems}


def plan_order(parts: Iterable[dict], resolutions: Iterable[dict], boards: int = 1) -> dict:
    """The quantity is placements × boards and nothing else.

    No stock subtraction, no spares, no rounding to a pack, no price break —
    every one is a decision, and a tool that makes them quietly can order ten
    thousand of a five-euro part because the arithmetic said so.
    """
    by_key = {r["key"]: r for r in resolutions}
    by_supplier: dict[str, list[dict]] = {}
    no_supplier: list[dict] = []
    unresolved: list[dict] = []

    for part in parts:
        resolution = by_key.get(part["key"])
        catalogued = resolution["part"] if resolution else None
        if catalogued is None:
            unresolved.append(part)
            continue
        line = {"key": part["key"], "quantity": part["placements"] * boards, "part": catalogued, "refs": part["refs"]}
        supplier = catalogued.get("supplier")
        if not supplier:
            no_supplier.append(line)
            continue
        by_supplier.setdefault(supplier, []).append(line)

    orders = [
        {"supplier": supplier, "lines": sorted(lines, key=lambda l: collation_key(l["key"]))}
        for supplier, lines in by_supplier.items()
    ]
    orders.sort(key=lambda o: collation_key(o["supplier"]))
    return {"boards": boards, "orders": orders, "noSupplier": no_supplier, "unresolved": unresolved}


def supplier_file_name(supplier: str) -> str:
    """A filename per supplier, with nothing in it a filesystem will object to."""
    safe = re.sub(r"^-|-\Z", "", re.sub(r"[^a-z0-9]+", "-", supplier.lower()))
    return f"order.{safe or 'supplier'}.csv"
