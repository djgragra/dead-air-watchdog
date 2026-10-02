#!/usr/bin/env python3
"""Generates the app and tray icons (no dependencies): python3 dev/make-icons.py
Design: a level display falling silent (orange bars shrinking to a flat grey line) on a dark tile.
Writes assets/icon.png, icon.ico, icon.icns (macOS, needs iconutil), linux-icons/*.png, tray-*.png."""
import math, os, struct, subprocess, sys, tempfile, zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
ORANGE, GREY, TILE, EDGE = (255, 138, 43), (110, 119, 135), (23, 26, 33), (42, 47, 58)

def png(w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def sd_round_rect(px, py, cx, cy, hw, hh, r):
    qx, qy = abs(px - cx) - hw + r, abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def cover(d):  # signed distance in pixels -> coverage
    return min(1.0, max(0.0, 0.5 - d))

def blend(dst, src, a):
    return tuple(dst[i] * (1 - a) + src[i] * a for i in range(3))

def app_icon(n):
    out = bytearray(n * n * 4)
    s = n / 512.0
    # tile
    bars = []  # (x, half height, colour)
    heights = [0.16, 0.30, 0.44, 0.34, 0.22, 0.10, 0.02, 0.02, 0.02]
    for i, h in enumerate(heights):
        x = (0.16 + i * 0.085) * n
        bars.append((x, max(h * n * 0.5, 0.022 * n), ORANGE if i < 6 else GREY))
    rad = 0.028 * n
    for y in range(n):
        for x in range(n):
            px, py = x + 0.5, y + 0.5
            a_tile = cover(sd_round_rect(px, py, n / 2, n / 2, n / 2 - 1, n / 2 - 1, 0.22 * n))
            if a_tile <= 0: continue
            edge = cover(sd_round_rect(px, py, n / 2, n / 2, n / 2 - 1, n / 2 - 1, 0.22 * n) + 0.012 * n)
            col = blend(EDGE, TILE, edge)
            for bx, hh, c in bars:
                col = blend(col, c, cover(math.hypot(px - bx, py - min(max(py, n / 2 - hh), n / 2 + hh)) - rad))
            i = (y * n + x) * 4
            out[i:i + 4] = bytes((int(col[0]), int(col[1]), int(col[2]), int(a_tile * 255)))
    return png(n, n, out)

def tray_icon(n, colour):
    out = bytearray(n * n * 4)
    for y in range(n):
        for x in range(n):
            d = math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2)
            a_out = cover(d - (n / 2 - 1))
            if a_out <= 0: continue
            col = blend((20, 22, 28), colour, cover(d - (n / 2 - 1 - n * 0.09)))
            i = (y * n + x) * 4
            out[i:i + 4] = bytes((int(col[0]), int(col[1]), int(col[2]), int(a_out * 255)))
    return png(n, n, out)

def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)

def ico(images):  # images: {size: png bytes}
    head = struct.pack("<HHH", 0, 1, len(images))
    entries, blobs, off = b"", b"", 6 + 16 * len(images)
    for size, data in sorted(images.items()):
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), off)
        blobs += data; off += len(data)
    return head + entries + blobs

def main():
    cache = {}
    def icon(n):
        if n not in cache: cache[n] = app_icon(n)
        return cache[n]
    write(os.path.join(ROOT, "icon.png"), icon(512))
    write(os.path.join(ROOT, "icon.ico"), ico({s: icon(s) for s in (16, 32, 48, 256)}))
    for s in (16, 32, 48, 64, 128, 256, 512):
        write(os.path.join(ROOT, "linux-icons", f"{s}x{s}.png"), icon(s))
    for name, col in (("idle", (123, 132, 148)), ("ok", (53, 201, 143)), ("counting", (242, 193, 78)), ("alarm", (239, 91, 91))):
        write(os.path.join(ROOT, f"tray-{name}.png"), tray_icon(32, col))
    if sys.platform == "darwin":
        with tempfile.TemporaryDirectory() as tmp:
            iset = os.path.join(tmp, "icon.iconset")
            os.makedirs(iset)
            for s in (16, 32, 128, 256, 512):
                write(os.path.join(iset, f"icon_{s}x{s}.png"), icon(s))
                write(os.path.join(iset, f"icon_{s}x{s}@2x.png"), icon(s * 2))
            subprocess.run(["iconutil", "-c", "icns", iset, "-o", os.path.join(ROOT, "icon.icns")], check=True)
    print("icons written to", os.path.normpath(ROOT))

main()
