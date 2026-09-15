"""The sheets a project is actually made of, walked from its root schematic.

Not every ``.kicad_sch`` beside a project belongs to it. The reference board's
directory holds nine sheets that do, plus ``_autosave-*.kicad_sch``, a sheet
that was cut from the design, and four more that were never in it. Globbing
the directory read all of them, and reported the resistors in those files as
duplicate designators in the design — which they are not.

The BOM comes from ``kicad-cli``, which walks the hierarchy. Anything that
writes to the design has to walk the same one.
"""

from __future__ import annotations

import os
from pathlib import Path

from kinv.adapters.kicad.sexpr import args, children, parse_sexpr
from kinv.js import code_units


def read_text(path: str | os.PathLike[str]) -> str:
    """A KiCad file as text, the way Node's ``readFileSync(path, "utf8")`` reads it.

    Bytes decoded, not opened in text mode — which would fold CRLF into LF
    and make every byte offset into the file wrong.
    """
    return Path(path).read_bytes().decode("utf8", errors="replace")


def project_sheets(project: str) -> list[str]:
    root = _root_schematic_path(project)
    if root is None:
        return []

    found: list[str] = []
    seen: set[str] = set()
    queue = [root]

    while queue:
        file = queue.pop(0)
        key = os.path.abspath(file).lower()
        # A hierarchy may reuse one sheet in several places, and a broken one
        # can name itself: visit each file once.
        if key in seen:
            continue
        seen.add(key)
        if not os.path.exists(file):
            continue
        found.append(file)

        try:
            tree = parse_sexpr(read_text(file))
            for sheet in children(tree, "sheet"):
                named = [p for p in children(sheet, "property") if (args(p) or [None])[0] == "Sheetfile"]
                target = args(named[0])[1] if named and len(args(named[0])) > 1 else None
                if target:
                    queue.append(os.path.normpath(os.path.join(os.path.dirname(file), target)))
        except (OSError, ValueError):
            # A sheet that will not parse still exists and is still part of the
            # design; it simply cannot tell us about its children.
            continue

    return sorted(found, key=code_units)


def _root_schematic_path(project: str) -> str | None:
    """The root schematic for a ``.kicad_pro``, a ``.kicad_sch``, or neither."""
    stem, ext = os.path.splitext(project)
    ext = ext.lower()
    if ext == ".kicad_sch":
        return project
    if ext == ".kicad_pro":
        sch = f"{stem}.kicad_sch"
        return sch if os.path.exists(sch) else None
    # A CSV export has no hierarchy to walk; callers that can still do
    # something useful with the directory handle that themselves.
    #
    # Spelled the way the TypeScript version builds this path — Node's
    # `join(dirname(p), p-without-extension + ".kicad_sch")`, which
    # concatenates even when the second part is absolute, and `slice(0, -0)`
    # for a path with no extension. The result almost never exists, so a CSV
    # falls back to its directory in both versions alike.
    bare = project[: -len(ext)] if ext else ""
    sch = os.path.normpath(os.path.dirname(project) + os.sep + bare + ".kicad_sch")
    return sch if os.path.exists(sch) else None


def project_sheets_or_directory(project: str, directory_files: list[str]) -> list[str]:
    """The sheets to work on, falling back to the directory when there is no hierarchy."""
    sheets = project_sheets(project)
    return sheets if sheets else directory_files
