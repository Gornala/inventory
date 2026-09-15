"""What a footprint reference like ``Capacitor_SMD:C_0603_1608Metric`` says about the part."""

from __future__ import annotations

import re

# Library nickname → class. Checked before the name, and longest first.
_LIBRARY_CLASSES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^Capacitor", re.I), "capacitor"),
    (re.compile(r"^Resistor", re.I), "resistor"),
    (re.compile(r"^Inductor", re.I), "inductor"),
    (re.compile(r"^Ferrite", re.I), "ferrite"),
    (re.compile(r"^(Diode|LED)", re.I), "diode"),
    (re.compile(r"^(Transistor|Package_TO)", re.I), "transistor"),
    (re.compile(r"^Connector", re.I), "connector"),
    (re.compile(r"^(Button_Switch|Switch)", re.I), "switch"),
    (re.compile(r"^(Crystal|Oscillator)", re.I), "crystal"),
    (re.compile(r"^Transformer", re.I), "transformer"),
    (re.compile(r"^Fuse", re.I), "fuse"),
    (re.compile(r"^Relay", re.I), "relay"),
    (re.compile(r"^TestPoint", re.I), "testpoint"),
    (re.compile(r"^MountingHole|^Mounting_", re.I), "mounting"),
    (re.compile(r"^Package_", re.I), "ic"),
]

# Footprint-name prefix → class, for libraries that say nothing useful.
_NAME_CLASSES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^C_"), "capacitor"),
    (re.compile(r"^CP_"), "capacitor"),
    (re.compile(r"^R_"), "resistor"),
    (re.compile(r"^L_"), "inductor"),
    (re.compile(r"^FB_"), "ferrite"),
    (re.compile(r"^(D_|LED_)"), "diode"),
    (re.compile(r"^Q_"), "transistor"),
    (re.compile(r"^TestPoint"), "testpoint"),
    (re.compile(r"^MountingHole"), "mounting"),
    (re.compile(r"^PinSocket|^PinHeader|^USB_|^Conn_"), "connector"),
]

_CHIP = re.compile(r"_([0-9]{4})_([0-9]{4})Metric")
_VARIANT = re.compile(r"_(HandSolder|Pad[0-9.x]+mm(?:_HandSolder)?|Castellated|ReverseGeometry)", re.I)


def parse_footprint(raw: str) -> dict | None:
    """``{raw, library, name, cls, chip, variant}``, or None for an empty cell."""
    trimmed = raw.strip()
    if trimmed == "":
        return None

    colon = trimmed.find(":")
    library = trimmed[:colon] if colon >= 0 else None
    name = trimmed[colon + 1 :] if colon >= 0 else trimmed

    cls = "unknown"
    if library is not None:
        for pattern, candidate in _LIBRARY_CLASSES:
            if pattern.search(library):
                cls = candidate
                break
    if cls == "unknown":
        for pattern, candidate in _NAME_CLASSES:
            if pattern.search(name):
                cls = candidate
                break

    chip_match = _CHIP.search(name)
    chip = {"imperial": chip_match.group(1), "metric": chip_match.group(2)} if chip_match else None

    variant_match = _VARIANT.search(name)
    variant = variant_match.group(1) if variant_match else None

    return {"raw": trimmed, "library": library, "name": name, "cls": cls, "chip": chip, "variant": variant}


def package_of(fp: dict | None) -> str | None:
    """The package token in canonical keys.

    The imperial chip code where there is one (``0603``), otherwise the
    footprint name, which for a specific part is the most honest identity
    available.
    """
    if not fp:
        return None
    return fp["chip"]["imperial"] if fp["chip"] else fp["name"]
