"""A KiCad BOM export, read into BOM lines."""

from __future__ import annotations

import math
from pathlib import Path

from kinv.adapters.kicad.csv import parse_csv_records
from kinv.core.parse.refdes import expand_refs
from kinv.js import num

# Column aliases, so a hand-exported BOM with KiCad's default labels also works.
_ALIASES: dict[str, list[str]] = {
    "refs": ["Reference", "References", "Refs", "Designator"],
    "value": ["Value"],
    "footprint": ["Footprint"],
    "datasheet": ["Datasheet"],
    "description": ["Description"],
    "quantity": ["QUANTITY", "Quantity", "Qty"],
    "dnp": ["DNP"],
}
_KNOWN = {name for names in _ALIASES.values() for name in names}


def _pick(record: dict[str, str], names: list[str]) -> str | None:
    for name in names:
        if name in record:
            return record[name]
    return None


def _is_dnp(cell: str | None) -> bool:
    """kicad-cli localises generated columns — "Nicht bestücken" on a German install.

    So DNP is "the cell is not empty", never a comparison against a word.
    """
    return cell is not None and cell.strip() != ""


def parse_bom_csv(text: str, source: str) -> list[dict]:
    lines = []
    for record in parse_csv_records(text):
        refs = expand_refs(_pick(record, _ALIASES["refs"]) or "")
        quantity_cell = _pick(record, _ALIASES["quantity"])
        parsed_quantity = num(quantity_cell) if quantity_cell is not None else math.nan

        fields = {name: value for name, value in record.items() if name not in _KNOWN and value.strip() != ""}

        lines.append(
            {
                "refs": refs,
                "value": _pick(record, _ALIASES["value"]) or "",
                "footprint": _pick(record, _ALIASES["footprint"]) or "",
                "datasheet": _pick(record, _ALIASES["datasheet"]) or None,
                "description": _pick(record, _ALIASES["description"]) or None,
                "quantity": parsed_quantity if math.isfinite(parsed_quantity) and quantity_cell else len(refs),
                "dnp": _is_dnp(_pick(record, _ALIASES["dnp"])),
                "fields": fields,
                "source": source,
            }
        )
    return lines


def read_bom_csv(path: str | Path) -> list[dict]:
    path = Path(path)
    # Bytes, not read_text: text mode would turn a CRLF inside a quoted cell
    # into LF, and the TypeScript reader sees the file as it is.
    return parse_bom_csv(path.read_bytes().decode("utf8", errors="replace"), path.name)
