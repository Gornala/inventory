"""``python -m kinv`` — the command line.

Only ``ui`` so far; the other commands follow in the next stage of the port.
"""

from __future__ import annotations

import argparse
import sys
import time
import webbrowser

from kinv import __version__
from kinv.js import num


def _ui(args: argparse.Namespace) -> int:
    from kinv.ui.server import start_ui_server

    near = num(args.near)
    options = {
        "group_by": args.group_by,
        "exclude_dnp": args.exclude_dnp,
        "include_excluded": args.include_excluded,
    }
    if near == near and abs(near) != float("inf"):
        options["near_value_percent"] = near

    try:
        server, url = start_ui_server(args.project, port=args.port, **options)
    except OSError as err:
        print(f"kinv ui: cannot listen on port {args.port}: {err.strerror or err}", file=sys.stderr)
        return 1

    print(f"kinv ui → {url}")
    print("re-reads the schematics whenever you save in KiCad · ctrl-c to stop")
    if args.open:
        webbrowser.open(url)  # a convenience; failing to open one is not an error
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kinv", description="KiCad BOM → consolidated inventory → a basket per supplier")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)

    ui = commands.add_parser("ui", help="serve a live view of the project's BOM, findings and issues")
    ui.add_argument("project", help="path to a .kicad_pro or .kicad_sch, or an exported .csv")
    ui.add_argument("--port", type=int, default=7373, help="port to listen on (default 7373)")
    ui.add_argument("--group-by", default="Value,Footprint", help="kicad-cli grouping fields")
    ui.add_argument("--exclude-dnp", action="store_true", help="drop do-not-populate parts")
    ui.add_argument("--near", default="2", help="flag values closer together than this percentage")
    ui.add_argument("--include-excluded", action="store_true", help="keep test points and mounting holes as parts")
    ui.add_argument("--no-open", dest="open", action="store_false", help="do not open a browser")
    ui.set_defaults(run=_ui)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
