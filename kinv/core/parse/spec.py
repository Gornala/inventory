"""One BOM line, read: its comparable spec, its key, its issues, and whether it is bought."""

from __future__ import annotations

import re
from typing import Callable, Iterable

from kinv.core.canonical import canonical_key
from kinv.core.parse.footprint import package_of, parse_footprint
from kinv.core.parse.refdes import CLASS_LETTER, class_of_ref
from kinv.core.parse.value import parse_value
from kinv.js import num_str

_PASSIVE_UNITS = {
    "resistor": "ohm",
    "thermistor": "ohm",  # nominal resistance at 25 °C
    "capacitor": "farad",
    "inductor": "henry",
    "ferrite": "ohm",  # impedance at a stated frequency; ohms is the sane base
}


def _family(cls: str) -> str:
    """Families that look alike on a board.

    A mismatch is only worth reporting when it crosses a family: an ``R`` on a
    ``Capacitor_SMD`` footprint is a real error, while a ``U`` on
    ``Package_TO_SOT_SMD:SOT-23-6`` is an everyday regulator.
    """
    if cls in ("ic", "transistor", "diode"):
        return "semiconductor"
    # A thermistor is a resistor-shaped part and lives on resistor land
    # patterns; it keys separately, but it is not a footprint error.
    if cls in ("resistor", "thermistor"):
        return "resistive"
    if cls in ("inductor", "ferrite", "transformer"):
        return "magnetics"
    # Modules, displays, batteries and sounders are built from whatever
    # footprint suits, so they never take part in the comparison.
    if cls in ("display", "battery", "antenna", "sounder", "module", "unknown"):
        return "unknown"
    return cls


def _is_two_terminal_chip(cls: str) -> bool:
    """Classes that live on generic two-terminal chip land patterns.

    Within this set a footprint from the "wrong" library is cosmetic: measured
    against the KiCad 10 libraries, same-size chip land patterns agree to
    within 0.075 mm of outer span. The part solders; what is wrong is the 3D
    model and the library intent.
    """
    return cls in ("resistor", "thermistor", "capacitor", "inductor", "ferrite", "diode")


def _article(word: str) -> str:
    """"a resistor" but "an inductor"."""
    return "an" if re.match(r"^[aeiou]", word, re.I) else "a"


def _looks_like_mpn(value: str) -> bool:
    """A manufacturer part number rather than a placeholder: ``IHLP6767GZER100M01``, not ``TBD``."""
    t = value.strip()
    return (
        len(t) >= 5
        and re.search("[A-Za-z]", t) is not None
        and re.search("[0-9]", t) is not None
        and re.search("[A-Za-z0-9]{5,}", t) is not None
    )


# Classes excluded by default: board features rather than bought parts.
DEFAULT_EXCLUDED_CLASSES = ("testpoint", "mounting")

# Field names a designer might put a real part number in.
PART_NUMBER_FIELDS = ["MPN", "PN", "Part Number", "PartNumber", "Manufacturer Part Number"]


def _has_part_number(line: dict) -> bool:
    for name, value in line["fields"].items():
        if value.strip() == "":
            continue
        if any(field.lower() == name.lower() for field in PART_NUMBER_FIELDS):
            return True
    return _looks_like_mpn(line["value"])


