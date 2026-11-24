# Microsoft Rewards Master (`v2.5.0`)

Tiện ích mở rộng **Manifest V3** dành cho **Microsoft Edge** giúp tự động hóa toàn diện các nhiệm vụ Microsoft Rewards hàng ngày theo kiến trúc **API-First / Zero-Window**, kiểm soát từng mô-đun độc lập và bảo vệ tab làm việc chính của bạn.

- **Phiên bản:** `2.5.0` (Manifest V3)
- **Trình duyệt hỗ trợ:** Microsoft Edge (Chromium)
- **Thư mục mã nguồn extension:** [`ms-rewards-extension/`](./ms-rewards-extension)

---

## ✨ Tính Năng Chính (7 Mô-đun Độc Lập)

| Mô-đun | Cơ chế nổi bật trong v2.5.0 |
| --- | --- |
| 📅 **Điểm danh App Bing** | Hỗ trợ `SAIOS` / `SAAndroid`, tự động đồng bộ HTTP `Date` chuẩn từ máy chủ Microsoft. |
| 🎯 **Quest Hàng Ngày (Daily Set / Quiz / Poll)** | Thực thi API-First qua `/earn` Next.js RSC Server Actions $\rightarrow$ Flyout V1 $\rightarrow$ bấm đồng bộ thẻ `#dailyset` & Quiz Solver. |
| 📷 **Visual Search Streak** | Tải ảnh Bing thật, upload xuyên **Shadow DOM**, xác thực chéo trạng thái `1/1`. |
| 💻 **Tìm kiếm Web PC** | Khử trùng lặp `offerId` (`90/90 pts`), tự bỏ qua khi đã đạt tối đa, hỗ trợ hẹn bù Cooldown. |
| 📱 **Tìm kiếm App / Mobile** | **Stage 0 Silent Direct Mobile API (Zero-Window, `IsMobileClient=true`)** + 3 tầng Tab dự phòng (`CDP Android Chrome` $\rightarrow$ `CDP iPhone Safari Zero-CH` $\rightarrow$ `Pure DNR Tab`), checkpoint mỗi **4 lượt** vượt quy tắc *"Earning starts with your third search"* đạt đủ `60/60 pts`, loại bỏ treo debugger 32s. |
| 📰 **Đọc báo MSN News** | Read to Earn qua OAuth API ổn định (`30/30 pts`). |
| ☕ **Treo máy 30p duyệt Edge** | Zero-Window Edge Browsing API (`skipBingWarmup`), chạy ngầm ổn định kể cả khi thu nhỏ/ẩn màn hình. |

---

## 📦 Cài Đặt Vào Microsoft Edge

### Cách 1: Tải bản Release ZIP (Khuyên dùng)
1. Tải tệp **`Microsoft-Rewards-Master-v2.5.0.zip`** tại mục [Releases](https://github.com/khongphaifu/ms-rewards-master/releases).
2. Giải nén vào một thư mục cố định trên máy (ví dụ `C:\Extensions\ms-rewards-master`).
3. Mở Microsoft Edge $\rightarrow$ vào `edge://extensions/` $\rightarrow$ bật **Developer mode**.
4. Bấm **Load unpacked** và chọn thư mục vừa giải nén.

### Cách 2: Clone từ Git
```bash
git clone https://github.com/khongphaifu/ms-rewards-master.git
```
Sau đó mở `edge://extensions/` $\rightarrow$ bật **Developer mode** $\rightarrow$ bấm **Load unpacked** và trỏ tới thư mục `ms-rewards-extension`.

---

## 📁 Cấu Trúc Repository

```text
ms-rewards-extension/
├── manifest.json          # Cấu hình Manifest V3 (v2.5.0)
├── background.js          # Service Worker điều phối các mô-đun & Stage 0 Mobile API
├── popup/                 # Giao diện điều khiển Popup & nhật ký trạng thái
├── content/               # Content scripts (quiz-solver, search-automator, news-reader, stay-alive)
├── utils/                 # API & parser (mobile-cdp, rsc-parser, rewards-api, quests-automator, ...)
├── icons/                 # Biểu tượng extension (16/48/128)
└── auto-start/            # Script tùy chọn khởi chạy Edge cùng Windows
```

### (Tùy chọn) Tự động mở Edge khi khởi động Windows
Mở PowerShell tại thư mục gốc repository và chạy:
```powershell
powershell -ExecutionPolicy Bypass -File .\ms-rewards-extension\auto-start\setup-startup.ps1
```
Để gỡ khỏi Startup:
```powershell
powershell -ExecutionPolicy Bypass -File .\ms-rewards-extension\auto-start\setup-startup.ps1 -Uninstall
```
