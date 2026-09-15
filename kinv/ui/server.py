"""The local web server behind ``kinv ui``: the page, and a small JSON API over the board.

Binds to 127.0.0.1 only. It serves a live view of files on disk; it is a local
instrument, not something to expose on a network.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

from kinv.adapters.export.orders import list_order_files, write_order_files
from kinv.adapters.git import dirty_files
from kinv.adapters.kicad.schematic_edit import apply_field_write, apply_value_rewrite, plan_field_write, plan_value_rewrite
from kinv.adapters.os_dialog import choose_folder
from kinv.adapters.store.inventory import read_assignments, read_catalog, write_assignments, write_catalog
from kinv.adapters.store.project_state import clear_solved, set_buy_choice, set_solved
from kinv.core.inventory.adopt import apply_adopt, plan_adopt
from kinv.core.inventory.fields import fields_to_write
from kinv.core.inventory.order import plan_order
from kinv.core.inventory.resolve import assign_part, now_iso, set_supplier, unassign
from kinv.js import num, stringify
from kinv.report import create_report_cache, footprint_detail

_PAGE = (Path(__file__).parent / "page.html").read_bytes().decode("utf8")

# Identifies this build of the page. The browser holds one copy of the script
# for as long as the tab is open and only re-renders it from JSON, so a rebuilt
# UI would never reach a tab already open — the page stamps itself with this
# and reloads when the report reports another. Hashed the way the TypeScript
# server hashes it, so the same page is the same build in either.
BUILD = hashlib.sha1(_PAGE.encode("utf8")).hexdigest()[:12]
_HTML = _PAGE.replace("__KINV_BUILD__", BUILD, 1).encode("utf8")

_POST_ROUTES = ("/api/solved", "/api/rewrite", "/api/assign", "/api/supplier", "/api/order", "/api/fields", "/api/adopt", "/api/buy")


def _str(value: Any) -> str:
    """A JSON body is whatever the caller sent; only strings are taken as strings."""
    return value if isinstance(value, str) else ""


def _js_number(value: Any) -> float:
    """``Number(value)`` for whatever JSON can hold."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return num(value)
    if value is None:
        return 0.0
    return math.nan


def _usable_dir(directory: str) -> str:
    """A directory you picked, checked — and never invented, since a typo should be a sentence."""
    path = os.path.abspath(directory)
    if not os.path.exists(path):
        raise ValueError(f"no such directory: {path}")
    if not os.path.isdir(path):
        raise ValueError(f"not a directory: {path}")
    return path


