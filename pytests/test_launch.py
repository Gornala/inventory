"""The KiCad plugin's side of kinv: finding a running server, starting one, and the package it ships in."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path

from kinv import launch
from kinv.ui.server import start_ui_server

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PROJECT = str(HERE / "fixtures" / "state" / "empty" / "board.bom.csv")
OTHER = str(HERE / "fixtures" / "state" / "decided" / "board.bom.csv")


class WithHome(unittest.TestCase):
    def setUp(self) -> None:
        self._previous = os.environ.get("KINV_HOME")
        self.home = tempfile.mkdtemp(prefix="kinv-home-")
        os.environ["KINV_HOME"] = self.home

    def tearDown(self) -> None:
        if self._previous is None:
            os.environ.pop("KINV_HOME", None)
        else:
            os.environ["KINV_HOME"] = self._previous
        shutil.rmtree(self.home, ignore_errors=True)


class FindingARunningServer(WithHome):
    def setUp(self) -> None:
        super().setUp()
        self.server, self.url = start_ui_server(PROJECT, port=0)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def test_says_which_board_it_serves(self):
        with urllib.request.urlopen(self.url + "api/hello") as response:
            hello = json.loads(response.read())
        self.assertEqual(hello["project"], os.path.abspath(PROJECT))

    def test_a_recorded_server_for_this_project_is_reused(self):
        self.assertIsNone(launch.running_url(PROJECT))
        launch.write_record(PROJECT, self.url)
        self.assertEqual(launch.running_url(PROJECT), self.url)
        self.assertEqual(launch.open_ui(PROJECT, browser=False), self.url)

    def test_a_stale_record_pointing_at_another_boards_server_is_not(self):
        launch.write_record(OTHER, self.url)
        self.assertIsNone(launch.running_url(OTHER))

    def test_a_server_clears_only_its_own_record(self):
        launch.write_record(PROJECT, self.url)
        launch.clear_record(PROJECT, "http://127.0.0.1:1/")
        self.assertTrue(os.path.exists(launch.record_path(PROJECT)))
        launch.clear_record(PROJECT, self.url)
        self.assertFalse(os.path.exists(launch.record_path(PROJECT)))


class ChoosingAPort(unittest.TestCase):
    def test_skips_a_port_in_use(self):
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            self.assertNotEqual(launch.free_port(port, tries=5), port)


class StartingOneInTheBackground(WithHome):
    def test_starts_records_answers_and_stops_when_no_tab_asks(self):
        # the plugin's own start, but with the idle limit cut to seconds
        os.environ["KINV_HOME"] = self.home
        idle, launch.IDLE_MINUTES = launch.IDLE_MINUTES, 0.02
        try:
            url = launch.open_ui(PROJECT, browser=False)
        finally:
            launch.IDLE_MINUTES = idle
        self.assertEqual(launch.running_url(PROJECT), url)
        with open(launch.record_path(PROJECT), encoding="utf8") as file:
            pid = json.load(file)["pid"]

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and os.path.exists(launch.record_path(PROJECT)):
            time.sleep(0.5)
        stopped = not os.path.exists(launch.record_path(PROJECT))
        if not stopped:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, stdin=subprocess.DEVNULL)
            else:
                os.kill(pid, 9)
        self.assertTrue(stopped, "the server did not stop by itself")
        with open(launch.log_path(PROJECT), encoding="utf8", errors="replace") as file:
            self.assertIn("stopping", file.read())

    def test_a_server_that_cannot_start_says_why(self):
        with self.assertRaises(RuntimeError) as raised:
            launch.open_ui(str(HERE / "no-such-board.kicad_pro"), browser=False, wait=20)
        self.assertIn("Log:", str(raised.exception))


class ThePackage(unittest.TestCase):
    def test_manifest(self):
        manifest = json.loads((ROOT / "plugin" / "plugin.json").read_text("utf8"))
        for key in ("identifier", "name", "description", "runtime", "actions"):
            self.assertIn(key, manifest)
        for action in manifest["actions"]:
            self.assertTrue((ROOT / "plugin" / action["entrypoint"]).exists())
            for icon in action["icons-light"] + action["icons-dark"]:
                self.assertTrue((ROOT / "plugin" / icon).exists(), icon)

    def test_zip_layout(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            import build_plugin
        finally:
            sys.path.pop(0)
        out = tempfile.mkdtemp(prefix="kinv-plugin-")
        try:
            with zipfile.ZipFile(build_plugin.build(out)) as archive:
                names = set(archive.namelist())
                metadata = json.loads(archive.read("metadata.json"))
        finally:
            shutil.rmtree(out, ignore_errors=True)
        for name in ("resources/icon.png", "plugins/plugin.json", "plugins/kinv_action.py", "plugins/requirements.txt",
                     "plugins/kinv/__main__.py", "plugins/kinv/ui/page.html", "plugins/kinv/launch.py"):
            self.assertIn(name, names)
        self.assertFalse(any("__pycache__" in n for n in names))
        self.assertEqual(metadata["identifier"], json.loads((ROOT / "plugin" / "plugin.json").read_text("utf8"))["identifier"])
        self.assertRegex(metadata["versions"][0]["version"], r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
