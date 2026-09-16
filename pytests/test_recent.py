"""The project a schematic belongs to, when KiCad names the schematic but not its folder."""

import json
import os
import shutil
import tempfile
import unittest

from kinv.adapters.kicad.recent import project_for


class TheProjectOfASchematic(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="kinv-recent-")
        self.config = os.path.join(self.root, "config", "10.0")
        os.makedirs(self.config)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def project(self, *parts: str) -> str:
        path = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf8") as file:
            file.write("{}")
        return os.path.normpath(path)

    def history(self, settings: str, paths: list[str]) -> None:
        with open(os.path.join(self.config, settings), "w", encoding="utf8") as file:
            json.dump({"system": {"file_history": paths}}, file)

    def test_from_the_folder_kicad_passes_on(self):
        board = self.project("boards", "MW_board", "MW_board.kicad_pro")
        found = project_for("MW_board.kicad_sch", env={"KIPRJMOD": os.path.dirname(board)}, config_dirs=[])
        self.assertEqual(found, board)

    def test_from_the_recent_projects_newest_first(self):
        old = self.project("old", "MW_board", "MW_board.kicad_pro")
        new = self.project("new", "MW_board", "MW_board.kicad_pro")
        other = self.project("other", "dia_carrier_2.kicad_pro")
        self.history("kicad.json", [other, new, old])
        self.assertEqual(project_for("MW_board.kicad_sch", env={}, config_dirs=[self.config]), new)

    def test_from_the_recent_schematics(self):
        board = self.project("b", "MW_board.kicad_pro")
        self.history("eeschema.json", [board.replace(".kicad_pro", ".kicad_sch")])
        self.assertEqual(project_for("MW_board.kicad_sch", env={}, config_dirs=[self.config]), board)

    def test_a_folder_without_the_project_is_passed_over(self):
        board = self.project("b", "MW_board.kicad_pro")
        self.history("kicad.json", [board])
        found = project_for("MW_board.kicad_sch", env={"KIPRJMOD": os.path.join(self.root, "elsewhere")}, config_dirs=[self.config])
        self.assertEqual(found, board)

    def test_nothing_known(self):
        self.history("kicad.json", [self.project("b", "other.kicad_pro")])
        self.assertIsNone(project_for("MW_board.kicad_sch", env={}, config_dirs=[self.config]))
        self.assertIsNone(project_for("", env={}, config_dirs=[self.config]))


if __name__ == "__main__":
    unittest.main()
