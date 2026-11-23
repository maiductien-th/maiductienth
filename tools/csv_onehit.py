"""Rewrite the binary `character` config so every monster/boss row has maxHp 1.

The table is the game's binary CSV: b"CSV\\0", int32 column count, then
length-prefixed (int32 little-endian) UTF-8 cells. Rows start at the first
`hero_1` id cell and are `ncols` cells each.
"""
import struct, sys, zlib

ENEMY_TYPES = {b"monster", b"boss"}


def patch(raw: bytes) -> tuple[bytes, int]:
    ncols = struct.unpack("<i", raw[4:8])[0] - 1
    p = 4 + 4 * 3
    names = []
    p = raw.index(b"\x02\x00\x00\x00id\x03\x00\x00\x00str")
    for _ in range(ncols):
        for k in range(2):
            n = struct.unpack("<i", raw[p:p + 4])[0]
            if k == 0:
                names.append(raw[p + 4:p + 4 + n])
            p += 4 + n
    i_type, i_hp = names.index(b"type"), names.index(b"maxHp")
    start = raw.index(b"\x06\x00\x00\x00hero_1\x00")
    out, q, n = bytearray(raw[:start]), start, 0
    rows = 0
    while q < len(raw):
        cells, r = [], q
        for _ in range(ncols):
            ln = struct.unpack("<i", raw[r:r + 4])[0] if r + 4 <= len(raw) else -1
            if ln < 0 or r + 4 + ln > len(raw):
                cells = None
                break
            cells.append(raw[r + 4:r + 4 + ln])
            r += 4 + ln
        if cells is None:
            break
        q, rows = r, rows + 1
        if cells[i_type] in ENEMY_TYPES and cells[i_hp] not in (b"", b"0", b"1"):
            cells[i_hp] = b"1"
            n += 1
        for c in cells:
            out += struct.pack("<i", len(c)) + c
    out += raw[q:]
    print("rows", rows, "trailing bytes", len(raw) - q, file=sys.stderr)
    return bytes(out), n


def patch_compressed(blob: bytes) -> tuple[bytes, int]:
    raw = zlib.decompress(blob)
    new, n = patch(raw)
    return zlib.compress(new, 9), n


if __name__ == "__main__":
    data = open(sys.argv[1], "rb").read()
    new, n = patch(zlib.decompress(data))
    print("rows patched:", n, "size", len(new))
