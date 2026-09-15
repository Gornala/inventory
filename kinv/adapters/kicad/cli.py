"""Exporting a BOM through ``kicad-cli``, which walks the hierarchy the way KiCad does."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from kinv.adapters.kicad.bom import parse_bom_csv
from kinv.adapters.kicad.fields import project_field_names
from kinv.adapters.kicad.hierarchy import read_text
from kinv.js import collation_key

# Always requested, in this order. The generated columns come last.
_NAMED_FIELDS = ["Reference", "Value", "Footprint", "Datasheet", "Description"]
_GENERATED_FIELDS = ["${QUANTITY}", "${DNP}"]


def _bom_fields(schematic: str) -> str:
    """The ``--fields`` list: the fixed columns plus every custom field on a symbol."""
    return ",".join([*_NAMED_FIELDS, *project_field_names(schematic), *_GENERATED_FIELDS])


def find_kicad_cli() -> str | None:
    """The KINV_KICAD_CLI override, then the Windows install root (newest first), then PATH."""
    override = os.environ.get("KINV_KICAD_CLI")
    if override:
        return override if os.path.exists(override) else None

    root = "C:/Program Files/KiCad"
    if os.path.exists(root):
        versions = [v for v in os.listdir(root) if os.path.exists(os.path.join(root, v, "bin/kicad-cli.exe"))]
        versions.sort(key=lambda v: collation_key(v, numeric=True), reverse=True)
        if versions:
            return os.path.join(root, versions[0], "bin/kicad-cli.exe")

    return "kicad-cli.exe" if os.name == "nt" else "kicad-cli"


def root_schematic(project_path: str) -> str:
    """Root schematic for a project path (``.kicad_pro`` or ``.kicad_sch``)."""
    stem, ext = os.path.splitext(project_path)
    if ext == ".kicad_sch":
        return project_path
    if ext == ".kicad_pro":
        sch = f"{stem}.kicad_sch"
        if not os.path.exists(sch):
            raise FileNotFoundError(f"no schematic beside the project: expected {sch}")
        return sch
    raise ValueError(f"not a KiCad project or schematic: {project_path}")


def export_bom(project_path: str, group_by: str | None = None, exclude_dnp: bool = False) -> list[dict]:
    """A BOM for the whole schematic hierarchy, in one kicad-cli call.

    Reading goes through kicad-cli rather than parsing ``.kicad_sch`` because
    it resolves the hierarchy, instance paths and inherited fields exactly the
    way KiCad itself does — the parts most likely to drift between versions.
    """
    cli = find_kicad_cli()
    if not cli:
        raise FileNotFoundError("kicad-cli not found; set KINV_KICAD_CLI to its path")

    schematic = root_schematic(project_path)
    work = tempfile.mkdtemp(prefix="kinv-")
    out = os.path.join(work, "bom.csv")
    try:
        command = [cli, "sch", "export", "bom", "--fields", _bom_fields(schematic), "-o", out]
        if group_by is not None:
            command += ["--group-by", group_by]
        if exclude_dnp:
            command.append("--exclude-dnp")
        command.append(schematic)

        creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, creationflags=creation)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).decode("utf8", errors="replace").strip()
            raise RuntimeError(f"kicad-cli failed ({result.returncode}): {detail}")
        return parse_bom_csv(read_text(out), os.path.dirname(schematic))
    finally:
        shutil.rmtree(work, ignore_errors=True)
