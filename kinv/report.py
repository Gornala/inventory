"""The whole reading of a board, in the shape the page and every command consume."""

from __future__ import annotations

import os
import threading
from typing import Callable

from kinv.adapters.kicad.bom import read_bom_csv
from kinv.adapters.kicad.cli import export_bom
from kinv.adapters.kicad.hierarchy import project_sheets_or_directory
from kinv.adapters.kicad.libraries import library_table, resolve_footprint
from kinv.adapters.kicad.mod import read_footprint_file
from kinv.adapters.store.inventory import inventory_signature, read_assignments, read_catalog
from kinv.adapters.store.project_state import buy_signature, read_buy_choices, read_solved, solved_signature
from kinv.core.consolidate.findings import compare_columns, consolidate, parts_by_key
from kinv.core.consolidate.identity import finding_id, finding_signature
from kinv.core.footprint.audit import audit_footprints
from kinv.core.footprint.check import check_footprint
from kinv.core.footprint.measure import measure
from kinv.core.footprint.name import parse_footprint_name
from kinv.core.inventory.package_check import package_issues
from kinv.core.inventory.resolve import now_iso, resolve_parts
from kinv.core.parse.spec import analyze_bom, apply_buy_choices, apply_mountability
from kinv.js import js_sorted, num_str


def source_signature(project: str) -> str:
    """A cheap fingerprint of the project's schematics, so kicad-cli only runs when something changed.

    Modification time *and* total size: a hierarchy save writes every sheet at
    once, and on a fast disk several can share a timestamp.
    """
    try:
        if os.path.splitext(project)[1].lower() == ".csv":
            stat = os.stat(project)
            return f"{num_str(stat.st_mtime_ns / 1e6)}:{stat.st_size}"
        directory = os.path.dirname(project) or "."
        if not os.path.exists(directory):
            return ""

        # Only the sheets the design is made of. KiCad's `_autosave-*` files
        # change on a timer and would re-export the BOM for an edit nobody made.
        sheets = project_sheets_or_directory(
            project,
            [os.path.join(directory, name) for name in os.listdir(directory) if name.endswith(".kicad_sch")],
        )
        newest = 0.0
        size = 0
        files = 0
        for path in sheets:
            stat = os.stat(path)
            newest = max(newest, stat.st_mtime_ns / 1e6)
            size += stat.st_size
            files += 1
        return "" if files == 0 else f"{num_str(newest)}:{size}:{files}"
    except OSError:
        return ""


def load_project(project: str, group_by: str | None = None, exclude_dnp: bool = False, include_excluded: bool = False) -> list[dict]:
    """A ``.csv`` is read directly; anything else goes through kicad-cli."""
    if project.lower().endswith(".csv"):
        lines = read_bom_csv(project)
    else:
        lines = export_bom(project, group_by=group_by, exclude_dnp=exclude_dnp)
    return analyze_bom(lines, [] if include_excluded else None)


def analyze_project(
    project: str,
    group_by: str | None = None,
    exclude_dnp: bool = False,
    include_excluded: bool = False,
) -> tuple[list[dict], list[dict]]:
    """Reads the board the way every command must read it: one reading, one answer."""
    raw = load_project(project, group_by=group_by, exclude_dnp=exclude_dnp, include_excluded=include_excluded)

    # Footprint libraries are read straight from disk; a library that has gone
    # missing must degrade to "cannot verify", never take the report down.
    try:
        table = library_table(project)

        def pads(reference: str):
            path = resolve_footprint(reference, table)
            return None if path is None else read_footprint_file(path)["pads"]

        footprints = audit_footprints(raw, pads)
    except Exception:  # noqa: BLE001 — any failure here means "cannot verify"
        footprints = []

    # Geometry overrules the class-and-part-number guess in both directions;
    # your own decisions overrule both. `--include-excluded` sets all aside.
    mountability = {f["reference"]: f["mountable"] for f in footprints if not f["unresolved"]}
    choices = {c["key"]: c["buy"] for c in read_buy_choices(project)}
    if include_excluded:
        lines = raw
    else:
        lines = apply_buy_choices(apply_mountability(raw, mountability.get), choices.get)
    return lines, footprints


