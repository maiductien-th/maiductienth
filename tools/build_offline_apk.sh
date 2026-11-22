#!/usr/bin/env bash
# Build the offline APK: swap the Lua net layer in assets/scp.ab, re-sign.
#   tools/build_offline_apk.sh work/base.apk offline/net_agent.lua work/FINAL.apk
set -euo pipefail
APK=${1:-work/base.apk}
LUA=${2:-offline/net_agent.lua}
OUT=${3:-work/FINAL.apk}
KS=${KEYSTORE:-keys/my.jks}
BT=${BUILD_TOOLS:-$HOME/android-sdk/build-tools/34.0.0}
TMP=$(mktemp -d)

unzip -o -q "$APK" assets/scp.ab -d "$TMP"
PYTHONPATH="$(dirname "$0")" python3 - "$TMP/assets/scp.ab" "$LUA" <<'PY'
import sys, warnings
import UnityPy
import ab_pack
warnings.filterwarnings("ignore")
bundle_path, lua_path = sys.argv[1], sys.argv[2]
orig = open(bundle_path, "rb").read()
env = UnityPy.load(ab_pack.decode(orig))
src = open(lua_path).read()
for obj in env.objects:
    if obj.type.name != "TextAsset":
        continue
    ta = obj.read()
    if ta.m_Name == "net_agent":
        ta.m_Script = src
        ta.save()
        break
else:
    raise SystemExit("net_agent TextAsset not found")
serialized = list(env.file.files.values())[0].save()
open(bundle_path, "wb").write(ab_pack.build(serialized, orig))
print("rebuilt", bundle_path)
PY

cp -f "$APK" "$OUT.tmp"
(cd "$TMP" && zip -q -0 "$OLDPWD/$OUT.tmp" assets/scp.ab)
"$BT/zipalign" -f -p 4 "$OUT.tmp" "$OUT.aligned"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:${KS_PASS:-123456}" --out "$OUT" "$OUT.aligned"
rm -f "$OUT.tmp" "$OUT.aligned" "$OUT.aligned.idsig"
"$BT/apksigner" verify --print-certs "$OUT" | head -3
rm -rf "$TMP"
