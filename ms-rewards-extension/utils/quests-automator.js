/**
 * Daily Quests Automator (v2.3.0) - Silent API-First Triple-Engine Quest Solver & Real Card Clicker
 * - Tầng 1 (Silent API): Next.js /earn RSC Flight Decoder + Server Actions (timezoneOffset string + (nav) router tree + strict ack).
 * - Tầng 2 (Silent API): Bing Flyout V1 (/msrewards/api/v1/reportactivity, bỏ qua dailySetPromotions nếu /earn đã xử lý) + Mobile dapi/me.
 * - Tầng 3 (Real DOM Card Click): Mở /earn trong Worker Window, bấm trực tiếp card #dailyset (và #daily_set_card trên Flyout nếu cần)
 *   + quiz-solver.js, rồi đối chiếu trung thực Daily Set Streak 3/3 (không báo xanh giả khi vẫn 0/3).
 */

import { sleep } from "./delay.js";
import { BING_IOS_APP_UA, generateRandomHex, getMobileAccessToken } from "./read-to-earn.js";
import { fetchRewardsOverview } from "./rewards-api.js";
import {
  fetchEarnPageRsc,
  findStreakByKind,
  discoverServerActions,
  reportEarnOfferViaServerAction,
  claimPointsViaServerAction,
  fetchFlyoutViewModel,
  reportFlyoutOfferV1,
  extractSerpImpressionGuid,
  reportBingSerpActivity
} from "./rsc-parser.js";

const ME_URL_SAANDROID = "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613";
const ACTIVITIES_URL = "https://prod.rewardsplatform.microsoft.com/dapi/me/activities";
const EARN_URL = "https://rewards.bing.com/earn";
const FLYOUT_PANEL_URL =
  "https://www.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards&isDarkMode=0&ru=https%3A%2F%2Fwww.bing.com%2F";

const waitTabReady = (tabId, timeoutMs = 6000) => {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve();
    };

    const timeoutTimer = setTimeout(finish, timeoutMs);
    const pollTimer = setInterval(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          finish();
          return;
        }
        if (tab.status === "complete") finish();
      });
    }, 200);

    const listener = (uTabId, changeInfo) => {
      if (uTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") finish();
    });
  });
};

export const isExcludedNonWebQuest = (promo) => {
  const offer = String(promo?.offerId || promo?.name || promo?.attributes?.offerid || "").toLowerCase();
  const typeStr = String(promo?.promotionType || promo?.attributes?.type || "").toLowerCase();
  const title = String(promo?.title || promo?.attributes?.title || "").toLowerCase();
  const dest = String(
    promo?.destinationUrl || promo?.destination || promo?.attributes?.destination || promo?.url || ""
  ).toLowerCase();

  if (
    offer.includes("pcsearch") ||
    offer.includes("mobilesearch") ||
    offer.includes("readarticle") ||
    offer.includes("edge_browsing") ||
    offer.includes("edge_flight") ||
    offer.includes("browsewith") ||
    offer.includes("visualsearch") ||
    offer.includes("dailycheckin") ||
    offer.includes("app_install") ||
    offer.includes("downloadapp") ||
    typeStr === "search" ||
    title.includes("search on bing") ||
    title.includes("tìm kiếm trên bing") ||
    title.includes("browse with microsoft edge") ||
    title.includes("duyệt web bằng microsoft edge") ||
    title.includes("install bing app") ||
    title.includes("bing app streak") ||
    title.includes("visual search streak") ||
    title.includes("set goal") ||
    title.includes("đặt mục tiêu") ||
    title.includes("auto-redeem") ||
    title.includes("tự động đổi") ||
    title.includes("sweepstakes") ||
    title.includes("rút thăm") ||
    title.includes("donate") ||
    title.includes("quyên góp") ||
    title.includes("privacy") ||
    title.includes("quyền riêng tư") ||
    title.includes("terms of use") ||
    title.includes("điều khoản") ||
    title.includes("sign out") ||
    title.includes("đăng xuất") ||
    title.includes("refer a friend") ||
    title.includes("giới thiệu bạn bè")
  ) {
    return true;
  }

  if (
    dest.includes("play.google.com") ||
    dest.includes("apps.apple.com") ||
    dest.includes("account.microsoft.com") ||
    dest.includes("privacy.microsoft.com") ||
    dest.includes("go.microsoft.com/fwlink") ||
    dest.includes("rewards.bing.com/redeem") ||
    dest.includes("rewards.bing.com/status") ||
    dest.includes("rewards.bing.com/support") ||
    dest.includes("rewards.bing.com/donate") ||
    dest.includes("sweepstakes") ||
    dest.includes("/refer")
  ) {
    return true;
  }

  try {
    if (dest) {
      const parsed = new URL(dest, "https://rewards.bing.com/");
      const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
      if (parsed.hostname === "rewards.bing.com" && (path === "" || path === "/earn" || path === "/redeem" || path === "/status" || path === "/support")) {
        return true;
      }
    }
  } catch (e) {}

  return false;
};

const isInteractiveQuizCard = (card) => {
  const combined = `${card?.activityType || ""} ${card?.promotionSubtype || ""} ${card?.offerId || ""} ${card?.title || ""} ${card?.description || ""} ${card?.destinationUrl || ""}`.toLowerCase();
  return /quiz|poll|supersonic|lightspeed|thisorthat|warpspeed|trivia|rn=\w+/i.test(combined);
};

