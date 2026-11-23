"""Turn a static void method in a dex into `return-void`.

  python3 tools/dex_noop.py classes8.dex Lcom/fattoy/library/AndroidUtils; InAppReview
"""
import hashlib
import struct
import sys
import zlib


def uleb(buf, off):
    val = shift = 0
    while True:
        b = buf[off]
        off += 1
        val |= (b & 0x7F) << shift
        if b < 0x80:
            return val, off
        shift += 7


def noop(dex, cls, name):
    dex = bytearray(dex)
    u32 = lambda o: struct.unpack_from("<I", dex, o)[0]
    str_n, str_off = u32(0x38), u32(0x3C)
    type_off = u32(0x44)
    meth_off = u32(0x5C)
    cdef_n, cdef_off = u32(0x60), u32(0x64)

    def string(i):
        p = u32(str_off + 4 * i)
        _, p = uleb(dex, p)
        return bytes(dex[p:dex.index(0, p)]).decode("utf-8", "replace")

    def type_name(i):
        return string(u32(type_off + 4 * i))

    for c in range(cdef_n):
        base = cdef_off + 32 * c
        if type_name(u32(base)) != cls:
            continue
        p = u32(base + 24)
        sf, p = uleb(dex, p)
        inf, p = uleb(dex, p)
        dm, p = uleb(dex, p)
        vm, p = uleb(dex, p)
        for _ in range(sf + inf):
            _, p = uleb(dex, p)
            _, p = uleb(dex, p)
        idx = 0
        for k in range(dm + vm):
            if k == dm:
                idx = 0
            d, p = uleb(dex, p)
            _, p = uleb(dex, p)
            code, p = uleb(dex, p)
            idx += d
            mname = string(u32(meth_off + 8 * idx + 4))
            if mname == name and code:
                # Every code unit becomes return-void, so each try/catch
                # target still lands on an instruction boundary.
                units = u32(code + 12)
                dex[code + 16:code + 16 + 2 * units] = b"\x0e\x00" * units
                dex[12:32] = hashlib.sha1(dex[32:]).digest()
                dex[8:12] = struct.pack("<I", zlib.adler32(dex[12:]))
                return bytes(dex)
    raise SystemExit("method not found: %s->%s" % (cls, name))


if __name__ == "__main__":
    path, cls, name = sys.argv[1:4]
    data = open(path, "rb").read()
    open(path, "wb").write(noop(data, cls, name))
    print("patched %s->%s in %s" % (cls, name, path))
