/**
 * Read to Earn Module - Đọc Báo Nhận Điểm Chuẩn App Microsoft Start / Bing
 * Tích hợp phương thức gọi API chính thức của Mobile App (30 điểm/ngày)
 * Tự động quản lý OAuth 2.0 Token (Access Token & Refresh Token)
 * Cam kết chạy trọn vẹn số bài, không tự ngắt sớm giữa chừng.
 */

import { humanDelay, sleep } from "./delay.js";

const CLIENT_ID = "0000000040170455";
const AUTH_URL = "https://login.live.com/oauth20_authorize.srf";
const REDIRECT_URL = "https://login.live.com/oauth20_desktop.srf";
const TOKEN_URL = "https://login.live.com/oauth20_token.srf";
const ACTIVITIES_URL = "https://prod.rewardsplatform.microsoft.com/dapi/me/activities";
const USER_INFO_URL = "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=bing&options=613";
const BING_APP_UA = "Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2";
export const BING_IOS_APP_UA = BING_APP_UA;

/**
 * Sinh chuỗi hex ngẫu nhiên
 */
export const generateRandomHex = (length = 64) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Đổi Refresh Token lấy Access Token mới không cần mở tab
 */
export const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) return null;
  try {
    const bodyParams = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "service::prod.rewardsplatform.microsoft.com::MBI_SSL"
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams.toString()
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.access_token) {
      if (data.refresh_token) {
        chrome.storage.local.set({ ms_rewards_refresh_token: data.refresh_token });
      }
      return data.access_token;
    }
    return null;
  } catch (e) {
    return null;
  }
};

/**
 * Lấy Access Token Mobile App thông qua phiên đăng nhập Microsoft sẵn có trên trình duyệt
 */
export const getMobileAccessToken = async (addLog) => {
  // 1. Thử dùng Refresh Token đã lưu trước đó để làm mới trong tích tắc (hoàn toàn ngầm)
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["ms_rewards_refresh_token"], resolve);
  });

  if (stored && stored.ms_rewards_refresh_token) {
    if (addLog) addLog("🔄 Đang làm mới Access Token từ phiên đã lưu...");
    const refreshedToken = await refreshAccessToken(stored.ms_rewards_refresh_token);
    if (refreshedToken) {
      if (addLog) addLog("🔑 Đã kết nối phiên Microsoft Rewards thành công!");
      return refreshedToken;
    }
    if (addLog) addLog("ℹ️ Token cũ đã hết hạn, đang tạo phiên kết nối mới...");
  }

  // 2. Mở tab xác thực kết nối với Microsoft
  if (addLog) addLog("📱 Đang kết nối ủy quyền tài khoản Microsoft Rewards Mobile...");
  return new Promise((resolve) => {
    let authTabId = null;
    let isResolved = false;
    let autoConsent = null;

    const cleanupAuthListeners = () => {
      chrome.tabs.onUpdated.removeListener(navListener);
      if (autoConsent) {
        chrome.tabs.onUpdated.removeListener(autoConsent);
        autoConsent = null;
      }
    };

    const timeout = setTimeout(async () => {
      if (!isResolved) {
        isResolved = true;
        cleanupAuthListeners();
        if (authTabId) {
          try { await chrome.tabs.remove(authTabId); } catch (e) {}
        }
        if (addLog) addLog("⚠️ Quá thời gian xác thực OAuth (25s). Vui lòng đảm bảo bạn đã đăng nhập Microsoft trên Edge.");
        resolve(null);
      }
    }, 25000);

    const navListener = async (tabId, changeInfo, tab) => {
      if (tabId !== authTabId) return;

      const url = changeInfo.url || tab.url;
      if (url && (url.includes("oauth20_desktop.srf?code=") || url.includes("oauth20_desktop.srf#code="))) {
        isResolved = true;
        clearTimeout(timeout);
        cleanupAuthListeners();

        // Đóng ngay tab xác thực để không làm phiền người dùng
        try {
          await chrome.tabs.remove(authTabId);
        } catch (e) {}

        const parsedUrl = new URL(url);
        const code = parsedUrl.searchParams.get("code") || new URLSearchParams(parsedUrl.hash.substring(1)).get("code");
        if (!code) {
          resolve(null);
          return;
        }

        if (addLog) addLog("🔐 Đã nhận mã ủy quyền, đang tạo Access Token...");

        // Đổi authorization code lấy token tại https://login.live.com/oauth20_token.srf
        try {
          const bodyParams = new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: "authorization_code",
            code: code,
            redirect_uri: REDIRECT_URL,
            scope: "service::prod.rewardsplatform.microsoft.com::MBI_SSL"
          });

          const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: bodyParams.toString()
          });

          if (!res.ok) {
            const errText = await res.text();
            console.error("[ReadToEarn] Lỗi đổi token:", errText);
            resolve(null);
            return;
          }

          const data = await res.json();
          if (data && data.access_token) {
            if (data.refresh_token) {
              chrome.storage.local.set({ ms_rewards_refresh_token: data.refresh_token });
            }
            resolve(data.access_token);
          } else {
            resolve(null);
          }
        } catch (err) {
          console.error("[ReadToEarn] Lỗi đổi token:", err);
          resolve(null);
        }
      }
    };

    chrome.tabs.onUpdated.addListener(navListener);

    const authorizeUrl = new URL(AUTH_URL);
    authorizeUrl.searchParams.append("response_type", "code");
    authorizeUrl.searchParams.append("client_id", CLIENT_ID);
    authorizeUrl.searchParams.append("redirect_uri", REDIRECT_URL);
    authorizeUrl.searchParams.append("scope", "service::prod.rewardsplatform.microsoft.com::MBI_SSL");
    authorizeUrl.searchParams.append("state", generateRandomHex(16));

    // Mở tab thật (active: true) để gửi cookie đăng nhập sẵn có của Edge
    chrome.tabs.create({ url: authorizeUrl.href, active: true }).then((tab) => {
      authTabId = tab.id;
      // Tự động nhấn "Đồng ý" (Yes/Accept) nếu Microsoft hỏi cấp quyền
      autoConsent = (uTabId, uChangeInfo) => {
        if (uTabId === authTabId && uChangeInfo.status === "complete") {
          chrome.scripting.executeScript({
            target: { tabId: authTabId },
            func: () => {
              const acceptBtn = document.querySelector("#idBtn_Accept") || 
                                document.querySelector("input[value='Yes']") ||
                                document.querySelector("input[value='Có']") ||
                                document.querySelector("button[type='submit']");
              if (acceptBtn) acceptBtn.click();
            }
          }).catch(() => {});
        }
      };
      chrome.tabs.onUpdated.addListener(autoConsent);
    }).catch(() => {
      clearTimeout(timeout);
      cleanupAuthListeners();
      resolve(null);
    });
  });
};

