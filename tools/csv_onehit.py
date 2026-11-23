"""One hit for the offline-menu build: rewrite the binary config tables that
set enemy HP so every enemy spawns with 1 HP.

Enemy HP is the room's base HP (`stage_room_property.maxHp`, absolute per
stage room) times the stage level factor (`stage_level.maxHp`) times the
enemy's own factor (`character.maxHp`, a multiplier: plain zombies are 1).
Patching only `character` therefore leaves most enemies untouched, so all
three are set to 1.

Table format: b"CSV\\0", int32 column count, header, then (name, type)
length-prefixed cell pairs per column, an int32 row count, and the rows as
length-prefixed (int32 little-endian) UTF-8 cells.
"""
import struct, sys, zlib

ENEMY_TYPES = {b"monster", b"boss"}
# table -> (first column name, only rows whose `type` is an enemy type)
TABLES = {
    "character": (b"id", True),
    "stage_room_property": (b"stage_id", False),
    "stage_level": (b"id", False),
}


def _cell(raw: bytes, p: int) -> tuple[bytes, int]:
    n = struct.unpack("<i", raw[p:p + 4])[0]
    if n < 0 or p + 4 + n > len(raw):
        raise ValueError("bad cell at %d" % p)
    return raw[p + 4:p + 4 + n], p + 4 + n


def patch(raw: bytes, table: str = "character") -> tuple[bytes, int]:
    first, enemies_only = TABLES[table]
    ncols = struct.unpack("<i", raw[4:8])[0] - 1
    p = raw.index(struct.pack("<i", len(first)) + first)
    names = []
    for _ in range(ncols):
        name, p = _cell(raw, p)
        _, p = _cell(raw, p)
        names.append(name)
    i_hp = names.index(b"maxHp")
    i_type = names.index(b"type") if enemies_only else None
    nrows = struct.unpack("<i", raw[p:p + 4])[0]
    p += 4
    out, n = bytearray(raw[:p]), 0
    for _ in range(nrows):
        cells = []
        for _ in range(ncols):
            c, p = _cell(raw, p)
            cells.append(c)
        if (i_type is None or cells[i_type] in ENEMY_TYPES) and cells[i_hp] not in (b"", b"1"):
            cells[i_hp] = b"1"
            n += 1
        for c in cells:
            out += struct.pack("<i", len(c)) + c
    if p != len(raw):
        raise ValueError("%s: %d trailing bytes" % (table, len(raw) - p))
    return bytes(out), n


def patch_compressed(blob: bytes, table: str = "character") -> tuple[bytes, int]:
    new, n = patch(zlib.decompress(blob), table)
    return zlib.compress(new, 9), n


if __name__ == "__main__":
    new, n = patch(zlib.decompress(open(sys.argv[1], "rb").read()), sys.argv[2])
    print("rows patched:", n, "size", len(new))
