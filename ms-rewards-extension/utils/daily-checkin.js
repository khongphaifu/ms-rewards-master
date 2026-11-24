/**
 * Daily Check-in Module (v2.1.0) - Điểm Danh Chuẩn App Bing (Late-2026 SAIOS Protocol)
 * - Kênh chính SAIOS với đầy đủ headers bắt buộc:
 *   X-Rewards-AppId: SAIOS/33.4.440603001, X-Rewards-PartnerId: startapp, X-Rewards-Flights: rwgobig.
 * - Xác minh hoàn thành đa tiêu chí (chính xác cả Ngày 1-6 lẫn Ngày 7 khi complete giữ "False"):
 *   complete, pointprogress delta, progress delta, last_updated delta, balanceDelta >= 5, /earn RSC streak.
 * - Tự động quét thêm các promotion "sapphire" (channel SAAndroid, type 101, X-Rewards-PartnerId: BingHomepage).
 * - Silent API-First: Chỉ mở Worker Window fallback khi API không xác nhận được hoàn thành.
 */

import { sleep } from "./delay.js";
import { BING_IOS_APP_UA, generateRandomHex, getMobileAccessToken } from "./read-to-earn.js";
import { fetchEarnPageRsc } from "./rsc-parser.js";
import {
  attachMobileEmulation,
  detachMobileEmulation,
  detachAllTargets
} from "./mobile-cdp.js";

const ME_URL_SAIOS = "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAIOS&options=613";
const ME_URL_SAANDROID = "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613";
const ME_URL_BING = "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=bing&options=613";
const ACTIVITIES_URL = "https://prod.rewardsplatform.microsoft.com/dapi/me/activities";
const FLYOUT_INFO_URL = "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards";

export const SAIOS_PROFILE = {
  name: "SAIOS",
  channel: "SAIOS",
  meUrl: ME_URL_SAIOS,
  userAgent:
    "Mozilla/5.0 (iPad; CPU iPad OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/605.1.15 BingSapphire/33.4.440603001",
  extraHeaders: {
    Accept: "*/*",
    "X-Rewards-AppId": "SAIOS/33.4.440603001",
    "X-Rewards-PartnerId": "startapp",
    "X-Rewards-Flights": "rwgobig",
    "X-Rewards-IsMobile": "true"
  }
};

export const SAANDROID_PROFILE = {
  name: "SAAndroid",
  channel: "SAAndroid",
  meUrl: ME_URL_SAANDROID,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36 BingSapphire/34.5.450113001",
  extraHeaders: {
    Accept: "*/*",
    "X-Rewards-AppId": "SAAndroid/34.5.450113001",
    "X-Rewards-PartnerId": "BingHomepage",
    "X-Rewards-Flights": "rwgobig",
    "X-Rewards-IsMobile": "true"
  }
};

export const BING_IOS_PROFILE = {
  name: "BingIOS",
  channel: "bing",
  meUrl: ME_URL_BING,
  userAgent: BING_IOS_APP_UA,
  extraHeaders: {
    Accept: "*/*",
    "X-Rewards-ismobile": "true"
  }
};

const buildProfileHeaders = (accessToken, profile, countryCode, language = "en", isJson = false, overrideHeaders = {}) => {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": profile.userAgent,
    "X-Rewards-Country": String(countryCode || "us").toLowerCase(),
    "X-Rewards-Language": String(language || "en").toLowerCase(),
    ...profile.extraHeaders,
    ...overrideHeaders
  };
  if (isJson) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
};

const formatPartsForTz = (baseDate, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(baseDate);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const yyyy = map.year;
    const mm = map.month;
    const dd = map.day;
    return {
      tz: timeZone,
      yyyymmdd: `${yyyy}${mm}${dd}`,
      mmddyyyy: `${mm}${dd}${yyyy}`,
      mm_dd_yyyy: `${mm}/${dd}/${yyyy}`
    };
  } catch (e) {
    const yyyy = String(baseDate.getUTCFullYear());
    const mm = String(baseDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(baseDate.getUTCDate()).padStart(2, "0");
    return {
      tz: "UTC-fallback",
      yyyymmdd: `${yyyy}${mm}${dd}`,
      mmddyyyy: `${mm}${dd}${yyyy}`,
      mm_dd_yyyy: `${mm}/${dd}/${yyyy}`
    };
  }
};

