"""The canonical key parts are filed under, and the labels a person reads."""

from __future__ import annotations

from kinv.core.parse.refdes import CLASS_LETTER
from kinv.core.units import format_magnitude
from kinv.js import num_str, to_precision


def canonical_key(spec: dict) -> str:
    """The join key between a schematic line, a catalog entry and an order line.

    Two lines that produce the same key are the same thing to buy. Land-pattern
    variants are deliberately absent: a 1210 cap on a HandSolder footprint is
    the same purchase as one on the standard footprint.
    """
    letter = CLASS_LETTER[spec["cls"]]
    pkg = spec["pkg"] if spec["pkg"] is not None else "?"
    if spec["kind"] == "generic":
        return f"{letter}|{format_magnitude(spec['magnitude'])}|{pkg}"
    return f"{letter}|{spec['designator']}|{pkg}"


def display_value(spec: dict) -> str:
    """Human-facing value, e.g. ``100n`` -> ``100nF``."""
    if spec["kind"] == "specific":
        return spec["designator"]
    magnitude = format_magnitude(spec["magnitude"])
    return {
        "ohm": f"{magnitude} Ω",
        "farad": f"{magnitude}F",
        "henry": f"{magnitude}H",
    }[spec["unit"]]


# The classes that measure in ohms do not all call themselves resistors.
_CLASS_WORD = {
    "resistor": "RES",
    "ferrite": "FERRITE BEAD",
    # NTC or PTC is not something the board says, so neither does the label.
    "thermistor": "THERMISTOR",
}


def search_label(spec: dict) -> str:
    """How a distributor writes the same part, so the row can be pasted into a search box.

    ``C|100n|0402`` is the right join key and the wrong thing to type into
    DigiKey. Their listings read ``CAP CER 0.1UF 0402`` and ``RES 5.62K OHM
    0603``, so that is what this produces: their words, their units, their
    order. It is a label and never an identity — nothing is filed under it.

    A specific part is its own search term: ``RP2040`` is what you would type.
    """
    if spec["kind"] == "specific":
        return spec["designator"]

    pkg = "" if spec["pkg"] is None else f" {spec['pkg']}"
    unit = spec["unit"]
    if unit == "ohm":
        return f"{_CLASS_WORD.get(spec['cls'], 'RES')} {_ohms(spec['magnitude'])} OHM{pkg}"
    if unit == "farad":
        return f"CAP CER {_farads(spec['magnitude'])}{pkg}"
    return f"FIXED IND {_henries(spec['magnitude'])}{pkg}"


def _plain(value: float) -> str:
    """A number as a person writes it: no exponent, no trailing zeros.

    ``to_precision`` first, because 4.7 µF divided down arrives as
    4.700000000000001 and a search box does not want to see that.
    """
    return num_str(to_precision(value, 6))


def _ohms(magnitude: float) -> str:
    """Ohms carry an SI prefix upwards and none downwards.

    5.62k is ``5.62K OHM``, but 5 mΩ cannot be ``5M OHM`` — that is five
    megohms. Below an ohm the distributors write the decimal out.
    """
    absolute = abs(magnitude)
    if absolute >= 1e6:
        return f"{_plain(magnitude / 1e6)}M"
    if absolute >= 1e3:
        return f"{_plain(magnitude / 1e3)}K"
    return _plain(magnitude)


def _farads(magnitude: float) -> str:
    """Picofarads under 10 nF, microfarads from there up — nobody lists a ``100NF`` part."""
    if abs(magnitude) < 10e-9:
        return f"{_plain(magnitude / 1e-12)}PF"
    return f"{_plain(magnitude / 1e-6)}UF"


def _henries(magnitude: float) -> str:
    """nH, then µH, then mH — ``MH``, as they write it."""
    absolute = abs(magnitude)
    if absolute >= 1e-3:
        return f"{_plain(magnitude / 1e-3)}MH"
    if absolute >= 1e-6:
        return f"{_plain(magnitude / 1e-6)}UH"
    return f"{_plain(magnitude / 1e-9)}NH"
