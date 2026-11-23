# Installing the Swordash offline APK

1. Uninstall any store or earlier build of Swordash first. This APK is signed
   with a different key (`CN=swordash-mod`), so installing over it fails with
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstalling deletes the old local
   data.
2. Install the APK: `adb install Swordash-offline.apk`, or open the file on the
   phone and allow installs from that source.
3. Requirements: Android 7.1 (API 25) or newer on an arm64-v8a device. There is
   no 32-bit build.
4. Open the game and tap **Guest**. No network, account or server is needed;
   the Google/Facebook buttons and the "Link with" prompt need the network and
   do nothing useful offline (tick "Don't show it again").
5. Progress is saved on the phone at
   `/data/data/com.fattoy.swordash.android/files/offline_profile.lua` after
   every change and survives closing or force-stopping the app. Uninstalling or
   clearing the app's data erases it.

Build it yourself from the repository:

    KS_PASS=<keystore password> tools/build_offline_apk.sh work/base.apk offline work/FINAL.apk

`work/base.apk` is the merged original APK from `tools/build.sh`. The script
needs `zipalign` and `apksigner` (or `BUILD_TOOLS`) and a keystore at
`keys/my.jks`.

See `OFFLINE_REPORT.md` for what was tested and what does not work offline.