/**
 * Đọc báo nhận điểm qua API chính thức của Microsoft Start / Bing App
 * Chạy trọn vẹn toàn bộ số bài yêu cầu (KHÔNG ngắt sớm)
 */
export const executeApiReadToEarn = async (accessToken, options) => {
  const { isRunningCheck, addLog, onProgress, targetCount = 10, minDelay = 5, maxDelay = 8 } = options;

  let currentBalance = 0;
  let countryCode = "vn";
  let offerId = "ENUS_readarticle3_30points";

  try {
    const meRes = await fetch(USER_INFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": BING_APP_UA,
        "X-Rewards-Country": countryCode,
        "X-Rewards-Language": "vi"
      }
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      currentBalance = meData?.response?.balance || 0;
      if (meData?.response?.attributes?.country) {
        countryCode = meData.response.attributes.country.toLowerCase();
      }
      // Tự động phát hiện offerid phù hợp nếu có trong danh sách
      const promotions = meData?.response?.promotions || [];
      const readPromo = promotions.find(p => p.attributes?.offerid && p.attributes.offerid.includes("readarticle"));
      if (readPromo && readPromo.attributes?.offerid) {
        offerId = readPromo.attributes.offerid;
      }
      addLog(`👤 Số dư tài khoản: ${currentBalance} điểm khả dụng (Khu vực: ${countryCode.toUpperCase()})`);
    }
  } catch (e) {
    console.warn("Lỗi kiểm tra profile điểm:", e);
  }

  let totalGained = 0;
  let articlesClaimed = 0;

  for (let i = 1; i <= targetCount; i++) {
    if (!isRunningCheck()) break;

    const payload = {
      amount: 1,
      country: countryCode,
      id: generateRandomHex(64),
      type: 101,
      attributes: {
        offerid: offerId
      }
    };

    addLog(`📖 [Read to Earn ${i}/${targetCount}] Gửi yêu cầu nhận điểm bài báo #${i}...`);

    try {
      const claimRes = await fetch(ACTIVITIES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": BING_APP_UA,
          "Content-Type": "application/json",
          "X-Rewards-Country": countryCode,
          "X-Rewards-Language": "vi",
          "X-Rewards-ismobile": "true"
        },
        body: JSON.stringify(payload)
      });

      if (claimRes.ok) {
        const claimData = await claimRes.json();
        const newBalance = claimData?.response?.balance;

        if (newBalance && newBalance > currentBalance) {
          const gained = newBalance - currentBalance;
          totalGained += gained;
          currentBalance = newBalance;
          articlesClaimed++;
          addLog(`🎉 [Bài ${i}/${targetCount}] CỘNG THÀNH CÔNG +${gained} ĐIỂM! Số dư mới: ${newBalance} pts`);
        } else {
          articlesClaimed++;
          addLog(`✅ [Bài ${i}/${targetCount}] Đã gửi thành công yêu cầu nhận điểm.`);
        }
      } else {
        const errText = await claimRes.text();
        addLog(`⚠️ [Bài ${i}/${targetCount}] Phản hồi API: HTTP ${claimRes.status}`);
        console.warn("Claim error:", errText);
      }
    } catch (err) {
      addLog(`❌ [Bài ${i}/${targetCount}] Lỗi gửi yêu cầu: ${err.message}`);
    }

    if (onProgress) onProgress(i, targetCount);

    if (i < targetCount && isRunningCheck()) {
      const delayUsed = await humanDelay(minDelay, maxDelay);
      addLog(`⏱️ Đã nghỉ ${(delayUsed / 1000).toFixed(1)}s an toàn.`);
    }
  }

  addLog(`✅ Hoàn thành phiên Read to Earn (${targetCount} bài)! Tổng điểm đã cộng: +${totalGained} điểm.`);
  return { success: true, pointsGained: totalGained };
};

/**
 * Hàm điều phối chính cho Read to Earn
 */
export const executeReadToEarn = async (options) => {
  const { addLog } = options;
  addLog("📱 Đang khởi động tiến trình đọc báo nhận thưởng Microsoft Rewards...");

  const token = await getMobileAccessToken(addLog);
  if (token) {
    return await executeApiReadToEarn(token, options);
  } else {
    addLog("❌ Không thể lấy mã xác thực Mobile App. Vui lòng đảm bảo bạn đã đăng nhập tài khoản Microsoft trên Edge!");
    return { success: false, error: "AUTH_FAILED" };
  }
};
