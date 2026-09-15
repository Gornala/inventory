"""The footprint's name against the footprint's pads.

Pitch and pad count are exact facts and disagreeing about them is an error.
Absolute sizes are advisory: a land pattern is deliberately larger than the
package body by an IPC-density-dependent margin, so calling "pads span 7.9 mm"
on a 7 mm body a defect produces a checker nobody trusts.
"""

from __future__ import annotations

from kinv.core.footprint.name import CHIP_SIZES
from kinv.js import num_str, to_fixed

_PITCH_TOLERANCE = 0.02  # mm — generous against rounding in names


def check_footprint(declared: dict, measured: dict) -> list[dict]:
    findings: list[dict] = []

    if declared["pitch"] is not None and measured["pitch"] is not None:
        delta = abs(declared["pitch"] - measured["pitch"])
        if delta > _PITCH_TOLERANCE:
            findings.append(
                {
                    "code": "pitch-mismatch",
                    "severity": "error",
                    "message": f"name says {num_str(declared['pitch'])} mm pitch, pads measure "
                    f"{to_fixed(measured['pitch'], 3)} mm ({to_fixed(delta, 3)} mm out)",
                }
            )

    if declared["pinCount"] is not None:
        # Distinct numbers, not pad instances: a power MOSFET spreads one drain
        # across several pads that all carry the same number.
        signal = measured["distinctPads"] - len(measured["exposedPads"])
        if signal == declared["pinCount"] + 1:
            # A thermal pad given a pin number of its own: true, not a defect.
            findings.append(
                {
                    "code": "extra-thermal-pad",
                    "severity": "info",
                    "message": f"name says {num_str(declared['pinCount'])} pins and there are {signal} numbered pads — "
                    "the extra one is normally a thermal pad numbered as a pin",
                }
            )
        elif signal != declared["pinCount"]:
            extra = f" plus {len(measured['exposedPads'])} exposed" if measured["exposedPads"] else ""
            findings.append(
                {
                    "code": "pin-count-mismatch",
                    "severity": "error",
                    "message": f"name says {num_str(declared['pinCount'])} pins, footprint has {signal} numbered pads{extra}",
                }
            )

    if declared["exposedPad"] is not None and not measured["exposedPads"]:
        findings.append(
            {"code": "exposed-pad-missing", "severity": "error", "message": "name claims an exposed pad, none measured"}
        )
    # Deliberately no "unexpected exposed pad" finding: large pads are ordinary
    # (MOSFET drain paddles, USB shield tabs), and reporting them produced six
    # findings on the reference board, none of them defects.

    # Advisory only, and only for chip packages, where the nominal body size
    # is a fixed number rather than an IPC allowance.
    nominal = CHIP_SIZES.get(declared["chip"]["imperial"]) if declared["chip"] else None
    if nominal and measured["span"]["x"] > 0 and measured["span"]["x"] < nominal["x"]:
        imperial = declared["chip"]["imperial"] if declared["chip"] else ""
        findings.append(
            {
                "code": "body-vs-pads",
                "severity": "warning",
                "message": f"pads span {num_str(measured['span']['x'])} mm across, narrower than the "
                f"{num_str(nominal['x'])} mm nominal {imperial} body",
            }
        )

    return findings


def check_pin_numbers(symbol_pins: list[str], pad_numbers: list[str]) -> list[dict]:
    """Symbol pins against footprint pads — needs no footprint library at all."""
    if not symbol_pins or not pad_numbers:
        return []
    pads = set(pad_numbers)
    missing = [p for p in dict.fromkeys(symbol_pins) if p not in pads]
    if not missing:
        return []
    return [
        {
            "code": "symbol-pin-mismatch",
            "severity": "error",
            "message": f"{len(missing)} symbol pin(s) have no matching pad: "
            + ", ".join(missing[:8])
            + (" …" if len(missing) > 8 else ""),
        }
    ]