const getTodayYmd = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const isExploreSearchCard = (card) => {
  const combined = `${card?.offerId || ""} ${card?.title || ""} ${card?.sourceGroup || ""} ${card?.destinationUrl || ""}`.toLowerCase();
  return combined.includes("exploreonbing") || combined.includes("explore") || combined.includes("search");
};

const normalizeQuestUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === "#" || trimmed.startsWith("javascript:")) return null;
  try {
    const resolved = new URL(trimmed, "https://rewards.bing.com/").href;
    if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) return null;
    if (resolved.includes("rewards.bing.com/#") || resolved === "https://rewards.bing.com/") return null;
    return resolved;
  } catch (e) {
    return null;
  }
};

export const selectTodayDailySetItems = (dailySetsObj, serverDateHeader = null) => {
  if (!dailySetsObj || typeof dailySetsObj !== "object") return [];
  if (Array.isArray(dailySetsObj)) return dailySetsObj;

  const base = serverDateHeader ? new Date(serverDateHeader) : new Date();
  const validDate = Number.isNaN(base.getTime()) ? new Date() : base;
  const candidateKeys = new Set();

  for (const tz of ["UTC", "America/Los_Angeles"]) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(validDate);
      const m = {};
      for (const p of parts) m[p.type] = p.value;
      candidateKeys.add(`${m.month}/${m.day}/${m.year}`);
      candidateKeys.add(`${m.year}-${m.month}-${m.day}`);
      candidateKeys.add(`${Number(m.month)}/${Number(m.day)}/${m.year}`);
      candidateKeys.add(`${m.year}${m.month}${m.day}`);
    } catch (e) {}
  }

  const matched = [];
  const all = [];
  for (const [key, arr] of Object.entries(dailySetsObj)) {
    if (!Array.isArray(arr)) continue;
    all.push(...arr);
    if (candidateKeys.has(String(key).trim())) matched.push(...arr);
  }
  return matched.length > 0 ? matched : all;
};

export const extractQuestsFromPromoList = (rootObj, options = {}) => {
  const { serverDateHeader = null } = options;
  const results = [];
  const visited = new WeakSet();

  const walk = (node) => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const rawUrl = node.destinationUrl || node.destination || node.attributes?.destination || node.url;
    const maxPts = Number(node.pointProgressMax ?? node.pointTotal ?? node.attributes?.max ?? node.points ?? 0);
    const curPts = Number(node.pointProgress ?? node.attributes?.progress ?? 0);
    const isComplete =
      node.complete === true ||
      node.isComplete === true ||
      node.isCompleted === true ||
      String(node.attributes?.complete || "").toLowerCase() === "true" ||
      (maxPts > 0 && curPts >= maxPts);

    if (rawUrl && !isComplete && !isExcludedNonWebQuest(node)) {
      const normalized = normalizeQuestUrl(rawUrl);
      if (normalized && (maxPts > 0 || node.offerId || node.name || node.attributes?.offerid)) {
        results.push({
          title: node.title || node.attributes?.title || node.offerId || node.name || "Rewards Quest",
          url: normalized,
          offerId: node.offerId || node.name || node.attributes?.offerid || "",
          points: maxPts > 0 ? Math.max(1, maxPts - curPts) : 10
        });
      }
    }

    for (const [key, val] of Object.entries(node)) {
      if (!val || typeof val !== "object") continue;
      if ((key === "dailySets" || key === "dailySetPromotions") && !Array.isArray(val)) {
        for (const item of selectTodayDailySetItems(val, serverDateHeader)) walk(item);
      } else {
        walk(val);
      }
    }
  };

  walk(rootObj);
  return results;
};

/**
 * Tầng 1A (Silent API): Nhận các promotion trên Mobile App API (/dapi/me?channel=SAAndroid)
 */
const runLayer1MobileApiQuests = async (isRunningCheck, addLog) => {
  let claimedCount = 0;
  let token = null;
  try {
    token = await getMobileAccessToken(null);
  } catch (e) {}

  if (!token) return { claimedCount: 0 };

  try {
    const res = await fetch(ME_URL_SAANDROID, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": BING_IOS_APP_UA,
        "X-Rewards-Country": "us",
        "X-Rewards-Language": "en",
        "X-Rewards-IsMobile": "true"
      }
    });
    if (!res.ok) return { claimedCount: 0 };

    const data = await res.json();
    const countryCode = (data?.response?.attributes?.country || "us").toLowerCase();
    const promotions = data?.response?.promotions || [];

    for (const p of promotions) {
      if (!isRunningCheck()) break;
      const attrs = p.attributes || {};
      const offerId = attrs.offerid || "";
      const max = Number(attrs.max || 0);
      const progress = Number(attrs.progress || 0);
      const isComplete = String(attrs.complete).toLowerCase() === "true" || (max > 0 && progress >= max);

      if (!offerId || max <= 0 || isComplete || isExcludedNonWebQuest(p)) continue;

      const claimRes = await fetch(ACTIVITIES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": BING_IOS_APP_UA,
          "X-Rewards-Country": countryCode,
          "X-Rewards-Language": "en",
          "X-Rewards-IsMobile": "true"
        },
        body: JSON.stringify({
          amount: 1,
          country: countryCode,
          id: typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : generateRandomHex(32),
          type: Number(p.type) || 101,
          channel: "SAAndroid",
          attributes: { offerid: offerId }
        })
      }).catch(() => null);

      const claimJson = await claimRes?.json?.().catch(() => null);
      if (claimRes?.ok && !claimJson?.error) {
        claimedCount++;
        addLog(`🎉 [Quests Mobile API] Đã nhận thưởng "${attrs.title || offerId}".`);
      }
      await sleep(150);
    }
  } catch (e) {}

  return { claimedCount };
};

