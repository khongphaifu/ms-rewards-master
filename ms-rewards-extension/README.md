# Microsoft Rewards Master (v2.5.0)

Tiện ích mở rộng **Manifest V3** cho trình duyệt **Microsoft Edge**, tự động hóa đầy đủ các tác vụ Microsoft Rewards với kiến trúc **Zero-Window API-First**, chạy ổn định ngầm và cho phép tùy chọn bật/tắt độc lập từng mô-đun trong Popup.

## ✨ 7 Mô-đun Độc Lập

- 📅 **Điểm danh App Bing (`SAIOS` / `SAAndroid` + Server Date):** Tự động đọc HTTP header `Date` chuẩn từ máy chủ Microsoft để vượt sai lệch giờ hệ thống, kiểm tra trạng thái promotion (`complete` / `progress`) và cộng điểm chính xác.
- 🎯 **Làm Quest Hàng Ngày (Daily Set, Quiz, Poll):** Thực thi theo chuỗi `/earn` Next.js RSC Server Actions $\rightarrow$ Bing Flyout V1 (`/msrewards/api/v1/reportactivity`) $\rightarrow$ tự động bấm đồng bộ trực tiếp các thẻ `#dailyset` và giải Quiz/Poll trên DOM thật.
- 📷 **Visual Search Streak (Tìm kiếm hình ảnh):** Tải ảnh thực tế từ Bing, tải lên xuyên **Shadow DOM** qua `DataTransfer`, xác thực chéo trên Dashboard/Flyout API và tự dự phòng qua Mobile CDP khi cần.
- 💻 **Tìm kiếm Web PC (`90/90 pts`):** Tự động khử trùng lặp `offerId` để hiển thị chuẩn hạn mức điểm ngày, dừng ngay lập tức khi đã đạt tối đa và tự hẹn giờ bù Cooldown nếu bị giới hạn tốc độ.
- 📱 **Tìm kiếm App / Mobile (`v2.5.0` — `60/60 pts`):**
  - **Stage 0 — Silent Direct Mobile API (Zero-Window):** Gửi tìm kiếm và beacon `/rewardsapp/reportActivity` trực tiếp từ Service Worker kèm quy tắc `declarativeNetRequest` (`tabIds: [-1]`), xác thực `IsMobileClient === true` mà **không mở cửa sổ hay gắn debugger**.
  - **3 tầng Tab dự phòng tự động:** Nếu Stage 0 chưa hợp lệ, tự động xoay vòng qua `Stage 1` (CDP Android Chrome) $\rightarrow$ `Stage 2` (CDP iPhone Safari Zero Client Hints) $\rightarrow$ `Stage 3` (Pure DNR Normal Tab, không debugger).
  - **Chống treo & vượt mốc warm-up:** Theo dõi các tab gắn debugger qua `attachedTabIds` kèm timeout cứng để loại bỏ treo 32 giây; nâng checkpoint lên mỗi **4 lượt** (mặc định `25` lượt) để vượt qua cơ chế *"Earning starts with your third search"*.
- 📰 **Đọc báo MSN News (Read to Earn):** Tương tác qua OAuth API ổn định (`30/30 pts`).
- ☕ **Treo máy 30p duyệt Edge (Zero-Window API):** Sử dụng API duyệt Edge ngầm (`skipBingWarmup`) giúp duy trì đếm đủ 30 phút ổn định ngay cả khi bạn thu nhỏ trình duyệt hoặc làm việc ở cửa sổ khác.

---

## 🚀 Hướng Dẫn Cài Đặt / Tải Lại Trên Microsoft Edge

1. Mở Microsoft Edge $\rightarrow$ truy cập `edge://extensions/`.
2. Bật **Developer mode** (Chế độ nhà phát triển).
3. Nếu cài mới: bấm **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục `ms-rewards-extension`.
4. Nếu cập nhật bản mới: bấm nút **Reload (↻)** tại thẻ **Microsoft Rewards Master - Tùy Chọn Tác Vụ** (phiên bản hiển thị **2.5.0**).
