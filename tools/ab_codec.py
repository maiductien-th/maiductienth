"""Decode/encode Swordash AssetBundles.

The game ships AssetBundles whose UnityFS header and block directory are plain,
while the compressed data block is obfuscated. AssetUtility.decodeByte8
(libil2cpp.so RVA 0x1938744) swaps each byte's nibbles and XORs with 0x33:

    w8 = (raw >> 4) ^ 3 ; w9 = (raw << 4) ^ 0x30 ; result = w9 | w8

The transform is an involution, so AssetUtility.encodeByte8 is the same
operation. The first 9 bytes of the data block are left in the clear; this is
the ab_head_end_flag length that AssetUtility.FindAssetBundleContentStart
(RVA 0x19385A0) scans for, allocated as a 9-element array in .cctor.
"""
import struct

HEAD_CLEAR = 9


def _xf(data: bytes) -> bytes:
    return bytes(((((b << 4) & 0xF0) ^ 0x30) | (((b >> 4) & 0x0F) ^ 0x03)) for b in data)


def data_start(d: bytes) -> int:
    """Offset of the compressed data block in a UnityFS bundle."""
    p = d.index(b"\x00") + 1            # signature
    p += 4                               # format version
    p = d.index(b"\x00", p) + 1          # unity version
    p = d.index(b"\x00", p) + 1          # unity revision
    _size, cbis, _ubis, flags = struct.unpack(">qIII", d[p:p + 20])
    p += 20
    if flags & 0x200:                    # BlockInfoNeedPaddingAtStart
        p = (p + 15) // 16 * 16
    if flags & 0x80:                     # blocks info stored at the end
        return p
    start = p + cbis
    if flags & 0x200:
        start = (start + 15) // 16 * 16
    return start


def decode(d: bytes) -> bytes:
    """Obfuscated bundle -> plain UnityFS."""
    ds = data_start(d)
    return d[:ds + HEAD_CLEAR] + _xf(d[ds + HEAD_CLEAR:])


encode = decode  # the transform is an involution


if __name__ == "__main__":
    import sys, zipfile
    apk = sys.argv[1]
    z = zipfile.ZipFile(apk)
    names = [n for n in z.namelist() if n.endswith(".ab")]
    bad = 0
    for n in names:
        d = z.read(n)
        if encode(decode(d)) != d:
            print("roundtrip mismatch:", n)
            bad += 1
    print(f"{len(names) - bad}/{len(names)} bundles roundtrip byte-exact")
