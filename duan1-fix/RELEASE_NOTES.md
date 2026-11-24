## Các lỗi đã sửa trong bản Fix v2 (sửa lỗi văng game ở `duan1-fix1`)

1. **Sửa lỗi văng game (`NullPointerException` trên UI thread) khi vào `MainView` và trong lúc chơi (`classes7.dex` + `offline-server.js`):**
   - **Nguyên nhân gốc (tìm thấy qua kiểm thử trực tiếp trên giả lập Android 12 + phân tích `classes7.dex`):** Dù `YqSdkMgr.checkIsSupportSDK()` trả về `false`, plugin `com.xmyanqu.dq.SDK37User` vẫn được nạp trong khi `SDK37Tools.initSDK()` đã bị bỏ qua, khiến `SDK37Tools.riverSDKApi == null`. Khi `MainView` mở lên (`MainView.afterInitView`), game gọi `U8SDKMgr.inst.sdk.getGameCenter()` -> `YqSdkMgr.sqSDKGetButtonList()` -> `SDK37Tools.sqSDKGetButtonList()` và truy cập `riverSDKApi` đang `null` trên luồng giao diện chính, gây văng game ngay lập tức. Lỗi tương tự cũng xảy ra ở `queryProducts`, `setLanguage`, `videoAd`, `submitExtraData`, `pay`, `performFeature`, `isFeatureSupported`, v.v.
   - **Đã sửa:**
     - Vô hiệu hóa toàn bộ 45+ hàm ủy quyền `YqPlatform` trong `YqSdkMgr.smali` (`classes7.dex`) và tắt `BuglyExt` (`initBugly`, `postException`, `putUserData`).
     - Chặn toàn bộ cầu gọi JNI SDK/quảng cáo ở tầng JS (`android-tool`: `yqSdkInvoke`, `jsb37Invoke`, `jsbAdInvoke`, `initCnAd`; `android-sdk`: 35+ phương thức bao gồm `getGameCenter`, `videoAd`, `queryProducts`, `setLanguage`, `submitExtraData`, `pay`,...; và `SubmitEventMgr`).

2. **Sửa lỗi treo màn hình splash Funtap che mất màn đăng nhập (`GameLoginView`):**
   - **Nguyên nhân:** `GameLoginView.getIsTiShen()` gửi `POST /server/list` trước khi `isViewValid == true`. Do server offline phản hồi quá nhanh (15ms), `isOnReqTsState` bị kẹt `true` mãi mãi nên `doHideSplash()` không chạy.
   - **Đã sửa:** Vá `GameLoginView.getIsTiShen` và `onUILoadedComplete` luôn xóa cờ `isOnReqTsState` và gọi `doHideSplash()`.

3. **Tắt popup giả "mạng chậm / khởi động lại" khi đang nạp tài nguyên (`GameLoadingView`):**
   - Vô hiệu hóa bộ đếm `GameLoadingView.checkLoadStatus()` (trước đó bật `CommonConfirmView` sau 10 giây chờ nạp DB/Protobuf).

4. **Tối ưu tốc độ nạp 120 file `.proto` (`ProtobufMgr`):**
   - Dùng chung một `ProtoBuf.Builder` theo khóa `"./" + protoName` để không phân tích lại các file `.proto` dùng chung (`Common`, `Battle`, `WatchPlayer`,...) 120 lần (tăng tốc 5x–64x, xác minh xây dựng đủ `1706/1706` message classes không lỗi).

5. **Kế thừa đầy đủ các bản sửa từ `duan1-fix1`:**
   - Sửa 4 byte XXTEA length trailer trong `assets/assets/main/index.jsc` (xác minh giải mã 112/112 file `.jsc`).
   - Tích hợp `assets/offline-server.js` xử lý HTTP (`/server/list`, `/player/testLogin`, `/player/createRole`) và WebSocket/Protobuf offline (tạo nhân vật, chặt cây, trang bị/tách trang bị, nâng cấp cây, đột phá cảnh giới, vượt ải, nhận thưởng nhiệm vụ, tự lưu tiến trình trong `localStorage`).

## Kết quả kiểm thử
- **Node.js E2E:** PASS toàn bộ luồng HTTP + 16 gói đồng bộ đăng nhập Protobuf + chặt cây + trang bị + tách + đột phá + nâng cây + vượt ải (`MainAction` decode) + nhiệm vụ + `localStorage`.
- **Giả lập Android 12 (`arm64-v8a`):** Đã xác minh trực tiếp cài đặt, khởi động V8, ẩn splash sạch, hiện `S1 - Hành Đạo Offline`, đăng nhập, mở màn tạo nhân vật (`CreatRoleView`), tạo nhân vật và nạp 120/120 Protobuf + toàn bộ DB không crash.

## Hướng dẫn cài đặt
- **File:** `HanhDaoKy-3.8.00-offline-fix2.apk` (arm64-v8a, Android 6.0+, ký v1+v2+v3, đã `zipalign -p 4`)
- **Lưu ý quan trọng:** **Gỡ cài đặt bản `duan1` hoặc `duan1-fix1` cũ trước** khi cài bản `fix2` này (do khóa ký APK mới).
