"""kinv.js against JavaScript's own answers.

The cases in ``golden/js.json`` were computed by Node (``scripts/golden/js.mjs``):
thousands of numbers and strings, seeded, with the ties and edges where Python
and JavaScript genuinely disagree. Every one has to match, because the keys
the catalog is filed under are built out of these functions.
"""

import json
import unittest
from pathlib import Path

from kinv.js import js_round, locale_compare, num_str, to_fixed, to_precision

GOLDEN = json.loads((Path(__file__).parent / "golden" / "js.json").read_text("utf8"))


def _mismatches(rows, compute):
    return [(row, compute(row)) for row in rows if compute(row) != row[-1]]


class NumbersAsJavaScriptPrintsThem(unittest.TestCase):
    def test_string_of_a_number(self):
        bad = _mismatches(GOLDEN["numStr"], lambda r: num_str(r[0]))
        self.assertEqual(bad[:5], [], f"{len(bad)} of {len(GOLDEN['numStr'])} differ")

    def test_to_fixed(self):
        bad = _mismatches(GOLDEN["toFixed"], lambda r: to_fixed(r[0], r[1]))
        self.assertEqual(bad[:5], [], f"{len(bad)} of {len(GOLDEN['toFixed'])} differ")

    def test_to_precision(self):
        # JSON hands 1.23456789e20 back as the exact integer 123456789000000000000,
        # which is not the double JavaScript held; compare as doubles
        rows = [(r[0], r[1], float(r[2])) for r in GOLDEN["toPrecision"]]
        bad = _mismatches(rows, lambda r: to_precision(r[0], r[1]))
        self.assertEqual(bad[:5], [], f"{len(bad)} of {len(GOLDEN['toPrecision'])} differ")

    def test_math_round(self):
        bad = _mismatches(GOLDEN["round"], lambda r: js_round(r[0]))
        self.assertEqual(bad[:5], [], f"{len(bad)} of {len(GOLDEN['round'])} differ")


class OrderAsLocaleCompareOrdersIt(unittest.TestCase):
    def _check(self, index, **options):
        rows = GOLDEN["compare"]
        bad = [
            (a, b, row[index], locale_compare(a, b, **options))
            for row in rows
            for a, b in [(row[0], row[1])]
            if locale_compare(a, b, **options) != row[index]
        ]
        self.assertEqual(bad[:5], [], f"{len(bad)} of {len(rows)} differ")

    def test_default(self):
        self._check(2)

    def test_base_sensitivity(self):
        self._check(3, base=True)

    def test_numeric(self):
        self._check(4, numeric=True)


if __name__ == "__main__":
    unittest.main()