/**
 * Trích xuất ngày thực tế của máy chủ Microsoft từ HTTP header "Date"
 */
export const extractServerDates = (responseHeaderDate) => {
  const parsed = responseHeaderDate ? new Date(responseHeaderDate) : new Date();
  const baseDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  const utcDates = formatPartsForTz(baseDate, "UTC");
  const ptDates = formatPartsForTz(baseDate, "America/Los_Angeles");
  const localNow = new Date();
  const localDates = {
    tz: "LocalPC",
    yyyymmdd: `${localNow.getFullYear()}${String(localNow.getMonth() + 1).padStart(2, "0")}${String(localNow.getDate()).padStart(2, "0")}`,
    mmddyyyy: `${String(localNow.getMonth() + 1).padStart(2, "0")}${String(localNow.getDate()).padStart(2, "0")}${localNow.getFullYear()}`,
    mm_dd_yyyy: `${String(localNow.getMonth() + 1).padStart(2, "0")}/${String(localNow.getDate()).padStart(2, "0")}/${localNow.getFullYear()}`
  };

  const candidates = [ptDates, utcDates];
  if (localDates.yyyymmdd !== utcDates.yyyymmdd && localDates.yyyymmdd !== ptDates.yyyymmdd) {
    candidates.push(localDates);
  }

  return {
    serverDateRaw: responseHeaderDate || baseDate.toUTCString(),
    primary: utcDates,
    pacific: ptDates,
    candidates
  };
};

