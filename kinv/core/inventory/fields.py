"""The schematic fields a resolved part is worth writing back."""

from __future__ import annotations

from typing import Iterable


def fields_for_part(resolution: dict) -> dict[str, str]:
    """Only what the tool actually decided: the part number, who makes it, where to buy it.

    ``Value`` and ``Footprint`` are the designer's; ``Description`` and
    ``Datasheet`` come from the symbol library and overwriting them would
    replace something a person chose with something a distributor said.
    """
    part = resolution.get("part")
    if part is None:
        return {}
    fields = {"MPN": part["mpn"]}
    if part.get("manufacturer", "") != "":
        fields["Manufacturer"] = part["manufacturer"]
    # Supplier-neutral names: a field called `DigiKey#` would say the board is
    # bought from one distributor forever.
    if part.get("supplier") is not None:
        fields["Supplier"] = part["supplier"]
    if part.get("orderNumber") is not None:
        fields["Supplier#"] = part["orderNumber"]
    return fields


def fields_to_write(parts: Iterable[dict], resolutions: Iterable[dict]) -> list[dict]:
    """Every assigned part's fields, against the placements that carry them."""
    by_key = {r["key"]: r for r in resolutions}
    entries = []
    for part in parts:
        resolution = by_key.get(part["key"])
        if resolution is None:
            continue
        fields = fields_for_part(resolution)
        if not fields:
            continue
        # Every spelling that fed this part: 100n and 100nF are one purchase.
        values = list(dict.fromkeys(source["value"] for source in part["sources"]))
        entries.append({"key": part["key"], "refs": part["refs"], "values": values, "fields": fields})
    return entries
