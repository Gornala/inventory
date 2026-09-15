"""Footprint library tables: where ``Library:Footprint`` lives on disk."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from kinv.adapters.kicad.hierarchy import read_text
from kinv.adapters.kicad.sexpr import args, child, children, parse_sexpr
from kinv.js import collation_key


def _newest_first(names: list[str]) -> list[str]:
    return sorted(names, key=lambda v: collation_key(v, numeric=True), reverse=True)


def _kicad_roots() -> list[str]:
    """KiCad install roots: the one kinv was pointed at, then the usual places, newest first."""
    roots: list[str] = []
    pointed = os.environ.get("KINV_KICAD_ROOT")
    if pointed:
        roots.append(pointed)
    cli = os.environ.get("KINV_KICAD_CLI")
    if cli:
        # <root>/bin/kicad-cli.exe, /usr/bin/kicad-cli, KiCad.app/Contents/MacOS/kicad-cli: two up is
        # the root. The KiCad plugin sets this from KiCad itself, so an install anywhere is found.
        roots.append(os.path.dirname(os.path.dirname(os.path.abspath(cli))))
    base = "C:/Program Files/KiCad"
    if os.path.exists(base):
        roots.extend(os.path.join(base, version) for version in _newest_first(os.listdir(base)))
    for unix in ("/usr/share/kicad", "/usr/local/share/kicad"):
        if os.path.exists(unix):
            roots.append(os.path.dirname(os.path.dirname(unix)))
    mac = "/Applications/KiCad/KiCad.app/Contents"
    if os.path.exists(mac):
        roots.append(mac)
    return roots


def _install_dirs(root: str, kind: str) -> list[str]:
    """Where an install keeps ``footprints``, ``symbols`` or ``3dmodels``: share/kicad, or SharedSupport on macOS."""
    return [os.path.join(root, "share/kicad", kind), os.path.join(root, "SharedSupport", kind)]


_VAR = re.compile(r"\$\{([^}]+)\}")


def resolve_vars(uri: str) -> str:
    """Resolves ``${KICAD9_FOOTPRINT_DIR}`` and friends.

    These rarely exist in the process environment — KiCad keeps them in
    ``kicad_common.json`` and falls back to built-in defaults — and a KiCad 10
    install can carry a table written by KiCad 9, so the version in the
    variable name is deliberately ignored when falling back.
    """

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        from_env = os.environ.get(name)
        if from_env:
            return from_env
        from_config = _config_vars().get(name)
        if from_config:
            return from_config

        kind = (
            "footprints"
            if name.endswith("FOOTPRINT_DIR")
            else "symbols"
            if name.endswith("SYMBOL_DIR")
            else "3dmodels"
            if name.endswith("3DMODEL_DIR")
            else None
        )
        if kind:
            for root in _kicad_roots():
                for candidate in _install_dirs(root, kind):
                    if os.path.exists(candidate):
                        return candidate
        return match.group(0)

    return _VAR.sub(replace, uri)


_config_cache: dict[str, str] | None = None


def _config_vars() -> dict[str, str]:
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    merged: dict[str, str] = {}
    for directory in kicad_config_dirs():
        file = os.path.join(directory, "kicad_common.json")
        if not os.path.exists(file):
            continue
        try:
            parsed = json.loads(read_text(file))
            variables = parsed.get("environment", {}).get("vars") if isinstance(parsed, dict) else None
            if isinstance(variables, dict):
                # the newest version's config, read first, wins
                merged = {**variables, **merged}
        except (OSError, ValueError, AttributeError):
            pass  # a malformed config is not this tool's problem to report
    _config_cache = merged
    return merged


def kicad_config_dirs() -> list[str]:
    """KiCad's per-user config directories, newest version first."""
    home = str(Path.home())
    if sys.platform == "win32":
        roots = [os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData/Roaming"), "kicad")]
    elif sys.platform == "darwin":
        roots = [os.path.join(home, "Library/Preferences/kicad")]
    else:
        roots = [os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "kicad")]

    dirs: list[str] = []
    for root in roots:
        if not os.path.exists(root):
            continue
        for version in _newest_first(os.listdir(root)):
            directory = os.path.join(root, version)
            if os.path.exists(os.path.join(directory, "fp-lib-table")):
                dirs.append(directory)
    return dirs


def parse_lib_table(text: str) -> list[dict]:
    root = parse_sexpr(text)
    return [
        {
            "name": (args(child(lib, "name")) or [""])[0],
            "uri": resolve_vars((args(child(lib, "uri")) or [""])[0]),
            "type": (args(child(lib, "type")) or ["KiCad"])[0],
        }
        for lib in children(root, "lib")
    ]


def library_table(project_path: str) -> dict[str, dict]:
    """Footprint libraries visible to a project; the project's own table shadows the global one."""
    table: dict[str, dict] = {}
    for directory in kicad_config_dirs():
        for entry in parse_lib_table(read_text(os.path.join(directory, "fp-lib-table"))):
            table.setdefault(entry["name"], entry)

    project_dir = project_path if os.path.splitext(project_path)[1] == "" else os.path.dirname(project_path)
    project_table = os.path.join(project_dir, "fp-lib-table")
    if os.path.exists(project_table):
        for entry in parse_lib_table(read_text(project_table)):
            table[entry["name"]] = entry  # project wins
    return table


def resolve_footprint(reference: str, table: dict[str, dict]) -> str | None:
    """Absolute path of ``Library:Footprint``, or None when it cannot be found."""
    colon = reference.find(":")
    if colon < 0:
        return None
    library = table.get(reference[:colon])
    if not library:
        return None
    path = os.path.join(library["uri"], f"{reference[colon + 1:]}.kicad_mod")
    return path if os.path.exists(path) else None
