/**
 * Edge Desktop / EdgeHub Platform API Client (v2.2.0)
 * - Triển khai giao thức chính thức cho nhiệm vụ "Browse with Microsoft Edge" (30 phút/ngày = 6 nhịp x 5 phút).
 * - Gửi kèm credentials: "include" (MUID/MC1 cookies), Accept-Language và warm-up phiên (/earn + flyout) trước mỗi nhịp.
 * - Đối chiếu tiến độ thực trực tiếp từ /earn RSC streak ("edge-browsing": activitiesCompleted/activitiesTotal) và /dapi/me.
 * - Chạy ngầm 100% qua chrome.alarms kể cả khi thu nhỏ/ẩn màn hình Edge.
 */

import { sleep } from "./delay.js";
import { getMobileAccessToken, refreshAccessToken } from "./read-to-earn.js";
import { fetchRewardsOverview } from "./rewards-api.js";
import { activateEarnOffer, fetchEarnPageRsc, findStreakByKind } from "./rsc-parser.js";

export const EDGE_PROFILE_URL =
  "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=edge&options=Profile,Promotions";
export const EDGE_ACTIVITIES_URL =
  "https://prod.rewardsplatform.microsoft.com/dapi/me/activities";
export const DEFAULT_EDGE_OFFER_ID = "edge_flight_1_ww_treatment_eligible";
export const DEFAULT_EDGE_ACTIVITY_TYPE = "714";

export const buildEdgeHeaders = (accessToken, country = "us", language = "en") => {
  const langLower = String(language || "en").toLowerCase();
  const acceptLanguage = langLower === "vi"
    ? "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
    : "en-US,en;q=0.9";

  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "*/*",
    "Accept-Language": acceptLanguage,
    "Content-Type": "application/json",
    "X-Rewards-AppId": "EdgeDesktop",
    "X-Rewards-PartnerId": "EdgeHub",
    "X-Rewards-Country": String(country || "us").toLowerCase(),
    "X-Rewards-Language": langLower
  };
};

const parseEdgePromotion = (promotions = []) => {
  if (!Array.isArray(promotions)) return null;
  const promo = promotions.find((p) => {
    if (!p) return false;
    const name = String(p.name || "").toLowerCase();
    const offerId = String(p.attributes?.offerid || p.offerId || "").toLowerCase();
    const reportType = String(p.attributes?.report_offer_type || "");
    return (
      name === "edge_browsing_streak_flight" ||
      offerId.includes("edge_flight") ||
      offerId.includes("edge_browsing") ||
      reportType === "714"
    );
  });

  if (!promo) return null;

  const attrs = promo.attributes || {};
  const complete = String(attrs.complete || promo.complete || "").toLowerCase() === "true";
  const progress = Number(attrs.progress ?? attrs.pointprogress ?? promo.pointProgress ?? 0);
  const maxProgress = Number(attrs.max ?? attrs.pointmax ?? promo.pointProgressMax ?? 6);
  const reportIntervalMinutes = Number(attrs.report_per_minutes) || 5;

  let minutesCompleted = 0;
  if (complete) {
    minutesCompleted = 30;
  } else if (maxProgress > 0 && maxProgress <= 12) {
    minutesCompleted = Math.min(30, progress * reportIntervalMinutes);
  } else if (maxProgress >= 25) {
    minutesCompleted = Math.min(30, progress);
  } else if (progress > 0) {
    minutesCompleted = Math.min(30, progress * reportIntervalMinutes);
  }

  return {
    found: true,
    offerId: String(attrs.offerid || promo.offerId || DEFAULT_EDGE_OFFER_ID),
    activityType: String(attrs.report_offer_type || DEFAULT_EDGE_ACTIVITY_TYPE),
    reportIntervalMinutes,
    complete,
    progress,
    maxProgress,
    minutesCompleted,
    raw: promo
  };
};

/**
 * Đọc số phút thực tế từ Next.js /earn RSC ("Edge Browsing Streak": activitiesCompleted/activitiesTotal)
 */
export const readEdgeBrowsingStreakMinutes = async () => {
  try {
    const rsc = await fetchEarnPageRsc("https://rewards.bing.com/earn");
    if (!rsc.success) {
      return { found: false, minutesCompleted: 0, targetMinutes: 30, complete: false, geoLocale: "", langCode: "" };
    }
    const streak = findStreakByKind(rsc.streaks, "edge-browsing");
    if (!streak) {
      return {
        found: false,
        minutesCompleted: 0,
        targetMinutes: 30,
        complete: false,
        geoLocale: rsc.geoLocale || "",
        langCode: rsc.langCode || ""
      };
    }

    const targetMinutes = streak.activitiesTotal > 0 ? streak.activitiesTotal : 30;
    const minutesCompleted = Math.min(targetMinutes, Math.max(0, Number(streak.activitiesCompleted || 0)));
    const complete = Boolean(streak.isCurrentDayCompleted || (targetMinutes > 0 && minutesCompleted >= targetMinutes));

    return {
      found: true,
      minutesCompleted: complete ? targetMinutes : minutesCompleted,
      targetMinutes,
      complete,
      isEnabled: streak.isEnabled,
      activationOfferId: streak.activationOfferId || "",
      geoLocale: rsc.geoLocale || "",
      langCode: rsc.langCode || ""
    };
  } catch (e) {
    return { found: false, minutesCompleted: 0, targetMinutes: 30, complete: false, geoLocale: "", langCode: "" };
  }
};

