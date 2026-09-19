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


def project_of(
    documents: list[tuple[str, str, str]],
    env: Mapping[str, str] | None = None,
    config_dirs: list[str] | None = None,
) -> str | None:
    """The ``.kicad_pro`` behind the documents KiCad has open, or None.

    Each document is ``(file_name, project_name, project_folder)`` as KiCad's
    API hands it over. The PCB editor fills the folder in; the schematic editor
    (10.0) gives only ``MW_board.kicad_sch`` and leaves the rest empty, so that
    one is looked up the long way round. A press carries the folder of the
    window it came from in ``KIPRJMOD``: with two projects open, that is what
    decides which of them the button belongs to.
    """
    env = os.environ if env is None else env
    found = []
    for file_name, name, folder in documents:
        path = None
        if folder and name:
            candidate = os.path.join(folder, name + ".kicad_pro")
            if os.path.isfile(candidate):
                path = os.path.normpath(candidate)
        if path is None and file_name:
            path = project_for(file_name, env=env, config_dirs=config_dirs)
        if path and path not in found:
            found.append(path)
    pressed_in = env.get("KIPRJMOD")
    if pressed_in:
        for path in found:
            if _same_folder(os.path.dirname(path), pressed_in):
                return path
    return found[0] if found else None


def _same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
