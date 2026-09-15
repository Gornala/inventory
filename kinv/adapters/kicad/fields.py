"""The designer's own symbol field names, so the BOM export can ask for all of them."""

from __future__ import annotations

import os
import re

from kinv.adapters.kicad.hierarchy import project_sheets_or_directory, read_text
from kinv.js import js_sorted, locale_compare

# Field names KiCad owns rather than the designer.
_RESERVED = {
    "Reference", "Value", "Footprint", "Datasheet", "Description", "Sheetname", "Sheetfile",
    "QUANTITY", "ITEM_NUMBER", "DNP", "EXCLUDE_FROM_BOM", "EXCLUDE_FROM_BOARD", "EXCLUDE_FROM_SIM",
}

# `(property "Name" …)`, with the escapes s-expression strings allow.
_PROPERTY = re.compile(r'\(property\s+"((?:[^"\\]|\\.)*)"', re.S)


def _unescape(text: str) -> str:
    return re.sub(r"\\(.)", r"\1", text, flags=re.S)


def _usable(name: str) -> bool:
    """Only a name that survives the round trip through ``--fields``."""
    if name == "" or name in _RESERVED:
        return False
    if name.startswith("ki_"):
        return False  # library metadata: keywords, fp filters, locked
    if name.startswith("Sim."):
        return False  # the simulator's, not the BOM's
    return re.search(r'[,"${}]', name) is None


def custom_field_names(text: str) -> list[str]:
    """The designer's own field names in one schematic's text.

    A regex rather than the s-expression reader: only the names are wanted,
    and the reader would parse megabytes of schematic on every re-export.
    """
    names: dict[str, None] = {}
    for match in _PROPERTY.finditer(text):
        name = _unescape(match.group(1))
        if _usable(name):
            names[name] = None
    return list(names)


def project_field_names(schematic_path: str) -> list[str]:
    """Every custom field used anywhere in a project. Never throws."""
    names: dict[str, None] = {}
    try:
        directory = os.path.dirname(schematic_path)
        if not os.path.exists(directory or "."):
            return []
        # The sheets the design is made of, not every file beside it.
        sheets = project_sheets_or_directory(
            schematic_path,
            [os.path.join(directory, f) for f in os.listdir(directory or ".") if f.endswith(".kicad_sch")],
        )
        for file in sheets:
            for name in custom_field_names(read_text(file)):
                names[name] = None
    except OSError:
        return []

    # Case-insensitive, so `Capacity` and `capacity` land next to each other —
    # the inconsistency is the point of showing them.
    return js_sorted(names, lambda a, b: locale_compare(a, b, base=True) or (-1 if a < b else 1))
