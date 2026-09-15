"""Reading a KiCad ``Value`` field as a magnitude, or recognising that it is not one."""

from __future__ import annotations

import math
import re
from typing import Any

from kinv.core.units import prefix_multiplier

ParsedValue = dict[str, Any]
"""``{kind: "quantity", magnitude, unit, bare, raw}`` or ``{kind: "opaque", raw}``."""


def _normalize(raw: str) -> str:
    """Unicode and spelling variants that mean the same thing."""
    text = raw.strip()
    text = re.sub("[µμ]", "u", text)  # MICRO SIGN, GREEK SMALL LETTER MU
    text = re.sub("[ΩΩ]", "ohm", text)  # OHM SIGN, GREEK CAPITAL OMEGA
    return re.sub(r"\s+", "", text)


_TAILS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:ohms?)\Z", re.IGNORECASE), "ohm"),
    (re.compile(r"(?:farads?)\Z", re.IGNORECASE), "farad"),
    (re.compile(r"(?:henrys?|henries)\Z", re.IGNORECASE), "henry"),
    (re.compile(r"F\Z"), "farad"),
    (re.compile(r"H\Z"), "henry"),
]


def _take_unit(text: str) -> tuple[str, str | None]:
    """Strips an explicit trailing unit, returning what it was."""
    for pattern, unit in _TAILS:
        rest = pattern.sub("", text, count=1)
        # Only a unit if something numeric survives; guards `F` in a part number.
        if rest != text and re.search("[0-9]", rest):
            return rest, unit
    return text, None


_RKM = re.compile("^([0-9]+)([a-zA-Zµ])([0-9]+)\\Z")  # 5k6, 3n3, 0R1, 4u7
_PLAIN = re.compile("^([0-9]+(?:\\.[0-9]+)?)([a-zA-Zµ]?)\\Z")  # 10k, 4.7n, 100, 0.1


def parse_value(raw: str) -> ParsedValue:
    """Parses a KiCad ``Value`` field into a magnitude, or reports it as opaque.

    The unit is usually absent (``10k``), so the caller supplies it from the
    component class; ``unit`` here is only what the text itself asserted.
    """
    trimmed = raw.strip()
    if trimmed == "":
        return {"kind": "opaque", "raw": raw}

    rest, unit = _take_unit(_normalize(trimmed))

    rkm = _RKM.match(rest)
    if rkm:
        whole, letter, frac = rkm.groups()
        multiplier = prefix_multiplier(letter)
        if multiplier is not None:
            magnitude = float(f"{whole}.{frac}") * multiplier
            if math.isfinite(magnitude):
                return {"kind": "quantity", "magnitude": magnitude, "unit": unit, "bare": False, "raw": raw}
        return {"kind": "opaque", "raw": raw}

    plain = _PLAIN.match(rest)
    if plain:
        digits, letter = plain.groups()
        multiplier = 1.0 if letter == "" else prefix_multiplier(letter)
        if multiplier is not None:
            magnitude = float(digits) * multiplier
            if math.isfinite(magnitude):
                return {
                    "kind": "quantity",
                    "magnitude": magnitude,
                    "unit": unit,
                    "bare": letter == "" and unit is None,
                    "raw": raw,
                }
        return {"kind": "opaque", "raw": raw}

    return {"kind": "opaque", "raw": raw}
