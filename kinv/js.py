"""The handful of JavaScript behaviours the TypeScript version's output depends on.

Keys like ``R|10k|0402`` are written into the catalog and into ``.kinv/``
files, so the Python version has to spell them byte for byte the way the
TypeScript version did — or a catalog built with one is a stranger to the
other. JavaScript and Python round and print floats differently, and
``localeCompare`` is not Python's ``sorted``. Everything that differs and
matters lives here, emulated exactly rather than approximated, and each
function says which JavaScript expression it stands in for.
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from functools import cmp_to_key
from typing import Any, Callable, Iterable

# --- numbers -----------------------------------------------------------------


def _digits_and_point(x: float) -> tuple[str, int]:
    """Shortest round-trip digits of ``|x|`` and ``n`` such that |x| = 0.DIGITS × 10^n.

    Python's ``repr`` and JavaScript's ``Number#toString`` both find the
    shortest digit string that round-trips; they only lay it out differently.
    """
    text = repr(abs(x))
    mantissa, _, exp = text.partition("e")
    whole, _, frac = mantissa.partition(".")
    raw = whole + frac
    stripped = raw.lstrip("0")
    leading_zeros = len(raw) - len(stripped)
    point = len(whole) + (int(exp) if exp else 0) - leading_zeros
    return stripped.rstrip("0") or "0", point


def num_str(x: float) -> str:
    """``String(x)`` for a JavaScript number."""
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"  # -0 included: JavaScript prints it as "0"

    sign = "-" if x < 0 else ""
    digits, n = _digits_and_point(x)
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exponent = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + exponent
    return sign + digits[0] + "." + digits[1:] + "e" + exponent


def _half_up(x: float, quantum_exponent: int) -> Decimal:
    """The exact binary value of ``|x|``, rounded half-up at 10**quantum_exponent.

    ``toFixed`` and ``toPrecision`` are both specified on the exact value and
    pick the larger candidate on a tie — half-up on the magnitude. Python's
    float formatting rounds a tie to even, so it cannot stand in for either.
    """
    return Decimal(abs(x)).quantize(Decimal(1).scaleb(quantum_exponent), rounding=ROUND_HALF_UP)


def to_fixed(x: float, digits: int) -> str:
    """``x.toFixed(digits)``."""
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if abs(x) >= 1e21:
        return num_str(x)
    rounded = _half_up(x, -digits)
    text = f"{rounded:.{digits}f}"
    # The sign survives a round to zero: (-0.0000054).toFixed(0) is "-0".
    # Only -0 itself loses it, because -0 < 0 is false.
    return ("-" + text) if x < 0 else text


def to_precision(x: float, precision: int) -> float:
    """``Number(x.toPrecision(precision))`` — the value, which is all any caller keeps."""
    x = float(x)
    if x == 0 or math.isnan(x) or math.isinf(x):
        return x
    exponent = Decimal(abs(x)).adjusted()  # floor(log10|x|)
    value = float(_half_up(x, exponent - precision + 1))
    return -value if x < 0 else value


def fixed_num(x: float, digits: int) -> float:
    """``Number(x.toFixed(digits))``."""
    return float(to_fixed(x, digits))


def js_round(x: float) -> int:
    """``Math.round(x)``: the nearest integer, ties towards +infinity."""
    floor = math.floor(x)
    return floor + 1 if x - floor >= 0.5 else floor


def num(text: str) -> float:
    """``Number(text)`` for the decimal strings this codebase feeds it."""
    stripped = text.strip()
    if stripped == "":
        return 0.0
    try:
        return float(stripped)
    except ValueError:
        return math.nan


# --- JSON --------------------------------------------------------------------


def stringify(value: Any, indent: int | None = None) -> str:
    """``JSON.stringify(value, null, indent)``.

    Two differences from ``json.dumps`` matter here. Numbers are written the
    way JavaScript writes them (``2``, not ``2.0``; ``1e-7``, not
    ``1e-07``). And a key whose value is ``None`` is left out of an object,
    because ``None`` is how this port spells ``undefined`` — which
    ``JSON.stringify`` drops — and nothing in kinv's data is ever a
    deliberate ``null``. In an array it is written ``null``, as JavaScript
    does.
    """
    import json

    encode_string = json.encoder.py_encode_basestring  # non-ASCII kept, as JS does

    def walk(item: Any, depth: int) -> str | None:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, (int, float)):
            number = float(item)
            return num_str(number) if math.isfinite(number) else "null"
        if isinstance(item, str):
            return encode_string(item)

        pad = "" if indent is None else "\n" + " " * (indent * (depth + 1))
        close = "" if indent is None else "\n" + " " * (indent * depth)
        colon = ":" if indent is None else ": "

        if isinstance(item, dict):
            parts = [
                f"{pad}{encode_string(str(k))}{colon}{walk(v, depth + 1)}"
                for k, v in item.items()
                if v is not None
            ]
            return "{" + ",".join(parts) + close + "}" if parts else "{}"
        if isinstance(item, (list, tuple)):
            parts = [f"{pad}{walk(v, depth + 1)}" for v in item]
            return "[" + ",".join(parts) + close + "]" if parts else "[]"
        raise TypeError(f"not JSON-serialisable: {type(item).__name__}")

    return walk(value, 0) or "null"


# --- collation ---------------------------------------------------------------

# ICU's order for the characters that occur in keys, packages, references,
# supplier and file names — measured from Node with `Intl.Collator("en")`
# rather than recalled (the machine's default locale is de-DE, which orders
# every one of these the same). Characters sharing a group differ only below
# the primary level: by case, or by an accent.
_GROUPS: list[str] = [
    " ", "_", "-", "—", ",", ";", ":", "!", "?", ".", "·", "'", '"',
    "(", ")", "[", "]", "{", "}", "@", "*", "/", "\\", "&", "#", "%", "`", "^",
    "→", "+", "×", "<", "=", ">", "|", "~", "$",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "aAä", "bB", "cC", "dD", "eEé", "fF", "gG", "hH", "iI", "jJ", "kK",
    "lL", "mM", "nN", "oOö", "pP", "qQ", "rR", "sS", "ß", "tT",
    "uUü", "vV", "wW", "xX", "yY", "zZ",
    "μµ", "ΩΩ",
]

_PRIMARY: dict[str, int] = {}
_SECONDARY: dict[str, int] = {}
_TERTIARY: dict[str, int] = {}
for _index, _group in enumerate(_GROUPS):
    for _char in _group:
        _PRIMARY[_char] = _index
        _SECONDARY[_char] = 1 if _char in "äéöü" else 0
        _TERTIARY[_char] = 1 if _char.isupper() else 0

_DIGIT_GROUP = _PRIMARY["0"]
_UNKNOWN = len(_GROUPS)

Element = tuple[tuple[int, int, int], int, int]


def _elements(text: str, numeric: bool) -> list[Element]:
    """Collation elements: (primary, secondary, tertiary), per character or digit run."""
    out: list[Element] = []
    i = 0
    while i < len(text):
        char = text[i]
        if numeric and "0" <= char <= "9":
            j = i
            while j < len(text) and "0" <= text[j] <= "9":
                j += 1
            run = text[i:j].lstrip("0") or "0"
            # A digit run weighs as one number: by length, then by value.
            out.append(((_DIGIT_GROUP, len(run), int(run)), 0, 0))
            i = j
            continue
        primary = _PRIMARY.get(char)
        if primary is None:
            # Outside the measured set: after all of it, in code point order.
            out.append(((_UNKNOWN, ord(char), 0), 0, 0))
        else:
            out.append(((primary, 0, 0), _SECONDARY[char], _TERTIARY[char]))
        i += 1
    return out


def collation_key(text: str, *, numeric: bool = False, base: bool = False) -> tuple[Any, ...]:
    """A sort key that orders like ``a.localeCompare(b, "en", options)``.

    ``base`` is ``sensitivity: "base"`` (case and accents ignored), ``numeric``
    is ``numeric: true`` (``R2`` before ``R10``). Levels compare in turn over
    the whole string, the way ICU does: every primary difference outranks any
    difference in case.
    """
    elements = _elements(text, numeric)
    primaries = tuple(e[0] for e in elements)
    if base:
        return (primaries,)
    return (primaries, tuple(e[1] for e in elements), tuple(e[2] for e in elements))


def locale_compare(a: str, b: str, *, numeric: bool = False, base: bool = False) -> int:
    """``a.localeCompare(b, "en", {numeric, sensitivity})``, as -1, 0 or 1."""
    ka = collation_key(a, numeric=numeric, base=base)
    kb = collation_key(b, numeric=numeric, base=base)
    return (ka > kb) - (ka < kb)


def js_sorted(values: Iterable[Any], compare: Callable[[Any, Any], float]) -> list[Any]:
    """``[...values].sort(compare)``: stable, as JavaScript's sort is."""

    def normalized(a: Any, b: Any) -> int:
        result = compare(a, b)
        return (result > 0) - (result < 0)

    return sorted(values, key=cmp_to_key(normalized))


def code_units(text: str) -> tuple[int, ...]:
    """The key ``Array#sort()`` uses with no comparator: UTF-16 code units."""
    units: list[int] = []
    for char in text:
        point = ord(char)
        if point > 0xFFFF:
            point -= 0x10000
            units.extend((0xD800 + (point >> 10), 0xDC00 + (point & 0x3FF)))
        else:
            units.append(point)
    return tuple(units)
