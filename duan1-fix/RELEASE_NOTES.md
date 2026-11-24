## Các lỗi đã tìm thấy và sửa từ bản `duan1`

1. **Lỗi hỏng mã hóa XXTEA ở `assets/assets/main/index.jsc` (nguyên nhân chính khiến game treo màn hình splash, không vào được):**
   - Hàm `xxtea_decrypt` trong `libcocos2djs.so` bắt buộc 4 byte cuối (trailer) sau giải mã phải chứa độ dài dữ liệu gốc (`enc_len - 7 <= trailer <= enc_len - 4`).
   - File `assets/assets/main/index.jsc` ở bản `duan1` bị mã hóa thiếu 4 byte length trailer (`trailer = 357` trong khi `enc_len = 25728`), khiến `xxtea_decrypt` trả về `NULL` và Cocos2d-JS không load được bundle `main`.
   - **Đã sửa:** Mã hóa lại `assets/assets/main/index.jsc` đúng chuẩn XXTEA có length trailer của `libcocos2djs.so` và xác minh giải mã toàn bộ 112/112 file `.jsc`.

2. **Lỗi SDK 37Games / RiverSDK chặn khởi động & đăng nhập (`classes7.dex`):**
   - `YqSdkMgr.checkIsSupportSDK()` trước đó vẫn trả về `true`, khiến `GameActivity` gọi khởi tạo SDK 37Games/RiverSDK và `GameConfig.isU8SDK = true` (bắt buộc đăng nhập online).
   - **Đã sửa:** Patch `YqSdkMgr` trong `classes7.dex` (`checkIsSupportSDK() -> false`, `sdkInitFinished() -> "true"`, vô hiệu hóa `initAd` / `loadVideo`) và bỏ qua bước chờ SDK ở `assets/main.js`.

3. **Lỗi không có server offline cho `http://127.0.0.1/` và WebSocket/Protobuf:**
   - Bản `duan1` chỉ trỏ `PackageInfo` về `http://127.0.0.1/` nhưng không có backend xử lý `server/list`, `player/testLogin`, `player/createRole`, `packageUpdateVN` và WebSocket Protobuf.
   - **Đã sửa:** Tích hợp `assets/offline-server.js` chạy trực tiếp trong game:
     - Xử lý đầy đủ HTTP (`/server/list`, `/player/testLogin`, `/player/createRole`, bỏ qua check update & event tracking).
     - Giả lập WebSocket & Protobuf đúng schema gốc (`S_PLAYER_LOGIN` + 16 gói đồng bộ khởi đầu + `LoginOverMsg`).
     - Hỗ trợ vòng chơi offline cơ bản: chọn nhân vật, chặt cây nhận trang bị, trang bị / tách trang bị lấy tu vi & linh thạch, nâng cấp cây tiên, đột phá cảnh giới, vượt ải (có mô phỏng trận đánh `BattleRecordMsg`), nhận thưởng nhiệm vụ chính tuyến và tự lưu tiến trình vào `localStorage`.

## Thông tin cài đặt
- **File:** `HanhDaoKy-3.8.00-offline-fix1.apk` (arm64-v8a, Android 6.0+, ký v1+v2+v3, đã `zipalign -p 4`)
- **Lưu ý:** Gỡ cài đặt bản `duan1` cũ trước khi cài bản này (do khác chữ ký APK).
- *(Đã kiểm thử tự động toàn bộ luồng HTTP + Protobuf bằng Node.js và xác minh cấu trúc/chữ ký/XXTEA APK trên Linux, chưa test trực tiếp trên máy Android vật lý.)*
