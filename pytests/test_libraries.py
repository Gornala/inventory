"""Finding KiCad's own libraries when KiCad is installed somewhere kinv would not guess."""

import os
import shutil
import tempfile
import unittest

from kinv.adapters.kicad.libraries import resolve_vars

VARIABLE = "${KINV_TEST_FOOTPRINT_DIR}"  # in no environment and no kicad_common.json, so only the install is left


class AnInstallAnywhere(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = {name: os.environ.pop(name, None) for name in ("KINV_KICAD_CLI", "KINV_KICAD_ROOT")}
        self.root = tempfile.mkdtemp(prefix="kicad-elsewhere-")

    def tearDown(self) -> None:
        for name, value in self.saved.items():
            os.environ.pop(name, None)
            if value is not None:
                os.environ[name] = value
        shutil.rmtree(self.root, ignore_errors=True)

    def make(self, *parts: str) -> str:
        path = os.path.join(self.root, *parts)
        os.makedirs(os.path.dirname(path) if "." in parts[-1] else path, exist_ok=True)
        return path

    def test_is_found_through_the_kicad_cli_beside_it(self):
        footprints = self.make("D-drive", "KiCad", "share", "kicad", "footprints")
        cli = self.make("D-drive", "KiCad", "bin", "kicad-cli.exe")
        os.environ["KINV_KICAD_CLI"] = cli
        self.assertEqual(os.path.normcase(resolve_vars(VARIABLE)), os.path.normcase(footprints))

    def test_a_macos_app_bundle(self):
        footprints = self.make("KiCad.app", "Contents", "SharedSupport", "footprints")
        os.environ["KINV_KICAD_CLI"] = self.make("KiCad.app", "Contents", "MacOS", "kicad-cli")
        self.assertEqual(os.path.normcase(resolve_vars(VARIABLE)), os.path.normcase(footprints))

    def test_or_named_directly(self):
        footprints = self.make("kicad", "share", "kicad", "footprints")
        os.environ["KINV_KICAD_ROOT"] = os.path.join(self.root, "kicad")
        self.assertEqual(os.path.normcase(resolve_vars(VARIABLE + "/Resistor_SMD.pretty")),
                         os.path.normcase(footprints + "/Resistor_SMD.pretty"))


if __name__ == "__main__":
    unittest.main()
