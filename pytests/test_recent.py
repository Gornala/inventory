"""The project a schematic belongs to, when KiCad names the schematic but not its folder."""

import json
import os
import shutil
import tempfile
import unittest

from kinv.adapters.kicad.recent import project_for, project_of


class WithProjectsOnDisk(unittest.TestCase):
    """A few projects in a temporary folder, and a KiCad config that remembers some of them."""

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


class TheProjectOfASchematic(WithProjectsOnDisk):
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


class TheProjectTheButtonWasPressedIn(WithProjectsOnDisk):
    """Both toolbar buttons, from what KiCad's API really answers in 10.0.

    The PCB editor names the project's folder; the schematic editor names only
    its file. Pressed in either window, the button must land on the same
    project, and with two projects open, on the one it was pressed in.
    """

    def test_only_the_pcb_editor_is_open(self):
        board = self.project("b", "MW_board.kicad_pro")
        documents = [("MW_board.kicad_pcb", "MW_board", os.path.dirname(board))]
        self.assertEqual(project_of(documents, env={}, config_dirs=[]), board)

    def test_only_the_schematic_editor_is_open(self):
        board = self.project("b", "MW_board.kicad_pro")
        documents = [("MW_board.kicad_sch", "", "")]
        env = {"KIPRJMOD": os.path.dirname(board)}
        self.assertEqual(project_of(documents, env=env, config_dirs=[]), board)

    def test_the_schematic_editor_without_the_folder_kicad_forgot(self):
        board = self.project("b", "MW_board.kicad_pro")
        self.history("eeschema.json", [board.replace(".kicad_pro", ".kicad_sch")])
        documents = [("MW_board.kicad_sch", "", "")]
        self.assertEqual(project_of(documents, env={}, config_dirs=[self.config]), board)

    def test_both_editors_open_on_one_project(self):
        board = self.project("b", "MW_board.kicad_pro")
        documents = [
            ("MW_board.kicad_pcb", "MW_board", os.path.dirname(board)),
            ("MW_board.kicad_sch", "", ""),
        ]
        for env in ({}, {"KIPRJMOD": os.path.dirname(board)}):
            self.assertEqual(project_of(documents, env=env, config_dirs=[]), board)

    def test_two_projects_open_the_press_decides(self):
        one = self.project("one", "MW_board.kicad_pro")
        two = self.project("two", "dia_carrier.kicad_pro")
        documents = [
            ("MW_board.kicad_pcb", "MW_board", os.path.dirname(one)),
            ("dia_carrier.kicad_pcb", "dia_carrier", os.path.dirname(two)),
        ]
        self.assertEqual(project_of(documents, env={"KIPRJMOD": os.path.dirname(two)}, config_dirs=[]), two)
        self.assertEqual(project_of(documents, env={"KIPRJMOD": os.path.dirname(one)}, config_dirs=[]), one)

    def test_a_project_kicad_names_but_has_not_saved(self):
        documents = [("MW_board.kicad_pcb", "MW_board", os.path.join(self.root, "nowhere"))]
        self.assertIsNone(project_of(documents, env={}, config_dirs=[]))

    def test_nothing_open(self):
        self.assertIsNone(project_of([], env={}, config_dirs=[]))


if __name__ == "__main__":
    unittest.main()
