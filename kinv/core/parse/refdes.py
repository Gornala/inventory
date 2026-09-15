"""Reference designators: what class of part ``R12`` or ``LCD1`` is."""

from __future__ import annotations

import re

COMPONENT_CLASSES = (
    "resistor", "capacitor", "inductor", "ferrite", "diode", "transistor", "ic",
    "connector", "switch", "crystal", "transformer", "fuse", "relay", "testpoint",
    "mounting", "thermistor", "display", "battery", "antenna", "sounder", "module",
    "unknown",
)

# Letter used for each class in a canonical key.
CLASS_LETTER: dict[str, str] = {
    "resistor": "R",
    "capacitor": "C",
    "inductor": "L",
    "ferrite": "FB",
    "diode": "D",
    "transistor": "Q",
    "ic": "U",
    "connector": "J",
    "switch": "SW",
    "crystal": "Y",
    "transformer": "T",
    "fuse": "F",
    "relay": "K",
    "testpoint": "TP",
    "mounting": "MH",
    "thermistor": "TH",
    "display": "DS",
    "battery": "BT",
    "antenna": "ANT",
    "sounder": "LS",
    "module": "MOD",
    "unknown": "X",
}

# Reference designator prefixes.
#
# Deliberately long: IEEE 315 covers the single letters, but real schematics
# are full of `LCD1`, `REG3`, `OPA2` and `H4` because a designer would rather
# read the board than decode it. Anything not listed stays `unknown`, which
# only means the footprint gets the deciding vote — never a wrong guess.
_PREFIX_CLASSES: list[tuple[str, str]] = [
    # passives
    ("R", "resistor"), ("RES", "resistor"), ("RV", "resistor"), ("RN", "resistor"),
    ("RA", "resistor"), ("POT", "resistor"), ("VR", "resistor"),
    ("C", "capacitor"), ("CAP", "capacitor"), ("CN", "capacitor"),
    ("L", "inductor"), ("IND", "inductor"), ("CHK", "inductor"),
    ("FB", "ferrite"), ("FER", "ferrite"),
    ("TH", "thermistor"), ("NTC", "thermistor"), ("PTC", "thermistor"), ("RT", "thermistor"),
    ("T", "transformer"), ("TR", "transformer"), ("XFMR", "transformer"),
    # semiconductors
    ("D", "diode"), ("DZ", "diode"), ("ZD", "diode"), ("LED", "diode"), ("CR", "diode"),
    ("Q", "transistor"), ("TX", "transistor"),
    ("U", "ic"), ("IC", "ic"), ("REG", "ic"), ("VREG", "ic"), ("OP", "ic"), ("OPA", "ic"),
    ("AMP", "ic"), ("AR", "ic"), ("MCU", "ic"), ("FPGA", "ic"), ("MEM", "ic"), ("DRV", "ic"),
    ("ADC", "ic"), ("DAC", "ic"),
    ("OSC", "crystal"),
    # connectors and mechanics
    ("J", "connector"), ("P", "connector"), ("CON", "connector"), ("JP", "connector"),
    ("CONN", "connector"), ("USB", "connector"), ("HDR", "connector"),
    ("SW", "switch"), ("S", "switch"), ("SB", "switch"), ("BTN", "switch"), ("KEY", "switch"),
    ("K", "relay"), ("RY", "relay"), ("RLY", "relay"),
    ("F", "fuse"), ("FU", "fuse"), ("FUSE", "fuse"),
    ("Y", "crystal"), ("X", "crystal"), ("XTAL", "crystal"),
    ("TP", "testpoint"), ("TSTP", "testpoint"),
    ("H", "mounting"), ("HW", "mounting"), ("MH", "mounting"), ("MK", "mounting"),
    ("MP", "mounting"), ("STANDOFF", "mounting"),
    # modules and the rest
    ("LCD", "display"), ("DISP", "display"), ("DS", "display"), ("OLED", "display"),
    ("SEG", "display"),
    ("BT", "battery"), ("BAT", "battery"),
    ("ANT", "antenna"), ("AE", "antenna"), ("E", "antenna"),
    ("LS", "sounder"), ("SP", "sounder"), ("SPK", "sounder"), ("BZ", "sounder"), ("BUZ", "sounder"),
    ("MOD", "module"), ("M", "module"), ("PS", "module"), ("PSU", "module"),
]

_PREFIX_LOOKUP = dict(_PREFIX_CLASSES)
_LONGEST_PREFIX = max(len(prefix) for prefix, _ in _PREFIX_CLASSES)

_REF_PATTERN = re.compile(r"^([A-Za-z_]+)([0-9]+)\Z")


def parse_ref(ref: str) -> dict | None:
    """``{prefix, number, ref}`` for ``R12``, or None for anything else."""
    m = _REF_PATTERN.match(ref.strip())
    if not m:
        return None
    prefix, digits = m.groups()
    return {"prefix": prefix.upper(), "number": int(digits), "ref": ref.strip()}


def class_of_prefix(prefix: str) -> str:
    upper = prefix.upper()
    # Exact match on the whole prefix: `LEDR1` is not an LED, and inventing a
    # class from a partial match is how a tool starts being wrong confidently.
    if len(upper) > _LONGEST_PREFIX:
        return "unknown"
    return _PREFIX_LOOKUP.get(upper, "unknown")


def class_of_ref(ref: str) -> str:
    parsed = parse_ref(ref)
    return class_of_prefix(parsed["prefix"]) if parsed else "unknown"


def expand_refs(cell: str) -> list[str]:
    """Expands a kicad-cli reference cell into individual designators.

    kicad-cli emits ``C6001-C6004`` for runs and joins groups with commas, so a
    single cell reads ``C1001,C2004,C6001-C6004``. A range only expands when
    both ends share a prefix and ascend; anything else is kept verbatim rather
    than guessed at.
    """
    out: list[str] = []
    for chunk in cell.split(","):
        piece = chunk.strip()
        if piece == "":
            continue

        dash = piece.find("-")
        if dash <= 0:
            out.append(piece)
            continue

        start = parse_ref(piece[:dash])
        end = parse_ref(piece[dash + 1 :])
        if not start or not end or start["prefix"] != end["prefix"] or end["number"] < start["number"]:
            out.append(piece)
            continue

        out.extend(f"{start['prefix']}{n}" for n in range(start["number"], end["number"] + 1))
    return out
