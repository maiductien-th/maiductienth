AGENTS.md — Swordash offline mod
Context
This repo mods the game Swordash (com.fattoy.swordash.android), Unity + IL2CPP, ABIs arm64-v8a and armeabi-v7a. The original APK and the IL2CPP dump live in GitHub Release v0.1. The game is server-authoritative.

Three goals, in priority order:

Remove the login step — launch straight into the game.
Full resources (gems, coins, Zeno) — hook the getters, not the setters.
Render the game playable with no network (mock the network layer).
Hard rules
dump.cs is pseudocode and cannot be recompiled. Never try to rebuild from it.
Patching path = inject a frida-gadget into libunity.so and hook at runtime. Do not byte-patch libil2cpp.so unless forced.
The existing dump is incomplete. Phase 0 must re-dump from the APK and diff before anything else.
Never answer with prose. Every reply must contain a file path or raw pasted command output.
Every claim about an offset, class, or method needs evidence: grep output from the dump, or a screenshot.
Work in phases and stop at every GATE with a short report. Never merge phases.
Do not touch resources (use --skip-resources) — only lib/ and the manifest.
Keep package, versionCode, minSdk, targetSdk unchanged in the manifest.
Standard commands (installed by tools/setup.sh)
bash
Copy
gh release download v0.1 -R <owner>/<repo> -D in/     # fetch artifacts
java -jar $APKEDITOR m -i in/*.xapk -o work/base.apk  # merge splits if xapk
objection patchapk -s work/base.apk --skip-resources  # inject gadget, auto zipalign + sign
apksigner verify --print-certs work/base.objection.apk
aapt dump badging work/base.objection.apk | head -5
unzip -l work/base.objection.apk | grep -i gadget
Invariants
libgadget.so, libgadget.config.json and libgadget.js must live in the same lib/<abi>/ directory.
Keep the original libunity.so intact; add the patched copy under a different name.
hooks.js must pass a syntax check before packaging.
Reuse one keystore at keys/my.jks; never commit the plaintext password.
Required output
REPORT.md (class/method/RVA table with evidence), hooks.ts compiled to hooks.js, tools/setup.sh, INSTALL.md, FINAL.apk.

Done
apksigner verify passes, aapt dump badging shows the correct package, unzip -l shows the gadget in every ABI dir, hooks.js contains all three hooks and passes node --check, and INSTALL.md states that the original app must be uninstalled first.
