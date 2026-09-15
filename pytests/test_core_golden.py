"""The Python core against the TypeScript core, compared as exact JSON text.

``golden/core.json`` holds the TypeScript version's answers — each item as the
string ``JSON.stringify`` produced (``scripts/golden/core.ts``). Every test here
recomputes the same thing in Python and compares ``stringify`` output as text,
so key order, number formatting and dropped ``undefined``\\ s all have to agree,
not just the values. Your reference board is in here whole.
"""

import json
import unittest
from pathlib import Path

from kinv.adapters.kicad.bom import read_bom_csv
from kinv.adapters.kicad.csv import parse_csv
from kinv.core.canonical import canonical_key, display_value, search_label
from kinv.core.consolidate.findings import compare_columns, consolidate, parts_by_key
from kinv.core.consolidate.identity import finding_id, finding_signature
from kinv.core.parse.footprint import package_of, parse_footprint
from kinv.core.parse.refdes import class_of_ref, expand_refs
from kinv.core.parse.spec import analyze_bom, analyze_line
from kinv.core.parse.value import parse_value
from kinv.core.units import format_magnitude
from kinv.js import js_sorted, stringify

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = json.loads((Path(__file__).parent / "golden" / "core.json").read_text("utf8"))


class Golden(unittest.TestCase):
    maxDiff = 4000

    def assert_same(self, expected: list[str], computed: list[str], what: str) -> None:
        """Text equality, reporting the first differing item rather than a wall of JSON."""
        self.assertEqual(len(computed), len(expected), f"{what}: different number of items")
        for index, (want, got) in enumerate(zip(expected, computed)):
            if want != got:
                self.fail(f"{what}[{index}] differs\n  typescript: {want}\n  python:     {got}")


class TheReferenceBoard(Golden):
    def board(self, name: str, path: str) -> None:
        lines = analyze_bom(read_bom_csv(ROOT / path))
        golden = GOLDEN["boards"][name]
        self.assert_same(golden["lines"], [stringify(l) for l in lines], f"{name}.lines")
        self.assert_same(
            golden["findings"],
            [stringify({"finding": f, "id": finding_id(f), "signature": finding_signature(f)}) for f in consolidate(lines)],
            f"{name}.findings",
        )
        self.assert_same(golden["parts"], [stringify(p) for p in parts_by_key(lines)], f"{name}.parts")

    def test_reference_board(self):
        self.board("reference", "tests/fixtures/kicad10/transformer_test.bom.csv")

    def test_custom_fields_board(self):
        self.board("customFields", "tests/fixtures/kicad10/custom-fields.bom.csv")


class TheParsers(Golden):
    def test_values(self):
        cases = GOLDEN["parsed"]["values"]
        computed = [stringify({"v": json.loads(c)["v"], "parsed": parse_value(json.loads(c)["v"])}) for c in cases]
        self.assert_same(cases, computed, "values")

    def test_footprints(self):
        cases = GOLDEN["parsed"]["footprints"]
        computed = []
        for case in cases:
            f = json.loads(case)["f"]
            fp = parse_footprint(f)
            computed.append(stringify({"f": f, "fp": fp, "pkg": package_of(fp)}))
        self.assert_same(cases, computed, "footprints")

    def test_reference_designators(self):
        cases = GOLDEN["parsed"]["refs"]
        computed = [stringify({"r": json.loads(c)["r"], "cls": class_of_ref(json.loads(c)["r"])}) for c in cases]
        self.assert_same(cases, computed, "refs")

    def test_reference_cells(self):
        cases = GOLDEN["parsed"]["refCells"]
        computed = [stringify({"c": json.loads(c)["c"], "refs": expand_refs(json.loads(c)["c"])}) for c in cases]
        self.assert_same(cases, computed, "refCells")

    def test_csv(self):
        cases = GOLDEN["csv"]
        computed = [stringify({"input": json.loads(c)["input"], "rows": parse_csv(json.loads(c)["input"])}) for c in cases]
        self.assert_same(cases, computed, "csv")


class KeysAndLabels(Golden):
    def test_synthetic_lines(self):
        """1,500 generated lines: every class, value spelling and footprint shape."""
        cases = GOLDEN["synthetic"]
        computed = []
        for case in cases:
            line = json.loads(case)["line"]
            analyzed = analyze_line(line)
            spec = analyzed["spec"]
            computed.append(
                stringify(
                    {
                        "line": line,
                        "analyzed": analyzed,
                        "label": search_label(spec),
                        "display": display_value(spec),
                        "key": canonical_key(spec),
                    }
                )
            )
        self.assert_same(cases, computed, "synthetic")

    def test_magnitudes(self):
        cases = GOLDEN["magnitudes"]
        computed = [stringify([json.loads(c)[0], format_magnitude(json.loads(c)[0])]) for c in cases]
        self.assert_same(cases, computed, "magnitudes")

    def test_column_order(self):
        self.assertEqual(js_sorted(GOLDEN["columns"], compare_columns), GOLDEN["sortedColumns"])


if __name__ == "__main__":
    unittest.main()