/**
 * Tầng 1 (Silent API): Next.js /earn RSC Flight Decoder & Server Actions (reportActivity & reportClaimAllPoints)
 * Chạy TRƯỚC Flyout V1 để đồng bộ trực tiếp với cây trạng thái /earn mới (gồm (nav) + X-Deployment-Id + strict ack).
 */
const runLayer1EarnRscServerActions = async (isRunningCheck, addLog, claimedOfferIds) => {
  let claimed = 0;
  const deferred = [];
  let sawAnyOffers = false;

  const rsc = await fetchEarnPageRsc(EARN_URL);
  if (!rsc.success) {
    addLog(`ℹ️ [Quests Tầng 1 - /earn RSC] Không đọc được trang /earn (status=${rsc.status || 0}).`);
    return { claimed, deferred, sawAnyOffers: false, pointClaimDone: 0, rsc, actions: {} };
  }

  sawAnyOffers = rsc.offers.length > 0;
  const actions = await discoverServerActions(rsc.scriptUrls);
  const todayYmd = getTodayYmd();

  // Kích hoạt Daily Set Streak nếu trên /earn đang tắt (isEnabled === false)
  const dsStreak = findStreakByKind(rsc.streaks, "daily-set");
  if (dsStreak && dsStreak.isEnabled === false && dsStreak.activationOfferId && actions.reportActivity) {
    addLog(`🔧 [Daily Set Streak] Đang kích hoạt streak trên /earn (${dsStreak.activationOfferId})...`);
    await reportEarnOfferViaServerAction(
      {
        offerId: dsStreak.activationOfferId,
        hash: dsStreak.activationHash || "",
        activityType: dsStreak.activationActivityType || 11
      },
      actions.reportActivity
    ).catch(() => {});
  }

  const uncompleted = rsc.offers.filter(
    (o) =>
      !o.isCompleted &&
      !o.isLocked &&
      o.isAvailable &&
      (!o.date || o.date <= todayYmd) &&
      !isExcludedNonWebQuest(o) &&
      !claimedOfferIds.has(o.offerId)
  );

  addLog(
    `🔎 [Quests Tầng 1 - /earn RSC] Tìm thấy ${rsc.offers.length} offers (${uncompleted.length} chưa xong) | ServerAction=${Boolean(actions.reportActivity)}.`
  );

  for (const offer of uncompleted) {
    if (!isRunningCheck()) break;
    if (offer.hash && actions.reportActivity && !isInteractiveQuizCard(offer)) {
      const actRes = await reportEarnOfferViaServerAction(offer, actions.reportActivity);
      if (actRes.ok && actRes.acknowledged) {
        claimed++;
        claimedOfferIds.add(offer.offerId);
        addLog(`✅ [/earn Server Action] Đã xác nhận "${offer.title}" (+${offer.points || "?"} pts)!`);
        await sleep(200);
        continue;
      }
      addLog(`ℹ️ [/earn Server Action] Server chưa ack "${offer.title}" (${actRes.error || "no ack"}) — chuyển Tầng 3 DOM.`);
    }

    const normUrl = normalizeQuestUrl(offer.destinationUrl);
    if (normUrl) {
      deferred.push({
        offerId: offer.offerId,
        title: offer.title,
        url: normUrl,
        points: offer.points || 10,
        isExplore: isExploreSearchCard(offer)
      });
    }
  }

  let pointClaimDone = 0;
  if (rsc.pointClaim > 0 && actions.reportClaimAllPoints) {
    const claimRes = await claimPointsViaServerAction(actions.reportClaimAllPoints);
    if (claimRes.ok) {
      pointClaimDone = rsc.pointClaim;
      addLog(`🎉 [/earn Claim All] Đã nhận thêm ${rsc.pointClaim} điểm đang chờ (${actions.reportClaimAllPoints.slice(0, 8)}...)!`);
    }
  }

  return { claimed, deferred, sawAnyOffers, pointClaimDone, rsc, actions };
};

/**
 * Tầng 2 (Silent API): Bing Flyout V1 Direct Report (/msrewards/api/v1/reportactivity)
 * Bỏ qua dailySetPromotions khi /earn đã trả về offers để tránh Flyout đánh dấu Completed mà không tăng Streak.
 */
const runLayer2FlyoutV1Report = async (isRunningCheck, addLog, claimedOfferIds, { skipDailySet = false } = {}) => {
  let claimed = 0;
  const deferred = [];
  let sawAnyOffers = false;

  const flyout = await fetchFlyoutViewModel();
  if (!flyout.success) {
    addLog("ℹ️ [Quests Tầng 2 - Flyout V1] Chưa đọc được window.flyoutViewModel.");
    return { claimed, deferred, sawAnyOffers: false, flyout };
  }

  sawAnyOffers = flyout.cards.length > 0;
  const uncompleted = flyout.cards.filter(
    (c) =>
      !c.isCompleted &&
      !c.isLocked &&
      !(skipDailySet && c.sourceGroup === "dailySetPromotions") &&
      !claimedOfferIds.has(c.offerId) &&
      !isExcludedNonWebQuest(c)
  );
  addLog(
    `🔎 [Quests Tầng 2 - Flyout V1] Quét được ${flyout.cards.length} thẻ (${uncompleted.length} thẻ còn lại${skipDailySet ? ", đã bỏ qua Daily Set cho /earn xử lý" : ""}).`
  );

  for (const card of uncompleted) {
    if (!isRunningCheck()) break;
    if (card.hash && !isInteractiveQuizCard(card)) {
      const rep = await reportFlyoutOfferV1(card, flyout.userId);
      if (rep.success || rep.OfferComplete) {
        claimed++;
        claimedOfferIds.add(card.offerId);
        addLog(`✅ [Flyout V1] Hoàn thành "${card.title}" (+${card.points || "?"} pts)!`);
        await sleep(180);
        continue;
      }
    }
    if (normalizeQuestUrl(card.destinationUrl)) {
      deferred.push({
        offerId: card.offerId,
        title: card.title,
        url: normalizeQuestUrl(card.destinationUrl),
        points: card.points || 10,
        sourceGroup: card.sourceGroup
      });
    }
  }

  return { claimed, deferred, sawAnyOffers, flyout };
};

