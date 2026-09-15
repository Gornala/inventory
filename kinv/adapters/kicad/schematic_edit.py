"""Writing fields onto schematic symbols by splicing text in place.

Not parse-and-reserialise: reproducing KiCad's pretty-printer exactly is a
losing game, and a reflowed file turns a four-line change into a diff nobody
can review. Every byte outside the planned spans is written back unchanged.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil

from kinv.adapters.kicad.hierarchy import project_sheets_or_directory, read_text
from kinv.adapters.kicad.sexpr import Atom, List, args, child, children, parse_sexpr
from kinv.js import code_units, collation_key


def _quote(value: str) -> str:
    """KiCad quotes with ``\\"`` and ``\\\\`` and nothing else."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf8")).hexdigest()


def _schematics_beside(project: str) -> list[str]:
    """The sheets this project is made of — walked from the root, never globbed."""
    directory = os.path.dirname(project) or "."
    if not os.path.exists(directory):
        return []
    return project_sheets_or_directory(
        project,
        sorted((os.path.join(os.path.dirname(project), f) for f in os.listdir(directory) if f.endswith(".kicad_sch")), key=code_units),
    )


def schematic_locks(project: str) -> list[str]:
    """``~name.kicad_sch.lck``: KiCad has the document open, and its next save would win.

    The lock lands on the root schematic, not on each sheet, so any schematic
    lock in the project directory blocks the whole write.
    """
    directory = os.path.dirname(project) or "."
    try:
        names = [f for f in os.listdir(directory) if f.startswith("~") and f.endswith(".kicad_sch.lck")]
    except OSError:
        return []
    return sorted((os.path.join(os.path.dirname(project), f) for f in names), key=code_units)


def _property(symbol: List, name: str) -> List | None:
    return next((p for p in children(symbol, "property") if (args(p) or [None])[0] == name), None)


def _property_value_atom(symbol: List, name: str) -> Atom | None:
    node = _property(symbol, name)
    atom = node.items[2] if node is not None and len(node.items) > 2 else None
    return atom if isinstance(atom, Atom) else None


def _references_of(symbol: List) -> list[str]:
    """Every reference a symbol answers to: the property, plus one per instance path."""
    found: dict[str, None] = {}
    atom = _property_value_atom(symbol, "Reference")
    if atom is not None and atom.value != "":
        found[atom.value] = None
    instances = child(symbol, "instances")
    if instances is None:
        return list(found)
    for project in children(instances, "project"):
        for path in children(project, "path"):
            reference = (args(child(path, "reference")) or [None])[0]
            if reference:
                found[reference] = None
    return list(found)


def _is_hidden(node: List) -> bool:
    """KiCad 9 says so inside ``effects``, KiCad 10 directly, KiCad 7 with a bare atom."""
    if (args(child(node, "hide")) or [None])[0] == "yes":
        return True
    effects = child(node, "effects")
    if effects is None:
        return False
    if any(isinstance(n, Atom) and n.value == "hide" for n in effects.items):
        return True
    return (args(child(effects, "hide")) or [None])[0] == "yes"


def _clone_property(text: str, donor: List, name: str, value: str) -> str:
    """A new field, cloned from a hidden one the file already has — its dialect, its indentation."""
    name_atom = donor.items[1]
    value_atom = donor.items[2]
    body = text[donor.start : donor.end]
    ns, ne = name_atom.start - donor.start, name_atom.end - donor.start
    vs, ve = value_atom.start - donor.start, value_atom.end - donor.start
    # Value first: replacing the name would move the value's offsets.
    with_value = body[:vs] + _quote(value) + body[ve:]
    cloned = with_value[:ns] + _quote(name) + with_value[ne:]
    # KiCad 7 numbered fields with `(id N)`; a clone would repeat the donor's.
    return re.sub(r"\n\s*\(id [0-9]+\)", "", cloned)


def _indent_of(text: str, node: List) -> str:
    line_start = text.rfind("\n", 0, node.start + 1) + 1
    return text[line_start : node.start]


def _newline_of(text: str) -> str:
    """CRLF where the file uses it: an inserted LF line would make the whole file a diff."""
    return "\r\n" if "\r\n" in text else "\n"


