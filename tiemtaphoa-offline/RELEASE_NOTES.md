## Các lỗi đã sửa & kiểm chứng trực tiếp trên giả lập Android 12 — Fix v3 (`tiemtaphoa-offline-v3`)

1. **Sửa triệt để thông báo lặp liên tục `"Tải tài nguyên từ xa thất bại, vui lòng kiểm tra mạng"` (và lỗi treo 1% khi tắt mạng):**
   - **Nguyên nhân gốc:** `RemoteResMgr.loadResManifest()` và `loadRemoteRes()` gọi thẳng `jsb.Downloader` tải `remoteRes.manifest` / file âm thanh từ CDN `cdn-sg-vn.pogohopper.com`, gây ra `SSLHandshakeException` / lỗi mạng và bật thông báo `L_ShiGuang_Common_Text_0802` liên tục mỗi lần chuyển màn hình hoặc phát âm thanh.
   - **Đã sửa:** Vá runtime `RemoteResMgr` (`loadResManifest`, `loadRemoteRes`, `downloadRemoteRes`, `checkRemoteFileExist`, `loadRemoteSkelSpineResNoNode`, `loadRemoteJsonSpineResNoNode`) ngay trước khi màn hình đăng nhập khởi chạy để chạy thuần offline (fallback về tài nguyên có sẵn trong APK qua `I18nUtil`, không gọi CDN ngoài, không hiện toast lỗi mạng) và bổ sung endpoint `.manifest` trả `{}` trong offline HTTP handler.

2. **Sửa lỗi không có NPC khách tới mua hàng ở Quán Đồ Ăn Sáng (Nhiệm vụ #2 `2. Tích lũy bán 3 phần đồ ăn sáng` không tăng):**
   - **Nguyên nhân gốc:** Tất cả 51 khách hàng của Quán Đồ Ăn Sáng (`108001`–`108051`) trong `CustomerDB` đều có `goShopLimit = 1`, khiến `BuildingBaseView.initActiveCustomer()` chỉ cho phép khách xuất hiện nếu tồn tại trong `CustomerMgr` (gói `4601`). Ở bản v2, gói `4601` trả danh sách rỗng `customerList: []` làm `activeCustomerIdList = []`, gây lỗi `doAddActorCustomer()` và không spawn bất kỳ NPC nào.
   - **Đã sửa:** Mở khóa sẵn toàn bộ 57 khách hàng (`108001`–`108057`, `status = 2`) trong gói đồng bộ đăng nhập `4601` (`CustomerListMsg`), bổ sung xử lý đầy đủ `S_CUSTOMER_UNLOCK (24603 → 4603)`, `S_CUSTOMER_UNLOCK_REWARD (24604 → 4604)` và đồng bộ `S_CUSTOMER_DATA_SYNC (4602)`.
   - **Kiểm chứng trên giả lập:** NPC khách hàng đi tới quầy gọi món Quẩy (`30đ/phần`), chảo tự chiên & phục vụ, tiền tăng đều và tiến độ Nhiệm vụ #2 (`Tích lũy bán 3 phần đồ ăn sáng`) tăng mượt (`0/3 → 1/3 → 2/3 → 3/3`).

3. **Sửa triệt để lỗi bấm nút Quay lại (`←` / `btnClose`) bị đứng màn hình:**
   - **Nguyên nhân gốc (phát hiện trực tiếp qua `logcat` giả lập):** Khi đóng Quán Đồ Ăn Sáng, `UIMgr.removeFromLayer()` gọi `showUnderView()` **trước** `viewContainer.removeFromParent()`. Lúc bật lại thanh công cụ `GameToolBarView.onShow()`, hàm `GuideBookUtil.canGetGuideBookReward()` đọc `o.state` của 41 nhiệm vụ Sổ Tay (`GuideBookDB`: `2300001`–`2300041`) vốn chưa có trong gói `1201`, làm văng `TypeError: Cannot read property 'state' of undefined`, chặn lệnh gỡ màn hình Quán Đồ Ăn Sáng trong khi toàn bộ sự kiện chạm đã bị xóa → đứng cứng màn hình.
   - **Đã sửa:**
     - Đồng bộ sẵn toàn bộ 41 nhiệm vụ Sổ Tay (`2300001`–`2300041`) trong gói `1201` và vá null-guard cho `GuideBookUtil.canGetGuideBookReward`.
     - Vá an toàn `UIMgr.removeFromLayer()` & `showUnderView()` và `BuildingBaseView.leaveBuilding()` / `saveCommonCustomerDataList()` đảm bảo gỡ màn hình sạch sẽ, khôi phục `GRoot.inst.touchable = true` và không bao giờ đứng màn hình.
   - **Kiểm chứng trên giả lập:** Bấm `←` thoát Quán Đồ Ăn Sáng trở về Sảnh Chính (`VillageMainView`) mượt mà, bản đồ & toàn bộ thanh điều hướng phản hồi bình thường, có thể vào lại Quán Đồ Ăn Sáng rồi thoát ra nhiều lần liên tiếp không đứng máy.

4. **Tối ưu thêm từ log giả lập:**
   - Đồng bộ đầy đủ `workshopConfig` (`WorkshopConfigData`) trong `SyncWorkshopInfoMsg (5601)` loại bỏ lỗi `TypeError: Cannot read property 'id' of null` ở `WorkshopMgr.updateWorkshopData`.
   - Chuyển phản hồi `OfflineWebSocket` và `OfflineXMLHttpRequest` sang microtask (`Promise.resolve().then(...)`) để phản hồi `<1ms`, loại bỏ lỗi quá hạn `syncSeqSendMsg net fail` trên máy cấu hình thấp.

## Hướng dẫn cài đặt
- **File:** `GocChoXua-3.7.1-offline-fix3.apk` (`~1.1 GB`, `arm64-v8a`, đã `zipalign -p 4`, ký v1+v2+v3)
- **Lưu ý quan trọng:** **Gỡ cài đặt bản cũ (`v1`/`v2`) trước** khi cài bản `fix3` này.
- **Tài khoản mặc định:** `tiemtaphoa01` ở server `S1 - Góc Chợ Xưa Offline`.
- **Giftcode offline (Cài đặt → Đổi quà):** `OFFLINE`, `RICH`, `VIP999`, `ALLHERO`.