const runQuizSolverAndBeacon = async (tabId, quest, isRunningCheck, addLog) => {
  await waitTabReady(tabId, 6500);
  if (!isRunningCheck()) return { solved: false };

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/quiz-solver.js"]
  });
  await sleep(400);

  const solveRes = await Promise.race([
    chrome.tabs.sendMessage(tabId, { action: "SOLVE_QUEST_ON_PAGE" }).catch(() => null),
    sleep(30000).then(() => ({ timeout: true }))
  ]);

  if (quest.isExplore || isExploreSearchCard(quest)) {
    const searchTopic = String(quest.title || "trending news").replace(/explore on bing|khám phá/gi, "").trim() || "today weather";
    const serpUrl = `https://www.bing.com/search?q=${encodeURIComponent(searchTopic)}&FORM=ML2EPN`;
    await chrome.tabs.update(tabId, { url: serpUrl });
    await waitTabReady(tabId, 5000);
    const htmlRes = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => ({
        ig: window._G?.IG || "",
        html: document.documentElement?.innerHTML?.slice(0, 70000) || ""
      })
    }).catch(() => null);
    const ig = htmlRes?.[0]?.result?.ig || extractSerpImpressionGuid(htmlRes?.[0]?.result?.html || "");
    if (ig) {
      await reportBingSerpActivity({ serpUrl, query: searchTopic, ig, formCode: "ML2EPN" });
    }
  }

  await sleep(900);
  const detail = solveRes?.timeout
    ? "hết thời gian chờ 30s"
    : `${solveRes?.taskType || "explore"}${solveRes?.stepsDone ? `, ${solveRes.stepsDone} bước` : ""}`;
  addLog(`✅ [Quest UI] Xong "${quest.title}" (${detail}).`);
  return { solved: true };
};

/**
 * Thực thi 1 tab Quest trong Worker Window bằng content/quiz-solver.js + Explore Search SERP IG Beacon
 */
const solveSingleQuestTab = async (quest, isRunningCheck, addLog, windowId, existingTabId = null) => {
  let qTabId = existingTabId;
  try {
    addLog(`🎯 [Quest UI] Đang giải: "${quest.title}" (+${quest.points || "?"} pts)...`);
    if (!qTabId) {
      const createOpts = { url: quest.url, active: true };
      if (windowId) createOpts.windowId = windowId;
      const created = await chrome.tabs.create(createOpts);
      qTabId = created.id;
    }
    return await runQuizSolverAndBeacon(qTabId, quest, isRunningCheck, addLog);
  } catch (err) {
    addLog(`⚠️ [Quest UI] Bỏ qua "${quest.title}" (${err.message}).`);
    return { solved: false };
  } finally {
    if (qTabId) {
      try { await chrome.tabs.remove(qTabId); } catch (e) {}
    }
  }
};

const clickDomCardAndDetectNavigation = async (sourceTabId, cardSelector, cardIdx, windowId) => {
  const beforeTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  const beforeUrl = beforeTab?.url || "";
  let popupTabId = null;

  const onCreated = (tab) => {
    if (!tab?.id || tab.id === sourceTabId || popupTabId) return;
    if (tab.openerTabId === sourceTabId || (windowId && tab.windowId === windowId)) {
      popupTabId = tab.id;
    }
  };

  try {
    chrome.tabs?.onCreated?.addListener?.(onCreated);
  } catch (e) {}

  let clicked = false;
  try {
    const clickRes = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      world: "MAIN",
      args: [cardSelector, cardIdx],
      func: (sel, idx) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        const el = nodes[idx];
        if (!el) return false;
        try {
          el.scrollIntoView({ behavior: "instant", block: "center" });
        } catch (e) {}
        try {
          el.click();
          return true;
        } catch (e) {
          return false;
        }
      }
    }).catch(() => null);
    clicked = Boolean(clickRes?.[0]?.result);

    if (clicked) {
      const deadline = Date.now() + 2200;
      while (Date.now() < deadline) {
        if (popupTabId) return { mode: "popup", popupTabId };
        const curTab = await chrome.tabs.get(sourceTabId).catch(() => null);
        if (curTab?.url && curTab.url !== beforeUrl && !curTab.url.includes("rewards.bing.com/earn") && !curTab.url.includes("bing.com/rewards/panelflyout")) {
          return { mode: "same_tab", popupTabId: null };
        }
        await sleep(200);
      }
    }
  } finally {
    try {
      chrome.tabs?.onCreated?.removeListener?.(onCreated);
    } catch (e) {}
  }

  return { mode: "no_nav", popupTabId: null };
};

