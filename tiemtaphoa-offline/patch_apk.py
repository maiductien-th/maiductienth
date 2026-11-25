#!/usr/bin/env python3
"""
Builds standalone offline APK for Góc Chợ Xưa (com.gcxua.vn 3.7.1):
  1. Patches YqSdkMgr.smali (disables BBT/YqPlatform third-party SDK & ads, immediate init)
  2. Compiles patched classes3.dex via smali
  3. Patches assets/yq_plugin_config.xml (keeps only GameIApplication)
  4. Patches assets/main.js to load assets/offline-server.js before window.boot()
  5. Updates merged_base.apk (fast in-place zip update), runs zipalign -p 4, signs v1+v2+v3
"""
import os
import re
import shutil
import subprocess
import sys

WORK_DIR = "/home/antigravity/work/tiemtaphoa"
REPO_DIR = "/home/antigravity/maiductien-th/maiductienth/tiemtaphoa-offline"
MERGED_BASE = os.path.join(WORK_DIR, "merged_base.apk")
SMALI_CLASSES1_DIR = os.path.join(WORK_DIR, "apktool_base", "smali")
SMALI_DIR = os.path.join(WORK_DIR, "apktool_base", "smali_classes3")
PATCHED_SMALI_DIR = os.path.join(WORK_DIR, "smali_classes3_patched")
OUT_APK_UNSIGNED = os.path.join(WORK_DIR, "unsigned.apk")
OUT_APK_ALIGNED = os.path.join(WORK_DIR, "aligned.apk")
OUT_APK_FINAL = os.path.join(WORK_DIR, "GocChoXua-3.7.1-offline.apk")
KEYSTORE = os.path.join(WORK_DIR, "offline-release.jks")

ZIPALIGN = "/opt/android-sdk/build-tools/34.0.0/zipalign"
APKSIGNER = "/opt/android-sdk/build-tools/34.0.0/apksigner"
DEXDUMP = "/opt/android-sdk/build-tools/34.0.0/dexdump"


def run(cmd, cwd=None):
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


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

        # Neutralize all remaining YqPlatform / SDK methods safely
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
    print(f"Patched {patched_count} methods in {smali_path}")


def patch_main_js(orig_main_js, out_main_js):
    src = open(orig_main_js, "r", encoding="utf-8").read()
    needle = "require('jsb-adapter/jsb-engine.js');"
    assert needle in src, "Expected needle not found in assets/main.js"
    inject = needle + "\n        require('offline-server.js');"
    src = src.replace(needle, inject, 1)
    # Also ensure window.boot() does not stall waiting on Android SDK callback
    old_boot = "if (cc.sys.OS_ANDROID !== cc.sys.os || GetSdkInitFinished()) {"
    if old_boot in src:
        src = src.replace(old_boot, "if (true) {", 1)
    open(out_main_js, "w", encoding="utf-8").write(src)
    print(f"Patched main.js -> {out_main_js}")


def main():
    assert os.path.exists(MERGED_BASE), f"Missing {MERGED_BASE}"
    assert os.path.exists(SMALI_CLASSES1_DIR), f"Missing {SMALI_CLASSES1_DIR}"
    assert os.path.exists(SMALI_DIR), f"Missing {SMALI_DIR}"

    # 1. Copy smali_classes3 and patch YqSdkMgr.smali
    if os.path.exists(PATCHED_SMALI_DIR):
        shutil.rmtree(PATCHED_SMALI_DIR)
    shutil.copytree(SMALI_DIR, PATCHED_SMALI_DIR)
    yq_smali = os.path.join(PATCHED_SMALI_DIR, "org/cocos2dx/javascript/plugin/YqSdkMgr.smali")
    patch_yq_sdk_mgr(yq_smali)

    # 2. Rebuild classes.dex (fixes corrupted checksum & out-of-order string_ids in original XAPK)
    #    and assemble patched classes3.dex
    stage_dir = os.path.join(WORK_DIR, "apk_stage")
    if os.path.exists(stage_dir):
        shutil.rmtree(stage_dir)
    os.makedirs(os.path.join(stage_dir, "assets"), exist_ok=True)

    dex1_out = os.path.join(stage_dir, "classes.dex")
    run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.smali.Main", "a", SMALI_CLASSES1_DIR, "-o", dex1_out])
    run([DEXDUMP, "-c", dex1_out])

    dex3_out = os.path.join(stage_dir, "classes3.dex")
    run(["java", "-Xmx2g", "-cp", "/usr/share/java/*", "org.jf.smali.Main", "a", PATCHED_SMALI_DIR, "-o", dex3_out])
    run([DEXDUMP, "-c", dex3_out])

    # 3. Prepare patched assets
    with open(os.path.join(stage_dir, "assets", "yq_plugin_config.xml"), "w", encoding="utf-8") as f:
        f.write(
            "<?xml version='1.0' encoding='UTF-8'?>\n"
            "<plugins>\n"
            '    <plugin name="org.cocos2dx.javascript.GameIApplication" type="8" />\n'
            "</plugins>\n"
        )

    patch_main_js(
        os.path.join(WORK_DIR, "inspect", "assets", "main.js"),
        os.path.join(stage_dir, "assets", "main.js"),
    )
    shutil.copy2(
        os.path.join(REPO_DIR, "offline-server.js"),
        os.path.join(stage_dir, "assets", "offline-server.js"),
    )

    # 4. Copy merged_base.apk and update modified/added files + remove old META-INF sigs
    shutil.copy2(MERGED_BASE, OUT_APK_UNSIGNED)
    subprocess.run(
        ["zip", "-d", OUT_APK_UNSIGNED, "META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA", "META-INF/MANIFEST.MF"],
        check=False,
    )
    run(
        [
            "zip", "-r", "-u", OUT_APK_UNSIGNED,
            "classes.dex",
            "classes3.dex",
            "assets/yq_plugin_config.xml",
            "assets/main.js",
            "assets/offline-server.js",
        ],
        cwd=stage_dir,
    )

    # 5. Zipalign
    if os.path.exists(OUT_APK_ALIGNED):
        os.remove(OUT_APK_ALIGNED)
    run([ZIPALIGN, "-f", "-p", "4", OUT_APK_UNSIGNED, OUT_APK_ALIGNED])

    # 6. Generate release keystore if needed and sign v1+v2+v3
    if not os.path.exists(KEYSTORE):
        run([
            "keytool", "-genkeypair", "-v",
            "-keystore", KEYSTORE,
            "-alias", "offline",
            "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-storepass", "offline123", "-keypass", "offline123",
            "-dname", "CN=GocChoXuaOffline, OU=Offline, O=Offline, L=HN, S=HN, C=VN"
        ])

    if os.path.exists(OUT_APK_FINAL):
        os.remove(OUT_APK_FINAL)
    run([
        APKSIGNER, "sign",
        "--ks", KEYSTORE,
        "--ks-key-alias", "offline",
        "--ks-pass", "pass:offline123",
        "--key-pass", "pass:offline123",
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--v3-signing-enabled", "true",
        "--out", OUT_APK_FINAL,
        OUT_APK_ALIGNED,
    ])
    run([APKSIGNER, "verify", "--verbose", OUT_APK_FINAL])
    print("\nSUCCESS! Built:", OUT_APK_FINAL)


if __name__ == "__main__":
    main()
