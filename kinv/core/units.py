"""Physical units, SI prefixes, and the magnitude formatting keys are built from."""

from __future__ import annotations

import math
from typing import Literal

from kinv.js import num_str, to_precision

Unit = Literal["ohm", "farad", "henry"]

UNIT_SYMBOL: dict[str, str] = {"ohm": "Ω", "farad": "F", "henry": "H"}

# SI prefixes, largest first. Case matters for exactly one pair: `m` is milli
# and `M` is mega. Everything else is matched case-insensitively, because
# schematics contain `10K` and `5K6` as often as `10k` and `5k6`.
_PREFIXES: list[tuple[str, int]] = [
    ("G", 9),
    ("M", 6),
    ("k", 3),
    ("", 0),
    ("m", -3),
    ("u", -6),
    ("n", -9),
    ("p", -12),
]


def prefix_multiplier(letter: str) -> float | None:
    """Multiplier for a prefix letter, or None. ``R`` is the RKM ohm marker (×1)."""
    if letter == "m":
        return 1e-3  # milli — lower case only
    if letter == "M":
        return 1e6  # mega — upper case only
    lower = letter.lower()
    if lower == "p":
        return 1e-12
    if lower == "n":
        return 1e-9
    if lower in ("u", "µ", "μ"):  # u, MICRO SIGN, GREEK SMALL LETTER MU
        return 1e-6
    if lower == "r":
        return 1.0  # RKM ohm marker: 0R1, 4R7
    if lower == "k":
        return 1e3
    if lower == "g":
        return 1e9
    return None


def _tidy(n: float) -> float:
    """Drops floating point noise from a decimal-scaled magnitude."""
    return to_precision(n, 10)


def format_magnitude(magnitude: float) -> str:
    """Engineering notation with a mantissa in [1, 1000).

    This is what makes ``100n`` and ``100nF`` the same canonical part, and
    ``5K6`` and ``5k6`` the same as ``5.6k``. It deliberately does NOT merge
    ``0.1`` and ``10m`` — 100 mΩ and 10 mΩ are different resistors.
    """
    if not math.isfinite(magnitude):
        raise ValueError(f"not a finite magnitude: {num_str(magnitude)}")
    if magnitude == 0:
        return "0"

    sign = "-" if magnitude < 0 else ""
    absolute = abs(magnitude)

    for symbol, exponent in _PREFIXES:
        scaled = _tidy(absolute / 10.0**exponent)
        if 1 <= scaled < 1000:
            return f"{sign}{_trim_zeros(scaled)}{symbol}"

    # Outside pico..giga: fall back to exponent form rather than lying about it.
    return f"{sign}{_trim_zeros(_tidy(absolute))}"


def _trim_zeros(n: float) -> str:
    # 4.700000000000001 -> "4.7", 100 -> "100"
    return num_str(to_precision(n, 6))
