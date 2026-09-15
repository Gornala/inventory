"""The files a supplier's upload form eats, and the ones already on disk."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from kinv.adapters.kicad.hierarchy import read_text
from kinv.core.inventory.order import supplier_file_name
from kinv.js import code_units, num, num_str


def to_csv(columns: list[str], rows: list[dict]) -> str:
    """RFC 4180, CRLF: a field is quoted when it holds a delimiter, a quote or a newline."""

    def quote(value) -> str:
        text = num_str(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else str(value)
        return f'"{text.replace(chr(34), chr(34) * 2)}"' if re.search(r'[",\r\n]', text) else text

    lines = [",".join(quote(c) for c in columns)]
    for row in rows:
        lines.append(",".join(quote(row.get(c, "") if row.get(c) is not None else "") for c in columns))
    return "\r\n".join(lines) + "\r\n"


def supplier_csv(lines: list[dict], reference: bool, header: bool) -> str:
    """A quantity and their part number; the key as a third column only when asked for."""
    columns = ["Quantity", "Part Number"]
    if reference:
        columns.append("Customer Reference")
    rows = [
        {
            "Quantity": line["quantity"],
            # the supplier's own number if you gave one; the MPN is the fallback
            "Part Number": line["part"].get("orderNumber") if line["part"].get("orderNumber") is not None else line["part"]["mpn"],
            "Customer Reference": line["key"],
        }
        for line in lines
    ]
    csv = to_csv(columns, rows)
    return csv if header else csv[csv.index("\r\n") + 2 :]


def _iso_from_timestamp(seconds: float) -> str:
    moment = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def write_order_files(plan: dict, directory: str, reference: bool, header: bool) -> list[dict]:
    """One file per supplier, and what went into each."""
    written = []
    for order in plan["orders"]:
        name = supplier_file_name(order["supplier"])
        path = os.path.abspath(os.path.join(directory, name))
        with open(path, "wb") as handle:
            handle.write(supplier_csv(order["lines"], reference, header).encode("utf8"))
        written.append(
            {
                "name": name,
                "path": path,
                "supplier": order["supplier"],
                "lines": len(order["lines"]),
                "pieces": sum(line["quantity"] for line in order["lines"]),
                "writtenAt": _iso_from_timestamp(datetime.now(timezone.utc).timestamp()),
            }
        )
    return written


def list_order_files(directory: str) -> list[dict]:
    """The order files in a directory, counted out of the files themselves."""
    if not os.path.exists(directory):
        return []
    names = sorted((n for n in os.listdir(directory) if re.match(r"^order\..+\.csv\Z", n, re.I)), key=code_units)
    files = []
    for name in names:
        path = os.path.abspath(os.path.join(directory, name))
        counted = _summarise(read_text(path))
        files.append(
            {
                "name": name,
                "path": path,
                "supplier": name[len("order.") : -len(".csv")],
                **counted,
                "writtenAt": _iso_from_timestamp(os.stat(path).st_mtime),
            }
        )
    return files


def _summarise(text: str) -> dict:
    """Lines and pieces; a header is detected, since ``--no-header`` is a real option."""
    rows = [line for line in re.split(r"\r?\n", text) if line.strip() != ""]
    body = rows[1:] if rows and re.match(r'^"?quantity"?,', rows[0], re.I) else rows
    pieces = 0.0
    for row in body:
        first = num(row.split(",")[0].replace('"', ""))
        if first == first and abs(first) != float("inf"):
            pieces += first
    return {"lines": len(body), "pieces": pieces}
