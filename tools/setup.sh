#!/usr/bin/env bash
# tools/setup.sh — cài đủ tool cho pipeline. Chạy 1 lần mỗi session mới.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq openjdk-17-jdk-headless unzip zip file python3-pip nodejs npm \
  lib32stdc++6 android-sdk-build-tools 2>/dev/null || \
sudo apt-get install -y -qq openjdk-17-jdk-headless unzip zip file python3-pip nodejs npm lib32stdc++6

# build-tools (apksigner / zipalign / aapt) — lấy trực tiếp nếu apt không có
if ! command -v apksigner >/dev/null; then
  BT=$(ls -d /opt/android*/build-tools/* /usr/lib/android-sdk/build-tools/* 2>/dev/null | sort -V | tail -1)
  if [ -n "${BT:-}" ]; then export PATH="$BT:$PATH"; fi
fi
if ! command -v apksigner >/dev/null; then
  mkdir -p /opt/bt && cd /opt/bt
  curl -sLo bt.zip https://dl.google.com/android/repository/build-tools_r34-linux.zip
  unzip -qo bt.zip && BT=$(find /opt/bt -name apksigner -printf '%h\n' | head -1)
  export PATH="$BT:$PATH"
  cd - >/dev/null
fi

pip install -q --break-system-packages objection frida-tools 2>/dev/null || pip install -q objection frida-tools
# offline APK builder (tools/build_offline_apk.sh)
pip install -q --break-system-packages UnityPy==1.25.2 2>/dev/null || pip install -q UnityPy==1.25.2

# APKEditor (merge split APK)
mkdir -p tools/bin
[ -f tools/bin/APKEditor.jar ] || \
  curl -sLo tools/bin/APKEditor.jar https://github.com/REAndroid/APKEditor/releases/download/V1.4.1/APKEditor-1.4.1.jar
export APKEDITOR="$PWD/tools/bin/APKEditor.jar"

# Il2CppDumper — net6 build (v6.7.40 does not know metadata v31, and the plain
# zip asset does not exist; the net6 asset runs under the dotnet runtime).
command -v dotnet >/dev/null || sudo apt-get install -y -qq dotnet-runtime-6.0
[ -f tools/bin/Il2CppDumper.zip ] || \
  curl -sLo tools/bin/Il2CppDumper.zip https://github.com/Perfare/Il2CppDumper/releases/download/v6.7.46/Il2CppDumper-net6-v6.7.46.zip
mkdir -p tools/bin/il2cppdumper && unzip -qo tools/bin/Il2CppDumper.zip -d tools/bin/il2cppdumper

# The dumper ends with Console.ReadKey when RequireAnyKey is true, which aborts
# (exit 134) without an interactive console. Turn it off so it exits cleanly.
python3 - <<'PY'
import json
p = "tools/bin/il2cppdumper/config.json"
c = json.load(open(p, encoding="utf-8-sig"))
c["RequireAnyKey"] = False
json.dump(c, open(p, "w"), indent=2)
PY
cat > tools/bin/il2cppdumper/Il2CppDumper <<'LAUNCH'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Il2CppDumper catches its own init/dump errors and still exits 0, so also
# require dump.cs in the output dir.
dotnet "$DIR/Il2CppDumper.dll" "$@" || exit
[ -f "${3:-.}/dump.cs" ] || { echo "Il2CppDumper: no dump.cs in ${3:-.}" >&2; exit 1; }
LAUNCH
chmod +x tools/bin/il2cppdumper/Il2CppDumper

# deps cho hooks
[ -d node_modules ] || npm install --silent frida-il2cpp-bridge frida-compile typescript
npx tsc --init --target es2020 --module commonjs >/dev/null 2>&1 || true

# keystore dùng chung — KHÔNG commit file .jks
mkdir -p keys
[ -f keys/my.jks ] || keytool -genkey -v -keystore keys/my.jks -alias k -keyalg RSA \
  -keysize 2048 -validity 10000 -storepass 123456 -keypass 123456 -dname "CN=swordash-mod" >/dev/null 2>&1

echo "OK. PATH đã set trong shell này. Biến: APKEDITOR=$APKEDITOR"
