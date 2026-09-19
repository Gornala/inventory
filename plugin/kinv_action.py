"""The toolbar button: opens kinv for the project KiCad has open.

KiCad runs this in the plugin's own environment, with the IPC API's address in
the environment. It asks KiCad for the project and the kicad-cli beside it,
hands both to ``kinv.launch.open_ui`` and exits; the server runs on by itself.
"""

from __future__ import annotations

import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
# The package ships next to this file; in a checkout of the repository it is one level up.
for candidate in (HERE, os.path.dirname(HERE)):
    if os.path.isdir(os.path.join(candidate, "kinv")):
        sys.path.insert(0, candidate)
        break


def tell(message: str) -> None:
    """A plugin has no terminal anyone reads, so trouble goes into a message box."""
    print(message, file=sys.stderr)
    if os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, "kinv", 0x10 | 0x10000)  # MB_ICONERROR | MB_SETFOREGROUND
        return
    try:
        import tkinter
        from tkinter import messagebox

        root = tkinter.Tk()
        root.withdraw()
        messagebox.showerror("kinv", message)
        root.destroy()
    except Exception:  # noqa: BLE001 — stderr it is, then
        pass


def open_documents(kicad, note) -> list[tuple[str, str, str]]:
    """What KiCad has open, as ``(file name, project name, project folder)`` per document.

    Both editors are asked, whichever the button was pressed in: the PCB editor
    answers with the project's folder, the schematic editor (10.0) with the
    file name alone, and either one on its own has to be enough.
    """
    from kipy.proto.common.types import DocumentType

    documents = []
    for doctype in (DocumentType.DOCTYPE_PCB, DocumentType.DOCTYPE_SCHEMATIC):
        try:
            open_ones = kicad.get_open_documents(doctype)
        except Exception as err:  # noqa: BLE001 — an older KiCad may not answer for every type
            note(f"  {DocumentType.Name(doctype)}: no answer ({err})")
            continue
        for document in open_ones:
            note(
                f"  {DocumentType.Name(doctype)}: {document.board_filename!r}"
                f" in {document.project.path!r} ({document.project.name!r})"
            )
            documents.append((document.board_filename, document.project.name, document.project.path))
    return documents


def open_project(kicad, note) -> str:
    """The ``.kicad_pro`` of the board or schematic this was pressed in."""
    from kinv.adapters.kicad.recent import project_of

    project = project_of(open_documents(kicad, note))
    if not project:
        raise RuntimeError("KiCad has no saved project open. Save the project first, then press the button again.")
    return project


def main() -> int:
    note = print  # until the package is found: a failure to import it must still reach a message box
    try:
        from kinv.launch import note

        note(f"button pressed in {os.getcwd()!r} (KIPRJMOD={os.environ.get('KIPRJMOD')!r})")
        from kipy import KiCad
        from kipy.errors import ConnectionError as KiCadUnreachable

        kicad = KiCad()
        try:
            kicad.ping()  # first: open_project passes over a document type that does not answer
        except KiCadUnreachable as err:
            raise RuntimeError(
                f"KiCad's API does not answer ({err}).\n\nTurn it on in Preferences → Plugins → Enable KiCad API."
            ) from None
        project = open_project(kicad, note)
        note(f"  project {project}")
        env = {}
        try:
            cli = kicad.get_kicad_binary_path("kicad-cli")
            if cli and os.path.exists(cli):
                # This KiCad's kicad-cli, not whichever is found first — and so its
                # footprint libraries too, wherever it is installed.
                env["KINV_KICAD_CLI"] = cli
        except Exception:  # noqa: BLE001 — kinv looks for one itself
            pass

        from kinv.launch import open_ui

        open_ui(project, env=env)
        note("  done")
        return 0
    except Exception as err:  # noqa: BLE001
        detail = str(err) if isinstance(err, RuntimeError) else traceback.format_exc()
        note(f"  failed: {detail}")
        tell(f"kinv could not open.\n\n{detail}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