class _Refused(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def start_ui_server(
    project: str,
    port: int = 7373,
    choose: Callable[[str], dict] | None = None,
    **report_options: Any,
) -> tuple[ThreadingHTTPServer, str]:
    """Starts the server on a background thread; returns it and its URL."""
    get_report = create_report_cache(project, **report_options)
    ask_where = choose or choose_folder
    state = {
        # Where the last export went, and where the next starts: held for as
        # long as the server runs, since a picked folder is a convenience and
        # not a decision about the board.
        "export_to": os.path.dirname(os.path.abspath(project)),
        # One folder dialog at a time: pressing export again is exactly what
        # you do when the first one has not surfaced yet.
        "picking": False,
    }
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "kinv"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass  # a request log in the terminal is noise for a local instrument

        # --- responses ---------------------------------------------------------

        def _send(self, status: int, body: bytes, content_type: str, no_store: bool = True) -> None:
            self.send_response(status)
            self.send_header("content-type", content_type)
            if no_store:
                # It is a live view of files on disk; a cached copy is a wrong one.
                self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, value: Any) -> None:
            self._send(status, stringify(value).encode("utf8"), "application/json; charset=utf-8")

        def _text(self, status: int, message: str) -> None:
            self._send(status, message.encode("utf8"), "text/plain; charset=utf-8", no_store=False)

        # --- routing -------------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802
            self._route()

        def do_POST(self) -> None:  # noqa: N802
            self._route()

        def do_PUT(self) -> None:  # noqa: N802
            self._route()

        def do_DELETE(self) -> None:  # noqa: N802
            self._route()

        def _route(self) -> None:
            url = self.path or "/"
            # An open tab polls every two seconds; `kinv ui --idle-exit` stops
            # the server once that has been quiet for long enough.
            server.last_request = time.monotonic()  # type: ignore[attr-defined]
            try:
                if url == "/" or url.startswith("/?"):
                    return self._send(200, _HTML, "text/html; charset=utf-8")
                if url.startswith("/api/hello"):
                    # Which board this server is for — how the KiCad plugin
                    # tells an open kinv it can reuse from a stale address.
                    return self._json(200, {"kinv": BUILD, "project": os.path.abspath(project)})
                if url.startswith("/api/footprint"):
                    return self._footprint(url)
                if url.startswith("/api/exports"):
                    try:
                        directory = state["export_to"]
                        return self._json(200, {"dir": directory, "files": list_order_files(directory)})
                    except Exception as err:  # noqa: BLE001
                        return self._text(500, str(err))
                if url.startswith("/api/report"):
                    try:
                        return self._json(200, {**get_report(), "build": BUILD})
                    except Exception as err:  # noqa: BLE001
                        return self._text(500, str(err))
                if url.startswith(_POST_ROUTES):
                    return self._write(url)
                self._text(404, "not found")
            except (BrokenPipeError, ConnectionResetError):
                pass  # the tab went away mid-answer

        def _footprint(self, url: str) -> None:
            reference = parse_qs(urlsplit(url).query).get("ref", [""])[0]
            try:
                detail = footprint_detail(project, reference)
            except Exception as err:  # noqa: BLE001
                return self._text(500, str(err))
            if detail is None:
                return self._text(404, f"footprint not found in any library: {reference}")
            self._json(200, detail)

        # --- writes --------------------------------------------------------------

        def _same_origin(self) -> bool:
            """Any page can make a simple cross-origin POST; none can set a custom header."""
            if self.headers.get("x-kinv") != "1":
                return False
            origin = self.headers.get("origin")
            if origin is None:
                return True
            try:
                return urlsplit(origin).hostname in ("127.0.0.1", "localhost")
            except ValueError:
                return False

        def _body(self) -> dict:
            length = int(self.headers.get("content-length") or 0)
            # A local instrument still does not need an unbounded buffer.
            if length > 1_000_000:
                raise _Refused(400, "request too large")
            raw = self.rfile.read(length) if length else b""
            parsed = json.loads(raw.decode("utf8") or "null")
            return parsed if isinstance(parsed, dict) else {}

        def _write(self, url: str) -> None:
            if self.command != "POST":
                return self._json(405, {"error": "POST only"})
            if not self._same_origin():
                return self._json(403, {"error": "not from this page"})
            try:
                body = self._body()
                self._dispatch(url, body)
            except _Refused as refused:
                self._json(refused.status, {"error": str(refused)})
            except Exception as err:  # noqa: BLE001 — as the TypeScript server: a failed write is a 400
                self._json(400, {"error": str(err)})

        def _dispatch(self, url: str, b: dict) -> None:
            if url.startswith("/api/solved/reset"):
                clear_solved(project)
                return self._json(200, {"ok": True})
            if url.startswith("/api/solved"):
                ident = _str(b.get("id"))
                if ident == "":
                    return self._json(400, {"error": "no finding id"})
                set_solved(project, {"id": ident, "signature": _str(b.get("signature")), "at": now_iso()}, b.get("solved") is not False)
                return self._json(200, {"ok": True})

            if url.startswith("/api/buy"):
                # Which side of the list a part sits on, and nothing else.
                key = _str(b.get("key"))
                if key == "":
                    return self._json(400, {"error": "no part key"})
                buy = b.get("buy") is True
                set_buy_choice(project, key, buy, now_iso())
                return self._json(200, {"ok": True, "key": key, "buy": buy})

            if url.startswith("/api/supplier"):
                key = _str(b.get("key"))
                if key == "":
                    return self._json(400, {"error": "no part key"})
                result = set_supplier(
                    key,
                    {"supplier": _str(b.get("supplier")), "orderNumber": _str(b.get("orderNumber"))},
                    read_catalog(),
                    read_assignments(),
                )
                write_catalog(result["catalog"])
                return self._json(200, {"ok": True, "part": result["part"]})

            if url.startswith("/api/order/where"):
                return self._where(b)
            if url.startswith("/api/order"):
                return self._order(b)
            if url.startswith("/api/fields"):
                return self._fields(url)
            if url.startswith("/api/adopt"):
                return self._adopt(url)
            if url.startswith("/api/assign"):
                return self._assign(url, b)
            return self._rewrite(url, b)

        def _where(self, b: dict) -> None:
            """The OS dialog, on the machine the server runs on — which is the one the browser runs on."""
            with lock:
                if state["picking"]:
                    return self._json(200, {"status": "busy"})
                state["picking"] = True
            try:
                choice = ask_where(_str(b.get("start")) or state["export_to"])
                if choice.get("status") != "chosen":
                    return self._json(200, choice)
                try:
                    state["export_to"] = _usable_dir(choice["dir"])
                except ValueError as err:
                    return self._json(400, {"error": str(err)})
                self._json(200, {"status": "chosen", "dir": state["export_to"]})
            except Exception as err:  # noqa: BLE001
                self._json(500, {"error": str(err)})
            finally:
                with lock:
                    state["picking"] = False

        def _order(self, b: dict) -> None:
            # The quantity is placements x boards, and the boards are the number you typed.
            boards_value = _js_number(b.get("boards"))
            if not boards_value or math.isnan(boards_value):
                boards_value = 1.0
            boards = max(1, math.floor(boards_value))
            asked = _str(b.get("dir"))
            if asked != "":
                try:
                    state["export_to"] = _usable_dir(asked)
                except ValueError as err:
                    return self._json(400, {"error": str(err)})
            try:
                report = get_report()
                plan = plan_order(report["parts"], report["resolutions"], boards)
                directory = state["export_to"]
                # Quantity and part number only; `kinv order --reference` adds the key.
                files = write_order_files(plan, directory, reference=False, header=True)
                self._json(
                    200,
                    {
                        "ok": True,
                        "boards": boards,
                        "dir": directory,
                        "files": files,
                        "noSupplier": len(plan["noSupplier"]),
                        "unresolved": len(plan["unresolved"]),
                    },
                )
            except Exception as err:  # noqa: BLE001
                self._json(500, {"error": str(err)})

        def _fields(self, url: str) -> None:
            """Out to the schematic: the MPN and vendor onto the symbols."""
            try:
                report = get_report()
                entries = fields_to_write(report["parts"], report["resolutions"])
                plan = plan_field_write(
                    project, [{"refs": e["refs"], "valueIsOneOf": e["values"], "fields": e["fields"]} for e in entries]
                )
                # After this runs, `git diff` should show only what the tool did.
                plan["dirty"] = dirty_files([f["path"] for f in plan["files"]])
                if url.startswith("/api/fields/plan"):
                    return self._json(200, {**plan, "entries": len(entries)})
                try:
                    self._json(200, {**apply_field_write(plan), "plan": plan})
                except Exception as err:  # noqa: BLE001
                    self._json(409, {"error": str(err)})
            except Exception as err:  # noqa: BLE001
                self._json(500, {"error": str(err)})

        def _adopt(self, url: str) -> None:
            """Back in from the schematic — a plan first, always."""
            try:
                report = get_report()
                plan = plan_adopt(report["parts"], read_catalog(), read_assignments())
                if url.startswith("/api/adopt/plan"):
                    return self._json(200, plan)
                result = apply_adopt(plan, read_catalog(), read_assignments())
                write_catalog(result["catalog"])
                write_assignments(result["assignments"])
                self._json(
                    200,
                    {
                        "ok": True,
                        "adopted": len(result["adopted"]),
                        "filled": len(result["filled"]),
                        "conflicts": len([e for e in plan["entries"] if e["status"] == "conflict"]),
                    },
                )
            except Exception as err:  # noqa: BLE001
                self._json(500, {"error": str(err)})

        def _assign(self, url: str, b: dict) -> None:
            key = _str(b.get("key"))
            if key == "":
                return self._json(400, {"error": "no part key"})
            if url.startswith("/api/assign/clear"):
                write_assignments(unassign(key, read_assignments()))
                return self._json(200, {"ok": True})
            result = assign_part(
                key,
                {name: _str(b.get(name)) for name in ("mpn", "manufacturer", "supplier", "orderNumber", "datasheet", "notes")},
                read_catalog(),
                read_assignments(),
            )
            # The catalog first: an assignment pointing at a part that is not
            # there yet is the one order the two writes must not happen in.
            write_catalog(result["catalog"])
            write_assignments(result["assignments"])
            self._json(200, {"ok": True, "part": result["part"]})

        def _rewrite(self, url: str, b: dict) -> None:
            groups = []
            for group in b.get("groups") if isinstance(b.get("groups"), list) else []:
                group = group if isinstance(group, dict) else {}
                refs = group.get("refs") if isinstance(group.get("refs"), list) else []
                groups.append({"from": _str(group.get("from")), "refs": [r for r in map(_str, refs) if r != ""]})
            request = {"groups": groups, "to": _str(b.get("to"))}
            if all(not g["refs"] for g in groups) or request["to"] == "":
                return self._json(400, {"error": "nothing to rewrite"})

            plan = plan_value_rewrite(project, request)
            if url.startswith("/api/rewrite/plan"):
                return self._json(200, plan)
            try:
                self._json(200, {**apply_value_rewrite(plan), "plan": plan})
            except Exception as err:  # noqa: BLE001
                self._json(409, {"error": str(err)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.last_request = time.monotonic()  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, name="kinv-ui", daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"
