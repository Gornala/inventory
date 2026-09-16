"""Which project a file KiCad names without its folder belongs to.

KiCad 10.0's schematic editor tells an API plugin the name of its schematic
(``MW_board.kicad_sch``) but not where it is, nor which project it is in. KiCad
does know: it puts the project's folder in ``KIPRJMOD`` for everything it
starts, and it lists recently opened projects and schematics in its settings,
the newest first.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping

from kinv.adapters.kicad.hierarchy import read_text
from kinv.adapters.kicad.libraries import kicad_config_versions


def _history(config_dirs: list[str]) -> list[str]:
    """Recent projects, then recent schematics, newest KiCad version first."""
    paths: list[str] = []
    for directory in config_dirs:
        for settings in ("kicad.json", "eeschema.json"):
            try:
                history = json.loads(read_text(os.path.join(directory, settings)))["system"]["file_history"]
            except (OSError, ValueError, KeyError, TypeError):
                continue
            if isinstance(history, list):
                paths.extend(p for p in history if isinstance(p, str))
    return paths


def project_for(file_name: str, env: Mapping[str, str] | None = None, config_dirs: list[str] | None = None) -> str | None:
    """The ``.kicad_pro`` for ``MW_board.kicad_sch`` (or ``.kicad_pcb``, or ``.kicad_pro``), or None."""
    stem = os.path.splitext(os.path.basename(file_name))[0]
    if not stem:
        return None
    env = os.environ if env is None else env
    folders = [env["KIPRJMOD"]] if env.get("KIPRJMOD") else []
    for path in _history(kicad_config_versions() if config_dirs is None else config_dirs):
        if os.path.splitext(os.path.basename(path))[0] == stem:
            folders.append(os.path.dirname(path))
    for folder in folders:
        candidate = os.path.join(folder, stem + ".kicad_pro")
        if os.path.isfile(candidate):
            return os.path.normpath(candidate)
    return None