def build_report(
    project: str,
    group_by: str | None = None,
    exclude_dnp: bool = False,
    near_value_percent: float | None = None,
    include_excluded: bool = False,
) -> dict:
    signature = source_signature(project)
    lines, footprints = analyze_project(project, group_by, exclude_dnp, include_excluded)

    found = consolidate(lines, near_value_percent)

    # A mark holds only while the finding still says what it said when it was settled.
    marks = {m["id"]: m for m in read_solved(project)}
    identified = [{**f, "id": finding_id(f), "signature": finding_signature(f)} for f in found]
    settled = [f for f in identified if marks.get(f["id"], {}).get("signature") == f["signature"]]
    settled_ids = {f["id"] for f in settled}
    findings = [f for f in identified if f["id"] not in settled_ids]

    parts = parts_by_key(lines)
    resolutions = resolve_parts(parts, read_catalog(), read_assignments())
    issues = [*(issue for line in lines for issue in line["issues"]), *package_issues(parts, resolutions)]

    bought = [line for line in lines if line["excluded"] is None]
    left_out = [line for line in lines if line["excluded"] is not None]
    columns: dict[str, None] = {}
    for part in parts:
        for name in part["fields"]:
            columns[name] = None

    def with_solved_at(f: dict) -> dict:
        at = marks.get(f["id"], {}).get("at")
        return f if at is None else {**f, "solvedAt": at}

    return {
        "project": project,
        "generatedAt": now_iso(),
        "sourceSignature": signature,
        "summary": {
            # Placements and lines count what will be bought; the excluded ones
            # are reported separately rather than silently folded in.
            "placements": sum(len(line["line"]["refs"]) for line in bought),
            "lines": len(bought),
            "parts": len(parts),
        },
        "counts": {
            "errors": len([i for i in issues if i["severity"] == "error"]),
            "warnings": len([i for i in issues if i["severity"] == "warning"]),
            "infos": len([i for i in issues if i["severity"] == "info"]),
            "findings": len(findings),
            "settled": len(settled),
            "assigned": len([r for r in resolutions if r["assignment"] is not None]),
            "resolved": len([p for p in parts if p["resolved"]]),
            "excluded": sum(len(line["line"]["refs"]) for line in left_out),
            "footprintFindings": sum(len(f["findings"]) for f in footprints),
        },
        "findings": findings,
        "settled": [with_solved_at(f) for f in settled],
        "issues": issues,
        "parts": parts,
        "partColumns": js_sorted(columns, compare_columns),
        "resolutions": resolutions,
        "footprints": footprints,
        "excluded": [
            {
                "key": line["key"],
                "value": line["line"]["value"],
                "footprint": line["line"]["footprint"],
                "reason": line["excluded"],
                "refs": line["line"]["refs"],
            }
            for line in left_out
        ],
    }


def create_report_cache(project: str, **options) -> Callable[[], dict]:
    """Rebuilds only when the schematics, the catalog or a decision have changed.

    Thread-safe: the server answers requests on several threads, and two polls
    arriving together must share one kicad-cli run rather than start two.
    """
    lock = threading.Lock()
    state: dict = {"report": None, "signature": None}

    def get() -> dict:
        # Stamped with the signature as it was *before* the build: a save that
        # lands while the build runs is still a change next time.
        signature = f"{source_signature(project)}|{solved_signature(project)}|{buy_signature(project)}|{inventory_signature()}"
        with lock:
            if state["report"] is not None and state["signature"] == signature:
                return state["report"]
            report = build_report(project, **options)
            state["report"] = report
            state["signature"] = signature
            return report

    return get


def footprint_detail(project: str, reference: str) -> dict | None:
    """Everything the browser needs to draw one footprint and measure on it."""
    path = resolve_footprint(reference, library_table(project))
    if path is None:
        return None
    file = read_footprint_file(path)
    measured = measure(file["pads"])
    declared = parse_footprint_name(reference)
    return {
        "reference": reference,
        "name": file["name"],
        "path": path,
        "pads": file["pads"],
        "courtyard": file["courtyard"],
        "measured": measured,
        "declared": declared,
        "findings": check_footprint(declared, measured),
    }
