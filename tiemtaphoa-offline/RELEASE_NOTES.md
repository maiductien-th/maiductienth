## Bản Hoàn Thiện — Fix v4 (`tiemtaphoa-offline-v4`): Sửa Triệt Để Toàn Bộ 13 Lỗi + Chế Độ Max Tester Lv60 VIP 15 & Vô Hạn Thẻ Giảm Giá

### 1. Chế độ 2 Server Offline (Mặc định Max Tester Lv60 + Server Tân Thủ)
- **`S1 - Max Tester Lv60 (VIP15 Full)` (Mặc định):** Vào thẳng Sảnh Chính với **Cấp 60**, **VIP 15**, **mở khóa toàn bộ tính năng (356 hệ thống + 52 công trình Lv50)**, **Full toàn bộ Nhân Tài**, **Full toàn bộ Nghệ Sĩ**, **Full toàn bộ Xe Cộ**, **Full toàn bộ Skin Nhân Tài / Nghệ Sĩ / Nhân Vật Chính**, **Full Avatar / Khung / Hình Tượng**, **Full tài nguyên & vật phẩm**.
- **Vô hạn Thẻ Giảm Giá / Xu Thời Gian (`101011`) & Voucher:** Bật cơ chế thanh toán bằng Thẻ Giảm Giá / Voucher cho **tất cả các gói nạp** trong game (`GameConfig.isForceSimulateRecharge = true`, `24104 S_SHOP_BUY_RECHARGE_ITEM` + `/recharge_order` & `/recharge`), số lượng thẻ giảm giá luôn vô hạn và tự nạp lại sau mỗi lần mua.
- **`S2 - Góc Chợ Xưa Offline (Tân Thủ)`:** Chơi từ đầu với toàn bộ 13 lỗi đã được sửa (có thể nhập mã `MAX60`, `TESTER`, `RICH`, `ALLHERO` trong Cài đặt → Đổi quà bất cứ lúc nào).

### 2. Danh sách 13 lỗi đã được sửa triệt để
1. **Lỗi 1 — Thông tin cá nhân → Tăng cấp nhân vật (3 khung trống + treo màn hình):** Sửa ID trang sức mặc định hợp lệ trong `LeadDecorateDB` (`106100` / `106000` thay vì `10001` / `100100`), trả thưởng đầy đủ `IdentityDB` ở `20108`/`20109`.
2. **Lỗi 2 & 5.3 — Menu trái `"Gói"` đơ màn hình & treo màn hình khi nhảy giữa các tính năng:** Vá chống treo toàn cục cho `UIMgr.open()` (không bao giờ kẹt `_isOpening` hay `GRoot.inst.touchable = false`, tự chuyển hướng `CashPackHelperView` sang `ShopMainView` có sẵn trong APK).
3. **Lỗi 3 & 6 — Ải (Xưởng) bị `1/1`, `+0/giây`, `"Ải mới — Vui lòng đón chờ!"` & Bản đồ chỉ hiện 1 ải + avatar trống:** Nâng `maxWorkshopId = 500`, tạo đủ 10 bước/ải (`WorkshopConfigData`), xử lý đầy đủ `25602`, `25606` (đánh Boss qua ải mới), `25607`/`25608` (Treo máy), `25617`/`25618` (Cấu hình ải).
4. **Lỗi 4 & 8 — Nhân tài năng lực = 0, Thiên phú = 0, Lệ Bình chồng UI, không trang bị Xe Cộ, nhận nhân tài không tăng thu nhập, lỗi hiển thị hình ảnh Nhân Tài/Nghệ Sĩ/Skin:**
   - Gửi đầy đủ gói `510` (`SyncHeroAbilityListMsg`) khi đăng nhập và sau mỗi lần nâng cấp/trang bị để hiển thị đúng Năng lực & Thiên phú.
   - Xử lý đầy đủ `20506` (`S_HERO_EQUIP_CAR` — trang bị & tháo Xe Cộ) và tự động mở khóa Nhân Tài / Nghệ Sĩ / Xe / Skin khi nhận từ phần thưởng + tính lại thu nhập (`106`).
   - Vá `FguiSpine` & `SpineUtil` tự động tải ảnh chân dung chất lượng cao có sẵn trong APK (`common/hero/<id>/1`, `common/beauty/<id>/1`, `common/skin/<id>/1`, `common/player/<id>/1`) hoặc Spine cục bộ (`heroact`/`beautyact`) khi Spine từ xa không có trong APK.
