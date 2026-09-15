"""What a KiCad footprint name asserts about itself.

These are conventions, not guarantees — which is the whole point: comparing
the claim against measured geometry is what catches a hand-edited or
mis-named footprint.
"""

from __future__ import annotations

import re

_CHIP = re.compile(r"_([0-9]{4})_([0-9]{4})Metric")
_PITCH = re.compile(r"_P([0-9]+(?:\.[0-9]+)?)mm")
_BODY = re.compile(r"_([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)mm")
_EP_SIZE = re.compile(r"_EP([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)mm")
_EP_CLAIM = re.compile(r"-([0-9]+)EP")
_PIN_COUNT = re.compile(r"^([A-Za-z]+)-([0-9]+)")

# Families where `NAME-<digits>` really is a pin count. A whitelist, because
# the same shape means a JEDEC package code elsewhere: SOT-23 is not 23 pins,
# and ESP-07 is a module name. Guessing produced four confident, wrong findings
# on a real board.
_PIN_COUNT_FAMILIES = {
    "QFN", "VQFN", "WQFN", "UQFN", "TQFN", "HVQFN", "DFN", "VDFN", "WDFN", "UDFN",
    "SON", "USON", "WSON", "VSON", "XSON", "SO", "SOIC", "SOP", "TSOP", "PSOP", "HSOP",
    "SSOP", "TSSOP", "VSSOP", "MSOP", "QSOP", "QFP", "TQFP", "LQFP", "PQFP", "HTQFP",
    "MQFP", "BGA", "LGA", "CSP", "WLCSP", "PLCC", "DIP", "SDIP", "SIP", "PDIP",
}


def parse_footprint_name(name: str) -> dict:
    """``{name, chip, pitch, pinCount, body, exposedPad, family}``."""
    bare = name[name.find(":") + 1 :] if ":" in name else name

    chip = _CHIP.search(bare)
    pitch = _PITCH.search(bare)
    ep_size = _EP_SIZE.search(bare)
    pins = _PIN_COUNT.match(bare)
    # The exposed-pad size always carries an `_EP` prefix, which the body
    # pattern cannot match, so the first hit is the body.
    body = _BODY.search(bare)

    if ep_size:
        exposed = {"x": float(ep_size.group(1)), "y": float(ep_size.group(2))}
    elif _EP_CLAIM.search(bare):
        exposed = "claimed"
    else:
        exposed = None

    return {
        "name": bare,
        "chip": {"imperial": chip.group(1), "metric": chip.group(2)} if chip else None,
        "pitch": float(pitch.group(1)) if pitch else None,
        "pinCount": float(pins.group(2)) if pins and pins.group(1).upper() in _PIN_COUNT_FAMILIES else None,
        "body": {"x": float(body.group(1)), "y": float(body.group(2))} if body else None,
        "exposedPad": exposed,
        "family": pins.group(1) if pins else None,
    }


# Nominal chip body sizes, imperial code → millimetres.
CHIP_SIZES: dict[str, dict[str, float]] = {
    "0201": {"x": 0.6, "y": 0.3},
    "0402": {"x": 1.0, "y": 0.5},
    "0603": {"x": 1.6, "y": 0.8},
    "0805": {"x": 2.0, "y": 1.25},
    "1206": {"x": 3.2, "y": 1.6},
    "1210": {"x": 3.2, "y": 2.5},
    "1812": {"x": 4.5, "y": 3.2},
    "2010": {"x": 5.0, "y": 2.5},
    "2220": {"x": 5.7, "y": 5.0},
    "2512": {"x": 6.3, "y": 3.2},
}