def plan_field_write(project: str, changes: list[dict]) -> dict:
    """Works out which text would change, and writes nothing.

    Each change is ``{refs, expect?, valueIsOneOf?, fields}``. Matching is by
    reference and, where the caller says what it expects, by the field's
    current value too — a stale report skips a symbol instead of overwriting
    something a person has since changed by hand.
    """
    wanted: dict[str, dict] = {}
    for change in changes:
        for ref in change["refs"]:
            wanted[ref] = change

    edits: list[dict] = []
    claimed: set[str] = set()
    skipped: list[dict] = []
    files: list[dict] = []

    for file in _schematics_beside(project):
        try:
            text = read_text(file)
            root = parse_sexpr(text)
        except (OSError, ValueError):
            continue  # a sheet that will not parse is one this edit cannot reason about

        touched = False
        # Only placements: `lib_symbols` carries library properties that are not on the board.
        for symbol in children(root, "symbol"):
            refs = _references_of(symbol)
            matched = [r for r in refs if r in wanted]
            if not matched:
                continue
            claimed.update(matched)
            ref = sorted(matched, key=code_units)[0]
            change = wanted[ref]
            uuid = (args(child(symbol, "uuid")) or [""])[0]
            also_affects = sorted((r for r in refs if r not in wanted), key=code_units)
            properties = children(symbol, "property")
            donor = next((p for p in properties if _is_hidden(p)), None)

            allowed = change.get("valueIsOneOf")
            if allowed is not None:
                atom = _property_value_atom(symbol, "Value")
                value = atom.value if atom is not None else ""
                if value not in allowed:
                    spelled = " or ".join(f'"{v}"' for v in allowed)
                    skipped.append({"ref": ref, "reason": f'reads "{value}" here, not {spelled} — a different part with the same reference'})
                    continue

            for field, value in change["fields"].items():
                node = _property(symbol, field)
                expected = (change.get("expect") or {}).get(field)

                if node is None:
                    if expected is not None:
                        skipped.append({"ref": ref, "reason": f"has no {field} field to change"})
                        continue
                    if donor is None:
                        skipped.append({"ref": ref, "reason": "no hidden field to copy this file's formatting from"})
                        continue
                    last = properties[-1]
                    edits.append(
                        {
                            "file": file,
                            "ref": ref,
                            "uuid": uuid,
                            "field": field,
                            "from": None,
                            "to": value,
                            "start": last.end,
                            "end": last.end,
                            "text": _newline_of(text) + _indent_of(text, last) + _clone_property(text, donor, field, value),
                            "alsoAffects": also_affects,
                        }
                    )
                    touched = True
                    continue

                atom = node.items[2] if len(node.items) > 2 else None
                if not isinstance(atom, Atom):
                    skipped.append({"ref": ref, "reason": f"the {field} field has no value to replace"})
                    continue
                if expected is not None and atom.value != expected:
                    skipped.append({"ref": ref, "reason": f'{field} reads "{atom.value}", not "{expected}"'})
                    continue
                if atom.value == value:
                    continue  # already says what it should

                edits.append(
                    {
                        "file": file,
                        "ref": ref,
                        "uuid": uuid,
                        "field": field,
                        "from": atom.value,
                        "to": value,
                        "start": atom.start,
                        "end": atom.end,
                        "text": _quote(value),
                        "alsoAffects": also_affects,
                    }
                )
                touched = True

        if touched:
            files.append({"path": file, "sha": _sha(text)})

    for ref in wanted:
        if ref not in claimed:
            skipped.append({"ref": ref, "reason": "no symbol with this reference"})

    edits.sort(key=lambda e: (collation_key(e["file"]), collation_key(e["ref"], numeric=True), collation_key(e["field"])))
    return {"project": project, "edits": edits, "skipped": skipped, "locked": schematic_locks(project), "dirty": [], "files": files}


def plan_value_rewrite(project: str, request: dict) -> dict:
    """"Use this spelling everywhere": one field, ``Value``, over several groups."""
    return plan_field_write(
        project,
        [{"refs": g["refs"], "expect": {"Value": g["from"]}, "fields": {"Value": request["to"]}} for g in request["groups"]],
    )


def apply_field_write(plan: dict) -> dict:
    """Splices the planned spans, last first, and writes every other byte unchanged."""
    if plan["locked"]:
        names = ", ".join(os.path.basename(l) for l in plan["locked"])
        raise RuntimeError(f"KiCad has this project open ({names}). Close the schematic editor first — saving from KiCad would overwrite the edit.")
    if plan["dirty"]:
        names = ", ".join(os.path.basename(f) for f in plan["dirty"])
        raise RuntimeError(f"uncommitted changes in {names} — commit or stash first, so this edit is the only thing in the diff")
    if not plan["edits"]:
        raise RuntimeError("nothing to change")

    by_file: dict[str, list[dict]] = {}
    for edit in plan["edits"]:
        by_file.setdefault(edit["file"], []).append(edit)

    backups: list[str] = []
    for file, file_edits in by_file.items():
        text = read_text(file)
        # A save between plan and apply moves every offset after the change:
        # the file has to be exactly what it was.
        seen = next((f for f in plan["files"] if f["path"] == file), None)
        if seen is not None and _sha(text) != seen["sha"]:
            raise RuntimeError(f"{os.path.basename(file)} changed since the plan was made — nothing was written")

        backup = f"{file}.bak"
        shutil.copyfile(file, backup)
        backups.append(backup)

        for edit in sorted(file_edits, key=lambda e: -e["start"]):
            text = text[: edit["start"]] + edit["text"] + text[edit["end"] :]
        with open(file, "wb") as handle:
            handle.write(text.encode("utf8"))

    return {
        "filesChanged": list(by_file),
        "backups": backups,
        "symbolsChanged": len({f"{e['file']}|{e['uuid']}" for e in plan["edits"]}),
    }


apply_value_rewrite = apply_field_write
