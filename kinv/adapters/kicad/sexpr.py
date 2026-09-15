"""S-expression reader for KiCad files, tracking the span of every node.

The spans are not needed to *read* a footprint — they are here because the
field write-back edits schematics by splicing text in place, and that requires
knowing exactly where each atom sits in the source.

Nodes are ``Atom`` and ``List``: small classes rather than dicts, because
they are walked a great deal and never serialised.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from kinv.js import num

_WHITESPACE = " \t\r\n"


@dataclass(eq=False)
class Atom:
    value: str
    quoted: bool
    start: int
    end: int
    kind: str = "atom"


@dataclass(eq=False)
class List:
    items: list[Atom | List] = field(default_factory=list)
    start: int = 0
    end: int = 0
    kind: str = "list"


Node = Atom | List


class SexprError(ValueError):
    pass


def parse_sexpr(text: str) -> List:
    length = len(text)
    i = 0

    def skip() -> None:
        nonlocal i
        while i < length:
            ch = text[i]
            if ch in _WHITESPACE:
                i += 1
                continue
            # KiCad does not write comments, but hand-edited files may carry them.
            if ch == "#":
                while i < length and text[i] != "\n":
                    i += 1
                continue
            return

    def read_string() -> Atom:
        nonlocal i
        start = i
        i += 1  # opening quote
        value: list[str] = []
        while i < length:
            ch = text[i]
            if ch == "\\":
                nxt = text[i + 1] if i + 1 < length else ""
                # KiCad escapes only \" and \\ ; anything else is literal
                value.append(nxt if nxt in ('"', "\\") else ch + nxt)
                i += 2
                continue
            if ch == '"':
                i += 1
                return Atom("".join(value), True, start, i)
            value.append(ch)
            i += 1
        raise SexprError(f"unterminated string at {start}")

    def read_atom() -> Atom:
        nonlocal i
        start = i
        while i < length:
            ch = text[i]
            if ch in _WHITESPACE or ch in "()":
                break
            i += 1
        return Atom(text[start:i], False, start, i)

    # Iterative rather than recursive: a schematic nests a few dozen deep, but
    # Python's recursion limit is not a thing a file should be able to reach.
    skip()
    if i >= length or text[i] != "(":
        raise SexprError("expected a list at the top level")

    root = List(start=i)
    i += 1
    stack: list[List] = [root]
    while stack:
        skip()
        if i >= length:
            raise SexprError(f"unterminated list at {stack[-1].start}")
        ch = text[i]
        current = stack[-1]
        if ch == ")":
            i += 1
            current.end = i
            stack.pop()
            continue
        if ch == "(":
            node = List(start=i)
            i += 1
            current.items.append(node)
            stack.append(node)
            continue
        current.items.append(read_string() if ch == '"' else read_atom())
    skip()
    return root


def head(node: Node | None) -> str | None:
    """The symbol a list starts with, e.g. ``pad`` in ``(pad "1" smd ...)``."""
    if not isinstance(node, List) or not node.items:
        return None
    first = node.items[0]
    return first.value if isinstance(first, Atom) else None


def children(node: Node | None, name: str) -> list[List]:
    """Direct child lists with the given head."""
    if not isinstance(node, List):
        return []
    return [n for n in node.items if isinstance(n, List) and head(n) == name]


def child(node: Node | None, name: str) -> List | None:
    found = children(node, name)
    return found[0] if found else None


def args(node: Node | None) -> list[str]:
    """Atom values of a list, excluding its head: ``(size 1.2 0.8)`` → ["1.2", "0.8"]."""
    if not isinstance(node, List):
        return []
    return [n.value for n in node.items[1:] if isinstance(n, Atom)]


def numbers(node: Node | None) -> list[float]:
    return [n for n in (num(a) for a in args(node)) if math.isfinite(n)]
