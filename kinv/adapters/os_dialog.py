"""The machine's own "choose a folder" dialog.

The server and the browser are the same machine — that is the premise of this
tool — so the place to ask "where do you want these written?" is the file
dialog the operating system already has, rather than a directory tree
reimplemented in a page.
"""

from __future__ import annotations

import os
import subprocess
import sys

# The owner form is the whole trick, and it took a measurement to get right.
# The process asking is not the one you are looking at, so Windows will not
# hand it the foreground; a dialog owned by nothing — or by a form that merely
# *has* TopMost set and was never shown — is created behind the browser, with
# no taskbar button to find it by. An owner that is shown and activated puts
# it in front (measured: topmost=True foreground=True), and Opacity 0 keeps
# the owner itself off the screen.
#
# One addition over the TypeScript version: stdout is switched to UTF-8.
# Redirected, PowerShell writes in the console's OEM code page, so a folder
# with an umlaut in its name came back as mojibake in both versions.
_WINDOWS_SCRIPT = "; ".join(
    [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'kinv — where should the upload files go?'",
        "$dialog.ShowNewFolderButton = $true",
        "if ($env:KINV_PICK_START) { $dialog.SelectedPath = $env:KINV_PICK_START }",
        "$owner = New-Object System.Windows.Forms.Form",
        "$owner.Text = 'kinv'",
        "$owner.TopMost = $true",
        "$owner.ShowInTaskbar = $false",
        "$owner.FormBorderStyle = 'None'",
        "$owner.Opacity = 0",
        "$owner.Width = 1",
        "$owner.Height = 1",
        "$owner.StartPosition = 'CenterScreen'",
        "$owner.Show()",
        "$owner.Activate()",
        "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.Write($dialog.SelectedPath) }",
        "$owner.Dispose()",
    ]
)

_TIMEOUT_SECONDS = 5 * 60  # a dialog nobody answers must not hold a request all afternoon


def folder_pickers(platform: str, start: str) -> list[dict]:
    """What to run to open a folder dialog here, best candidate first."""
    if platform == "win32":
        return [
            {
                "command": "powershell.exe",
                # -Sta: a WinForms dialog needs a single-threaded apartment.
                # -NoProfile: somebody's $PROFILE must not print into stdout.
                "args": ["-NoProfile", "-NonInteractive", "-Sta", "-Command", _WINDOWS_SCRIPT],
                # The start path travels in the environment, never in the script.
                "env": {"KINV_PICK_START": start},
            }
        ]
    if platform == "darwin":
        return [
            {
                "command": "osascript",
                "args": [
                    "-e", "on run argv",
                    "-e", 'POSIX path of (choose folder with prompt "kinv — where should the upload files go?" '
                    "default location POSIX file (item 1 of argv))",
                    "-e", "end run",
                    start,
                ],
            }
        ]
    # GTK first, then KDE; both take the path as a plain argument.
    return [
        {
            "command": "zenity",
            "args": [
                "--file-selection",
                "--directory",
                "--title=kinv — where should the upload files go?",
                "--filename=" + start.rstrip("/") + "/",
            ],
        },
        {"command": "kdialog", "args": ["--getexistingdirectory", start]},
    ]


def choose_folder(start: str) -> dict:
    """``{status: "chosen", dir}``, ``{status: "cancelled"}`` or ``{status: "unavailable", reason}``.

    Kept apart on purpose: a cancel is not an error, and a machine with no
    dialog at all has to be told apart from both, because the page offers a
    typed path instead.
    """
    last_reason = "no folder dialog on this machine"
    for picker in folder_pickers(sys.platform, start):
        environment = {**os.environ, **picker.get("env", {})}
        try:
            creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            result = subprocess.run(
                [picker["command"], *picker["args"]],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                env=environment,
                timeout=_TIMEOUT_SECONDS,
                creationflags=creation,
            )
        except FileNotFoundError:
            last_reason = f"{picker['command']} is not installed"
            continue
        except subprocess.TimeoutExpired:
            return {"status": "cancelled"}

        chosen = result.stdout.decode("utf8", errors="replace").strip()
        if chosen != "":
            return {"status": "chosen", "dir": chosen}

        # Nothing on stdout: you cancelled, or the dialog never opened. A cancel
        # is quiet or says so; anything else is a machine that cannot show one.
        noise = result.stderr.decode("utf8", errors="replace").strip()
        if result.returncode != 0 and noise != "" and "cancel" not in noise.lower():
            last_reason = noise.split("\n")[0][:200] or "the folder dialog failed"
            continue
        return {"status": "cancelled"}

    return {"status": "unavailable", "reason": last_reason}
