# Swordash offline mod: status

The APK runs with no network. The game's Lua net layer (`net_agent`) is
replaced with plain Lua source that answers every request locally and keeps the
player profile in the app's files directory. There is no Frida, no local server
process and no live request. Package `com.fattoy.swordash.android`, versionCode
163 (2.3.1), minSdk 25, targetSdk 35 and `lib/arm64-v8a` are unchanged; only
`assets/scp.ab` differs from the input APK.

## Build

    tools/build_offline_apk.sh work/base.apk offline work/FINAL.apk

Every `offline/*.lua` file replaces the TextAsset of the same name in
`assets/scp.ab` (`net_agent`, `compressor`). The APK is signed with a local key
(`CN=swordash-mod`, SHA-256 `ce5cb4cc...91325`), so a store install must be
uninstalled first.

## Verified on the emulator, networking off

Environment: x86_64 API 31 Google APIs image with ARM translation (the game is
arm64-only), Wi-Fi, mobile data and airplane mode off, no default network.

Release APK: `aapt` reports package `com.fattoy.swordash.android`, versionCode
163, versionName 2.3.1, sdkVersion 25, targetSdkVersion 35, native-code
`arm64-v8a` only; `apksigner` verifies v2 and v3 signatures, signer
`CN=swordash-mod`. Its entry list equals the input APK's apart from the
signature files.

Clean install of that APK (uninstall, install, first launch):

1. Boot, login screen, Guest login accepted locally; server config completes.
2. Stage 1-1 tutorial played to VICTORY (`OVER stage=sm_1 result=1 won=true
   coin=1017`); the main menu then shows stage 1-2 and coin 1017.
3. The tutorial gear is granted on that first clear: `Equipment_Weapon_Frontline_Tachi`
   and `Equipment_Disc_SpaceJudgement_A` both show in GEAR (2/35).
4. Equip guide: the weapon (Red Shadow) is equipped from the guide, ATK 200 to
   290, and the guide moves on to stage 1-2.
5. Force-stop and relaunch: `profile restored modules=36`; main menu at stage
   1-2 with coin 1017, gem 13, energy 20/20; the tutorial does not replay and
   the guide resumes after the equip step. Saved state before the restart:
   `ADV.stage=2`, `ECO.d={coin=1017,gem=13}`, two `EQUIP.el` entries,
   `GUIDE={gf=5,st="guide_equip_4"}`.
6. Stage 1-2 starts and plays (combat, room changes, death, revive prompt,
   Give Up, `OVER stage=sm_2 result=2`).

The same source on an earlier profile (upgrade install, data kept) also
covered: the milepost "Complete Mission 1-1" claim giving Rookie Box #1
(`AIM.CLAIM_REWARD`); using the box giving coin 500, stone 5 and Rookie Box #2
with coin going 1019 to 1519 live and no second copy of the tutorial gear; the
ULT disc equipped (HP 400 to 580); and all of it surviving a force-stop.

No Lua error (`attempt to`, `bad argument`, `LuaException`) appears in any of
these logs. The remaining Unity warnings are emulator GLSL limits, AppLovin and
Firebase failing to reach the network, which is expected offline.

## How it works

- Requests are answered by explicit handlers in `offline/net_agent.lua` and
  delivered on a tick (`World:RegistUpdate`), because the client publishes
  `SERVER_RESPONSE` and only then waits for it.
- The profile starts from each module's defaults in `ModuleDef.SYNC`, is
  updated by the handlers and saved atomically to
  `/data/data/com.fattoy.swordash.android/files/offline_profile.lua` after each
  sync.
- Stage rooms come from `ConfigMgr:GetRoomId`; `BATTLE.DEAD`/`OVER` update the
  battle state, coins and `ADV.stage`; `GUIDE.STEP_FINISH` sets the step's
  `finishFlag` bit.
- Rewards are parsed from the client's own config strings. `realitem`
  `UseReward` is taken from the CSV table in `assets/config.ab`: the zlib copy
  in `assets/scg.ab` that `ConfigMgr` loads leaves the ULT disc out of
  `box1_1`, while the tutorial dialogue ("A Weapon and a ULT Disk") and
  `guide_equip_6/7` need it. `WaitTime:N` on boxes is enforced.
- A request with no handler is answered `ret_code=OFFLINE` and logged as
  `UNRESOLVED`, rather than with invented data.

## Known gaps

- Stage 1-2 was never won in testing. The runs used a scripted input driver
  with a level-1 hero; it reached room 8 of 10 at best. Victory uses the same
  `BATTLE.OVER` path as stage 1-1, but a 1-2 clear and what it unlocks are
  untested.
- Energy is not deducted on stage start.
- `HERO.LEVELUP` is implemented from `cost_hero_level` but untested: level 2
  needs one level-up material the profile does not own yet.
- Shops, gacha, mail, pets, PvP, events and other online features have no
  handler and return `OFFLINE`.
- The guest "Link with Google/Facebook" prompt still appears (linking needs the
  network). Once, after a defeat, it opened over a guide highlight and blocked
  input until the app was restarted; ticking "Don't show it again" avoids it.
- Only tested on the emulator above, not on a real arm64 phone.

## Why not the Frida gadget

With the gadget injected the process dies at startup (`SIGSEGV`, `pc 0`).
Controls: re-signed without gadget runs; gadget present but not loaded runs;
gadget loaded crashes. This isolates the crash to loading the gadget in this
translated environment. It does not prove translation is the only cause, and
real arm64 hardware was not tested.

## AssetBundle encoding

Each `.ab` has a plain UnityFS header and an obfuscated compressed block:
`AssetUtility.decodeByte8` swaps each byte's nibbles and XORs with `0x33`,
leaving the first 9 bytes (`5d0000080000006c01`) clear. `tools/ab_codec.py`
roundtrips all 408 bundles byte-exactly and `tools/ab_pack.py` rebuilds a
bundle with the packer's LZMA settings (lc=3 lp=0 pb=2, 512K dict). Replacing a
compiled Lua TextAsset with plain source works because the game's VM compiles
it, so the permuted SLua opcode table never has to be emitted.
