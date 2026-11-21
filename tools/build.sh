#!/usr/bin/env bash
# tools/build.sh — Phase 0 pipeline: fetch artifacts, merge splits, re-dump IL2CPP,
# compare the class count of the old dump against the recovered one.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/8] git fetch origin && git checkout offline-mod"
git fetch origin && git checkout offline-mod

echo "[2/8] bash tools/setup.sh"
bash tools/setup.sh
export APKEDITOR="${APKEDITOR:-$PWD/tools/bin/APKEditor.jar}"

echo "[3/8] gh release download v0.1 -R maiductien-th/maiductienth -D in/"
mkdir -p in
gh release download v0.1 -R maiductien-th/maiductienth -D in/ --clobber

echo "[4/8] unzip Swordash_2.3.1.apks -> in/extract"
mkdir -p in/extract && unzip -qo in/Swordash_2.3.1.apks -d in/extract

echo "[5/8] java -jar \$APKEDITOR m -i in/extract -o work/base.apk"
mkdir -p work
java -jar "$APKEDITOR" m -i in/extract -o work/base.apk

echo "[6/8] unzip libil2cpp.so + global-metadata.dat -> in/apk/"
unzip -o work/base.apk "lib/*/libil2cpp.so" "assets/bin/Data/Managed/Metadata/global-metadata.dat" -d in/apk/

echo "[7/8] Il2CppDumper -> out/recovered/"
mkdir -p out/recovered
tools/bin/il2cppdumper/Il2CppDumper \
  in/apk/lib/arm64-v8a/libil2cpp.so \
  in/apk/assets/bin/Data/Managed/Metadata/global-metadata.dat \
  out/recovered/

echo "[8/8] class counts: old dump.cs vs out/recovered/dump.cs"
# The old dump.cs is not in the repo or in release v0.1; count 0 when it is absent.
OLD_DUMP="${OLD_DUMP:-dump.cs}"
if [ -f "$OLD_DUMP" ]; then grep -c 'class ' "$OLD_DUMP" > /tmp/a; else echo 0 > /tmp/a; fi
grep -c 'class ' out/recovered/dump.cs > /tmp/b
cat /tmp/a /tmp/b
