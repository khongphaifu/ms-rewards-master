/**
 * Tiện ích hỗ trợ tạo khoảng dừng ngẫu nhiên mô phỏng hành vi người dùng thật
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randomDelay = (minMs, maxMs) => {
  const duration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(duration);
};

export const humanDelay = async (minSeconds = 3, maxSeconds = 5) => {
  const minMs = minSeconds * 1000;
  const maxMs = Math.max(minMs, maxSeconds * 1000);
  // Thêm một chút jitter ngẫu nhiên
  const jitter = Math.floor(Math.random() * 400) - 200;
  const targetMs = Math.max(1500, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs + jitter);
  await sleep(targetMs);
  return targetMs;
};
