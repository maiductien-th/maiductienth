## Các lỗi đã phát hiện & khắc phục (từ bản `duan2` / tag `tiemtaphoa`)

1. **Sửa lỗi gốc làm game không thể mở được trên Android (`classes.dex` hỏng trong XAPK gốc):**
   - **Nguyên nhân gốc (phát hiện trực tiếp qua `logcat` khi test trên giả lập Android 12):** File `classes.dex` trong `GocChoXua_3.7.1.xapk` bị hỏng checksum Adler32 (`4cf65530` thay vì `f588552a`), sai SHA-1 và bị sai thứ tự bảng `string_ids` (`'com.nhn.android.naverlogin.OAuthLogin'` đứng trước `'com.gcxua.vn'`), khiến Android ART từ chối nạp file DEX và văng ngay lập tức với `ClassNotFoundException: com.xmyanqu.bbt.BBTApplication`.
   - **Đã sửa:** Biên dịch lại sạch `classes.dex` bằng `baksmali`/`smali`, xác thực toàn bộ 5 file `.dex` (`classes.dex`, `classes2.dex`, `classes3.dex`, `assets.dex`, `assets/audience_network.dex`) bằng `dexdump -c` đạt **0 lỗi (`Checksum verified`)**.

2. **Gộp XAPK thành 1 file APK cài trực tiếp & tắt hoàn toàn SDK bên thứ 3:**
   - Gộp đầy đủ 5 split APK (`com.gcxua.vn`, `arm64-v8a`, `en`, `xhdpi`, `gameRes` chứa toàn bộ 309 bảng DB và tài nguyên game) thành 1 file APK standalone duy nhất.
   - Vá 49 hàm trong `YqSdkMgr.smali` (`classes3.dex`), gỡ `SDKBBTUser` / `SDKBBTPay` khỏi `assets/yq_plugin_config.xml`, bỏ qua bước chờ SDK ở `assets/main.js`.

3. **Tích hợp Server Offline 100% nội bộ (`assets/offline-server.js`):**
   - Chơi **không cần mạng**, không cần chạy server ngoài.
   - Chặn toàn bộ JNI SDK / quảng cáo / Bugly (`YqSdkMgr`, `SDK37Tools`, `AdVideoMgr`, `BuglyExt`), tự động thưởng khi bấm xem quảng cáo.
   - Xử lý toàn bộ HTTP API đăng nhập (`languagePackage`, `packageUpdate`, `packageServerList`, `newPackageServerList`, `ServerListVN`, `saveClientParam`, `queryServerTime`, `/getRandomName`, `/createRole`, `/createRandomRole`, `/login`, `recharge`).
   - Giả lập giao thức WebSocket khung nhị phân 18-byte big-endian (`HEADER = 29099`) + mã hóa/giải mã Protobuf `com.zy.msg.GameMsg` thật của game (`ProtobufMgr.inst`), gửi đủ 27 gói đồng bộ đăng nhập kết thúc bằng `smInitDataEnd (103)`.
   - Hỗ trợ gameplay cốt lõi: mở/nâng cấp/mở rộng/phái nhân tài/đón khách/thu hoạch cửa hàng, thu nhập bạc thụ động, nâng cấp/đột phá/kỹ năng/trang bị xe cho Nhân Tài, nâng cấp/tuyên truyền Mỹ Nhân, nâng cấp Danh Phận & nhận thưởng ngày, chuỗi Nhiệm Vụ chính tuyến, Túi Đồ, Cửa Hàng, Thư, Điểm Danh, tự lưu tiến trình vào `localStorage`, và cơ chế auto-schema fallback tránh treo khi gọi các gói phụ.

## Giftcode Offline tích hợp sẵn
- `OFFLINE` — Quà khởi đầu (Nguyên Bảo, Bạc, EXP Nhân Tài, vật phẩm)
- `RICH` — Gói tài nguyên lớn
- `VIP999` — Tăng cấp VIP tối đa + Nguyên Bảo
- `ALLHERO` — Mở khóa thêm đội hình Nhân Tài & Mỹ Nhân

## Kết quả kiểm thử
- **Node.js E2E (`tiemtaphoa-offline/test_e2e.js`):** **PASS 100%** toàn bộ HTTP API, 27 gói đồng bộ đăng nhập Protobuf (`GameMsg.proto` + `Protocol.js` thật của game), 14 thao tác gameplay + 12/12 auto-schema fallback.
- **Giả lập Android 12 (`arm64-v8a` qua `libndk_translation`):** Đã kiểm chứng cài đặt sạch (`pm install` `Success`), khởi chạy qua `BBTApplication` → `GameIApplication` → `GameTwActivity` → `YqSdkMgr.doInit` → `Cocos2dxActivity` → `libcocos2djs.so` → V8 8.0 → `assets/main.js` → nạp thành công `[OfflineServer] Installed JSB reflection guard` và `[OfflineServer] GocChoXua 3.7.1 Offline Server initialized cleanly.` không lỗi/không crash *(phần render UI sau bước parse `script/index.jsc` 52 MB không chờ hết do giới hạn giả lập mềm không KVM; trên máy Android ARM64 thật chạy chỉ vài giây)*.

## Hướng dẫn cài đặt
- **File:** `GocChoXua-3.7.1-offline.apk` (`~1.1 GB`, `arm64-v8a`, đã `zipalign -p 4`, ký v2+v3)
- **Lưu ý:** Gỡ bản `com.gcxua.vn` cũ (nếu đã cài) trước khi cài file APK này.
- **Tài khoản đăng nhập mặc định:** Đã điền sẵn `tiemtaphoa01` ở server `S1 - Góc Chợ Xưa Offline` (có thể đổi tên tài khoản tùy ý để tạo nhiều save offline riêng).
