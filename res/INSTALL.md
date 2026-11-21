# Cài đặt Swordash mod

## Yêu cầu
- Android 8.0+ (API 26+), arm64 hoặc armv7.
- Bật "Cài từ nguồn không xác định".

## Quan trọng
APK này ký bằng key khác bản trên CH Play. **Phải gỡ bản gốc trước khi cài**, nếu không sẽ báo `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
Gỡ bản gốc sẽ mất dữ liệu local (tiến trình, save). Nếu game có liên kết tài khoản thì liên kết trước.

## Các bước
1. Tải `FINAL-signed.apk` trong Release/PR.
2. Cài đặt → Gỡ "Swordash" bản gốc.
3. Mở file APK → Cài.
4. Mở game. Lần đầu nếu trắng màn hình: đóng hẳn app rồi mở lại (gadget cần 1 lần khởi tạo).
5. Nếu cần kiểm tra hook đã chạy:
   ```
   adb logcat -s frida
   ```
   Kỳ vọng thấy dòng `[sw] hooks loaded`.

## Gỡ lỗi
| Triệu chứng | Nguyên nhân |
|---|---|
| Cài báo `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Chưa gỡ bản gốc |
| App crash ngay khi mở | `hooks.ts` sai class → sửa, build lại, ký lại |
| Vào được nhưng vẫn màn login | Hook Phase 3 sai tên method, xem log `FAIL ...` trong logcat |
| Vẫn cần mạng | Phase 5 chưa xong |
| Treo ở splash | `libgadget.js` thiếu `Il2Cpp.perform`, hoặc gadget sai thư mục `lib/<abi>/` |

## Log
```
adb logcat -s frida | grep '\[sw\]'
```
