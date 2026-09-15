"""The part you buy against the pads the board has."""

from __future__ import annotations

import re
from typing import Iterable

from kinv.core.footprint.name import CHIP_SIZES

# Metric chip code → imperial, written out rather than derived: 0805 is
# 2.0 × 1.25 mm and its metric code is `2012`, not the `2013` rounding gives.
_METRIC_TO_IMPERIAL = {
    "0603": "0201",  # and note the collision: metric 0603 is imperial 0201
    "1005": "0402",
    "1608": "0603",
    "2012": "0805",
    "3216": "1206",
    "3225": "1210",
    "4532": "1812",
    "5025": "2010",
    "5750": "2220",
    "6332": "2512",
}

# What a package field says when nothing said it.
_UNKNOWN = {"", "?", "-", "n/a", "none"}

_CHIP = re.compile(r"^(?:[rcl]|fb)?([0-9]{4})(?:metric)?\Z")


def normalise_package(value: str) -> str:
    """Reduces a package to something two people would write the same way.

    ``0603``, `` 0603 ``, ``1608``, ``1608Metric`` and ``R0603`` all mean the
    same part. Anything that is not a chip code is compared as written,
    case-folded — a ``SOIC-8`` is a ``SOIC-8``.
    """
    bare = re.sub(r"\s+", "", value.strip().lower())
    if bare in _UNKNOWN:
        return ""
    chip = _CHIP.match(bare)
    if chip is None:
        return bare
    code = chip.group(1)
    # Imperial wins the `0603` collision: it is what a person means by four
    # digits with no unit, and what every footprint name uses first.
    if code in CHIP_SIZES:
        return code
    return _METRIC_TO_IMPERIAL.get(code, code)


def package_issues(parts: Iterable[dict], resolutions: Iterable[dict]) -> list[dict]:
    """Fires only where you recorded a package: a blank means "not checked", honestly."""
    by_key = {r["key"]: r for r in resolutions}
    issues = []
    for part in parts:
        resolution = by_key.get(part["key"])
        bought = resolution["part"] if resolution else None
        declared = bought.get("package") if bought else None
        if bought is None or declared is None or declared.strip() == "":
            continue

        wanted = normalise_package(part["pkg"])
        have = normalise_package(declared)
        if wanted == "" or have == "" or wanted == have:
            continue

        issues.append(
            {
                "code": "package-mismatch",
                "severity": "error",
                "message": f"{bought['mpn']} is {declared}, but {part['key']} has a {part['pkg']} land pattern — "
                "the part will not fit the pads",
                "refs": part["refs"],
            }
        )
    return issues
