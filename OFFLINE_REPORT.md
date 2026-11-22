# Swordash offline mod — status

The goal is an APK that runs with no network. The Frida-gadget path in
`AGENTS.md` could not be validated here, so the mod is implemented in the
game's own Lua instead, which keeps it self-contained on the phone.

## Why not the Frida gadget

The APK ships `lib/arm64-v8a` only. This machine is x86_64, so the game runs
through `ndk_translation` on an x86_64 emulator image. With the gadget injected
the process dies at startup:

    signal 11 (SIGSEGV), code 2 (SEGV_ACCERR), fault addr 0x0
    backtrace: #00 pc 0000000000000000  <unknown>

Three controls isolate it to loading the gadget in this environment:

| APK | result |
|---|---|
| merged base, re-signed, no gadget | runs |
| gadget `.so` present, never loaded | runs |
| gadget loaded via injected `loadLibrary` | SIGSEGV at startup |

So it is not the re-signing and not the extra file. This does not prove binary
translation is the only possible cause, and it says nothing about whether the
gadget would work on real arm64 hardware, which was not tested.

## AssetBundle obfuscation

Every `.ab` has a plain UnityFS header and an obfuscated compressed block.
`AssetUtility.decodeByte8` (RVA `0x1938744`) swaps each byte's nibbles and XORs
with `0x33`; it is an involution, so `encodeByte8` is the same transform. The
first 9 bytes of the block stay clear — the `ab_head_end_flag` that
`FindAssetBundleContentStart` (RVA `0x19385A0`) scans for, allocated as a
9-element array in `.cctor`. It is `5d0000080000006c01` in all 408 bundles,
which is the LZMA props plus the first four stream bytes.

`tools/ab_codec.py` decodes and encodes, computing the block offset from the
header; it roundtrips all 408 bundles byte-exactly. `tools/ab_pack.py` rebuilds
the container around new SerializedFile bytes, recompressing with the packer's
LZMA settings (lc=3 lp=0 pb=2, 512K dict) so the flag prefix is reproduced. A
repack that drops the flag loads as a bundle but the game cannot find the
content, and Lua silently fails with `GetFunction: IsServerList No Table`.

## Lua source instead of bytecode

The Lua lives in `assets/scp.ab` as 174 TextAssets of SLua bytecode
(`\x1bLuaS`, Lua 5.3) with a permuted opcode table. Emitting that bytecode is
unnecessary: replacing a chunk with **plain Lua source** works, because the
game's own VM compiles it. Verified on device.

## What works now, with networking off

Verified on a clean install with the network disabled:

1. The game boots, Unity and Lua start.
2. It reaches its own login screen (Guest / Facebook / Google).
3. Tapping Guest runs the offline `net_agent`, which returns a synthesized
   LOGIN response instead of opening a socket.
4. `login_mgr.onLoginSuccess` accepts it and calls
   `bootstrap.InitClientModule`; the UI moves to "Connecting..".

Stock behaviour for comparison: the unmodified game boots offline but dies in
`net_agent._RequestServerRoute` -> `sproto_helper._socketConnect`.

## What does not work yet

The client stops at `server_config_mgr.LoadServerConfig`. `StartRequest` waits
on a `SERVER_RESPONSE` message, and the stub returns a value instead of
publishing that message, so the wait never completes.

Reaching gameplay also needs `role_data`: the LOGIN response carries the whole
player profile as a deflate-compressed string (`GameDef.IS_COMPRESS = 1`,
`Compressor` over `LibDeflate`), which every client module reads. Synthesizing
a valid profile is the remaining work. Entering a stage, saving and reopening
are therefore untested.

## Protocol facts recovered

`proto_def` LOGIN (3) response:

    login_result 0 : integer      role_data 1 : string
    server_timezone 2 : integer   server_time 3 : integer
    uid 4 : integer               new_day 5 : boolean
    param 6 : integer             oid 7 : string
    session 8 : string            gid 9 : string
    reg 10 : boolean

`GameDef.LOGIN_RESULT.SUCCESS = 1000` (read from the running game, not guessed).

## Build

    tools/build_offline_apk.sh work/base.apk offline/net_agent.lua work/FINAL.apk

The APK is signed with a local key, so the original app must be uninstalled
first; the package, versionCode, minSdk and targetSdk are unchanged and only
`assets/scp.ab` differs from the input.