const executeDomCardClickAndSolve = async ({
  sourceTabId,
  cardSelector,
  cardMeta,
  returnUrl,
  isRunningCheck,
  addLog,
  windowId,
  onSameTabReturn = null
}) => {
  const nav = await clickDomCardAndDetectNavigation(sourceTabId, cardSelector, cardMeta.domIndex, windowId);
  if (nav.mode === "popup" && nav.popupTabId) {
    await solveSingleQuestTab(cardMeta, isRunningCheck, addLog, windowId, nav.popupTabId);
    await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  } else if (nav.mode === "same_tab") {
    await runQuizSolverAndBeacon(sourceTabId, cardMeta, isRunningCheck, addLog);
    await chrome.tabs.update(sourceTabId, { url: returnUrl }).catch(() => {});
    await waitTabReady(sourceTabId, 7000);
    if (onSameTabReturn) await onSameTabReturn();
  } else {
    await solveSingleQuestTab(cardMeta, isRunningCheck, addLog, windowId, null);
  }
};

const syncDailySetViaFlyoutTab = async (isRunningCheck, addLog, windowId) => {
  let flyoutTab = null;
  let processed = 0;
  try {
    addLog("🔄 [Daily Set Streak Sync] Mở Bing Flyout UI để bấm trực tiếp thẻ #daily_set_card...");
    const createOpts = { url: FLYOUT_PANEL_URL, active: true };
    if (windowId) createOpts.windowId = windowId;
    flyoutTab = await chrome.tabs.create(createOpts);
    await waitTabReady(flyoutTab.id, 6500);
    await sleep(1000);

    const flyoutCardSelector = "#daily_set_card a[href], #bingRewards #daily_set_card [role='link'][href]";
    const scanRes = await chrome.scripting.executeScript({
      target: { tabId: flyoutTab.id },
      world: "MAIN",
      args: [flyoutCardSelector],
      func: (sel) => {
        const cards = Array.from(document.querySelectorAll(sel));
        return cards.map((card, idx) => ({
          domIndex: idx,
          title: (card.innerText || card.getAttribute("aria-label") || "Daily Set Flyout").split("\n")[0].trim().slice(0, 80),
          url: card.href || card.getAttribute("href") || "",
          points: 10
        })).filter((c) => c.url && !c.url.startsWith("#") && !c.url.startsWith("javascript:"));
      }
    }).catch(() => null);

    const rawCards = Array.isArray(scanRes?.[0]?.result) ? scanRes[0].result : [];
    const cards = rawCards.slice(0, 3);
    for (const card of cards) {
      if (!isRunningCheck()) break;
      await executeDomCardClickAndSolve({
        sourceTabId: flyoutTab.id,
        cardSelector: flyoutCardSelector,
        cardMeta: card,
        returnUrl: FLYOUT_PANEL_URL,
        isRunningCheck,
        addLog,
        windowId
      });
      processed++;
    }
  } catch (err) {
    addLog(`⚠️ [Daily Set Flyout UI] Lỗi: ${err.message}`);
  } finally {
    if (flyoutTab?.id) {
      try { await chrome.tabs.remove(flyoutTab.id); } catch (e) {}
    }
  }
  return processed;
};

/**
 * Tầng 3 (Selective Worker Window Fallback & Real DOM Click):
 * Mở https://rewards.bing.com/earn, chờ #dailyset hydrate xong, đóng dialog, mở accordion,
 * bấm trực tiếp từng thẻ trên /earn (kể cả #dailyset nếu Activity < 3/3) + giải quiz-solver.js.
 */
