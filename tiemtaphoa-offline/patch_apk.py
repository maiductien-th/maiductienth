#!/usr/bin/env python3
"""
Builds standalone offline APK for Góc Chợ Xưa (com.gcxua.vn 3.7.1) from GocChoXua_3.7.1.xapk:
  1. Merges all split APKs inside the XAPK into a single APK using APKEditor
  2. Rebuilds classes.dex cleanly via baksmali/smali (fixes corrupted Adler32 checksum,
     stale SHA-1, and out-of-order string_ids in the original XAPK that caused Android ART
     ClassNotFoundException: BBTApplication on startup)
  3. Decompiles classes3.dex via baksmali, patches 49 methods in YqSdkMgr.smali (disables
     BBT/YqPlatform third-party SDK & ads, immediate init), and reassembles via smali
  4. Validates both rebuilt DEX files with dexdump -c
  5. Patches assets/yq_plugin_config.xml (keeps only GameIApplication) and assets/main.js
     (injects require('offline-server.js') before window.boot())
  6. Updates APK, runs zipalign -f -p 4, signs v1+v2+v3 with apksigner, and verifies
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

APKEDITOR_URL = "https://github.com/REAndroid/APKEditor/releases/download/V1.4.9/APKEditor-1.4.9.jar"


def find_tool(name, extra_dirs=()):
    p = shutil.which(name)
    if p:
        return p
    search_dirs = list(extra_dirs) + [
        "/opt/android-sdk/build-tools/34.0.0",
        "/usr/bin",
    ]
    android_home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if android_home:
        search_dirs.extend(sorted(glob.glob(os.path.join(android_home, "build-tools", "*")), reverse=True))
    for d in search_dirs:
        cand = os.path.join(d, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    raise FileNotFoundError(f"Required tool not found on PATH or Android SDK: {name}")


def run(cmd, cwd=None):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_apkeditor(work_dir):
    for cand in (
        os.path.join(work_dir, "APKEditor-1.4.9.jar"),
        "/home/antigravity/work/tiemtaphoa/tools/APKEditor-1.4.9.jar",
    ):
        if os.path.isfile(cand) and os.path.getsize(cand) > 100000:
            return cand
    dest = os.path.join(work_dir, "APKEditor-1.4.9.jar")
    print(f"Downloading APKEditor -> {dest}", flush=True)
    urllib.request.urlretrieve(APKEDITOR_URL, dest)
    return dest


def patch_yq_sdk_mgr(smali_path):
    src = open(smali_path, "r", encoding="utf-8").read()

    keep_methods = {
        "<clinit>", "<init>", "access$002", "startGame", "setInitFinished",
        "initData", "getAdChannelData", "metaData"
    }

    method_pat = re.compile(r"(\.method\s+[^\n]+\n)(.*?)(\n\.end method)", re.S)
    patched_count = 0

    def replacer(m):
        nonlocal patched_count
        header, body, footer = m.group(1), m.group(2), m.group(3)
        sig_m = re.search(r"\s([^\s(]+)(\([^)]*\))(\S+)", header)
        if not sig_m:
            return m.group(0)
        name, params, ret_type = sig_m.group(1), sig_m.group(2), sig_m.group(3)

        if name in keep_methods or name.startswith("lambda$"):
            return m.group(0)

        if name == "checkIsSupportSDK":
            patched_count += 1
            return header + "    .locals 1\n    const/4 v0, 0x0\n    return v0" + footer

        if name == "sdkInitFinished":
            patched_count += 1
            return (
                header
                + "    .locals 1\n"
                + "    const/4 v0, 0x1\n"
                + "    sput-boolean v0, Lorg/cocos2dx/javascript/plugin/YqSdkMgr;->isRunCocosMainJsFile:Z\n"
                + "    sput-boolean v0, Lorg/cocos2dx/javascript/plugin/YqSdkMgr;->isInitFinished:Z\n"
                + '    const-string v0, "true"\n'
                + "    return-object v0"
                + footer
            )

        if name == "doInit":
            patched_count += 1
            return (
                header
                + "    .locals 2\n"
                + "    invoke-static {}, Lcom/xmyanqu/sdk/YqSDK;->getInstance()Lcom/xmyanqu/sdk/YqSDK;\n"
                + "    move-result-object v0\n"
                + "    invoke-virtual {v0, p0}, Lcom/xmyanqu/sdk/YqSDK;->setContext(Landroid/app/Activity;)V\n"
                + "    const/4 v0, 0x1\n"
                + "    sput-boolean v0, Lorg/cocos2dx/javascript/plugin/YqSdkMgr;->isInitFinished:Z\n"
                + '    const-string v1, ""\n'
                + "    if-eqz p1, :cond_done\n"
                + "    invoke-interface {p1, v0, v1}, Lcom/xmyanqu/sdk/base/ISDKCallback;->onResult(ILjava/lang/String;)V\n"
                + "    :cond_done\n"
                + "    return-void"
                + footer
            )

        if name == "supportMethod":
            patched_count += 1
            return header + '    .locals 1\n    const-string v0, ""\n    return-object v0' + footer

        patched_count += 1
        if ret_type == "V":
            return header + "    .locals 0\n    return-void" + footer
        elif ret_type in ("Z", "I", "S", "B", "C"):
            return header + "    .locals 1\n    const/4 v0, 0x0\n    return v0" + footer
        elif ret_type == "Ljava/lang/String;":
            return header + '    .locals 1\n    const-string v0, ""\n    return-object v0' + footer
        else:
            return header + "    .locals 1\n    const/4 v0, 0x0\n    return-object v0" + footer

    new_src = method_pat.sub(replacer, src)
    open(smali_path, "w", encoding="utf-8").write(new_src)
    print(f"Patched {patched_count} methods in {smali_path}", flush=True)


def patch_main_js_content(src):
    needle = "require('jsb-adapter/jsb-engine.js');"
    assert needle in src, "Expected needle not found in assets/main.js"
    inject = needle + "\n        require('offline-server.js');"
    src = src.replace(needle, inject, 1)
    old_boot = "if (cc.sys.OS_ANDROID !== cc.sys.os || GetSdkInitFinished()) {"
    if old_boot in src:
        src = src.replace(old_boot, "if (true) {", 1)
    return src


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Build standalone offline APK for GocChoXua 3.7.1")
    parser.add_argument("input_path", nargs="?", default="/home/antigravity/work/tiemtaphoa/GocChoXua_3.7.1.xapk",
                        help="Path to input .xapk or pre-merged .apk")
    parser.add_argument("output_apk", nargs="?", default="/home/antigravity/work/tiemtaphoa/GocChoXua-3.7.1-offline.apk",
                        help="Path to output signed offline .apk")
    parser.add_argument("--work-dir", default="", help="Optional persistent work directory")
    args = parser.parse_args()

    input_path = os.path.abspath(args.input_path)
    output_apk = os.path.abspath(args.output_apk)
    offline_js = os.path.join(script_dir, "offline-server.js")
    assert os.path.isfile(input_path), f"Missing input file: {input_path}"
    assert os.path.isfile(offline_js), f"Missing offline-server.js: {offline_js}"

    zipalign = find_tool("zipalign")
    apksigner = find_tool("apksigner")
    dexdump = find_tool("dexdump")

    cleanup_work = False
    if args.work_dir:
        work_dir = os.path.abspath(args.work_dir)
        os.makedirs(work_dir, exist_ok=True)
    else:
        work_dir = tempfile.mkdtemp(prefix="gcxua_offline_")
        cleanup_work = True

    try:
        # 1. Merge XAPK splits (or use pre-merged APK directly)
        merged_apk = os.path.join(work_dir, "merged_base.apk")
        if input_path.lower().endswith(".xapk"):
            apkeditor = ensure_apkeditor(work_dir)
            run(["java", "-Xmx3g", "-jar", apkeditor, "m", "-i", input_path, "-o", merged_apk])
        else:
            shutil.copy2(input_path, merged_apk)

        # 2. Extract classes.dex, classes3.dex, and assets/main.js from merged APK
        orig_c1 = os.path.join(work_dir, "orig_classes.dex")
        orig_c3 = os.path.join(work_dir, "orig_classes3.dex")
        with zipfile.ZipFile(merged_apk, "r") as z:
            open(orig_c1, "wb").write(z.read("classes.dex"))
            open(orig_c3, "wb").write(z.read("classes3.dex"))
            orig_main_js = z.read("assets/main.js").decode("utf-8")

        # 3. Rebuild classes.dex cleanly via baksmali/smali (fixes checksum & string_ids order)
        stage_dir = os.path.join(work_dir, "apk_stage")
        os.makedirs(os.path.join(stage_dir, "assets"), exist_ok=True)

        smali1_dir = os.path.join(work_dir, "smali_classes1")
        run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.baksmali.Main", "d", orig_c1, "-o", smali1_dir])
        dex1_out = os.path.join(stage_dir, "classes.dex")
        run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.smali.Main", "a", smali1_dir, "-o", dex1_out])
        run([dexdump, "-c", dex1_out])

        # 4. Decompile classes3.dex, patch YqSdkMgr.smali, and reassemble
        smali3_dir = os.path.join(work_dir, "smali_classes3")
        run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.baksmali.Main", "d", orig_c3, "-o", smali3_dir])
        yq_smali = os.path.join(smali3_dir, "org/cocos2dx/javascript/plugin/YqSdkMgr.smali")
        assert os.path.isfile(yq_smali), f"Missing {yq_smali}"
        patch_yq_sdk_mgr(yq_smali)
        dex3_out = os.path.join(stage_dir, "classes3.dex")
        run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.smali.Main", "a", smali3_dir, "-o", dex3_out])
        run([dexdump, "-c", dex3_out])

        # 5. Prepare patched assets
        with open(os.path.join(stage_dir, "assets", "yq_plugin_config.xml"), "w", encoding="utf-8") as f:
            f.write(
                "<?xml version='1.0' encoding='UTF-8'?>\n"
                "<plugins>\n"
                '    <plugin name="org.cocos2dx.javascript.GameIApplication" type="8" />\n'
                "</plugins>\n"
            )
        with open(os.path.join(stage_dir, "assets", "main.js"), "w", encoding="utf-8") as f:
            f.write(patch_main_js_content(orig_main_js))
        shutil.copy2(offline_js, os.path.join(stage_dir, "assets", "offline-server.js"))

        # 6. Update merged APK (strip old META-INF sigs, replace 5 files)
        unsigned_apk = os.path.join(work_dir, "unsigned.apk")
        shutil.move(merged_apk, unsigned_apk)
        subprocess.run(
            ["zip", "-d", unsigned_apk, "META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "META-INF/MANIFEST.MF"],
            check=False,
        )
        run(
            [
                "zip", "-r", "-u", unsigned_apk,
                "classes.dex",
                "classes3.dex",
                "assets/yq_plugin_config.xml",
                "assets/main.js",
                "assets/offline-server.js",
            ],
            cwd=stage_dir,
        )

        # 7. Zipalign
        aligned_apk = os.path.join(work_dir, "aligned.apk")
        run([zipalign, "-f", "-p", "4", unsigned_apk, aligned_apk])
        os.remove(unsigned_apk)

        # 8. Generate release keystore and sign v1+v2+v3
        keystore = os.path.join(work_dir, "offline-release.jks")
        if not os.path.exists(keystore):
            run([
                "keytool", "-genkeypair", "-v",
                "-keystore", keystore,
                "-alias", "offline",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
                "-storepass", "offline123", "-keypass", "offline123",
                "-dname", "CN=GocChoXuaOffline, OU=Offline, O=Offline, L=HN, S=HN, C=VN"
            ])

        os.makedirs(os.path.dirname(output_apk) or ".", exist_ok=True)
        if os.path.exists(output_apk):
            os.remove(output_apk)
        run([
            apksigner, "sign",
            "--ks", keystore,
            "--ks-key-alias", "offline",
            "--ks-pass", "pass:offline123",
            "--key-pass", "pass:offline123",
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--out", output_apk,
            aligned_apk,
        ])
        run([apksigner, "verify", "--verbose", output_apk])
        print("\nSUCCESS! Built:", output_apk, flush=True)
    finally:
        if cleanup_work and os.path.isdir(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