/**
 * Đọc trạng thái nhiệm vụ Edge Browsing 30p trực tiếp từ prod.rewardsplatform.microsoft.com
 */
export const fetchEdgeBrowsingStatus = async (accessToken, country = "us", language = "en") => {
  if (!accessToken) {
    return { ok: false, status: 0, found: false, apiFailed: true, error: "Thiếu Access Token" };
  }

  try {
    const res = await fetch(EDGE_PROFILE_URL, {
      method: "GET",
      credentials: "include",
      headers: buildEdgeHeaders(accessToken, country, language)
    });

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        found: false,
        apiFailed: true,
        error: `HTTP ${res.status}`
      };
    }

    const json = await res.json().catch(() => null);
    const resp = json?.response || {};
    const detectedCountry = String(resp.attributes?.country || country || "us").toLowerCase();
    const detectedLanguage = String(resp.attributes?.language || language || (detectedCountry === "vn" ? "vi" : "en")).toLowerCase();
    const parsedPromo = parseEdgePromotion(resp.promotions || []);

    if (!parsedPromo) {
      return {
        ok: true,
        status: res.status,
        found: false,
        apiFailed: false,
        offerId: DEFAULT_EDGE_OFFER_ID,
        activityType: DEFAULT_EDGE_ACTIVITY_TYPE,
        reportIntervalMinutes: 5,
        complete: false,
        progress: 0,
        maxProgress: 6,
        minutesCompleted: 0,
        country: detectedCountry,
        language: detectedLanguage
      };
    }

    return {
      ok: true,
      status: res.status,
      apiFailed: false,
      country: detectedCountry,
      language: detectedLanguage,
      ...parsedPromo
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      found: false,
      apiFailed: true,
      error: e.message
    };
  }
};

/**
 * Gửi 1 nhịp heartbeat 5 phút (type 714) qua EdgeDesktop / EdgeHub Platform API (có MUID/MC1 cookies)
 */
export const reportEdgeBrowsingActivity = async ({
  accessToken,
  offerId = DEFAULT_EDGE_OFFER_ID,
  activityType = DEFAULT_EDGE_ACTIVITY_TYPE,
  country = "us",
  language = "en"
}) => {
  if (!accessToken) {
    return { success: false, status: 0, apiFailed: true, error: "Thiếu Access Token" };
  }

  try {
    const res = await fetch(EDGE_ACTIVITIES_URL, {
      method: "POST",
      credentials: "include",
      headers: buildEdgeHeaders(accessToken, country, language),
      body: JSON.stringify({
        amount: 1,
        attributes: { offerid: String(offerId || DEFAULT_EDGE_OFFER_ID) },
        request_user_info: true,
        type: String(activityType || DEFAULT_EDGE_ACTIVITY_TYPE)
      })
    });

    const data = await res.json().catch(() => null);
    const code = data?.code;
    const isOk = Boolean(res.ok && (code === 0 || code === undefined) && !data?.error);
    return {
      success: isOk,
      status: res.status,
      apiFailed: !res.ok || (code !== undefined && code !== 0),
      isDuplicate: Boolean(data?.response?.isDuplicate),
      raw: data,
      error: !isOk ? data?.error?.description || `HTTP ${res.status} (code=${code})` : null
    };
  } catch (e) {
    return {
      success: false,
      status: 0,
      apiFailed: true,
      isDuplicate: false,
      error: e.message
    };
  }
};

const resolveToken = async (silentOnly) => {
  if (silentOnly) {
    try {
      const stored = await new Promise((resolve) => {
        chrome.storage?.local?.get?.(["ms_rewards_refresh_token"], (res) => resolve(res || {}));
      });
      if (!stored?.ms_rewards_refresh_token) return null;
      return await refreshAccessToken(stored.ms_rewards_refresh_token);
    } catch (e) {
      return null;
    }
  }
  try {
    return await getMobileAccessToken(null);
  } catch (e) {
    return null;
  }
};

/**
 * Thực thi 1 chu kỳ Edge Browsing API:
 * - Warm-up phiên Bing/Rewards (giống EdgeBrowsing.ts)
 * - Gửi POST /dapi/me/activities (type=714) với MUID/MC1 cookies
 * - Đối chiếu kết quả thật từ /dapi/me?channel=edge & /earn RSC streak ("edge-browsing")
 */
