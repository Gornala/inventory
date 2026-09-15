"""The Python report, footprint measurement and catalog writes against the TypeScript ones.

``golden/report.json`` is written by ``scripts/golden/report.ts`` and compared
here as exact text. The reports and the library footprints depend on the KiCad
libraries installed on the machine, so those tests skip where the libraries the
goldens were recorded against are not present; the fixture footprints, the
catalog operations and the files they write are checked everywhere.
"""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from kinv.adapters.kicad.libraries import library_table
from kinv.adapters.kicad.mod import parse_footprint_file
from kinv.adapters.kicad.hierarchy import read_text
from kinv.adapters.store import inventory
from kinv.core.footprint.check import check_footprint, check_pin_numbers
from kinv.core.footprint.measure import measure
from kinv.core.footprint.name import parse_footprint_name
from kinv.core.inventory.package_check import normalise_package
from kinv.core.inventory.resolve import assign_part, part_id, set_supplier
from kinv.report import build_report, footprint_detail
from kinv.js import stringify

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = HERE / "fixtures" / "state"
GOLDEN = json.loads((HERE / "golden" / "report.json").read_text("utf8"))

# The goldens were recorded where these libraries resolve. Without them the
# audits — and the lines geometry takes out of the parts list — differ by design.
HAVE_LIBRARIES = bool(library_table(str(STATE / "empty" / "board.bom.csv")))


def report_text(report: dict) -> str:
    rest = {k: v for k, v in report.items() if k not in ("generatedAt", "sourceSignature", "project")}
    return stringify(rest)


class Golden(unittest.TestCase):
    def assert_text(self, expected: str, computed: str, what: str) -> None:
        if expected == computed:
            return
        at = next((i for i, (a, b) in enumerate(zip(expected, computed)) if a != b), min(len(expected), len(computed)))
        self.fail(
            f"{what} differs at character {at}\n"
            f"  typescript: …{expected[max(0, at - 160):at + 160]}…\n"
            f"  python:     …{computed[max(0, at - 160):at + 160]}…"
        )


class WithHome(Golden):
    """Points KINV_HOME at a directory for the length of one test."""

    home: str

    def setUp(self) -> None:
        self._previous = os.environ.get("KINV_HOME")

    def tearDown(self) -> None:
        if self._previous is None:
            os.environ.pop("KINV_HOME", None)
        else:
            os.environ["KINV_HOME"] = self._previous

    def use_home(self, path: str) -> None:
        os.environ["KINV_HOME"] = path


@unittest.skipUnless(HAVE_LIBRARIES, "the KiCad libraries the goldens were recorded against are not installed")
class TheReport(WithHome):
    def test_with_nothing_decided(self):
        empty_home = tempfile.mkdtemp(prefix="kinv-home-")
        try:
            self.use_home(empty_home)
            report = build_report(str(STATE / "empty" / "board.bom.csv"))
            self.assert_text(GOLDEN["emptyReport"], report_text(report), "empty report")
        finally:
            shutil.rmtree(empty_home, ignore_errors=True)

    def test_with_a_catalog_settled_findings_and_buy_choices(self):
        self.use_home(str(STATE / "home"))
        report = build_report(str(STATE / "decided" / "board.bom.csv"))
        self.assert_text(GOLDEN["decidedReport"], report_text(report), "decided report")

    def test_library_footprints_in_detail(self):
        project = str(STATE / "empty" / "board.bom.csv")
        references = [a["reference"] for a in json.loads(GOLDEN["emptyReport"])["footprints"]]
        for reference, expected in zip(references, GOLDEN["detail"]):
            found = footprint_detail(project, reference)
            computed = "null" if found is None else stringify({k: v for k, v in found.items() if k != "path"})
            self.assert_text(expected, computed, f"footprint detail {reference}")