def analyze_line(line: dict, exclude_classes: Iterable[str] | None = None) -> dict:
    """``{line, spec, key, issues, resolved, excluded}`` for one BOM line."""
    issues: list[dict] = []
    resolved = False
    refs = line["refs"]

    def push(code: str, severity: str, message: str) -> None:
        issues.append({"code": code, "severity": severity, "message": message, "refs": refs})

    fp = parse_footprint(line["footprint"])
    if not fp:
        push("missing-footprint", "error", "no footprint assigned")

    ref_cls = class_of_ref(refs[0]) if refs else "unknown"
    fp_cls = fp["cls"] if fp else "unknown"

    if ref_cls != "unknown" and fp_cls != "unknown" and _family(ref_cls) != _family(fp_cls) and fp is not None:
        interchangeable = (
            fp["chip"] is not None and _is_two_terminal_chip(ref_cls) and _is_two_terminal_chip(fp_cls)
        )
        push(
            "class-mismatch",
            "warning" if interchangeable else "error",
            (
                f'{ref_cls} on a {fp_cls} land pattern ("{fp["raw"]}"). Same-size chip pads are '
                "interchangeable within 0.075 mm, so it will solder — but the 3D model and the "
                "library are wrong"
            )
            if interchangeable
            else f'reference designator says {ref_cls}, footprint "{fp["raw"]}" says {fp_cls}',
        )

    # The refdes is the more trustworthy of the two, since it is what the
    # designer typed deliberately; the footprint is what they picked from a list.
    cls = ref_cls if ref_cls != "unknown" else fp_cls

    if line["quantity"] != len(refs):
        push(
            "quantity-mismatch",
            "error",
            f"exported quantity {num_str(line['quantity'])} but {len(refs)} references listed",
        )

    # A test point with a part number is a real bought part; one without is a
    # pad on the board. Same for mounting holes.
    excluded_classes = DEFAULT_EXCLUDED_CLASSES if exclude_classes is None else tuple(exclude_classes)
    excluded = (
        f"{'mounting hole' if cls == 'mounting' else 'test point'} with no part number"
        if cls in excluded_classes and not _has_part_number(line)
        else None
    )

    unit = _PASSIVE_UNITS.get(cls)
    parsed = parse_value(line["value"])
    pkg = package_of(fp)

    if unit is not None:
        if line["value"].strip().upper() == CLASS_LETTER[cls]:
            push("placeholder-value", "error", f'value is the bare designator letter "{line["value"]}"')
        elif parsed["kind"] == "opaque":
            # A passive whose value is already a manufacturer part number is a
            # part someone has resolved by hand, not a broken value.
            if _looks_like_mpn(line["value"]):
                resolved = True
                push(
                    "pre-resolved",
                    "info",
                    f'"{line["value"].strip()}" is a specific part already — {_article(cls)} {cls} chosen '
                    "for power, size or precision gets picked before the generics do",
                )
            else:
                push("unparsable-value", "error", f'cannot read "{line["value"]}" as a {cls} value')
        elif parsed["bare"] and cls != "resistor":
            push(
                "ambiguous-bare-value",
                "warning",
                f'"{line["value"]}" has no unit; for a {cls} the magnitude is a guess',
            )

        if parsed["kind"] == "quantity":
            spec = {
                "kind": "generic",
                "cls": cls,
                "magnitude": parsed["magnitude"],
                "unit": unit,
                "pkg": pkg,
                "variant": fp["variant"] if fp else None,
            }
            return _analyzed(line, spec, issues, resolved, excluded)

    spec = {"kind": "specific", "cls": cls, "designator": line["value"].strip(), "pkg": pkg}
    return _analyzed(line, spec, issues, resolved, excluded)


def _analyzed(line: dict, spec: dict, issues: list, resolved: bool, excluded: str | None) -> dict:
    return {
        "line": line,
        "spec": spec,
        "key": canonical_key(spec),
        "issues": issues,
        "resolved": resolved,
        "excluded": excluded,
    }


def analyze_bom(lines: Iterable[dict], exclude_classes: Iterable[str] | None = None) -> list[dict]:
    return [analyze_line(line, exclude_classes) for line in lines]


def purchasable(lines: Iterable[dict]) -> list[dict]:
    """The lines that will actually be bought."""
    return [line for line in lines if line["excluded"] is None]


def apply_mountability(lines: Iterable[dict], mountable: Callable[[str], bool | None]) -> list[dict]:
    """Lets measured geometry overrule the name-based guess about what is a part.

    Measurement wins in both directions: it drops test pads no naming rule
    would catch, and it rescues a Würth SMD standoff the naming rule threw
    away for want of an MPN. Where nothing could be measured the guess stands.
    """
    out = []
    for line in lines:
        measured = mountable(line["line"]["footprint"].strip())
        if measured is None:
            out.append(line)
        elif measured:
            out.append(line if line["excluded"] is None else {**line, "excluded": None})
        else:
            reason = line["excluded"] or "footprint has no paste and no plated hole — nothing to solder"
            out.append({**line, "excluded": reason})
    return out


# The reason a part carries when you were the one who took it out.
NOT_BOUGHT_REASON = "marked do not buy"


def apply_buy_choices(lines: Iterable[dict], choice: Callable[[str], bool | None]) -> list[dict]:
    """Lets your own decision overrule both rules, in either direction."""
    out = []
    for line in lines:
        buy = choice(line["key"])
        if buy is None:
            out.append(line)
        elif buy:
            out.append(line if line["excluded"] is None else {**line, "excluded": None})
        else:
            out.append(line if line["excluded"] == NOT_BOUGHT_REASON else {**line, "excluded": NOT_BOUGHT_REASON})
    return out