const runLayer3EarnDomFallback = async ({
  deferredQuests,
  forceDailySetSync = false,
  isRunningCheck,
  addLog,
  onProgress,
  windowId
}) => {
  let processed = 0;
  let dashTab = null;

  const earnCardSelector = [
    "#dailyset a[href], #dailyset [role='link'][href]",
    "#exploreonbing a[href], #exploreonbing [role='link'][href]",
    "#moreactivities a[href], #moreactivities [role='link'][href]",
    "#quests a[href], #quests [role='link'][href]"
  ].join(", ");

  const prepareEarnPageScript = async (allowCompletedDailySet, sel) => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const readyDeadline = Date.now() + 6000;
    while (Date.now() < readyDeadline) {
      const hasDailySet = Boolean(document.querySelector("#dailyset a[href], #dailyset [role='link'][href], main section[id]"));
      const busyVisible = Array.from(document.querySelectorAll(".animate-pulse, [aria-busy='true']")).some(
        (el) => el.getClientRects().length > 0
      );
      if (hasDailySet && !busyVisible) break;
      await pause(250);
    }

    const closeBtn = document.querySelector('section[role="dialog"] button[slot="close"]');
    if (closeBtn) {
      try {
        closeBtn.click();
        await pause(400);
      } catch (e) {}
    }

    const containers = "#dailyset, #exploreonbing, #quests, #moreactivities";
    const expanders = Array.from(
      document.querySelectorAll(`${containers} button[slot="trigger"][aria-controls][aria-expanded="false"]`)
    );
    for (const btn of expanders) {
      try {
        btn.click();
        await pause(250);
      } catch (e) {}
    }
    await pause(300);

    const cards = Array.from(document.querySelectorAll(sel));
    const items = [];
    cards.forEach((card, domIndex) => {
      const inDailySet = Boolean(card.closest("#dailyset"));
      if (card.querySelector(".bg-statusSuccessRewardsBg") && !(allowCompletedDailySet && inDailySet)) {
        return;
      }
      if (card.matches(".locked_point, [aria-disabled='true']") || card.closest(".locked_point, [aria-disabled='true']")) {
        return;
      }
      const href = card.href || card.getAttribute("href") || "";
      const text = (card.innerText || card.getAttribute("aria-label") || "").trim();
      const low = text.toLowerCase();
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        (!(allowCompletedDailySet && inDailySet) && (low.includes("completed") || low.includes("hoàn thành") || low.includes("1/1"))) ||
        low.includes("browse with") ||
        low.includes("bing app streak") ||
        low.includes("visual search")
      ) {
        return;
      }
      items.push({
        domIndex,
        title: text.split("\n")[0].trim().slice(0, 80) || "Earn Card",
        url: href,
        isExplore: Boolean(card.closest("#exploreonbing")),
        inDailySet
      });
    });

    return items;
  };

  try {
    addLog(
      forceDailySetSync
        ? "🌐 [Daily Set Streak Sync] Mở https://rewards.bing.com/earn bấm trực tiếp 3 thẻ #dailyset để đồng bộ Activity 3/3..."
        : "🌐 [Quests Tầng 3 - /earn DOM Fallback] Mở https://rewards.bing.com/earn trong cửa sổ ngầm cho các thẻ Quiz/Explore..."
    );
    const createOpts = { url: EARN_URL, active: true };
    if (windowId) createOpts.windowId = windowId;
    dashTab = await chrome.tabs.create(createOpts);
    await waitTabReady(dashTab.id, 9000);
    await sleep(600);

    if (!isRunningCheck()) return processed;

    const scrapeRes = await chrome.scripting.executeScript({
      target: { tabId: dashTab.id },
      world: "MAIN",
      args: [Boolean(forceDailySetSync), earnCardSelector],
      func: prepareEarnPageScript
    }).catch(() => null);

    const domQuests = (scrapeRes?.[0]?.result || []).filter((q) => {
      const norm = normalizeQuestUrl(q.url);
      return Boolean(norm && !isExcludedNonWebQuest({ title: q.title, destinationUrl: norm }));
    });

    const handledKeys = new Set();
    const pendingExtras = [];
    for (const q of deferredQuests) {
      const norm = normalizeQuestUrl(q.url);
      if (!norm || isExcludedNonWebQuest({ title: q.title, destinationUrl: norm })) continue;
      const key = norm.split("#")[0];
      if (!handledKeys.has(key) && !domQuests.some((d) => normalizeQuestUrl(d.url)?.split("#")[0] === key)) {
        pendingExtras.push({ ...q, url: norm });
      }
    }

    const totalWork = domQuests.length + pendingExtras.length;
    if (totalWork === 0) {
      addLog("ℹ️ [Quests Tầng 3] Không còn thẻ Quest chưa hoàn thành nào trên /earn DOM.");
      return 0;
    }

    for (const domQuest of domQuests) {
      if (!isRunningCheck()) break;
      const normUrl = normalizeQuestUrl(domQuest.url);
      if (!normUrl) continue;
      handledKeys.add(normUrl.split("#")[0]);
      const cardMeta = { ...domQuest, url: normUrl, points: 10 };

      await executeDomCardClickAndSolve({
        sourceTabId: dashTab.id,
        cardSelector: earnCardSelector,
        cardMeta,
        returnUrl: EARN_URL,
        isRunningCheck,
        addLog,
        windowId,
        onSameTabReturn: () =>
          chrome.scripting.executeScript({
            target: { tabId: dashTab.id },
            world: "MAIN",
            args: [Boolean(forceDailySetSync), earnCardSelector],
            func: prepareEarnPageScript
          }).catch(() => null)
      });

      processed++;
      if (onProgress) onProgress(processed, totalWork);
    }

    for (const extra of pendingExtras) {
      if (!isRunningCheck()) break;
      const key = extra.url.split("#")[0];
      if (handledKeys.has(key)) continue;
      handledKeys.add(key);
      await solveSingleQuestTab(extra, isRunningCheck, addLog, windowId, null);
      processed++;
      if (onProgress) onProgress(processed, totalWork);
    }

    if (forceDailySetSync && isRunningCheck()) {
      await chrome.tabs.reload(dashTab.id).catch(() => {});
      await waitTabReady(dashTab.id, 6000);
      await sleep(1200);

      const midRsc = await fetchEarnPageRsc(EARN_URL).catch(() => ({ success: false, streaks: [] }));
      const midDs = findStreakByKind(midRsc.streaks, "daily-set");
      const midDone = Boolean(
        midDs &&
        (midDs.isCurrentDayCompleted || (midDs.activitiesTotal > 0 && midDs.activitiesCompleted >= midDs.activitiesTotal))
      );
      if (!midDone) {
        processed += await syncDailySetViaFlyoutTab(isRunningCheck, addLog, windowId);
      }
    }
  } finally {
    if (dashTab && dashTab.id) {
      try { await chrome.tabs.remove(dashTab.id); } catch (e) {}
    }
  }

  return processed;
};

const reReportTodayDailySetOffers = async (rsc, actions, addLog) => {
  if (!rsc?.offers?.length || !actions?.reportActivity) return 0;
  const todayYmd = getTodayYmd();
  const candidates = rsc.offers.filter(
    (o) =>
      o.hash &&
      !isInteractiveQuizCard(o) &&
      !isExcludedNonWebQuest(o) &&
      (o.date === todayYmd || (!o.date && /dailyset/i.test(o.offerId)))
  );
  let ackCount = 0;
  for (const offer of candidates) {
    const res = await reportEarnOfferViaServerAction(offer, actions.reportActivity).catch(() => ({ ok: false }));
    if (res.ok && res.acknowledged) ackCount++;
    await sleep(150);
  }
  if (candidates.length > 0 && addLog) {
    addLog(`🔧 [Daily Set Sync] Đã gửi lại ${candidates.length} Daily Set offers qua /earn Server Action (ack=${ackCount}).`);
  }
  return ackCount;
};

