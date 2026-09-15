"""Every distinct footprint a BOM uses, measured once and checked against its name."""

from __future__ import annotations

from typing import Callable, Iterable

from kinv.core.footprint.check import check_footprint
from kinv.core.footprint.measure import measure
from kinv.core.footprint.name import parse_footprint_name
from kinv.js import code_units, js_sorted

PadSource = Callable[[str], "list[dict] | None"]


def audit_footprints(lines: Iterable[dict], pads: PadSource) -> list[dict]:
    """Distinct, not per placement: measuring ``C_0603`` 58 times says the same thing 58 times."""
    used: dict[str, dict] = {}
    for line in lines:
        reference = line["line"]["footprint"].strip()
        if reference == "":
            continue
        slot = used.setdefault(reference, {"keys": {}, "refs": []})
        slot["keys"][line["key"]] = None
        slot["refs"].extend(line["line"]["refs"])

    audits: list[dict] = []
    for reference, slot in used.items():
        declared = parse_footprint_name(reference)
        found = pads(reference)
        keys = sorted(slot["keys"], key=code_units)

        # `is None`, not `not found`: JavaScript's `!found` is only true for a
        # footprint that was not found, and an empty pad list is truthy there.
        if found is None:
            audits.append(
                {
                    "reference": reference,
                    "keys": keys,
                    "refs": slot["refs"],
                    "placements": len(slot["refs"]),
                    "declared": declared,
                    "measured": None,
                    "unresolved": True,
                    "mountable": True,  # unknown, so give it the benefit of the doubt
                    "findings": [
                        {
                            "code": "pin-count-mismatch",
                            "severity": "warning",
                            "message": "footprint not found in any library — cannot verify it",
                        }
                    ],
                }
            )
            continue

        measured = measure(found)
        audits.append(
            {
                "reference": reference,
                "keys": keys,
                "refs": slot["refs"],
                "placements": len(slot["refs"]),
                "declared": declared,
                "measured": measured,
                "unresolved": False,
                "mountable": measured["mounting"] != "nothing-to-solder",
                "findings": check_footprint(declared, measured),
            }
        )

    return js_sorted(audits, lambda a, b: b["placements"] - a["placements"])


def count_footprint_findings(audits: Iterable[dict]) -> dict[str, int]:
    counts = {"error": 0, "warning": 0, "info": 0}
    for audit in audits:
        for finding in audit["findings"]:
            counts[finding["severity"]] += 1
    return counts
