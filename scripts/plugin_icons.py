"""Draws the plugin's icons: a parts list, three pads and three lines.

    python scripts/plugin_icons.py

Standard library only, like the rest: the shapes are rounded rectangles
measured on a 24-unit grid and rasterised with 4x4 supersampling, written as
PNG by hand. Writes the toolbar icons into plugin/ (24 and 48 px, light and
dark) and the package manager's 64 px icon into plugin/resources/.
"""

from __future__ import annotations

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, "plugin")

COPPER = (0xC8, 0x7E, 0x3A)
INK = {"light": (0x4A, 0x4A, 0x4A), "dark": (0xD8, 0xD8, 0xD8)}

# (x0, y0, x1, y1, radius, colour name) on the 24-unit grid
ROWS = [5.0, 10.5, 16.0]
SHAPES = [shape for y in ROWS for shape in ((3.0, y, 7.0, y + 3.5, 0.8, "copper"), (9.5, y + 1.0, 21.0, y + 2.5, 0.75, "ink"))]


def _inside(px: float, py: float, shape: tuple) -> bool:
    x0, y0, x1, y1, r, _ = shape
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size: int, ink: tuple, background: tuple | None = None, inset: float = 0.0) -> list[bytes]:
    """Rows of RGBA; ``background`` fills a rounded square behind the glyph, ``inset`` shrinks the glyph into it."""
    samples = 4
    scale = (24.0 + 2 * inset) / size
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            totals = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    gx = (x + (sx + 0.5) / samples) * scale - inset
                    gy = (y + (sy + 0.5) / samples) * scale - inset
                    colour = None
                    if background and _inside(gx, gy, (-inset, -inset, 24 + inset, 24 + inset, 5.0, "")):
                        colour = background
                    for shape in SHAPES:
                        if _inside(gx, gy, shape):
                            colour = COPPER if shape[5] == "copper" else ink
                    if colour:
                        totals[0] += colour[0]
                        totals[1] += colour[1]
                        totals[2] += colour[2]
                        totals[3] += 1
            covered = totals[3]
            if covered:
                row += bytes((round(totals[0] / covered), round(totals[1] / covered), round(totals[2] / covered)))
                row.append(round(255 * covered / samples**2))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def write_png(path: str, rows: list[bytes]) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    height, width = len(rows), len(rows[0]) // 4
    raw = b"".join(b"\0" + row for row in rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as file:
        file.write(png)


def main() -> None:
    for theme, ink in INK.items():
        for size in (24, 48):
            write_png(os.path.join(PLUGIN, f"icon-{theme}-{size}.png"), render(size, ink))
    write_png(os.path.join(PLUGIN, "resources", "icon.png"), render(64, INK["light"], background=(0xF4, 0xF1, 0xEA), inset=3.0))


if __name__ == "__main__":
    main()