/**
 * Thu thập URL các thẻ Daily Set hôm nay từ Flyout JSON + /earn RSC để bù Streak nếu cần
 */
const collectDailySetFallbackUrls = (flyoutRes, rscRes) => {
  const results = [];
  const rawDailySets = flyoutRes?.flyout?.rawModel?.flyoutResult?.dailySetPromotions;
  if (rawDailySets) {
    const todayCards = selectTodayDailySetItems(rawDailySets);
    for (const c of todayCards) {
      const url = normalizeQuestUrl(c?.destinationUrl || c?.destination || c?.url);
      if (url && !isExcludedNonWebQuest(c)) {
        results.push({
          offerId: String(c?.offerId || ""),
          title: String(c?.title || "Daily Set Card"),
          url,
          points: Number(c?.pointProgressMax ?? 10)
        });
      }
    }
  }

  if (results.length === 0 && Array.isArray(rscRes?.rsc?.offers)) {
    const todayYmd = getTodayYmd();
    for (const o of rscRes.rsc.offers) {
      if (o.date === todayYmd || (!o.date && /dailyset/i.test(o.offerId))) {
        const url = normalizeQuestUrl(o.destinationUrl);
        if (url && !isExcludedNonWebQuest(o)) {
          results.push({
            offerId: o.offerId,
            title: o.title || "Daily Set Card",
            url,
            points: o.points || 10
          });
        }
      }
    }
  }
  return results;
};

/**
 * Bộ điều phối tổng thể (v2.3.0):
 * 1. /earn RSC Server Actions FIRST -> 2. Flyout V1 SECOND (bỏ qua Daily Set nếu /earn có dữ liệu) -> 3. Mobile API
 * -> Kiểm tra Daily Set Streak trên /earn: nếu vẫn 0/3 dù card Completed, re-report Server Action + click trực tiếp thẻ #dailyset & Flyout UI
 * -> Báo cáo TRUNG THỰC verified=false (⚠️) nếu server vẫn giữ Daily Set 0/3.
 */
