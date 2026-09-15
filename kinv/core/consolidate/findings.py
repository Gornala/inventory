"""The consolidation report: duplicates, near-values, and the question that started it all."""

from __future__ import annotations

from typing import Iterable

from kinv.core.canonical import search_label
from kinv.core.units import format_magnitude
from kinv.js import code_units, collation_key, js_sorted, locale_compare

__all__ = [
    "FIELD_JOIN",
    "compare_columns",
    "consolidate",
    "distinct_parts",
    "parts_by_key",
]


def _placements(lines: Iterable[dict]) -> int:
    return sum(len(line["line"]["refs"]) for line in lines)


def _refs(lines: Iterable[dict]) -> list[str]:
    return [ref for line in lines for ref in line["line"]["refs"]]


def _group_by_key(lines: Iterable[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = {}
    for line in lines:
        buckets.setdefault(line["key"], []).append(line)
    return [
        {"key": key, "lines": ls, "placements": _placements(ls), "refs": _refs(ls)}
        for key, ls in buckets.items()
    ]


def _value_key(spec: dict) -> str:
    """Generic specs only, keyed by class and magnitude so packages can be compared."""
    return f"{spec['cls']}|{format_magnitude(spec['magnitude'])}"


def _by(lines: Iterable[dict], field) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = {}
    for line in lines:
        buckets.setdefault(field(line), []).append(line)
    return buckets


def _duplicate_spellings(groups: list[dict]) -> list[dict]:
    out = []
    for group in groups:
        by_value = _by(group["lines"], lambda line: line["line"]["value"].strip())
        if len(by_value) < 2:
            continue
        spellings = [
            {"value": value, "placements": _placements(ls), "refs": _refs(ls)}
            for value, ls in by_value.items()
        ]
        out.append(
            {
                "kind": "duplicate-spelling",
                "key": group["key"],
                "spellings": js_sorted(spellings, lambda a, b: b["placements"] - a["placements"]),
                "placements": group["placements"],
                "linesSaved": len(by_value) - 1,
            }
        )
    return out


def _mixed_footprints(groups: list[dict]) -> list[dict]:
    out = []
    for group in groups:
        by_footprint = _by(group["lines"], lambda line: line["line"]["footprint"].strip())
        if len(by_footprint) < 2:
            continue
        footprints = [
            {"footprint": footprint, "placements": _placements(ls), "refs": _refs(ls)}
            for footprint, ls in by_footprint.items()
        ]
        out.append(
            {
                "kind": "mixed-footprint",
                "key": group["key"],
                "footprints": js_sorted(footprints, lambda a, b: b["placements"] - a["placements"]),
            }
        )
    return out


def _multi_package(lines: list[dict]) -> list[dict]:
    by_value = _by((line for line in lines if line["spec"]["kind"] == "generic"), lambda l: _value_key(l["spec"]))

    out = []
    for ls in by_value.values():
        by_pkg = _by(ls, lambda line: line["spec"]["pkg"] if line["spec"]["pkg"] is not None else "?")
        if len(by_pkg) < 2:
            continue

        groups = js_sorted(
            [{"pkg": pkg, "placements": _placements(group), "refs": _refs(group)} for pkg, group in by_pkg.items()],
            lambda a, b: (b["placements"] - a["placements"]) or locale_compare(a["pkg"], b["pkg"]),
        )
        spec = ls[0]["spec"]
        out.append(
            {
                "kind": "multi-package",
                "cls": spec["cls"],
                "value": format_magnitude(spec["magnitude"]),
                "unit": spec["unit"],
                "groups": groups,
                "suggested": groups[0]["pkg"],
                # A tie means the tool has no basis to prefer either size; say so
                # rather than presenting an arbitrary pick as a recommendation.
                "tied": len(groups) > 1 and groups[0]["placements"] == groups[1]["placements"],
                "linesSaved": len(groups) - 1,
            }
        )
    return out


def _magnitudes_by_class(lines: list[dict]) -> dict[str, dict[float, dict]]:
    """By class and then by *magnitude*, deliberately not by key.

    10k in 0402 and 10k in 0603 are the multi-package finding, not a
    near-value one.
    """
    by_class: dict[str, dict[float, dict]] = {}
    for line in lines:
        spec = line["spec"]
        # 0R has no meaningful neighbourhood: everything is infinitely far from it.
        if spec["kind"] != "generic" or spec["magnitude"] == 0:
            continue
        magnitudes = by_class.setdefault(spec["cls"], {})
        slot = magnitudes.setdefault(spec["magnitude"], {"refs": [], "keys": {}})
        slot["refs"].extend(line["line"]["refs"])
        slot["keys"][line["key"]] = True  # an insertion-ordered set
    return by_class


def _near_values(lines: list[dict], percent: float) -> list[dict]:
    out = []
    for cls, magnitudes in _magnitudes_by_class(lines).items():
        ordered = js_sorted(magnitudes.items(), lambda a, b: a[0] - b[0])

        # Walk the sorted values, collecting runs where each step is within
        # tolerance of the last. 49.9k -> 50k -> 51k chains into one finding.
        run: list[tuple[float, dict]] = []

        def flush() -> None:
            if len(run) >= 2:
                lo, hi = run[0][0], run[-1][0]
                out.append(
                    {
                        "kind": "near-value",
                        "cls": cls,
                        "members": [
                            {
                                "key": " ".join(sorted(slot["keys"], key=code_units)),
                                "value": format_magnitude(magnitude),
                                "placements": len(slot["refs"]),
                                "refs": slot["refs"],
                            }
                            for magnitude, slot in run
                        ],
                        "spreadPercent": ((hi - lo) / lo) * 100,
                    }
                )

        for entry in ordered:
            if run and ((entry[0] - run[-1][0]) / run[-1][0]) * 100 <= percent:
                run.append(entry)
            else:
                flush()
                run = [entry]
        flush()
    return out


def _singletons(groups: list[dict]) -> list[dict]:
    out = []
    for group in groups:
        if group["placements"] != 1:
            continue
        line = group["lines"][0]
        # Only generics: you can swap a lone 82k for an 80.6k you already
        # stock, but a board with one RP2040 is not a consolidation opportunity.
        if line["spec"]["kind"] != "generic":
            continue
        out.append(
            {
                "kind": "singleton",
                "key": group["key"],
                "cls": line["spec"]["cls"],
                "value": line["line"]["value"].strip(),
                "ref": group["refs"][0],
            }
        )
    return out


def consolidate(lines: Iterable[dict], near_value_percent: float | None = None) -> list[dict]:
    percent = 2 if near_value_percent is None else near_value_percent
    # Excluded lines never reach the report: a board with 8 test points should
    # not produce eight "used once" findings about pads you cannot buy.
    buyable = [line for line in lines if line["excluded"] is None]
    groups = _group_by_key(buyable)
    return [
        *_duplicate_spellings(groups),
        *_mixed_footprints(groups),
        *_multi_package(buyable),
        *_near_values(buyable, percent),
        *_singletons(groups),
    ]


# `Description` and `Datasheet` are BOM columns like any other, and read best last.
_TRAILING_COLUMNS = ["Description", "Datasheet"]

# What separates two spellings' disagreeing values in a merged field:
# `RC0402FR-0710KL · RC0603FR-0710KL` is two parts arguing, not an MPN.
FIELD_JOIN = " · "


def _bom_fields(lines: list[dict]) -> dict[str, str]:
    """The BOM's own columns for one part, disagreements joined rather than hidden."""
    collected: dict[str, list[str]] = {}

    def add(name: str, value: str | None) -> None:
        trimmed = (value or "").strip()
        if trimmed == "":
            return
        seen = collected.get(name)
        if seen is None:
            collected[name] = [trimmed]
        elif trimmed not in seen:
            seen.append(trimmed)

    for line in lines:
        for name, value in line["line"]["fields"].items():
            add(name, value)
        add("Description", line["line"]["description"])
        add("Datasheet", line["line"]["datasheet"])

    return {name: FIELD_JOIN.join(collected[name]) for name in js_sorted(collected.keys(), compare_columns)}


def compare_columns(a: str, b: str) -> int:
    """Custom fields first, alphabetically and case-insensitively; the long prose last."""

    def rank(name: str) -> int:
        return _TRAILING_COLUMNS.index(name) + 1 if name in _TRAILING_COLUMNS else 0

    by_rank = rank(a) - rank(b)
    if by_rank:
        return by_rank
    by_name = locale_compare(a, b, base=True)
    if by_name:
        return by_name
    return -1 if a < b else 1 if a > b else 0


def parts_by_key(lines: Iterable[dict]) -> list[dict]:
    """One row per distinct part."""
    rows = []
    for group in _group_by_key(line for line in lines if line["excluded"] is None):
        first = group["lines"][0]
        spec = first["spec"]
        rows.append(
            {
                "key": group["key"],
                "label": search_label(spec),
                "cls": spec["cls"],
                "value": format_magnitude(spec["magnitude"]) if spec["kind"] == "generic" else spec["designator"],
                "pkg": spec["pkg"] if spec["pkg"] is not None else "?",
                "placements": group["placements"],
                "refs": group["refs"],
                "sources": [
                    {
                        "value": line["line"]["value"].strip(),
                        "footprint": line["line"]["footprint"],
                        "refs": line["line"]["refs"],
                        "dnp": line["line"]["dnp"],
                    }
                    for line in group["lines"]
                ],
                "issueCount": sum(len(line["issues"]) for line in group["lines"]),
                "fields": _bom_fields(group["lines"]),
                "resolved": spec["kind"] == "specific" and any(line["resolved"] for line in group["lines"]),
            }
        )
    # most placements first, then by key as localeCompare orders it
    return sorted(rows, key=lambda p: (-p["placements"], collation_key(p["key"])))


def distinct_parts(lines: Iterable[dict]) -> int:
    """Distinct parts once every free merge has been taken."""
    return len({line["key"] for line in lines})
