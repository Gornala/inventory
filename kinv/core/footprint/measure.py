"""Measuring a footprint from its pads: pitch, span, pad size, and how it attaches."""

from __future__ import annotations

import math
import re

from kinv.js import fixed_num, js_sorted, num_str

_COPPER_LAYER = re.compile(r"\.Cu\Z")


def pad_extents(pad: dict) -> dict:
    """How much space a pad takes along each axis once its rotation is applied.

    A side pad rotated 90 degrees occupies its width and height the other way
    round. Ignoring this drew a vendor QFN's side pads across each other as
    one solid bar.
    """
    # JavaScript's % keeps the dividend's sign; math.fmod does the same.
    angle = math.fmod(math.fmod(pad["angle"], 180) + 180, 180)
    if angle == 0:
        return {"w": pad["width"], "h": pad["height"]}
    if angle == 90:
        return {"w": pad["height"], "h": pad["width"]}
    radians = (angle * math.pi) / 180
    cos = abs(math.cos(radians))
    sin = abs(math.sin(radians))
    return {
        "w": pad["width"] * cos + pad["height"] * sin,
        "h": pad["width"] * sin + pad["height"] * cos,
    }


def is_copper_pad(pad: dict) -> bool:
    return any(_COPPER_LAYER.search(layer) or layer == "*.Cu" for layer in pad["layers"])


def is_pin(pad: dict) -> bool:
    """A pin: numbered and on copper. Excludes paste sub-pads and mounting holes."""
    return pad["number"].strip() != "" and is_copper_pad(pad)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = js_sorted(values, lambda a, b: a - b)
    mid = len(ordered) // 2
    return (ordered[mid - 1] + ordered[mid]) / 2 if len(ordered) % 2 == 0 else ordered[mid]


def _round(n: float, places: int = 4) -> float:
    return fixed_num(n, places)


def _measure_pitch(pads: list[dict]) -> float | None:
    """Pitch from the pads themselves: nearest-neighbour gaps along rows, then the median."""
    gaps: list[float] = []

    def collect(along: str, across: str) -> None:
        rows: dict[float, list[float]] = {}
        for pad in pads:
            rows.setdefault(_round(pad[across], 3), []).append(pad[along])
        for row in rows.values():
            if len(row) < 2:
                continue
            ordered = js_sorted(row, lambda a, b: a - b)
            for i in range(1, len(ordered)):
                gaps.append(_round(ordered[i] - ordered[i - 1]))

    collect("x", "y")  # horizontal rows
    collect("y", "x")  # vertical columns

    positive = [g for g in gaps if g > 0]
    return _median(positive) if positive else None


def _most_common_size(pads: list[dict]) -> dict | None:
    counts: dict[str, dict] = {}
    for pad in pads:
        key = f"{num_str(_round(pad['width'], 3))}x{num_str(_round(pad['height'], 3))}"
        slot = counts.get(key)
        if slot:
            slot["count"] += 1
        else:
            counts[key] = {"width": pad["width"], "height": pad["height"], "count": 1}
    ordered = js_sorted(counts.values(), lambda a, b: b["count"] - a["count"])
    return ordered[0] if ordered else None


def measure(all_pads: list[dict]) -> dict:
    pads = list(all_pads)
    pins = [p for p in pads if is_pin(p)]
    signal_size = _most_common_size(pins)

    # An exposed pad is a copper pin whose area dwarfs the signal pads, by
    # area, since EPs are often wide and short.
    signal_area = signal_size["width"] * signal_size["height"] if signal_size else 0
    exposed = [p for p in pins if signal_area > 0 and p["width"] * p["height"] > signal_area * 4]
    # identity, not equality: two identical pads are still two pads
    exposed_ids = {id(p) for p in exposed}
    signal_pins = [p for p in pins if id(p) not in exposed_ids]

    xs: list[float] = []
    ys: list[float] = []
    for pad in pins:
        extent = pad_extents(pad)
        xs += [pad["x"] - extent["w"] / 2, pad["x"] + extent["w"] / 2]
        ys += [pad["y"] - extent["h"] / 2, pad["y"] + extent["h"] / 2]

    # Paste and holes across every pad, not only numbered pins: an unnumbered
    # NPTH is still a hole, and a paste-only aperture still puts solder there.
    has_paste = any(layer.endswith(".Paste") for p in pads for layer in p["layers"])
    # A *plated* hole. A screw goes through an np_thru_hole; nothing solders to it.
    has_hole = any(p["drill"] is not None and p["drill"] > 0 and p["type"] != "np_thru_hole" for p in pads)

    if has_paste and has_hole:
        mounting = "smd+through-hole"  # stuck in, then reflowed: pin-in-paste
    elif has_paste:
        mounting = "smd"
    elif has_hole:
        mounting = "through-hole"
    else:
        mounting = "nothing-to-solder"

    shapes: dict[str, None] = {}
    for pad in pins:
        if pad["shape"] != "":
            shapes[pad["shape"]] = None
    drills: dict[float, None] = {}
    for pad in pads:
        if pad["drill"] is not None:
            drills[pad["drill"]] = None

    return {
        "padCount": len(pins),
        "distinctPads": len({p["number"] for p in pins}),
        # From the signal pins only: an exposed pad in the middle would
        # otherwise invent a gap no datasheet mentions.
        "pitch": _measure_pitch(signal_pins),
        "span": {
            "x": _round(max(xs) - min(xs)) if xs else 0,
            "y": _round(max(ys) - min(ys)) if ys else 0,
        },
        "padSize": {"width": signal_size["width"], "height": signal_size["height"]} if signal_size else None,
        "exposedPads": [{"width": p["width"], "height": p["height"]} for p in exposed],
        # The stencil sub-pads KiCad adds to break up a big thermal pad.
        "pasteOnlyPads": len([p for p in pads if not is_copper_pad(p) and "F.Paste" in p["layers"]]),
        "mechanicalPads": len([p for p in pads if p["number"].strip() == "" and is_copper_pad(p)]),
        "mounting": mounting,
        "shapes": list(shapes),
        "pinsWithPaste": len([p for p in pins if any(layer.endswith(".Paste") for layer in p["layers"])]),
        "drills": js_sorted(drills, lambda a, b: a - b),
    }
