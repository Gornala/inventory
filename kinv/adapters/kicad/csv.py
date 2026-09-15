"""RFC 4180 CSV reader.

Written rather than taken from the ``csv`` module because it has to agree with
the TypeScript reader to the character: the reference-designator column is
full of embedded commas (``"C1001,C2004,C6001-C6004"``), and the file may
arrive with CRLF, LF, or a byte-order mark.
"""

from __future__ import annotations


def parse_csv(text: str, delimiter: str = ",") -> list[list[str]]:
    if text.startswith("﻿"):
        text = text[1:]
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    quoted = False
    saw_field = False
    i = 0
    n = len(text)

    def end_field() -> None:
        nonlocal saw_field
        row.append("".join(field))
        field.clear()
        saw_field = False

    def end_row() -> None:
        nonlocal row
        end_field()
        rows.append(row)
        row = []

    while i < n:
        ch = text[i]

        if quoted:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                quoted = False
                i += 1
                continue
            field.append(ch)
            i += 1
            continue

        if ch == '"' and not saw_field:
            quoted = True
            saw_field = True
            i += 1
            continue
        if ch == delimiter:
            end_field()
            i += 1
            continue
        if ch == "\r":
            i += 2 if i + 1 < n and text[i + 1] == "\n" else 1
            end_row()
            continue
        if ch == "\n":
            i += 1
            end_row()
            continue

        field.append(ch)
        saw_field = True
        i += 1

    # A trailing newline must not produce a phantom row.
    if field or row:
        end_row()

    return rows


def parse_csv_records(text: str, delimiter: str = ",") -> list[dict[str, str]]:
    """Rows keyed by header name, with the header row consumed."""
    rows = parse_csv(text, delimiter)
    if not rows:
        return []
    header = rows.pop(0)
    records = []
    for row in rows:
        if not any(cell.strip() != "" for cell in row):
            continue
        record: dict[str, str] = {}
        for index, name in enumerate(header):
            record[name] = row[index] if index < len(row) else ""
        records.append(record)
    return records
