# ViSUBLY Grabber (tiện ích Chrome)

Tự động phát hiện video HLS (.m3u8), DASH (.mpd) và MP4 trên trang web, rồi gửi sang ứng dụng ViSUBLY đang chạy trên máy tính (qua `127.0.0.1`) để tải. Không cần mở DevTools hay "Copy as cURL" nữa.

## Cài đặt (Chrome)

1. Mở `chrome://extensions`.
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode) ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked).
4. Chọn thư mục `browser-extension/chrome` của dự án.
5. (Tùy chọn) Ghim biểu tượng ViSUBLY Grabber lên thanh công cụ.

## Ghép nối với ViSUBLY (làm một lần)

1. Mở ứng dụng ViSUBLY trên máy tính.
2. Vào **Cài đặt › Kết nối trình duyệt** và bấm tạo mã. Mã gồm 6 số, dùng một lần, hết hạn sau 5 phút.
3. Bấm biểu tượng tiện ích, nhập mã vào ô và bấm **Ghép nối**.
4. Chấm trạng thái chuyển sang xanh lá là xong. Muốn gỡ, bấm **Hủy ghép nối** ở chân popup (hoặc thu hồi tất cả trong ViSUBLY).

## Sử dụng

- Mở trang có video và bấm phát. Số trên biểu tượng tiện ích là số luồng video đã phát hiện ở tab hiện tại.
- Bấm biểu tượng, chọn luồng rồi bấm **Tải bằng ViSUBLY**.
- Hoặc rê chuột vào video: nút nổi **⬇ Tải bằng ViSUBLY** xuất hiện ở góc trên bên phải video, bấm để gửi luồng tốt nhất của tab.

## Xử lý sự cố

- **"Mở ViSUBLY trên máy tính trước"**: ViSUBLY chưa chạy, hoặc firewall chặn cổng 47653–47656 trên localhost.
- **"Chưa ghép nối"**: lấy mã mới trong ViSUBLY và ghép nối lại (mã cũ có thể đã hết hạn hoặc bị thu hồi).
- **Nhập sai mã 5 lần**: bị khóa 1 phút, đợi rồi thử lại.
- **Không thấy video nào**: hãy bấm phát video trước; tải lại trang nếu video đã chạy từ trước khi cài tiện ích.
- **Tải thất bại trong ViSUBLY**: link có thể gắn với cookie/phiên đăng nhập đã hết hạn, hãy phát lại video rồi gửi lại. Video có DRM (EME) không được hỗ trợ.
- Sau khi sửa mã tiện ích, vào `chrome://extensions` và bấm nút tải lại của tiện ích.

## Dành cho nhà phát triển

- `chrome/` là tiện ích Manifest V3 (service worker `background.js`, popup, content script).
- `tools/make-icons.js` sinh biểu tượng tạm: `node browser-extension/tools/make-icons.js`.
- Phía ứng dụng: `src/main/capture-bridge.js`, kiểm thử bằng `node scripts/test-capture-bridge.js`.
