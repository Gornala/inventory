"""Packs the KiCad plugin: a zip for the Plugin and Content Manager's "Install from File…".

    python scripts/build_plugin.py            → dist/kinv-kicad-plugin-<version>.zip

The layout is the one the package manager unpacks: metadata.json at the top,
the plugin (plugin.json, the action, its icons and the whole kinv package) in
plugins/, and the package manager's icon in resources/.
"""

from __future__ import annotations

import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from kinv import __version__  # noqa: E402

PLUGIN = os.path.join(ROOT, "plugin")
PLUGIN_FILES = ["plugin.json", "requirements.txt", "kinv_action.py"] + [
    f"icon-{theme}-{size}.png" for theme in ("light", "dark") for size in (24, 48)
]


def build(out_dir: str = os.path.join(ROOT, "dist")) -> str:
    with open(os.path.join(PLUGIN, "metadata.json"), encoding="utf8") as file:
        metadata = json.load(file)
    for version in metadata["versions"]:
        version["version"] = __version__

    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, f"kinv-kicad-plugin-{__version__}.zip")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.json", json.dumps(metadata, indent=2, ensure_ascii=False) + "\n")
        archive.write(os.path.join(PLUGIN, "resources", "icon.png"), "resources/icon.png")
        for name in PLUGIN_FILES:
            archive.write(os.path.join(PLUGIN, name), f"plugins/{name}")
        package = os.path.join(ROOT, "kinv")
        for directory, subdirectories, files in os.walk(package):
            subdirectories[:] = sorted(d for d in subdirectories if d != "__pycache__")
            for name in sorted(files):
                if name.endswith((".pyc", ".pyo")):
                    continue
                path = os.path.join(directory, name)
                archive.write(path, "plugins/kinv/" + os.path.relpath(path, package).replace(os.sep, "/"))
    return target


if __name__ == "__main__":
    print(build())
