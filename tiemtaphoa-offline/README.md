# Góc Chợ Xưa 3.7.1 — Offline Server & APK Builder

Bộ server offline nội bộ (`offline-server.js`) và công cụ đóng gói APK standalone cho tựa game **Góc Chợ Xưa** (`com.gcxua.vn`, v3.7.1 — Cocos Creator 2.x + FairyGUI + Protobuf).

## Các lỗi gốc đã phát hiện & sửa chữa

1. **Sửa lỗi văng ngay khi mở app (`classes.dex` hỏng trong XAPK gốc):**
   - File `classes.dex` trong `GocChoXua_3.7.1.xapk` gốc bị hỏng checksum Adler32 (`4cf65530` thay vì `f588552a`), sai SHA-1 và sai thứ tự bảng `string_ids` (`'com.nhn.android.naverlogin.OAuthLogin'` đứng trước `'com.gcxua.vn'`), khiến Android ART từ chối nạp DEX (`ClassNotFoundException: com.xmyanqu.bbt.BBTApplication`).
   - Đã biên dịch lại sạch `classes.dex` bằng `smali` và kiểm chứng 100% file `.dex` bằng `dexdump -c` (0 lỗi, `Checksum verified`).
2. **Vô hiệu hóa SDK/quảng cáo bên thứ 3 (`classes3.dex` + `yq_plugin_config.xml`):**
   - Vá 49 hàm trong `YqSdkMgr.smali`, loại bỏ plugin `SDKBBTUser` / `SDKBBTPay`, cho phép khởi tạo game ngay lập tức không cần SDK mạng.
3. **Tích hợp Server Offline 100% nội bộ (`assets/offline-server.js`):**
   - Chặn toàn bộ cầu JNI SDK / quảng cáo / Bugly (`YqSdkMgr`, `SDK37Tools`, `AdVideoMgr`, `BuglyExt`) và tự thưởng xem quảng cáo trong chế độ offline.
   - Xử lý toàn bộ HTTP API đăng nhập & cấu hình (`languagePackage`, `packageUpdate`, `packageServerList`, `newPackageServerList`, `ServerListVN`, `saveClientParam`, `queryServerTime`, `/getRandomName`, `/createRole`, `/createRandomRole`, `/login`, `recharge`).
   - Giả lập trọn bộ giao thức WebSocket khung nhị phân 18-byte big-endian (`HEADER = 29099`) + mã hóa/giải mã `com.zy.msg.GameMsg` Protobuf thật của game (`ProtobufMgr.inst`).
   - Hỗ trợ đầy đủ vòng lặp gameplay cốt lõi: tạo nhân vật, đồng bộ 27 gói khởi tạo đăng nhập (`smInitDataEnd`), xây/mở/nâng cấp/mở rộng/phái nhân tài/đón khách/thu hoạch cửa hàng, thu nhập thụ động, nâng cấp/đột phá/kỹ năng/trang bị xe cho Nhân Tài, nâng cấp/tuyên truyền Mỹ Nhân, nâng cấp Danh Phận & nhận bổng lộc, chuỗi Nhiệm Vụ chính tuyến, Túi Đồ, Cửa Hàng, Thư, Điểm Danh, và cơ chế auto-schema fallback cho các gói ít dùng để không bị treo game.
   - Tự động lưu tiến trình vào `localStorage`.
- **Giftcode offline tích hợp sẵn:**
  - `OFFLINE` — Quà tân thủ offline (Kim Nguyên Bảo, Bạc, Kinh nghiệm nhân tài, vật phẩm)
  - `RICH` — Gói tài nguyên lớn
  - `VIP999` — Tăng cấp VIP tối đa + Nguyên Bảo
  - `ALLHERO` — Mở khóa thêm Nhân Tài & Mỹ Nhân

## Cấu trúc thư mục

- `offline-server.js`: Server HTTP + WebSocket/Protobuf offline chạy nội bộ trong V8/JSB.
- `test_e2e.js`: Bộ kiểm thử E2E bằng Node.js chạy trực tiếp trên `Protobuf` (`GameMsg.proto`) và `Protocol.js` giải mã từ game.
- `patch_apk.py`: Script tự động vá `YqSdkMgr.smali`, biên dịch `classes3.dex`, tắt plugin SDK BBT trong `yq_plugin_config.xml`, chèn `offline-server.js` vào `assets/main.js`, `zipalign -p 4` và ký APK v1+v2+v3.

## Cách chạy kiểm thử & build

```bash
# Chạy test E2E giao thức Protobuf + HTTP + WebSocket trên Node.js
node tiemtaphoa-offline/test_e2e.js

# Build lại APK standalone offline (yêu cầu đã giải nén XAPK vào /home/antigravity/work/tiemtaphoa)
python3 tiemtaphoa-offline/patch_apk.py
```
