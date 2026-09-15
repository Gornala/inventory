"""A stable name for a finding, and a fingerprint of what it currently says.

Marking a finding "solved" has to survive a re-read of the board, and the
board is re-read every time you save. The *id* is what the finding is about —
this value, this key, these parts — and does not move when a count changes.
The *signature* is what the finding says right now.

A mark is honoured only while both match. So settling "10k in 0402 and 0603"
keeps quiet through unrelated edits, and speaks up again the day a third
package appears: you settled the question that was asked, not the subject.
"""

from __future__ import annotations

from kinv.js import code_units, num_str


def _joined(items: list[str], sep: str) -> str:
    return sep.join(sorted(items, key=code_units))


def finding_id(f: dict) -> str:
    kind = f["kind"]
    if kind in ("duplicate-spelling", "mixed-footprint", "singleton"):
        return f"{kind}:{f['key']}"
    if kind == "multi-package":
        return f"{kind}:{f['cls']}:{f['value']}{f['unit']}"
    return f"{kind}:{_joined([m['key'] for m in f['members']], ',')}"


def finding_signature(f: dict) -> str:
    kind = f["kind"]
    times = "×"
    if kind == "duplicate-spelling":
        return _joined([f"{s['value']}{times}{num_str(s['placements'])}" for s in f["spellings"]], " ")
    if kind == "mixed-footprint":
        return _joined([f"{x['footprint']}{times}{num_str(x['placements'])}" for x in f["footprints"]], " ")
    if kind == "multi-package":
        return _joined([f"{g['pkg']}{times}{num_str(g['placements'])}" for g in f["groups"]], " ")
    if kind == "near-value":
        return _joined([f"{m['value']}{times}{num_str(m['placements'])}" for m in f["members"]], " ")
    return f["ref"]