5. **Lỗi 5 — Tuyên Truyền (Trường Quay, Trung Tâm Quảng Cáo, Quảng Cáo Nghệ Sĩ):**
   - Xử lý đầy đủ Trường Quay (`24701`–`24730`) với 5 phim trường có nghệ sĩ.
   - Xử lý đầy đủ Trung Tâm Quảng Cáo (`26651`–`26656` + gói đẩy `6653`).
   - Sửa Quảng Cáo Nghệ Sĩ (`24308`): gửi đúng trường `addExp`/`addMoney`/`isCrit`, trừ đúng thể lực `4307` và cộng thưởng thực tế.
6. **Lỗi 7 — Thông tin cá nhân (Đổi nhân vật chính, Avatar, Hình tượng):** Đồng bộ đầy đủ `801` (`DecorationListMsg`), `7024`/`7026` (`SkinInfo`), xử lý `20177` (Đổi nhân vật chính), `20803`/`20804` (Đổi Avatar/Khung/Hình tượng), `27021` (Mặc Skin), mở khóa toàn bộ nhân vật trong `ResetRoleMainView`.
7. **Lỗi 9 — Quà May Mắn & Mục tiêu nghệ sĩ:** Đồng bộ gói đăng nhập bắt buộc `2005` (`TurntableLottery`) và `1001053` (`NewbieTarget`), xử lý quay thưởng `22004` và nhận thưởng `2001051`/`2001052`.
8. **Lỗi 10 — Sảnh chính (Thị Trấn):**
   - **Xe Cộ:** Đính kèm đầy đủ `skinId: 0` trên mọi `CarTempMsg` (sửa lỗi `0 != null` gây crash `renderListItem` khiến hiển thị `"Trống"` dù có xe).
   - **Nhà:** Đồng bộ `4002` đầy đủ nhà & phòng đã mở khóa + xử lý `24001`–`24013`.
   - **Vũ Trường (`26501`–`26504`)** & **Rạp Phim (`27291`–`27296`):** Mở khóa, xây dựng và nâng cấp bình thường, không treo màn hình.
   - **Quầy Cá (`7100`, `27101`–`27112`):** Mở khóa **Chế biến** (`27109`) và **Nhập hàng** (`27112`) hoàn chỉnh.
   - **Quà Hướng Dẫn & 3 nút góc dưới phải:** Mở khóa & cho phép nhận thưởng Sổ Tay (`2300001`–`2300041`), Điểm Danh (`24852`/`24853`), Nhiệm Vụ Ngày/Thành Tựu (`21205`/`21206`/`21208`), và Bảng Xếp Hạng (`24501`–`24504`).
9. **Lỗi 11 — Huyện Thành:**
   - **Tiệm (`24101`/`24102`):** Đọc đúng vật phẩm từ `ShopDB[id].reward` (sửa triệt để lỗi mua gì cũng thành Sách Làm Giàu).
   - **Ai Là Tỷ Phú (`24021`–`24030`)** & **Thương Chiến (`24901`–`24918`):** Tạo đối thủ NPC offline để khiêu chiến, chiến đấu và nhận thưởng bình thường.
   - **Đào Tạo (`22300`–`22304`):** Mở khóa ghế, ngồi học và hoàn thành nhận EXP.
10. **Lỗi 12 — Sự Kiện, Đặc Quyền Vĩnh Viễn & Quà VIP:**
    - Mở khóa đầy đủ thanh sự kiện, chuyển hướng Đặc Quyền Vĩnh Viễn (`StartPrivilegeCmnUtil`) sang bảng `PrivilegeMainView` có sẵn trong APK (không đơ máy).
    - Sửa Quà VIP (`5901`/`25902`): đọc đúng phần thưởng từ `VipDB`, trao vật phẩm/nhân tài/xe thật vào túi và lưu bền vững trạng thái đã nhận khi thoát ra vào lại.
11. **Lỗi 13 — Âm thanh (Nhạc nền BGM & âm thanh bấm SFX):** Ánh xạ `AudioMgr.load` sang toàn bộ file MP3 nhạc nền & hiệu ứng bấm có sẵn trong APK (`activity/29_1/sound/bgm/Cmn`, `activity/1011_1/sound/sfx/LuckydrawClick`, `GongfuBuy`, `DiggoldMoney`, `LuckydrawReach`).

## Hướng dẫn cài đặt
- **File:** `GocChoXua-3.7.1-offline-fix4.apk` (`~1.1 GB`, `arm64-v8a`, đã `zipalign -p 4`, ký v1+v2+v3)
- **Lưu ý:** Gỡ bản cũ trước khi cài bản `fix4` này để nhận cấu hình 2 server sạch (`S1 Max Tester Lv60` & `S2 Tân Thủ`).
