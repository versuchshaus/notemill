#!/usr/bin/env python3
"""Draw Notemill's icons from scratch, with no dependencies.

The original extension shipped an icon from Wikimedia under CC BY-SA. That is
a copyleft licence on artwork, which constrains how the extension may be
licensed and redistributed, so the mark is drawn here instead: an original
geometric design, owned by this project.

The mark: a rust rounded square holding a white sheet with a folded corner,
and - above 32px, where they are legible - two lines of "text". Rendering is
a coverage rasteriser with 6x supersampling; enough for icon sizes and small
enough to read in one sitting.

Usage: tools/icons.py            # writes img/icon-{16,32,48,64,128}.png, icon.png
"""

import struct
import zlib
from pathlib import Path

IMG = Path(__file__).resolve().parent.parent / "img"
SIZES = [16, 32, 48, 64, 128, 512]


def samples(size):
    """Supersampling per axis: generous where it shows, cheaper at 512."""
    return 6 if size <= 128 else 3

# The brand orange. Chosen to sit visibly on both a white and a near-black
# toolbar: a filled tile carries the mark, so what matters is the tile's
# contrast against either chrome, not stroke weight. contrast() below reports
# both, and both stay above 3:1, the threshold for non-text graphics.
ORANGE = (232, 98, 16)
SHEET = (255, 255, 255)
INK = ORANGE


def luminance(rgb):
    """WCAG relative luminance."""
    channels = []
    for value in rgb:
        c = value / 255
        channels.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = channels
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def rounded_rect(x0, y0, x1, y1, r):
    """A predicate: is (px, py) inside this rounded rectangle?"""
    def inside(px, py):
        if not (x0 <= px <= x1 and y0 <= py <= y1):
            return False
        for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
            if (px < x0 + r or px > x1 - r) and (py < y0 + r or py > y1 - r):
                near_x = x0 + r if px < x0 + r else x1 - r
                near_y = y0 + r if py < y0 + r else y1 - r
                return (px - near_x) ** 2 + (py - near_y) ** 2 <= r * r
        return True
    return inside


def polygon(points):
    """A predicate: is (px, py) inside this polygon? Even-odd crossing test."""
    def inside(px, py):
        hit = False
        n = len(points)
        for i in range(n):
            ax, ay = points[i]
            bx, by = points[(i + 1) % n]
            if (ay > py) != (by > py):
                x_at = ax + (py - ay) * (bx - ax) / (by - ay)
                if px < x_at:
                    hit = not hit
        return hit
    return inside


def draw(size):
    """Composite the mark at `size`, returning rows of RGBA tuples."""
    # The sheet fills most of the tile: at 16px there is no room for polite
    # margins, and the mark has to read at a glance in a crowded toolbar.
    pad_x = 0.155 * size
    pad_y = 0.105 * size
    sx0, sy0 = pad_x, pad_y
    sx1, sy1 = size - pad_x, size - pad_y
    fold = 0.38 * (sx1 - sx0)                # the corner the sheet turns over

    # The cut corner alone reads as a fold; a darker triangle inside it just
    # looks like a bite out of the page, which is what the first attempt did.
    sheet = polygon([(sx0, sy0), (sx1 - fold, sy0), (sx1, sy0 + fold),
                     (sx1, sy1), (sx0, sy1)])

    layers = [
        (rounded_rect(0.5, 0.5, size - 0.5, size - 0.5, 0.22 * size), ORANGE),
        (sheet, SHEET),
    ]

    # The lines are the mark. Drawn at every size, including 16px, where the
    # first version skipped them and left a blank sheet inside a thin frame -
    # bigger, and harder to read. Fewer and thicker as the canvas shrinks.
    inset = 0.15 * (sx1 - sx0)
    if size <= 24:
        widths, line_h, gap = (1.0, 0.66), max(1.6, 0.10 * size), 0.30 * (sy1 - sy0)
        first = sy0 + 0.44 * (sy1 - sy0)
    else:
        widths, line_h, gap = (1.0, 1.0, 0.62), max(1.0, 0.068 * size), 0.175 * (sy1 - sy0)
        first = sy0 + 0.42 * (sy1 - sy0)

    for i, width in enumerate(widths):
        top = first + i * gap
        if top + line_h > sy1 - inset * 0.5:
            break
        layers.append((rounded_rect(sx0 + inset, top,
                                    sx0 + inset + width * (sx1 - sx0 - 2 * inset),
                                    top + line_h, line_h / 2), INK))

    ss = samples(size)
    rows = []
    step = 1.0 / ss
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            weight = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) * step
                    py = y + (sy + 0.5) * step
                    colour = None
                    for predicate, value in layers:
                        if predicate(px, py):
                            colour = value
                    if colour is None:
                        continue
                    acc = [acc[i] + colour[i] for i in range(3)]
                    weight += 1
            total = ss * ss
            alpha = weight / total
            if weight:
                rgb = tuple(int(round(c / weight)) for c in acc)
            else:
                rgb = (0, 0, 0)
            row.append(rgb + (int(round(alpha * 255)),))
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)                        # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    IMG.mkdir(exist_ok=True)
    for name, bg in (("white toolbar", (255, 255, 255)),
                     ("dark toolbar", (43, 43, 47)),
                     ("sheet on tile", SHEET)):
        other = ORANGE if name != "sheet on tile" else ORANGE
        print("contrast %-14s %.2f:1" % (name + ":", contrast(other, bg)))
    for size in SIZES:
        rows = draw(size)
        name = "icon.png" if size == 512 else "icon-%d.png" % size
        write_png(IMG / name, rows)
        print("img/%s written (%d×%d)" % (name, size, size))


if __name__ == "__main__":
    main()
