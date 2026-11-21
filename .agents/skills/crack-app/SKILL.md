---
name: crack-app
description: Workflow for modding a Unity IL2CPP APK (Swordash) — merge splits, recover the dump, inject a frida-gadget, hook auth/currency/network, re-sign, verify. Use when the task involves APK, il2cpp, frida, or game modding.
---

# Unity IL2CPP APK modding workflow

Run in order. Stop at every GATE, report briefly, wait for approval.

## Phase 0 — Recover the full dump (mandatory, never skip)
The current `dump.cs` is **missing classes**. Rebuild a complete dump first, then diff.

```bash
bash tools/setup.sh
gh release download v0.1 -R maiductien-th/maiductienth -D in/
mkdir -p in/extract && unzip -qo in/*.apks -d in/extract   # .apks = bundle of split APKs
java -jar $APKEDITOR m -i in/extract -o work/base.apk      # merge splits into one installable APK
unzip -o work/base.apk "lib/*/libil2cpp.so" "assets/bin/Data/Managed/Metadata/global-metadata.dat" -d in/apk/
tools/bin/il2cppdumper/Il2CppDumper in/apk/lib/arm64-v8a/libil2cpp.so in/apk/assets/bin/Data/Managed/Metadata/global-metadata.dat out/recovered/
grep -c 'class ' dump.cs; grep -c 'class ' out/recovered/dump.cs
```
GATE: report the class count on both sides plus the list of missing classes. **Do not change anything before reporting.**

## Phase 1 — Build the shell, no hooks yet
```bash
objection patchapk -s work/base.apk --skip-resources
apksigner verify --print-certs work/base.objection.apk
unzip -l work/base.objection.apk | grep -i gadget
```
GATE: paste the output of both verification commands.

## Phase 2 — Choose hook targets
From the complete dump, build a table: class, method, RVA, why it was chosen. Minimum coverage:
- auth/session: `IsLoggedIn`, `HasSession`, `LoginManager`, `AuthService`, `SessionManager`
- currency: `get_Gems`, `get_Coins`, `get_Zeno` (getters!)
- network: the request send function (`UnityWebRequest`, `HttpClient`, `ApiClient.Send`)

GATE: paste the table. No hook code yet.

## Phase 3 — Auth hook
Write `hooks.ts`, build with `npx frida-compile hooks.ts -o libgadget.js`.
Hook must return `true` / an already-logged-in state plus a fake uid. GATE: paste `node --check` result and the hook log line.

## Phase 4 — Currency hook
Hook the getters to return `999999999`. Do not hook setters (the server overwrites them). GATE.

## Phase 5 — Network mock
Capture one real response per endpoint from the DTO types in the dump, then return canned JSON so the game runs in airplane mode. GATE.

## Phase 6 — Final packaging
```bash
# place libgadget.so + libgadget.config.json + libgadget.js in the SAME lib/<abi>/ dir
zipalign -f 4 unsigned.apk FINAL-aligned.apk
apksigner sign --ks keys/my.jks --ks-pass pass:123456 --out FINAL-signed.apk FINAL-aligned.apk
apksigner verify FINAL-signed.apk
```
Write `INSTALL.md` (must state: uninstall the original first — a different signature yields `INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
Open a PR on branch `offline-mod`, attach `FINAL-signed.apk` and `REPORT.md`.

## Never
- Rebuild from `dump.cs`.
- Touch resources or `res/`.
- Change the package name or versionCode.
- Hook setters instead of getters.
- Skip Phase 0.
