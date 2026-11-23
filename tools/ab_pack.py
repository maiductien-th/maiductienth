"""Rebuild a Swordash AssetBundle container around new SerializedFile bytes.

The game's bundles hold one LZMA block and one directory node. Repacking has to
reproduce the 9-byte ab_head_end_flag (5d0000080000006c01) that
AssetUtility.FindAssetBundleContentStart scans for, which means compressing with
the same LZMA settings the packer used (lc=3 lp=0 pb=2, 512K dict).
"""
import lzma
import struct

import lz4.block

from ab_codec import decode, encode, data_start

LZMA_PROPS = b"\x5d\x00\x00\x08\x00"
LZMA_FILTERS = [{"id": lzma.FILTER_LZMA1, "lc": 3, "lp": 0, "pb": 2, "dict_size": 524288}]


def _header_end(p: bytes) -> int:
    q = p.index(b"\x00") + 1
    q += 4
    q = p.index(b"\x00", q) + 1
    q = p.index(b"\x00", q) + 1
    return q


def read_inner(bundle: bytes) -> bytes:
    """Obfuscated bundle -> decompressed SerializedFile bytes."""
    p = decode(bundle)
    blk = p[data_start(p):]
    filt = lzma._decode_filter_properties(lzma.FILTER_LZMA1, blk[:5])
    return lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[filt]).decompress(blk[5:])


def build(inner: bytes, template: bytes) -> bytes:
    """New SerializedFile bytes + original bundle -> new obfuscated bundle."""
    p = decode(template)
    q = _header_end(p)
    _size, cbis, ubis, flags = struct.unpack(">qIII", p[q:q + 20])
    hdr_end = q + 20
    bi_off = (hdr_end + 15) // 16 * 16
    bi = bytearray(lz4.block.decompress(p[bi_off:bi_off + cbis], uncompressed_size=ubis))

    # FORMAT_RAW emits no props header; the packer's 5 props bytes are the start
    # of ab_head_end_flag, so prepend them explicitly.
    comp = lzma.LZMACompressor(format=lzma.FORMAT_RAW, filters=LZMA_FILTERS)
    block = LZMA_PROPS + comp.compress(inner) + comp.flush()

    struct.pack_into(">II", bi, 20, len(inner), len(block))   # block uncompressed/compressed
    struct.pack_into(">q", bi, 42, len(inner))                # directory node size
    new_bi = bytes(bi)
    cbi = lz4.block.compress(new_bi, mode="high_compression", store_size=False)

    body = bi_off + len(cbi)
    body = (body + 15) // 16 * 16 + len(block)

    out = bytearray(p[:q])
    out += struct.pack(">qIII", body, len(cbi), len(new_bi), flags)
    out += b"\x00" * (bi_off - len(out))
    out += cbi
    while len(out) % 16:
        out += b"\x00"
    out += block
    return encode(bytes(out))
