/**
 * Content Script hỗ trợ nhiệm vụ "Read to Earn" (Đọc tin tức nhận điểm):
 * Mô phỏng hành vi đọc bài báo tự nhiên trên MSN News / Microsoft Start:
 * 1. Cuộn trang mượt mà qua các đoạn văn.
 * 2. Giữ phiên đọc 8 - 12 giây để kích hoạt beacon ghi nhận điểm của Microsoft.
 * 3. Báo cáo hoàn tất về Background Service Worker.
 */

(() => {
  console.log("[MS-Rewards-Master] News Reader Content Script đã kích hoạt.");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const simulateReadingArticle = async () => {
    // Đợi bài báo render nội dung
    await sleep(2000);

    // Chuỗi hành động đọc bài báo tự nhiên
    const scrollSteps = [
      { down: 350, wait: 2000 },
      { down: 450, wait: 2500 },
      { down: 400, wait: 2000 },
      { down: -150, wait: 1500 } // cuộn ngược nhẹ như người đọc xem lại
    ];

    for (const step of scrollSteps) {
      window.scrollBy({ top: step.down, behavior: "smooth" });
      await sleep(step.wait);
    }

    console.log("[MS-Rewards-Master] Đã hoàn thành thời gian đọc bài báo này!");
    chrome.runtime.sendMessage({ action: "ARTICLE_READ_DONE" }).catch(() => {});
  };

  simulateReadingArticle().catch(err => {
    console.error("[MS-Rewards-Master] Lỗi khi đọc bài báo:", err);
    chrome.runtime.sendMessage({ action: "ARTICLE_READ_DONE", error: err.message }).catch(() => {});
  });
})();