const createActivityId = (useUuid = true) => {
  if (useUuid && typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return generateRandomHex(32);
};

const inferLanguageForCountry = (countryCode) => {
  const c = String(countryCode || "").toLowerCase();
  if (c === "vn") return "vi";
  if (c === "us" || c === "gb" || c === "au" || c === "ca") return "en";
  return "en";
};

const parseTimestampMs = (raw) => {
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Phân tích danh sách promotions để tìm các thẻ Bing App Check-in (type 103) & Sapphire Streak
 */
export const inspectCheckinPromotions = (promotions = []) => {
  const matched = [];
  const sapphirePromos = [];

  for (const p of promotions) {
    if (!p) continue;
    const attrs = p.attributes || {};
    const nameLower = String(p.name || "").toLowerCase();
    const offerId = String(attrs.offerid || p.offerId || p.name || "").trim();
    const offerLower = offerId.toLowerCase();
    const title = String(attrs.title || p.title || "").trim();
    const titleLower = title.toLowerCase();
    const attrTypeLower = String(attrs.type || "").toLowerCase();

    const isOtherStreak =
      offerLower.includes("visualsearch") ||
      offerLower.includes("visual_search") ||
      offerLower.includes("pcsearch") ||
      offerLower.includes("mobilesearch") ||
      offerLower.includes("readarticle") ||
      offerLower.includes("edge_browsing") ||
      offerLower.includes("browsewith") ||
      titleLower.includes("visual search") ||
      titleLower.includes("dailyset") ||
      titleLower.includes("daily set");

    if (isOtherStreak) continue;

    if (attrTypeLower === "sapphire" && String(attrs.complete || "").toLowerCase() !== "true" && offerId) {
      sapphirePromos.push({
        offerId,
        title: title || offerId,
        type: Number(p.type) || 101
      });
    }

    const isCheckin =
      Number(p.type) === 103 ||
      nameLower.includes("103") ||
      offerLower.includes("checkin") ||
      offerLower.includes("dailycheckin") ||
      offerLower.includes("sapphire") ||
      offerLower.includes("bingapp") ||
      (offerLower.includes("streak") && (offerLower.includes("app") || offerLower.includes("bing"))) ||
      titleLower.includes("check in") ||
      titleLower.includes("check-in") ||
      titleLower.includes("bing app streak") ||
      titleLower.includes("điểm danh");

    if (!isCheckin) continue;

    const progress = Number(attrs.progress ?? p.pointProgress ?? 0);
    const pointProgress = Number(attrs.pointprogress ?? p.pointProgress ?? progress);
    const max = Number(attrs.max ?? attrs.pointmax ?? p.pointProgressMax ?? 0);
    const lastUpdated = String(attrs.last_updated || p.lastUpdated || "");
    const lastUpdatedMs = parseTimestampMs(lastUpdated);
    const completed =
      String(attrs.complete || "").toLowerCase() === "true" ||
      p.complete === true ||
      (max > 0 && progress >= max);

    matched.push({
      key: offerId || nameLower || `type_${p.type || 103}`,
      offerId,
      title: title || offerId || "Daily Check-in",
      type: Number(p.type) || 103,
      progress,
      pointProgress,
      max,
      lastUpdated,
      lastUpdatedMs,
      completed
    });
  }

  const anyCompleted = matched.some((m) => m.completed);
  const allCompleted = matched.length > 0 && matched.every((m) => m.completed);
  const summary =
    matched.length > 0
      ? matched.map((m) => `${m.key} (prog=${m.progress}/${m.max}, pts=${m.pointProgress}, done=${m.completed})`).join("; ")
      : "Không thấy thẻ Check-in trong dapi/me promotions";

  return { matched, sapphirePromos, anyCompleted, allCompleted, summary };
};

/**
 * Gọi SAIOS, SAAndroid và Bing iOS /dapi/me để hợp nhất promotions và đọc HTTP header Date
 */
export const fetchMeProfile = async (accessToken, countryCode = "us") => {
  const endpoints = [
    { url: ME_URL_SAIOS, profile: SAIOS_PROFILE },
    { url: ME_URL_SAANDROID, profile: SAANDROID_PROFILE },
    { url: ME_URL_BING, profile: BING_IOS_PROFILE }
  ];

  const mergedPromosMap = new Map();
  let bestBalance = 0;
  let detectedCountry = String(countryCode || "us").toLowerCase();
  let detectedLanguage = inferLanguageForCountry(detectedCountry);
  let serverDateHeader = null;
  let lastError = null;
  let anySuccess = false;

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        method: "GET",
        headers: buildProfileHeaders(accessToken, ep.profile, detectedCountry, detectedLanguage, false)
      });
      if (!serverDateHeader) {
        serverDateHeader = res.headers?.get?.("date") || null;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status} (${ep.profile.name})`;
        continue;
      }
      const json = await res.json();
      anySuccess = true;
      const resp = json?.response || {};
      const bal = Number(resp.balance || 0);
      if (bal > bestBalance) bestBalance = bal;

      if (resp.attributes?.country) {
        detectedCountry = String(resp.attributes.country).toLowerCase();
        detectedLanguage = String(resp.attributes.language || inferLanguageForCountry(detectedCountry)).toLowerCase();
      }

      const promos = Array.isArray(resp.promotions) ? resp.promotions : [];
      for (const p of promos) {
        const key = String(p?.attributes?.offerid || p?.name || `type_${p?.type || Math.random()}`);
        if (!mergedPromosMap.has(key)) {
          mergedPromosMap.set(key, p);
        } else {
          const prev = mergedPromosMap.get(key);
          const prevDone = String(prev?.attributes?.complete || "").toLowerCase() === "true";
          const curDone = String(p?.attributes?.complete || "").toLowerCase() === "true";
          const prevPts = Number(prev?.attributes?.pointprogress || 0);
          const curPts = Number(p?.attributes?.pointprogress || 0);
          const prevUpdated = parseTimestampMs(prev?.attributes?.last_updated);
          const curUpdated = parseTimestampMs(p?.attributes?.last_updated);
          if ((!prevDone && curDone) || curPts > prevPts || curUpdated > prevUpdated) {
            mergedPromosMap.set(key, p);
          }
        }
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!anySuccess) {
    throw new Error(lastError || "Không đọc được /dapi/me");
  }

  return {
    balance: bestBalance,
    country: detectedCountry,
    language: detectedLanguage,
    promotions: Array.from(mergedPromosMap.values()),
    serverDateHeader
  };
};

const fetchBingServerDateHeader = async () => {
  try {
    const res = await fetch(FLYOUT_INFO_URL, { method: "GET", credentials: "include" });
    return res.headers?.get?.("date") || null;
  } catch (e) {
    return null;
  }
};

const isBingAppStreakDoneOnEarn = async () => {
  try {
    const rsc = await fetchEarnPageRsc("https://rewards.bing.com/earn");
    if (!rsc.success) return { checked: false, completed: false, streak: null };
    const streak = rsc.streaks.find(
      (s) =>
        s.partner.includes("bing-app") ||
        s.partner.includes("bingapp") ||
        s.partner.includes("checkin") ||
        s.offerId.toLowerCase().includes("checkin")
    );
    return {
      checked: true,
      completed: Boolean(streak?.isCurrentDayCompleted),
      streak,
      geoLocale: rsc.geoLocale,
      langCode: rsc.langCode
    };
  } catch (e) {
    return { checked: false, completed: false, streak: null };
  }
};

const waitTabLoaded = (tabId, timeoutMs = 8000) => {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const listener = (uTabId, changeInfo) => {
      if (uTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") {
        finish();
      }
    });
  });
};

/**
 * Xác minh hoàn thành theo 6 tiêu chí (chuẩn cả Ngày 1-6 lẫn Ngày 7)
 */
const verifyCheckinOutcome = async ({
  accessToken,
  countryCode,
  initialBalance,
  beforeCheckin,
  reportedGained,
  checkEarnRsc = true
}) => {
  let gained = reportedGained;
  let promoVerified = false;
  let promoDetail = "";

  try {
    const afterProfile = await fetchMeProfile(accessToken, countryCode);
    if (initialBalance > 0 && afterProfile.balance - initialBalance >= 5) {
      gained = Math.max(gained, afterProfile.balance - initialBalance);
    }

    const afterCheckin = inspectCheckinPromotions(afterProfile.promotions);
    for (const afterItem of afterCheckin.matched) {
      const prevItem = beforeCheckin.matched.find((b) => b.key === afterItem.key || b.offerId === afterItem.offerId);
      if (prevItem) {
        const becameComplete = !prevItem.completed && afterItem.completed;
        const pointIncreased = afterItem.pointProgress > prevItem.pointProgress;
        const progressIncreased = afterItem.progress > prevItem.progress;
        const updatedNewer = afterItem.lastUpdatedMs > 0 && afterItem.lastUpdatedMs > prevItem.lastUpdatedMs;

        if (becameComplete || pointIncreased || progressIncreased || updatedNewer) {
          promoVerified = true;
          const reason = becameComplete
            ? "complete=True"
            : pointIncreased
              ? `pointprogress +${afterItem.pointProgress - prevItem.pointProgress}`
              : progressIncreased
                ? `progress ${prevItem.progress}->${afterItem.progress}`
                : "last_updated mới hơn";
          promoDetail = `${afterItem.key} (${reason})`;
          break;
        }
      } else if (afterItem.completed || afterItem.progress > 0 || afterItem.pointProgress > 0) {
        promoVerified = true;
        promoDetail = `${afterItem.key} (${afterItem.progress}/${afterItem.max})`;
        break;
      }
    }
  } catch (e) {}

  let earnRscDone = false;
  if (!promoVerified && gained === 0 && checkEarnRsc) {
    const earnCheck = await isBingAppStreakDoneOnEarn();
    if (earnCheck.completed) {
      earnRscDone = true;
      promoDetail = "bing-app streak /earn hoàn thành (1/1)";
    }
  }

  return {
    verified: gained >= 5 || promoVerified || earnRscDone,
    gained,
    promoVerified: promoVerified || earnRscDone,
    promoDetail
  };
};

const sendActivityGroup = async ({
  groupName,
  profile,
  attempts,
  accessToken,
  countryCode,
  language,
  initialBalance,
  addLog
}) => {
  let anyHttpOk = false;
  let reportedGained = 0;
  let lastHttpDetail = "";

  for (const item of attempts) {
    try {
      const actRes = await fetch(ACTIVITIES_URL, {
        method: "POST",
        headers: buildProfileHeaders(accessToken, profile, countryCode, language, true, item.extraHeaders || {}),
        body: JSON.stringify(item.body)
      });

      const rawText = await actRes.text().catch(() => "");
      let actData = null;
      try {
        actData = JSON.parse(rawText);
      } catch (e) {}

      const apiError = actData?.error?.description || actData?.error?.code || actData?.errorMessage || "";
      if (actRes.ok && !actData?.error) {
        anyHttpOk = true;
        const returnedBalance = Number(actData?.response?.balance || 0);
        if (initialBalance > 0 && returnedBalance > initialBalance) {
          const diff = returnedBalance - initialBalance;
          reportedGained = Math.max(reportedGained, diff);
          addLog(`🎉 [${groupName}] ${item.label} -> HTTP ${actRes.status} (+${diff} pts | Ví: ${returnedBalance})`);
          return { anyHttpOk: true, reportedGained, immediateBalanceGain: true, lastHttpDetail: `HTTP ${actRes.status}` };
        }
        lastHttpDetail = `HTTP ${actRes.status} (Balance: ${returnedBalance || initialBalance})`;
        addLog(`ℹ️ [${groupName}] ${item.label} -> ${lastHttpDetail}`);
      } else {
        lastHttpDetail = `HTTP ${actRes.status}${apiError ? ` (${apiError})` : rawText ? `: ${rawText.slice(0, 90)}` : ""}`;
        addLog(`⚠️ [${groupName}] ${item.label} -> ${lastHttpDetail}`);
      }
    } catch (e) {
      lastHttpDetail = e.message;
      addLog(`⚠️ [${groupName}] ${item.label} -> Lỗi mạng: ${e.message}`);
    }
    await sleep(160);
  }

  return { anyHttpOk, reportedGained, immediateBalanceGain: false, lastHttpDetail };
};

/**
 * Thực thi điểm danh qua API chuẩn Late-2026:
 * SAIOS (startapp + rwgobig + type 103) -> Sapphire (SAAndroid type 101) -> Fallback SAAndroid/iOS
 */
export const executeApiCheckin = async (accessToken, addLog) => {
  if (!accessToken) return { success: false, verified: false, error: "Thiếu Access Token" };

  try {
    let countryCode = "us";
    let language = "en";
    let initialBalance = 0;
    let promotions = [];
    let serverDateHeader = null;

    // 0. Kiểm tra nhanh trạng thái streak trên /earn RSC
    const preEarn = await isBingAppStreakDoneOnEarn();
    if (preEarn.geoLocale) countryCode = preEarn.geoLocale;
    if (preEarn.langCode) language = preEarn.langCode;
    if (preEarn.completed) {
      addLog("✅ [API Check-in] Trang /earn xác nhận Bing App Streak hôm nay đã hoàn thành (1/1)!");
      return {
        success: true,
        verified: true,
        alreadyDone: true,
        gained: 0,
        summary: "Đã điểm danh hôm nay (1/1)"
      };
    }

    try {
      const profile = await fetchMeProfile(accessToken, countryCode);
      countryCode = profile.country;
      language = profile.language;
      initialBalance = profile.balance;
      promotions = profile.promotions;
      serverDateHeader = profile.serverDateHeader;
    } catch (e) {
      addLog(`ℹ️ [API Check-in] Lỗi đọc /dapi/me (${e.message}), lấy giờ máy chủ Bing dự phòng...`);
    }

    if (!serverDateHeader) {
      serverDateHeader = await fetchBingServerDateHeader();
    }

    const serverDates = extractServerDates(serverDateHeader);
    const beforeCheckin = inspectCheckinPromotions(promotions);

    addLog(`📊 [API Check-in] Ví: ${initialBalance} pts | Khu vực: ${countryCode.toUpperCase()} (${language}) | Server: "${serverDates.serverDateRaw}"`);
    addLog(`🔎 [API Check-in] Promotions: ${beforeCheckin.summary}`);

    if (beforeCheckin.matched.length > 0 && beforeCheckin.allCompleted) {
      addLog("✅ [API Check-in] Tài khoản đã điểm danh App Bing hôm nay rồi (1/1)!");
      return {
        success: true,
        verified: true,
        alreadyDone: true,
        gained: 0,
        summary: "Đã điểm danh hôm nay (1/1)"
      };
    }

    // GROUP 1 (CHÍNH THỨC LATE-2026): SAIOS (X-Rewards-AppId: SAIOS/33.4.440603001, PartnerId: startapp, Flights: rwgobig)
    const saiosAttempts = [
      {
        label: "SAIOS type=103 (startapp + rwgobig)",
        body: {
          risk_context: {},
          type: 103,
          channel: "SAIOS",
          attributes: {},
          id: createActivityId(true),
          amount: 1,
          country: countryCode
        }
      }
    ];

    const resSaios = await sendActivityGroup({
      groupName: "Group 1 - SAIOS",
      profile: SAIOS_PROFILE,
      attempts: saiosAttempts,
      accessToken,
      countryCode,
      language,
      initialBalance,
      addLog
    });

    // Claim thêm các promotion "sapphire" nếu đang còn
    let resSapphire = { anyHttpOk: false, reportedGained: 0, lastHttpDetail: "" };
    if (beforeCheckin.sapphirePromos.length > 0) {
      const sapphireAttempts = beforeCheckin.sapphirePromos.map((sp) => ({
        label: `Sapphire promo "${sp.offerId}"`,
        body: {
          id: createActivityId(true),
          amount: 1,
          type: sp.type || 101,
          channel: "SAAndroid",
          attributes: { offerid: sp.offerId },
          country: countryCode
        }
      }));
      resSapphire = await sendActivityGroup({
        groupName: "Sapphire - SAAndroid",
        profile: SAANDROID_PROFILE,
        attempts: sapphireAttempts,
        accessToken,
        countryCode,
        language,
        initialBalance,
        addLog
      });
    }

    const verifySaios = await verifyCheckinOutcome({
      accessToken,
      countryCode,
      initialBalance,
      beforeCheckin,
      reportedGained: Math.max(resSaios.reportedGained, resSapphire.reportedGained),
      checkEarnRsc: true
    });

    if (verifySaios.verified) {
      const msg =
        verifySaios.gained > 0
          ? `Điểm danh App Bing SAIOS thành công (+${verifySaios.gained} pts)`
          : `Đã xác nhận điểm danh SAIOS (${verifySaios.promoDetail})`;
      addLog(`✅ [API Check-in] ${msg}!`);
      return {
        success: true,
        verified: true,
        gained: verifySaios.gained,
        promoCompleted: verifySaios.promoVerified,
        summary: msg
      };
    }

    // GROUP 2 (FALLBACK): SAAndroid type=103 kèm startapp + rwgobig & Bing iOS
    const primaryOfferId =
      beforeCheckin.matched.find((m) => !m.completed && m.offerId)?.offerId ||
      "Gamification_Sapphire_DailyCheckIn";

    const resAndroid = await sendActivityGroup({
      groupName: "Group 2 - SAAndroid Fallback",
      profile: SAANDROID_PROFILE,
      attempts: [
        {
          label: "SAAndroid type=103 (startapp + rwgobig)",
          extraHeaders: { "X-Rewards-PartnerId": "startapp", "X-Rewards-Flights": "rwgobig" },
          body: {
            risk_context: {},
            type: 103,
            channel: "SAAndroid",
            attributes: {},
            id: createActivityId(true),
            amount: 1,
            country: countryCode
          }
        },
        {
          label: `SAAndroid type=103 + offerid=${primaryOfferId}`,
          extraHeaders: { "X-Rewards-PartnerId": "startapp", "X-Rewards-Flights": "rwgobig" },
          body: {
            risk_context: {},
            type: 103,
            channel: "SAAndroid",
            attributes: { offerid: primaryOfferId, date: serverDates.pacific.yyyymmdd },
            id: createActivityId(true),
            amount: 1,
            country: countryCode
          }
        }
      ],
      accessToken,
      countryCode,
      language,
      initialBalance,
      addLog
    });

    const verifyFinal = await verifyCheckinOutcome({
      accessToken,
      countryCode,
      initialBalance,
      beforeCheckin,
      reportedGained: resAndroid.reportedGained,
      checkEarnRsc: true
    });

    if (verifyFinal.verified) {
      const msg =
        verifyFinal.gained > 0
          ? `Điểm danh App Bing thành công (+${verifyFinal.gained} pts)`
          : `Đã xác nhận hoàn tất (${verifyFinal.promoDetail})`;
      addLog(`✅ [API Check-in] ${msg}!`);
      return {
        success: true,
        verified: true,
        gained: verifyFinal.gained,
        promoCompleted: verifyFinal.promoVerified,
        summary: msg
      };
    }

    const lastDetail = resAndroid.lastHttpDetail || resSaios.lastHttpDetail;
    const anyHttpOk = resSaios.anyHttpOk || resAndroid.anyHttpOk;
    if (anyHttpOk) {
      addLog("ℹ️ [API Check-in] API phản hồi HTTP 200 nhưng delta điểm/tiến độ chưa đổi. Thử fallback Mobile Web...");
    } else {
      addLog(`⚠️ [API Check-in] Chưa xác nhận được điểm danh qua API (${lastDetail || "không rõ"}).`);
    }

    return {
      success: false,
      verified: false,
      fallbackToWeb: true,
      reason: lastDetail || "API chưa xác nhận tăng điểm"
    };
  } catch (err) {
    addLog(`⚠️ [API Check-in] Gặp sự cố: ${err.message}`);
    return { success: false, verified: false, fallbackToWeb: true, reason: err.message };
  }
};

const clickCheckinInPage = async (tabId) => {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isAlreadyDoneText = (txt) => {
        const low = txt.toLowerCase();
        return low.includes("1/1") || low.includes("completed") || low.includes("hoàn thành");
      };

      const selectors = [
        '[data-bi-name="checkin"]',
        '[data-bi-id*="checkin" i]',
        ".daily-check-in",
        ".c-checkin-btn",
        ".checkin-btn",
        'button[id*="checkin" i]',
        'div[id*="checkin" i]',
        'a[href*="checkin" i]',
        '[aria-label*="Check in" i]',
        '[aria-label*="Check-in" i]',
        '[aria-label*="Bing App Streak" i]',
        '[aria-label*="Điểm danh" i]'
      ];

      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          const txt = (el?.innerText || el?.getAttribute?.("aria-label") || "").trim();
          if (el && el.offsetParent !== null && !isAlreadyDoneText(txt) && typeof el.click === "function") {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.click();
            return { clicked: true, selector };
          }
        } catch (e) {}
      }

      const candidates = Array.from(document.querySelectorAll("button, a, div[role='button'], span[role='button']"));
      for (const btn of candidates) {
        if (!btn.offsetParent) continue;
        const text = (btn.innerText || btn.textContent || "").trim();
        const aria = btn.getAttribute("aria-label") || "";
        const combined = `${text} ${aria}`.toLowerCase();
        if (isAlreadyDoneText(combined)) continue;

        if (
          combined.includes("check in: 0/1") ||
          combined.includes("check-in: 0/1") ||
          combined.includes("bing app streak") ||
          combined.includes("điểm danh") ||
          combined.includes("claim day") ||
          (combined.includes("check in") && text.length < 70)
        ) {
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          btn.click();
          return { clicked: true, text: text.slice(0, 60) };
        }
      }

      return { clicked: false };
    }
  });
  return results?.[0]?.result || { clicked: false };
};

/**
 * Fallback: Thực thi điểm danh trên Mobile Web CDP bên trong Worker Window (chỉ chạy khi API thất bại)
 */
export const executeWebCheckin = async ({ enableHeadersFunc, disableHeadersFunc, addLog, windowId }) => {
  addLog("📱 [Mobile Web Check-in] Chuyển sang UI Fallback trong cửa sổ ngầm để quét nút điểm danh...");

  let tab = null;
  try {
    if (disableHeadersFunc) await disableHeadersFunc();

    const createOpts = { url: "about:blank", active: true };
    if (windowId) createOpts.windowId = windowId;
    tab = await chrome.tabs.create(createOpts);

    if (enableHeadersFunc) await enableHeadersFunc(tab.id);
    await attachMobileEmulation(tab.id);

    const targets = [
      "https://www.bing.com/rewards/panelflyout?channel=BingFlyout&partnerId=BingRewards",
      "https://rewards.bing.com/earn"
    ];

    let clickedAny = false;
    for (const url of targets) {
      await chrome.tabs.update(tab.id, { url });
      await waitTabLoaded(tab.id, 7000);
      await sleep(1400);

      const clickRes = await clickCheckinInPage(tab.id).catch(() => ({ clicked: false }));
      if (clickRes && clickRes.clicked) {
        addLog(`✅ [Mobile Web Check-in] Đã nhấn phần tử điểm danh trên ${new URL(url).hostname} (${clickRes.selector || clickRes.text})!`);
        clickedAny = true;
        await sleep(1800);
        break;
      }
    }

    return { success: clickedAny, verified: false, clicked: clickedAny };
  } catch (err) {
    addLog(`⚠️ [Mobile Web Check-in] Lỗi: ${err.message}`);
    return { success: false, verified: false, error: err.message };
  } finally {
    if (tab && tab.id) {
      try {
        await detachMobileEmulation(tab.id);
        await chrome.tabs.remove(tab.id);
      } catch (e) {}
    }
    if (disableHeadersFunc) await disableHeadersFunc();
    await detachAllTargets();
  }
};

/**
 * Bộ điều phối tổng thể: Silent API-First (SAIOS -> Sapphire -> chỉ mở cửa sổ fallback nếu thật sự cần)
 */
export const runDailyCheckinWorkflow = async ({
  isRunningCheck,
  addLog,
  enableHeadersFunc,
  disableHeadersFunc,
  windowId = null,
  getWorkerWindowId = null
}) => {
  addLog("📅 [Daily Check-in] Bắt đầu điểm danh ngầm App Bing (SAIOS startapp/rwgobig)...");

  let accessToken = null;
  try {
    accessToken = await getMobileAccessToken(addLog);
  } catch (e) {}

  let apiResult = { success: false, verified: false, alreadyDone: false, gained: 0 };
  if (accessToken) {
    apiResult = await executeApiCheckin(accessToken, addLog);
    if (apiResult.verified) {
      return {
        success: true,
        verified: true,
        alreadyDone: !!apiResult.alreadyDone,
        gained: apiResult.gained || 0,
        summary: apiResult.summary || "Đã điểm danh App Bing"
      };
    }
  } else {
    addLog("⚠️ [Daily Check-in] Không lấy được OAuth Token. Đang chuẩn bị UI Fallback...");
  }

  let webRes = { success: false, clicked: false };
  if (isRunningCheck()) {
    const resolvedWinId = windowId || (typeof getWorkerWindowId === "function" ? await getWorkerWindowId().catch(() => null) : null);
    webRes = await executeWebCheckin({
      enableHeadersFunc,
      disableHeadersFunc,
      addLog,
      windowId: resolvedWinId
    });
  }

  if (accessToken && webRes.clicked) {
    const earnCheck = await isBingAppStreakDoneOnEarn();
    if (earnCheck.completed) {
      return {
        success: true,
        verified: true,
        alreadyDone: false,
        gained: 0,
        summary: "Đã điểm danh qua Mobile Web"
      };
    }
  }

  if (webRes.clicked) {
    return {
      success: true,
      verified: false,
      alreadyDone: false,
      gained: 0,
      summary: "Đã thử điểm danh — kiểm tra lại 1/1 trên Rewards"
    };
  }

  addLog("⚠️ [Daily Check-in] Chưa xác nhận được điểm danh từ API SAIOS/Web. Bấm '📋 Copy log' để kiểm tra.");
  return {
    success: false,
    verified: false,
    alreadyDone: false,
    gained: 0,
    summary: apiResult.reason ? `Chưa xác nhận (${apiResult.reason.slice(0, 35)})` : "Chưa điểm danh được (xem log)"
  };
};
