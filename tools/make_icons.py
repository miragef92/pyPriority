"""Génère les icônes PNG de l'appli web (sans dépendance) : python tools/make_icons.py"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
COLORS = [(0xE2, 0x4B, 0x4A), (0x37, 0x8A, 0xDD), (0xEF, 0x9F, 0x27), (0x88, 0x87, 0x80)]
BG = (0xF6, 0xF5, 0xF1)
SS = 4  # suréchantillonnage pour l'anticrénelage


def rounded(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x < x1 and y0 <= y < y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size, margin, background):
    """4 carrés arrondis ; `margin` en fraction de la taille (zone de sécurité des icônes « maskable »)."""
    inner = size * (1 - 2 * margin)
    gap = inner * 0.08
    cell = (inner - gap) / 2
    radius = cell * 0.18
    boxes = []
    for i, color in enumerate(COLORS):
        x0 = size * margin + (i % 2) * (cell + gap)
        y0 = size * margin + (i // 2) * (cell + gap)
        boxes.append((x0, y0, x0 + cell, y0 + cell, color))
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x, y = px + (sx + 0.5) / SS, py + (sy + 0.5) / SS
                    for x0, y0, x1, y1, c in boxes:
                        if rounded(x, y, x0, y0, x1, y1, radius):
                            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
                            break
                    else:
                        if background:
                            acc[0] += BG[0]; acc[1] += BG[1]; acc[2] += BG[2]; acc[3] += 255
            n = SS * SS
            a = acc[3] / n
            if a:
                row += bytes([round(acc[0] * 255 / acc[3]), round(acc[1] * 255 / acc[3]), round(acc[2] * 255 / acc[3]), round(a)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    write_png(OUT / "icon-192.png", 192, render(192, 0.08, background=False))
    write_png(OUT / "icon-512.png", 512, render(512, 0.08, background=False))
    write_png(OUT / "icon-maskable-512.png", 512, render(512, 0.22, background=True))
    (OUT / "icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1" fill="#E24B4A"/>'
        '<rect x="9" y="1" width="6" height="6" rx="1" fill="#378ADD"/><rect x="1" y="9" width="6" height="6" rx="1" fill="#EF9F27"/>'
        '<rect x="9" y="9" width="6" height="6" rx="1" fill="#888780"/></svg>\n', encoding="utf-8")
    print("Icônes écrites dans", OUT)