class FixtureFootprints(Golden):
    def test_parsed_measured_and_checked(self):
        directory = ROOT / "tests" / "fixtures" / "kicad10" / "footprints"
        names = sorted(f for f in os.listdir(directory) if f.endswith(".kicad_mod"))
        self.assertEqual(len(names), len(GOLDEN["footprints"]))
        for name, expected in zip(names, GOLDEN["footprints"]):
            file = parse_footprint_file(read_text(directory / name))
            measured = measure(file["pads"])
            declared = parse_footprint_name(file["name"])
            computed = stringify(
                {"f": name, "file": file, "measured": measured, "declared": declared, "findings": check_footprint(declared, measured)}
            )
            self.assert_text(expected, computed, name)

    def test_symbol_pins_against_pads(self):
        cases = [
            (["1", "2", "3"], ["1", "2", "3"]),
            (["1", "2", "3", "EP"], ["1", "2", "3"]),
            ([], ["1"]),
            (["1", "1", "2"], []),
            ([str(i + 1) for i in range(12)], ["1"]),
        ]
        computed = [stringify(check_pin_numbers(symbols, pads)) for symbols, pads in cases]
        self.assertEqual(computed, GOLDEN["pinChecks"])


class TheCatalog(WithHome):
    def test_assignments_and_suppliers_step_by_step(self):
        clock = {"t": 0}

        def now() -> str:
            stamp = f"2026-09-15T12:00:{clock['t']:02d}.000Z"
            clock["t"] += 1
            return stamp

        catalog: list = []
        assignments: list = []
        steps: list[str] = []

        def assign(key: str, entry: dict) -> None:
            nonlocal catalog, assignments
            result = assign_part(key, entry, catalog, assignments, now)
            catalog, assignments = result["catalog"], result["assignments"]
            steps.append(stringify(result))

        assign("C|100n|0603", {"mpn": "CL10B104KB8NNNC", "manufacturer": "Samsung"})
        assign("R|10k|0402", {"mpn": " RC0402FR-0710KL ", "manufacturer": "", "package": "0603"})
        assign("C|10u|0805", {"mpn": "CL21A106KAYNNNE", "supplier": "digikey", "orderNumber": "1276-2891-1-ND"})
        assign("R|1k|0402", {"mpn": "rc0402fr-0710kl", "manufacturer": "Yageo", "datasheet": "https://x"})
        assign("C|2.2u|0603", {"mpn": "GRM188R61E225KA12D", "notes": "  low ESR  ", "package": "1608Metric"})
        supplied = set_supplier("C|100n|0603", {"supplier": "lcsc", "orderNumber": "C1591"}, catalog, assignments)
        catalog = supplied["catalog"]
        steps.append(stringify(supplied))
        cleared = set_supplier("C|10u|0805", {"supplier": "", "orderNumber": " "}, catalog, assignments)
        catalog = cleared["catalog"]
        steps.append(stringify(cleared))

        for index, (expected, computed) in enumerate(zip(GOLDEN["steps"], steps)):
            self.assert_text(expected, computed, f"step {index}")

        # and the files on disk, to the byte: one catalog, two versions, no diff
        home = tempfile.mkdtemp(prefix="kinv-home-")
        try:
            self.use_home(home)
            inventory.write_catalog(catalog)
            inventory.write_assignments(assignments)
            self.assert_text(GOLDEN["catalogFile"], read_text(inventory.catalog_path()), "catalog.json")
            self.assert_text(GOLDEN["assignmentsFile"], read_text(inventory.assignments_path()), "assignments.json")
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def test_package_normalisation_and_part_ids(self):
        packages = ["0603", " 0603 ", "1608", "1608Metric", "R0603", "FB0402", "C1005", "SOIC-8", "soic-8", "?", "n/a",
                    "", "0201", "2012", "2013", "l3225metric", "QFN-56", "r 0402"]
        self.assertEqual([stringify([p, normalise_package(p)]) for p in packages], GOLDEN["packages"])
        ids = ["RC0402FR-0710KL", " rc0402fr/0710kl ", "--A--", "µPart", "", "ab__cd"]
        self.assertEqual([stringify([m, part_id(m)]) for m in ids], GOLDEN["ids"])


if __name__ == "__main__":
    unittest.main()
