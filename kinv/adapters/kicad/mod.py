"""Reading a ``.kicad_mod`` footprint: its pads and its courtyard."""

from __future__ import annotations

import math

from kinv.adapters.kicad.hierarchy import read_text
from kinv.adapters.kicad.sexpr import List, args, child, children, head, numbers, parse_sexpr


def _first(values: list, default=None):
    return values[0] if values else default


def _pad_of(node: List) -> dict:
    positional = args(node)
    number = positional[0] if len(positional) > 0 else ""
    kind = positional[1] if len(positional) > 1 else ""
    shape = positional[2] if len(positional) > 2 else ""
    at = numbers(child(node, "at"))
    size = numbers(child(node, "size"))
    drill = child(node, "drill")

    return {
        "number": number,
        "type": kind,
        "shape": shape,
        "x": at[0] if len(at) > 0 else 0,
        "y": at[1] if len(at) > 1 else 0,
        "width": size[0] if len(size) > 0 else 0,
        "height": size[1] if len(size) > 1 else 0,
        "angle": at[2] if len(at) > 2 else 0,
        "layers": args(child(node, "layers")),
        "drill": _first(numbers(drill)) if drill is not None else None,
        "roundrectRatio": _first(numbers(child(node, "roundrect_rratio"))),
    }


def _layer_bounds(root: List, layer: str) -> dict | None:
    """Bounding box of every graphic on a layer, across lines, rects and polys."""
    min_x = min_y = math.inf
    max_x = max_y = -math.inf

    stack = [root]
    while stack:
        node = stack.pop()
        kind = head(node)
        if kind is not None and kind.startswith("fp_"):
            if _first(args(child(node, "layer"))) == layer:
                for key in ("start", "end", "center", "mid"):
                    point = numbers(child(node, key))
                    if len(point) >= 2:
                        x, y = point[0], point[1]
                        min_x, max_x = min(min_x, x), max(max_x, x)
                        min_y, max_y = min(min_y, y), max(max_y, y)
        # children pushed in reverse keeps the visit order, which min/max do
        # not care about, but a reader of the loop might
        stack.extend(reversed([item for item in node.items if isinstance(item, List)]))

    if not math.isfinite(min_x) or not math.isfinite(min_y):
        return None
    return {"x": min_x, "y": min_y, "width": max_x - min_x, "height": max_y - min_y}


def parse_footprint_file(text: str) -> dict:
    root = parse_sexpr(text)
    if head(root) != "footprint":
        raise ValueError("not a footprint file")
    return {
        "name": _first(args(root), ""),
        "version": _first(args(child(root, "version"))),
        "descr": _first(args(child(root, "descr"))),
        "attr": args(child(root, "attr")),
        "pads": [_pad_of(pad) for pad in children(root, "pad")],
        "courtyard": _layer_bounds(root, "F.CrtYd"),
    }


def read_footprint_file(path: str) -> dict:
    return parse_footprint_file(read_text(path))