export const runDailyQuestsWorkflow = async ({
  isRunningCheck,
  addLog,
  onProgress,
  windowId = null,
  getWorkerWindowId = null
}) => {
  addLog("🎯 [Daily Quests] Khởi động Silent API-First (/earn RSC Server Actions -> Flyout V1 -> Real Card Click Sync)...");

  const initialOverview = await fetchRewardsOverview().catch(() => ({ success: false }));
  const startPoints = initialOverview.success ? initialOverview.availablePoints : 0;

  const claimedOfferIds = new Set();
  let apiClaimed = 0;
  let domProcessed = 0;
  let deferredQuests = [];

  // Tầng 1: Next.js /earn RSC Server Actions (chuẩn (nav) + timezoneOffset string + X-Deployment-Id)
  const rscRes = isRunningCheck()
    ? await runLayer1EarnRscServerActions(isRunningCheck, addLog, claimedOfferIds)
    : { claimed: 0, deferred: [], sawAnyOffers: false, pointClaimDone: 0, rsc: null, actions: {} };
  apiClaimed += rscRes.claimed;
  deferredQuests.push(...rscRes.deferred);

  // Tầng 2: Bing Flyout V1 Direct Report (bỏ qua Daily Set khi /earn RSC đã hoạt động)
  const flyoutRes = isRunningCheck()
    ? await runLayer2FlyoutV1Report(isRunningCheck, addLog, claimedOfferIds, { skipDailySet: Boolean(rscRes.sawAnyOffers) })
    : { claimed: 0, deferred: [], sawAnyOffers: false, flyout: null };
  apiClaimed += flyoutRes.claimed;
  deferredQuests.push(...flyoutRes.deferred);

  // Tầng 2B: Mobile App API Promotions
  if (isRunningCheck()) {
    const mob = await runLayer1MobileApiQuests(isRunningCheck, addLog);
    apiClaimed += mob.claimedCount || 0;
  }

  // Kiểm tra trạng thái Daily Set Streak thực tế trên /earn RSC sau khi chạy API
  let needDailySetSync = false;
  let latestRsc = rscRes.rsc;
  if (isRunningCheck()) {
    const verifyRsc = await fetchEarnPageRsc(EARN_URL);
    if (verifyRsc.success) latestRsc = verifyRsc;
    const dsStreak = findStreakByKind(verifyRsc.streaks, "daily-set");
    if (dsStreak) {
      const done =
        dsStreak.isCurrentDayCompleted ||
        (dsStreak.activitiesTotal > 0 && dsStreak.activitiesCompleted >= dsStreak.activitiesTotal);
      if (!done && (dsStreak.activitiesTotal === 0 || dsStreak.activitiesCompleted < dsStreak.activitiesTotal)) {
        await reReportTodayDailySetOffers(verifyRsc, rscRes.actions, addLog);
        const postReReportRsc = await fetchEarnPageRsc(EARN_URL);
        if (postReReportRsc.success) latestRsc = postReReportRsc;
        const postDs = findStreakByKind(postReReportRsc.streaks, "daily-set") || dsStreak;
        const postDone =
          postDs.isCurrentDayCompleted ||
          (postDs.activitiesTotal > 0 && postDs.activitiesCompleted >= postDs.activitiesTotal);

        if (!postDone) {
          needDailySetSync = true;
          addLog(
            `⚠️ [Daily Set Streak] Daily Set trên /earn vẫn là ${postDs.activitiesCompleted}/${postDs.activitiesTotal || 3} — chuẩn bị click trực tiếp 3 thẻ #dailyset trên giao diện thật!`
          );
        } else {
          addLog(`✅ [Daily Set Streak] Đã đồng bộ lên ${postDs.activitiesCompleted}/${postDs.activitiesTotal || 3}!`);
        }
      } else if (done) {
        addLog(`✅ [Daily Set Streak] Đã xác nhận hoàn thành ${dsStreak.activitiesCompleted}/${dsStreak.activitiesTotal || 3}!`);
      }
    }
  }

  // Khử trùng lặp danh sách quest còn sót cần chạy Tầng 3
  const remainingFiltered = [];
  const seenKeys = new Set();
  for (const q of deferredQuests) {
    if (claimedOfferIds.has(q.offerId)) continue;
    const key = (q.offerId || q.url).split("#")[0];
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      remainingFiltered.push(q);
    }
  }

  if (needDailySetSync) {
    for (const d of collectDailySetFallbackUrls(flyoutRes, rscRes)) {
      const key = (d.offerId || d.url).split("#")[0];
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        remainingFiltered.push(d);
      }
    }
  }

  // Mở Worker Window nếu còn Quiz/Explore, API rỗng HOẶC Daily Set Streak vẫn < total
  const bothApisEmpty = !flyoutRes.sawAnyOffers && !rscRes.sawAnyOffers;
  if (isRunningCheck() && (remainingFiltered.length > 0 || bothApisEmpty || needDailySetSync)) {
    const resolvedWinId =
      windowId || (typeof getWorkerWindowId === "function" ? await getWorkerWindowId().catch(() => null) : null);

    domProcessed = await runLayer3EarnDomFallback({
      deferredQuests: remainingFiltered,
      forceDailySetSync: needDailySetSync,
      isRunningCheck,
      addLog,
      onProgress,
      windowId: resolvedWinId
    });
  } else {
    if (onProgress) onProgress(1, 1);
    addLog("⚡ [Daily Quests] Đã xử lý gọn toàn bộ qua API ngầm — không cần mở cửa sổ phụ!");
  }

  // Kiểm chứng TRUNG THỰC kết quả Daily Set Streak cuối cùng từ /earn RSC
  const finalRsc = await fetchEarnPageRsc(EARN_URL).catch(() => ({ success: false }));
  if (finalRsc.success) latestRsc = finalRsc;
  const afterDs = findStreakByKind(latestRsc?.streaks || [], "daily-set");
  const dsCompletedCount = afterDs ? afterDs.activitiesCompleted : null;
  const dsTotalCount = afterDs ? afterDs.activitiesTotal || 3 : 3;
  const dailySetIncomplete = Boolean(
    afterDs && !afterDs.isCurrentDayCompleted && dsTotalCount > 0 && dsCompletedCount < dsTotalCount
  );

  const todayYmd = getTodayYmd();
  const todayDailySetOffers = (latestRsc?.offers || []).filter(
    (o) => o.date === todayYmd || (!o.date && /dailyset/i.test(o.offerId))
  );
  const allTodayCardsCompleted =
    todayDailySetOffers.length >= 3 && todayDailySetOffers.every((o) => o.isCompleted);

  const finalOverview = await fetchRewardsOverview().catch(() => ({ success: false }));
  let pointsGained = rscRes.pointClaimDone || 0;
  if (finalOverview.success && startPoints > 0) {
    pointsGained = Math.max(pointsGained, finalOverview.availablePoints - startPoints);
    addLog(`🎉 [Tổng kết Daily Quests] Ví hiện tại: ${finalOverview.availablePoints} pts (+${pointsGained} pts)!`);
  }

  const totalHandled = apiClaimed + domProcessed;
  let verified = pointsGained > 0 || totalHandled > 0 || !bothApisEmpty;
  if (dailySetIncomplete) {
    verified = false;
    addLog(
      `⚠️ [Daily Set Streak Diagnostic] activities=${dsCompletedCount}/${dsTotalCount}, days=${afterDs.completedDays}/${afterDs.totalDays}, resetAt=${afterDs.resetAt || "n/a"}, todayCompletedCards=${todayDailySetOffers.filter((o) => o.isCompleted).length}/${todayDailySetOffers.length}.`
    );
    if (allTodayCardsCompleted) {
      addLog(
        "ℹ️ [Daily Set Streak] Cả 3 thẻ hôm nay đều đã mang cờ Completed trên server Microsoft nhưng bộ đếm streak server vẫn giữ 0/3 (lỗi backend phía Microsoft do lệch múi giờ/sync). Ngày mai v2.3.0 sẽ tránh trước từ đầu."
      );
    }
  }

  const baseSummary =
    pointsGained > 0
      ? `Xong ${totalHandled} quest (+${pointsGained} pts)`
      : totalHandled > 0
        ? `Đã hoàn thành ${totalHandled} quest`
        : "Đã xong hết quest hôm nay";

  let summary = baseSummary;
  if (dailySetIncomplete && allTodayCardsCompleted) {
    summary = `Daily Set ${dsCompletedCount}/${dsTotalCount} (3 thẻ đã ✓Completed — lỗi đồng bộ server MS)`;
  } else if (dailySetIncomplete) {
    summary = `${baseSummary} | ⚠️ Daily Set ${dsCompletedCount}/${dsTotalCount}`;
  } else if (afterDs) {
    summary = `${baseSummary} | Daily Set ${dsCompletedCount}/${dsTotalCount}`;
  }

  return {
    success: true,
    verified,
    dailySetIncomplete,
    questsFound: totalHandled + remainingFiltered.length,
    questsProcessed: totalHandled,
    pointsGained,
    summary
  };
};
