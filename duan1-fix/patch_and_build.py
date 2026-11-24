#!/usr/bin/env python3
"""
Patches HanhDaoKy-3.8.00-offline.apk (from release `duan1`) to fix:
1. Missing 4-byte XXTEA length trailer in assets/assets/main/index.jsc
2. Active 37Games/RiverSDK checks in YqSdkMgr (classes7.dex)
3. Boot delay/SDK wait in assets/main.js
4. Missing offline HTTP + WebSocket/Protobuf backend (injects assets/offline-server.js)
"""

import gzip
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib

XXTEA_KEY = b"b20ac5e4-20c7-47"
XXTEA_K = struct.unpack("<4I", XXTEA_KEY.ljust(16, b"\0")[:16])


def xxtea_decrypt_raw(data: bytes):
    n = len(data) // 4
    v = list(struct.unpack("<%dI" % n, data[: n * 4]))
    delta = 0x9E3779B9
    q = 6 + 52 // n
    s = (q * delta) & 0xFFFFFFFF
    y = v[0]
    while s != 0:
        e = (s >> 2) & 3
        for p in range(n - 1, 0, -1):
            z = v[p - 1]
            mx = (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((s ^ y) + (XXTEA_K[(p & 3) ^ e] ^ z))
            v[p] = (v[p] - mx) & 0xFFFFFFFF
            y = v[p]
        z = v[n - 1]
        mx = (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((s ^ y) + (XXTEA_K[(0 & 3) ^ e] ^ z))
        v[0] = (v[0] - mx) & 0xFFFFFFFF
        y = v[0]
        s = (s - delta) & 0xFFFFFFFF
    return struct.pack("<%dI" % n, *v), v[-1]


def xxtea_encrypt(plain: bytes) -> bytes:
    length = len(plain)
    pad_len = (4 - (length % 4)) % 4
    padded = plain + b"\x00" * pad_len
    v = list(struct.unpack("<%dI" % (len(padded) // 4), padded))
    v.append(length)  # Required 4-byte length trailer checked by libcocos2djs.so
    n = len(v)
    delta = 0x9E3779B9
    q = 6 + 52 // n
    z = v[n - 1]
    s = 0
    for _ in range(q):
        s = (s + delta) & 0xFFFFFFFF
        e = (s >> 2) & 3
        for p in range(n - 1):
            y = v[p + 1]
            mx = (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((s ^ y) + (XXTEA_K[(p & 3) ^ e] ^ z))
            v[p] = (v[p] + mx) & 0xFFFFFFFF
            z = v[p]
        y = v[0]
        mx = (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((s ^ y) + (XXTEA_K[((n - 1) & 3) ^ e] ^ z))
        v[n - 1] = (v[n - 1] + mx) & 0xFFFFFFFF
        z = v[n - 1]
    return struct.pack("<%dI" % n, *v)


def xxtea_decrypt_strict(enc: bytes) -> bytes:
    assert len(enc) % 4 == 0 and len(enc) >= 8
    raw, trailer = xxtea_decrypt_raw(enc)
    enc_len = len(enc)
    assert (enc_len - 7) <= trailer <= (enc_len - 4), f"Invalid XXTEA trailer {trailer} for len {enc_len}"
    return raw[:trailer]


def patch_main_js(raw_text: str) -> str:
    old_block = """                cc.assetManager.loadBundle("script", function (err) {
                    if (err) return console.error(err.message, err.stack);
                    cc.game.run(option, onStart);
                });"""
    new_block = """                cc.assetManager.loadBundle("script", function (err) {
                    if (err) return console.error(err.message, err.stack);
                    try {
                        require("offline-server.js");
                    } catch (offlineErr) {
                        console.error("[Offline] require offline-server.js failed:", offlineErr);
                    }
                    cc.game.run(option, onStart);
                });"""
    assert old_block in raw_text, "Expected loadBundle('script') block not found in main.js"
    out = raw_text.replace(old_block, new_block, 1)

    old_boot = """    var sdkReady = false;
    try {
        sdkReady = (cc.sys.OS_ANDROID !== cc.sys.os) || GetSdkInitFinished();
    } catch (e) {
        console.log('GetSdkInitFinished failed: ' + e);
    }
    if (sdkReady) {
        window.boot();
    } else {
        console.log("wait android start.");
        setTimeout(function () {
            console.log("android sdk timeout, booting offline.");
            window.boot();
        }, 4000);
    }"""
    new_boot = """    console.log("[Offline] booting immediately without waiting for online SDK.");
    window.boot();"""
    assert old_boot in out, "Expected sdkReady boot block not found in main.js"
    return out.replace(old_boot, new_boot, 1)


def replace_smali_method(text: str, sig: str, new_body: str) -> str:
    pat = re.compile(re.escape(sig) + r".*?\.end method", re.DOTALL)
    m = pat.search(text)
    assert m, f"Method {sig} not found in YqSdkMgr.smali"
    return text[: m.start()] + new_body + text[m.end() :]


def run(cmd, cwd=None):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <input.apk> <output.apk>")
        sys.exit(1)

    input_apk = os.path.abspath(sys.argv[1])
    output_apk = os.path.abspath(sys.argv[2])
    script_dir = os.path.dirname(os.path.abspath(__file__))
    offline_js_src = os.path.join(script_dir, "offline-server.js")
    assert os.path.isfile(offline_js_src), f"Missing {offline_js_src}"

    work = os.path.abspath("work_build")
    if os.path.exists(work):
        shutil.rmtree(work)
    stage = os.path.join(work, "stage")
    os.makedirs(os.path.join(stage, "assets", "assets", "main"), exist_ok=True)

    with zipfile.ZipFile(input_apk, "r") as zin:
        # 1. Fix assets/assets/main/index.jsc
        broken_main_jsc = zin.read("assets/assets/main/index.jsc")
        raw_dec, _ = xxtea_decrypt_raw(broken_main_jsc)
        main_index_js = zlib.decompress(raw_dec, 16 + zlib.MAX_WBITS)
        fixed_gz = gzip.compress(main_index_js, compresslevel=9, mtime=0)
        fixed_main_jsc = xxtea_encrypt(fixed_gz)
        assert gzip.decompress(xxtea_decrypt_strict(fixed_main_jsc)) == main_index_js
        with open(os.path.join(stage, "assets", "assets", "main", "index.jsc"), "wb") as f:
            f.write(fixed_main_jsc)

        # 2. Patch assets/main.js
        orig_main_js = zin.read("assets/main.js").decode("utf-8")
        patched_main_js = patch_main_js(orig_main_js)
        with open(os.path.join(stage, "assets", "main.js"), "w", encoding="utf-8") as f:
            f.write(patched_main_js)

        # 3. Copy assets/offline-server.js
        shutil.copyfile(offline_js_src, os.path.join(stage, "assets", "offline-server.js"))

        # 4. Extract classes7.dex and patch YqSdkMgr.smali
        dex7_in = os.path.join(work, "classes7_orig.dex")
        with open(dex7_in, "wb") as f:
            f.write(zin.read("classes7.dex"))

    smali_dir = os.path.join(work, "smali7")
    baksmali_cp = "/usr/share/java/baksmali.jar:/usr/share/java/smali.jar:/usr/share/java/dexlib2.jar:/usr/share/java/guava.jar:/usr/share/java/jcommander.jar"
    smali_cp = "/usr/share/java/smali.jar:/usr/share/java/dexlib2.jar:/usr/share/java/guava.jar:/usr/share/java/jcommander.jar:/usr/share/java/antlr3-runtime.jar"
    run(["java", "-cp", baksmali_cp, "org.jf.baksmali.Main", "disassemble", dex7_in, "-o", smali_dir])

    yq_smali = os.path.join(smali_dir, "org", "cocos2dx", "javascript", "plugin", "YqSdkMgr.smali")
    s = open(yq_smali, "r", encoding="utf-8").read()

    # Neutralize ALL YqPlatform-delegating methods so uninitialized SDK37Tools.riverSDKApi can NEVER throw NPE
    void_0arg_methods = [
        ".method public static bindPhone()V",
        ".method public static channelInfo()V",
        ".method public static destroy()V",
        ".method public static faq()V",
        ".method public static getFeedbackState()V",
        ".method public static initAd()V",
        ".method public static isVideoAvailable()V",
        ".method public static loadVideo()V",
        ".method public static login()V",
        ".method public static openAgreement()V",
        ".method public static openAppStore()V",
        ".method public static openPersonalizedAdSettingsDialog()V",
        ".method public static openRegister()V",
        ".method public static queryAntiAddiction()V",
        ".method public static quitGame()V",
        ".method public static realName()V",
        ".method public static showAccountCenter()V",
        ".method public static showAd()V",
        ".method public static showAgeAppropriate()V",
        ".method public static showAgeIcon()V",
        ".method public static showBBS()V",
        ".method public static showGift()V",
        ".method public static showPayGuid()V",
        ".method public static sqSDKGetButtonList()V",
        ".method public static sqSDKPresentNaverSDKMainView()V",
        ".method public static startLoginView()V",
        ".method public static switchAccount()V",
        ".method public static validateIntegration()V",
    ]
    for sig in void_0arg_methods:
        s = replace_smali_method(s, sig, f"{sig}\n    .registers 0\n\n    return-void\n.end method")

    void_1arg_methods = [
        ".method public static achievement(Ljava/lang/String;)V",
        ".method public static bindLogin(Ljava/lang/String;)V",
        ".method public static initAdData(Ljava/lang/String;)V",
        ".method public static initV2Ad(Ljava/lang/String;)V",
        ".method public static openLink(Ljava/lang/String;)V",
        ".method public static performFeature(Ljava/lang/String;)V",
        ".method public static sdkVip(Ljava/lang/String;)V",
        ".method public static setAdUserId(Ljava/lang/String;)V",
        ".method public static setDynamicUserId(Ljava/lang/String;)V",
        ".method public static setLanguage(Ljava/lang/String;)V",
        ".method public static setPersonalizedAd(Z)V",
        ".method public static share(Ljava/lang/String;)V",
        ".method public static showAd(Ljava/lang/String;)V",
        ".method public static showHuaweiAd(Ljava/lang/String;)V",
        ".method public static showV2Ad(Ljava/lang/String;)V",
        ".method public static submitExtraData(Ljava/lang/String;)V",
    ]
    for sig in void_1arg_methods:
        s = replace_smali_method(s, sig, f"{sig}\n    .registers 1\n\n    return-void\n.end method")

    s = replace_smali_method(
        s,
        ".method public static queryProducts(Ljava/lang/String;Ljava/lang/String;)V",
        """.method public static queryProducts(Ljava/lang/String;Ljava/lang/String;)V
    .registers 2

    return-void
.end method""",
    )

    bool_or_int_false_0arg = [
        ".method public static checkIsSupportSDK()Z",
        ".method public static getPersonalizedAd()Z",
        ".method public static hashLogin()Z",
    ]
    for sig in bool_or_int_false_0arg:
        s = replace_smali_method(s, sig, f"{sig}\n    .registers 1\n\n    const/4 v0, 0x0\n\n    return v0\n.end method")

    bool_or_int_false_1arg = [
        ".method public static isFeatureSupported(I)Z",
        ".method public static isFeatureSupported(Ljava/lang/String;)Z",
        ".method public static isSupportMethod(Ljava/lang/String;)I",
    ]
    for sig in bool_or_int_false_1arg:
        s = replace_smali_method(s, sig, f"{sig}\n    .registers 2\n\n    const/4 v0, 0x0\n\n    return v0\n.end method")

    s = replace_smali_method(
        s,
        ".method public static getAdPlatform()Ljava/lang/String;",
        """.method public static getAdPlatform()Ljava/lang/String;
    .registers 1

    const-string v0, ""

    return-object v0
.end method""",
    )
    s = replace_smali_method(
        s,
        ".method public static sdkInitFinished()Ljava/lang/String;",
        """.method public static sdkInitFinished()Ljava/lang/String;
    .registers 1

    const/4 v0, 0x1

    sput-boolean v0, Lorg/cocos2dx/javascript/plugin/YqSdkMgr;->isRunCocosMainJsFile:Z

    sput-boolean v0, Lorg/cocos2dx/javascript/plugin/YqSdkMgr;->isInitFinished:Z

    const-string v0, "true"

    return-object v0
.end method""",
    )
    open(yq_smali, "w", encoding="utf-8").write(s)

    # Also disable online Bugly crash uploader init/post in offline mode
    bugly_smali = os.path.join(smali_dir, "org", "cocos2dx", "javascript", "bugly", "BuglyExt.smali")
    if os.path.isfile(bugly_smali):
        bs = open(bugly_smali, "r", encoding="utf-8").read()
        for bsig in [
            ".method public static initBugly(Ljava/lang/String;)V",
            ".method public static postException(Ljava/lang/String;)V",
            ".method public static putUserData(Ljava/lang/String;)V",
        ]:
            if bsig in bs:
                bs = replace_smali_method(bs, bsig, f"{bsig}\n    .registers 1\n\n    return-void\n.end method")
        open(bugly_smali, "w", encoding="utf-8").write(bs)

    dex7_out = os.path.join(stage, "classes7.dex")
    run(["java", "-cp", smali_cp, "org.jf.smali.Main", "assemble", smali_dir, "-o", dex7_out])

    # 5. Repack APK preserving all untouched entries and compression modes
    unsigned_apk = os.path.join(work, "unsigned.apk")
    aligned_apk = os.path.join(work, "aligned.apk")
    shutil.copyfile(input_apk, unsigned_apk)
    run(["zip", "-d", unsigned_apk, "META-INF/HANHDAOK.SF", "META-INF/HANHDAOK.RSA", "META-INF/MANIFEST.MF"])
    run(["zip", "-9", unsigned_apk, "classes7.dex", "assets/main.js", "assets/offline-server.js"], cwd=stage)
    run(["zip", "-0", unsigned_apk, "assets/assets/main/index.jsc"], cwd=stage)

    # 6. Zipalign & Sign
    run(["zipalign", "-f", "-p", "4", unsigned_apk, aligned_apk])
    ks = os.path.join(work, "hanhdaoky-offline.jks")
    run(
        [
            "keytool",
            "-genkeypair",
            "-keystore",
            ks,
            "-storepass",
            "hanhdaoky123",
            "-keypass",
            "hanhdaoky123",
            "-alias",
            "hanhdaoky",
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            "10000",
            "-dname",
            "CN=HanhDaoKy Offline, OU=Mod, O=Offline, L=VN, S=VN, C=VN",
        ]
    )
    run(
        [
            "apksigner",
            "sign",
            "--ks",
            ks,
            "--ks-key-alias",
            "hanhdaoky",
            "--ks-pass",
            "pass:hanhdaoky123",
            "--key-pass",
            "pass:hanhdaoky123",
            "--v1-signing-enabled",
            "true",
            "--v2-signing-enabled",
            "true",
            "--v3-signing-enabled",
            "true",
            "--out",
            output_apk,
            aligned_apk,
        ]
    )

    # 7. Final verification on signed APK
    run(["apksigner", "verify", "--verbose", output_apk])
    run(["zipalign", "-c", "-p", "4", output_apk])
    with zipfile.ZipFile(output_apk, "r") as zout:
        assert zout.getinfo("resources.arsc").compress_type == 0
        jsc_cnt = 0
        for info in zout.infolist():
            if info.filename.endswith(".jsc"):
                jsc_cnt += 1
                dec = xxtea_decrypt_strict(zout.read(info.filename))
                if dec[:2] == b"\x1f\x8b":
                    gzip.decompress(dec)
        print(f"Verified all {jsc_cnt} .jsc files in {output_apk}!")
    print("BUILD & VERIFICATION COMPLETE:", output_apk)


if __name__ == "__main__":
    main()
