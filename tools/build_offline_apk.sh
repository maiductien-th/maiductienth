#!/usr/bin/env bash
# Build the offline APK: swap the Lua net layer in assets/scp.ab, re-sign.
#   KS_PASS=... tools/build_offline_apk.sh work/base.apk offline work/FINAL.apk
# MENU=1 builds the offline-menu variant (MENU_BUILD = true in net_agent.lua).
set -euo pipefail
APK=${1:-work/base.apk}
LUA_DIR=${2:-offline}
OUT=${3:-work/FINAL.apk}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KS=${KEYSTORE:-$ROOT/keys/my.jks}
ZIPALIGN=${ZIPALIGN:-$(command -v zipalign || true)}
APKSIGNER=${APKSIGNER:-$(command -v apksigner || true)}
if [ -n "${BUILD_TOOLS:-}" ]; then ZIPALIGN="$BUILD_TOOLS/zipalign"; APKSIGNER="$BUILD_TOOLS/apksigner"; fi
[ -x "$ZIPALIGN" ] || { echo "zipalign not found; set BUILD_TOOLS or ZIPALIGN" >&2; exit 1; }
[ -x "$APKSIGNER" ] || { echo "apksigner not found; set BUILD_TOOLS or APKSIGNER" >&2; exit 1; }
[ -n "${KS_PASS:-}" ] || { echo "set KS_PASS to the password of $KS" >&2; exit 1; }
python3 -c "import UnityPy" 2>/dev/null || { echo "UnityPy missing; run tools/setup.sh" >&2; exit 1; }
TMP=$(mktemp -d)
if [ "${MENU:-0}" = 1 ]; then
  mkdir "$TMP/lua"
  cp "$LUA_DIR"/*.lua "$TMP/lua/"
  grep -q '^local MENU_BUILD = false$' "$TMP/lua/net_agent.lua" || { echo "MENU_BUILD flag not found" >&2; exit 1; }
  sed -i 's/^local MENU_BUILD = false$/local MENU_BUILD = true/' "$TMP/lua/net_agent.lua"
  LUA_DIR="$TMP/lua"
fi

unzip -o -q "$APK" assets/scp.ab -d "$TMP"
PYTHONPATH="$(dirname "$0")" python3 - "$TMP/assets/scp.ab" "$LUA_DIR" <<'PY'
import sys, warnings
import UnityPy
import ab_pack
warnings.filterwarnings("ignore")
import os
bundle_path, lua_dir = sys.argv[1], sys.argv[2]
orig = open(bundle_path, "rb").read()
env = UnityPy.load(ab_pack.decode(orig))
replacements = {
    os.path.splitext(f)[0]: open(os.path.join(lua_dir, f)).read()
    for f in os.listdir(lua_dir) if f.endswith(".lua")
}
done = []
for obj in env.objects:
    if obj.type.name != "TextAsset":
        continue
    ta = obj.read()
    if ta.m_Name in replacements:
        ta.m_Script = replacements[ta.m_Name]
        ta.save()
        done.append(ta.m_Name)
missing = set(replacements) - set(done)
if missing:
    raise SystemExit("TextAssets not found: " + ", ".join(sorted(missing)))
print("replaced:", ", ".join(sorted(done)))
serialized = list(env.file.files.values())[0].save()
open(bundle_path, "wb").write(ab_pack.build(serialized, orig))
print("rebuilt", bundle_path)
PY

cp -f "$APK" "$OUT.tmp"
(cd "$TMP" && zip -q -0 "$OLDPWD/$OUT.tmp" assets/scp.ab)
"$ZIPALIGN" -f -p 4 "$OUT.tmp" "$OUT.aligned"
"$APKSIGNER" sign --ks "$KS" --ks-pass env:KS_PASS --out "$OUT" "$OUT.aligned"
rm -f "$OUT.tmp" "$OUT.aligned" "$OUT.aligned.idsig"
"$APKSIGNER" verify --print-certs "$OUT" | head -3
rm -rf "$TMP"
