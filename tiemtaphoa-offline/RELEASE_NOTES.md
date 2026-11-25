## Các lỗi đã sửa trong bản Fix v2 (`tiemtaphoa-offline-v2`)

1. **Sửa lỗi Quán Đồ Ăn Sáng trống trơn (`0/phần`), không có khách & không làm được nhiệm vụ `2. Tích lũy bán 3 phần đồ ăn sáng`:**
   - **Nguyên nhân gốc:** Trong game, trạng thái mở khóa món ăn/nghiệp vụ của cửa hàng (`BuildingUtil.isSetingActived`) kiểm tra mã nhiệm vụ `type=22` (`unlockCondition`, ví dụ `2201101` mở khóa món đầu tiên `10101` Quẩy nóng) trong danh sách `completeTaskIdList` (gói `1209`), không chỉ dựa vào `building.businessList`. Do bản v1 chưa đồng bộ `2201101` vào `completeTaskIds` và chưa đẩy danh sách nhiệm vụ `type=22`, `unlockSetingIdList` bị rỗng → chảo rán bị ẩn, đơn giá `0/phần`, không có khách xuất hiện và không thể hoàn thành nhiệm vụ bán đồ ăn sáng.
   - **Đã sửa:**
     - Tự động mở khóa món khởi đầu (`2201101` cho Quán Đồ Ăn Sáng `15101` và các món cấp 1 của mọi cửa hàng khi mở mới), đồng bộ đầy đủ toàn bộ nhiệm vụ mở khóa nghiệp vụ `type=22` theo cấp cửa hàng trong mục **Công Việc** (`BuildingBusinessView`).
     - Xử lý đầy đủ `S_TASK_GET_REWARD (21205)` cho nhiệm vụ `type=22`: khi bấm mở khóa món mới (Bánh bao `10102`, Trứng trà `10103`,...) tự động gắn vào `businessList`, gửi gói `1209` + `405` (`U_BUILDING_UPDATE`) và cập nhật tiến độ nhiệm vụ chính tuyến (`ctype=170`) mà không ghi đè `mainTaskId`.
     - Bổ sung theo dõi chi tiết bán hàng `S_BUILDING_HANDLE (20424)` + `S_BUILDING_HANDLE_DETAIL (20428)` để tiến độ nhiệm vụ bán đồ ăn sáng (`ctype=157`) tăng ngay khi phục vụ khách (cả chế độ tự động lẫn thủ công).

2. **Sửa lỗi không hiện nút Trở về Sảnh Chính (`btnClose`) trong Quán Đồ Ăn Sáng:**
   - **Nguyên nhân:** `BuildingBreakfastMainView.initViewWithGuideCheck()` ẩn `btnClose` cho tới khi người chơi hoàn thành 11 nhiệm vụ đầu tiên (`GUIDE_BREAKFAST_SHOW_BACK_BTN_TASK = 200012`).
   - **Đã sửa:** Ghi đè cấu hình `GUIDE_BREAKFAST_SHOW_BACK_BTN_TASK = 200001` khi đăng nhập để **nút Trở về Sảnh Chính luôn hiển thị ngay từ đầu** (người chơi vừa có thể tự do ra sảnh chính, vừa làm trọn chuỗi nhiệm vụ chính tuyến bình thường).

3. **Bổ sung hoàn chỉnh chuỗi nhiệm vụ chính tuyến & Xưởng Sản Xuất (`Workshop`):**
   - Hỗ trợ đầy đủ các loại nhiệm vụ chính tuyến tiếp theo: Phái Nhân Tài (`ctype=105`), Nâng cấp Nhân Tài (`ctype=106`), Nâng kỹ năng Nhân Tài (`ctype=18`), Nâng cấp Xưởng (`ctype=154`), Mở khóa nghiệp vụ (`ctype=170`).
   - Bổ sung đồng bộ Xưởng (`5601` `SyncWorkshopInfoMsg`) và xử lý các gói Xưởng (`25602` nâng cấp, `25603` mua buff, `25604`–`25606` sự kiện/boss, `25611` thông tin xưởng).

4. **Kế thừa toàn bộ bản sửa từ v1:**
   - Sửa lỗi gốc `classes.dex` hỏng checksum/thứ tự `string_ids` trong XAPK gốc, gộp 5 split APK, tắt SDK/quảng cáo ngoài, tích hợp giftcode offline (`OFFLINE`, `RICH`, `VIP999`, `ALLHERO`).

## Hướng dẫn cài đặt
- **File:** `GocChoXua-3.7.1-offline-fix2.apk` (`~1.1 GB`, `arm64-v8a`, đã `zipalign -p 4`, ký v1+v2+v3)
- **Lưu ý quan trọng:** **Gỡ cài đặt bản v1 cũ trước** khi cài bản `fix2` này (do chữ ký build CI mới).
- **Tài khoản mặc định:** `tiemtaphoa01` ở server `S1 - Góc Chợ Xưa Offline`.