export const performEdgeBrowsingTick = async ({
  accessToken = null,
  country = "us",
  language = "en",
  addLog = null,
  silentOnly = false,
  dryRunCheckOnly = false,
  skipBingWarmup = false
} = {}) => {
  let token = accessToken;
  if (!token) {
    token = await resolveToken(silentOnly);
  }

  if (!token) {
    return {
      success: false,
      apiFailed: true,
      complete: false,
      serverMinutesKnown: false,
      minutesCompleted: 0,
      targetMinutes: 30,
      reason: "no_token"
    };
  }

  let before = await fetchEdgeBrowsingStatus(token, country, language);
  if (before.status === 401 && !accessToken) {
    token = await resolveToken(silentOnly);
    if (token) {
      before = await fetchEdgeBrowsingStatus(token, country, language);
    }
  }

  if (!before.ok && before.apiFailed) {
    return {
      success: false,
      apiFailed: true,
      complete: false,
      serverMinutesKnown: false,
      minutesCompleted: 0,
      targetMinutes: 30,
      reason: before.error || `HTTP ${before.status}`
    };
  }

  const effectiveCountry = before.country || country;
  const effectiveLang = before.language || language;

  if (!before.found) {
    if (addLog) {
      addLog("🔧 [Edge Browsing API] Chưa thấy promotion edge_browsing_streak_flight — đang tự kích hoạt offer trên /earn...");
    }
    await activateEarnOffer(DEFAULT_EDGE_OFFER_ID, 714).catch(() => {});
  }

  const preEarn = await readEdgeBrowsingStreakMinutes();
  const initialServerMinutes = Math.max(before.minutesCompleted || 0, preEarn.minutesCompleted || 0);
  const targetMinutes = preEarn.targetMinutes || 30;

  if (before.complete || preEarn.complete || initialServerMinutes >= targetMinutes) {
    if (addLog) {
      addLog("🎉 [Edge Browsing API] Máy chủ xác nhận đã hoàn tất 30/30 phút duyệt Microsoft Edge!");
    }
    return {
      success: true,
      apiFailed: false,
      complete: true,
      serverMinutesKnown: true,
      minutesCompleted: targetMinutes,
      targetMinutes,
      progress: before.maxProgress || 6,
      maxProgress: before.maxProgress || 6,
      reportIntervalMinutes: before.reportIntervalMinutes || 5,
      offerId: before.offerId
    };
  }

  if (dryRunCheckOnly) {
    return {
      success: true,
      apiFailed: false,
      complete: false,
      serverMinutesKnown: Boolean(preEarn.found || before.ok),
      minutesCompleted: initialServerMinutes,
      targetMinutes,
      progress: before.progress || 0,
      maxProgress: before.maxProgress || 6,
      reportIntervalMinutes: before.reportIntervalMinutes || 5,
      offerId: before.offerId
    };
  }

  // Warm-up phiên Bing Flyout + /earn trước khi POST nhịp 5 phút (bỏ qua Bing Flyout nếu đang chạy Mobile Search để tránh re-create _EDGE_S Desktop)
  if (!skipBingWarmup) {
    await fetchRewardsOverview().catch(() => null);
  }
  await fetchEarnPageRsc("https://rewards.bing.com/earn").catch(() => null);

  const reportRes = await reportEdgeBrowsingActivity({
    accessToken: token,
    offerId: before.offerId,
    activityType: before.activityType,
    country: effectiveCountry,
    language: effectiveLang
  });

  if (reportRes.apiFailed) {
    return {
      success: false,
      apiFailed: true,
      complete: false,
      serverMinutesKnown: Boolean(preEarn.found || before.ok),
      minutesCompleted: initialServerMinutes,
      targetMinutes,
      offerId: before.offerId,
      reason: reportRes.error || `HTTP ${reportRes.status}`
    };
  }

  // Đợi máy chủ Microsoft đồng bộ trạng thái /earn (EdgeBrowsing.ts checks after ~2s)
  await sleep(1500);

  const [after, postEarn] = await Promise.all([
    fetchEdgeBrowsingStatus(token, effectiveCountry, effectiveLang),
    readEdgeBrowsingStreakMinutes()
  ]);

  const resolvedComplete = Boolean(after.complete || postEarn.complete);
  const earnMinutes = postEarn.found ? postEarn.minutesCompleted : 0;
  const dapiMinutes = after.ok ? after.minutesCompleted : 0;
  const authoritativeMinutes = resolvedComplete
    ? targetMinutes
    : Math.max(initialServerMinutes, earnMinutes, dapiMinutes);

  const serverMinutesKnown = Boolean(postEarn.found || (after.ok && after.progress > 0));

  if (addLog) {
    addLog(
      `🛡️ [Edge Browsing API] Gửi nhịp 5p (code=${reportRes.raw?.code ?? 0}, duplicate=${reportRes.isDuplicate}) -> Tiến độ server: ${authoritativeMinutes}/${targetMinutes} phút.`
    );
  }

  return {
    success: true,
    apiFailed: false,
    complete: resolvedComplete,
    serverMinutesKnown,
    minutesCompleted: authoritativeMinutes,
    targetMinutes,
    progress: after.ok ? after.progress : before.progress,
    maxProgress: after.ok ? after.maxProgress : before.maxProgress,
    reportIntervalMinutes: after.reportIntervalMinutes || before.reportIntervalMinutes || 5,
    isDuplicate: reportRes.isDuplicate,
    code: reportRes.raw?.code ?? 0,
    offerId: before.offerId
  };
};
