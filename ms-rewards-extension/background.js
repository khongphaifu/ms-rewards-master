/**
 * Background Service Worker - Microsoft Rewards Master (v2.4.0)
 * Kiến trúc Late-2026:
 * - Treo máy 30p: EdgeDesktop/EdgeHub API + cookies/warm-up (tránh xung đột Mobile Search) + đồng bộ /earn RSC ("edge-browsing").
 * - Điểm danh (SAIOS startapp/rwgobig), Visual Search (kblob -> bcid -> IG Beacon).
 * - Daily Quests: /earn RSC Server Actions ((nav) + timezoneOffset string + X-Deployment-Id + strict ack)
 *   -> Flyout V1 -> Click thẻ #dailyset thật & báo cáo trung thực Daily Set Streak 3/3.
 * - Web PC Search: Tự bỏ qua / dừng ngay khi đã đạt tối đa điểm (180/180 pts).
 * - Mobile Search 4 tầng tự sửa lỗi:
 *   Stage 0: Android 10 Chrome CDP (TheNetsky v5) -> Stage 1: iPhone Safari CDP (Zero Client Hints)
 *   -> Stage 2: Pure DNR Normal Tab (Không Debugger, form=LWS001) -> Stage 3: Direct Mobile API (PC=U531/ANNTA1).
 *   Giữ _EDGE_S, chờ đúng bing.com load, DNR chỉ gắn [targetTabId] hoặc search/reportApi để không nhiễu Flyout.
 */

import { sleep, humanDelay } from "./utils/delay.js";
import { getRandomWord } from "./utils/wordlist.js";
import {
  attachMobileEmulation,
  applyMobileOverrides,
  verifyMobileEmulation,
  checkMobileBingSession,
  detachMobileEmulation,
  detachAllTargets,
  simulateMobileEngagement,
  simulateMobileSearchForm,
  getMobileDnrHeaderRules,
  inspectBingMobileDomSession,
  inspectSerpAndSendBeaconInDom
} from "./utils/mobile-cdp.js";
import { executeReadToEarn, generateRandomHex } from "./utils/read-to-earn.js";
import { fetchRewardsOverview } from "./utils/rewards-api.js";
import { runDailyCheckinWorkflow } from "./utils/daily-checkin.js";
import { executeVisualSearchStreak } from "./utils/visual-search.js";
import { runDailyQuestsWorkflow } from "./utils/quests-automator.js";
import { performEdgeBrowsingTick, fetchEdgeBrowsingStatus } from "./utils/edge-browsing.js";
import {
  fetchEarnPageRsc,
  fetchFlyoutViewModel,
  reportBingSerpActivity,
  extractSerpImpressionGuid
} from "./utils/rsc-parser.js";

const RULE_ID_MOBILE_HEADERS = 999;
const RULE_ID_MOBILE_API_SEARCH = 998;
const RULE_ID_MOBILE_API_REPORT = 997;
const ALL_MOBILE_DNR_RULE_IDS = [
  RULE_ID_MOBILE_HEADERS,
  RULE_ID_MOBILE_API_SEARCH,
  RULE_ID_MOBILE_API_REPORT
];
const STAY_ALIVE_ALARM_NAME = "MS_REWARDS_STAY_ALIVE_ALARM";
const SEARCH_RETRY_ALARM_NAME = "MS_REWARDS_SEARCH_RETRY_ALARM";

const STAY_ALIVE_URLS = [
  "https://www.msn.com/vi-vn/news",
  "https://www.msn.com/vi-vn/sports",
  "https://www.msn.com/vi-vn/lifestyle",
  "https://www.msn.com/vi-vn/money",
  "https://www.msn.com/vi-vn/weather",
  "https://www.bing.com/news"
];

export const state = {
  isRunning: false,
  currentStep: "idle",
  selectedTasks: {
    dailyCheckin: true,
    dailyQuests: true,
    visualSearch: true,
    pcSearch: true,
    mobileSearch: true,
    readMsn: true,
    stayAlive: true
  },
  taskStatus: {
    dailyCheckin: "idle",
    dailyQuests: "idle",
    visualSearch: "idle",
    pcSearch: "idle",
    mobileSearch: "idle",
    readMsn: "idle",
    stayAlive: "idle"
  },
  taskSummary: {},
  questsDone: 0,
  questsTarget: 0,
  searchesDone: 0,
  searchesTarget: 35,
  mobileSearchesDone: 0,
  mobileSearchesTarget: 25,
  articlesReadDone: 0,
  articlesReadTarget: 10,
  stayAliveTotalMinutes: 30,
  stayAliveSecondsRemaining: 30 * 60,
  stayAliveTabId: null,
  stayAliveWindowId: null,
  workerWindowId: null,
  mobileWindowId: null,
  stayAliveSession: null,
  pendingUserAlert: null,
  logs: [],
  config: {
    pcSearchCount: 35,
    mobileSearchCount: 25,
    readMsnCount: 10,
    stayAliveMinutes: 30,
    minSearchDelay: 2.5,
    maxSearchDelay: 4.5,
    forceSearchCount: false,
    configSchemaVersion: 4,
    cooldownSafeMode: false,
    cooldownRestMinutes: 1,
    autoStart: false,
    pinTab: true,
    preventSleepingMin: true
  }
};

const storageGet = (keys) =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      resolve({});
    }
  });

const storageSet = (obj) =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });

const storageRemove = (keys) =>
  new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => resolve());
    } catch (e) {
      resolve();
    }
  });

let hydrationPromise = null;

export const migrateStoredConfig = (rawConfig) => {
  const upgraded = { ...state.config, ...(rawConfig || {}) };
  let changed = false;
  if (upgraded.minSearchDelay >= 8 && upgraded.maxSearchDelay >= 14) {
    upgraded.minSearchDelay = 2.5;
    upgraded.maxSearchDelay = 4.5;
    changed = true;
  }
  if ((rawConfig?.configSchemaVersion || 0) < 3) {
    upgraded.forceSearchCount = false;
    changed = true;
  }
  if ((rawConfig?.configSchemaVersion || 0) < 4) {
    if (Number(upgraded.mobileSearchCount) === 20) upgraded.mobileSearchCount = 25;
    if (Number(upgraded.pcSearchCount) === 30) upgraded.pcSearchCount = 35;
    upgraded.configSchemaVersion = 4;
    changed = true;
  }
  return { config: upgraded, changed };
};

export const ensureStateHydrated = async () => {
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      const res = await storageGet(["config", "selectedTasks", "logs", "stayAliveSession"]);
      if (res.config) {
        const { config, changed } = migrateStoredConfig(res.config);
        state.config = config;
        if (changed) {
          await storageSet({ config: state.config });
        }
      }
      if (res.selectedTasks) {
        state.selectedTasks = { ...state.selectedTasks, ...res.selectedTasks };
      }
      if (Array.isArray(res.logs)) {
        state.logs = res.logs.slice(-100);
      }
      if (res.stayAliveSession) {
        state.stayAliveSession = res.stayAliveSession;
        if (res.stayAliveSession.active) {
          const targetSeconds = (res.stayAliveSession.durationMinutes || 30) * 60;
          const actualSeconds = res.stayAliveSession.actualActiveSeconds || 0;
          state.stayAliveSecondsRemaining = Math.max(0, targetSeconds - actualSeconds);
          state.stayAliveTotalMinutes = res.stayAliveSession.durationMinutes || 30;
          state.stayAliveTabId = res.stayAliveSession.tabId || null;
          state.stayAliveWindowId = res.stayAliveSession.windowId || null;
          state.taskStatus.stayAlive = "running";
        }
      }
    })();
  }
  await hydrationPromise;
};

const broadcastState = () => {
  try {
    chrome.runtime.sendMessage({ action: "STATE_UPDATED", state }).catch(() => {});
  } catch (e) {}
};

const setTaskStatus = (moduleKey, status, summary = null) => {
  if (state.taskStatus && Object.prototype.hasOwnProperty.call(state.taskStatus, moduleKey)) {
    state.taskStatus[moduleKey] = status;
  }
  if (summary !== null) {
    state.taskSummary[moduleKey] = summary;
  }
  broadcastState();
};

const createWindowSafe = async (options) => {
  try {
    return await chrome.windows.create(options);
  } catch (err) {
    if ("focused" in options) {
      const retryOpts = { ...options };
      delete retryOpts.focused;
      return await chrome.windows.create(retryOpts);
    }
    throw err;
  }
};

const ensureManagedWindow = async (stateKey, createOptions) => {
  const existingId = state[stateKey];
  if (existingId) {
    try {
      const win = await chrome.windows.get(existingId, { populate: true });
      if (win && win.id) {
        if (win.state === "minimized") {
          await chrome.windows.update(win.id, { state: "normal", focused: false }).catch(() => {});
        }
        return { windowId: win.id, initialTabId: win.tabs?.[0]?.id || null };
      }
    } catch (e) {
      state[stateKey] = null;
    }
  }

  const win = await createWindowSafe(createOptions);
  state[stateKey] = win.id;
  return { windowId: win.id, initialTabId: win.tabs?.[0]?.id || null };
};

const closeManagedWindow = async (stateKey) => {
  const winId = state[stateKey];
  if (winId) {
    state[stateKey] = null;
    try {
      await chrome.windows.remove(winId);
    } catch (e) {}
  }
};

const ensureWorkerWindow = () =>
  ensureManagedWindow("workerWindowId", {
    url: "about:blank",
    type: "normal",
    width: 520,
    height: 660,
    left: 60,
    top: 60,
    focused: false
  });

const closeWorkerWindow = () => closeManagedWindow("workerWindowId");

const ensureMobileWindow = () =>
  ensureManagedWindow("mobileWindowId", {
    url: "about:blank",
    type: "normal",
    width: 460,
    height: 860,
    left: 40,
    top: 40,
    focused: false
  });

const closeMobileWindow = () => closeManagedWindow("mobileWindowId");

const saveConfig = () => {
  storageSet({
    config: state.config,
    selectedTasks: state.selectedTasks
  });
};

const addLog = (message) => {
  const timestamp = new Date().toLocaleTimeString("vi-VN");
  const logEntry = `[${timestamp}] ${message}`;
  console.log(logEntry);
  state.logs.push(logEntry);
  if (state.logs.length > 100) state.logs.shift();

  storageSet({ logs: state.logs });
  try {
    chrome.runtime.sendMessage({ action: "NEW_LOG", log: logEntry }).catch(() => {});
  } catch (e) {}
};

const updateBadge = (text, color = "#0078D7") => {
  try {
    chrome.action?.setBadgeText?.({ text });
    chrome.action?.setBadgeBackgroundColor?.({ color });
  } catch (e) {}
};

const interruptibleSleep = async (ms) => {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms && state.isRunning) {
    await sleep(step);
    elapsed += step;
  }
};

const waitForTabCondition = (tabId, timeoutMs, isTabReady) => {
  return new Promise((resolve) => {
    let finished = false;
    let pollTimer = null;
    let timer = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
    };

    const done = (tab) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(tab || null);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && (changeInfo.status === "complete" || changeInfo.url) && isTabReady(tab)) {
        done(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        done(null);
        return;
      }
      if (isTabReady(tab)) done(tab);
    });

    if (finished) return;

    pollTimer = setInterval(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          done(null);
          return;
        }
        if (isTabReady(tab)) done(tab);
      });
    }, 200);

    timer = setTimeout(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) done(null);
        else done(tab);
      });
    }, timeoutMs);
  });
};

export const waitForTabComplete = (tabId, timeoutMs = 4500, expectUrlPart = null) =>
  waitForTabCondition(tabId, timeoutMs, (tab) => {
    if (!tab || tab.status !== "complete") return false;
    if (expectUrlPart && (!tab.url || !tab.url.includes(expectUrlPart))) return false;
    return true;
  });

export const waitForBingSignInLanding = (tabId, timeoutMs = 8000) =>
  waitForTabCondition(tabId, timeoutMs, (tab) => {
    if (!tab || tab.status !== "complete" || !tab.url) return false;
    try {
      const parsed = new URL(tab.url);
      const host = parsed.hostname.toLowerCase();
      const isBingHost = host === "bing.com" || host.endsWith(".bing.com");
      const isAuthPath = parsed.pathname.toLowerCase().startsWith("/fd/auth/");
      return (
        isBingHost &&
        !isAuthPath &&
        !host.includes("login.live.com") &&
        !host.includes("login.microsoftonline.com")
      );
    } catch (e) {
      return false;
    }
  });

const urlMatchesQueryOrCvid = (urlStr, query, cvid = null) => {
  if (!urlStr) return false;
  const lowerUrl = urlStr.toLowerCase();
  if (cvid && lowerUrl.includes(String(cvid).toLowerCase())) {
    return true;
  }

  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return true;
  const firstWord = normalizedQuery.split(/\s+/)[0];

  try {
    const parsed = new URL(urlStr);
    const qParam = (parsed.searchParams.get("q") || "").trim().toLowerCase();
    if (qParam) {
      return qParam === normalizedQuery || qParam.includes(firstWord);
    }
  } catch (e) {}

  try {
    const decoded = decodeURIComponent(lowerUrl);
    return decoded.includes(normalizedQuery) || decoded.includes(firstWord);
  } catch (e) {
    return lowerUrl.includes(encodeURIComponent(firstWord).toLowerCase());
  }
};

/**
 * Chờ điều hướng tìm kiếm thực sự sang từ khóa MỚI (sửa triệt để lỗi kết thúc sớm trên URL tìm kiếm trước đó)
 */
export const waitForSearchNavigation = (tabId, previousUrl, query, timeoutMs = 4500, cvid = null) => {
  return new Promise((resolve) => {
    let finished = false;
    let sawLoading = false;
    let pollTimer = null;
    let timer = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
    };

    const isNavigatedAndReady = (tab) => {
      if (!tab) return false;
      if (tab.status === "loading") {
        sawLoading = true;
        return false;
      }
      if (tab.status !== "complete") return false;
      if (!tab.url || (!tab.url.includes("search?") && !tab.url.includes("/search"))) return false;
      if (previousUrl && tab.url === previousUrl) return false;
      if (!sawLoading && (!previousUrl || tab.url === previousUrl)) return false;
      return urlMatchesQueryOrCvid(tab.url, query, cvid);
    };

    const done = (tab) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(tab || null);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if (changeInfo.status === "complete" && isNavigatedAndReady(tab)) {
        done(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        done(null);
        return;
      }
      if (isNavigatedAndReady(tab)) done(tab);
    });

    if (finished) return;

    pollTimer = setInterval(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          done(null);
          return;
        }
        if (isNavigatedAndReady(tab)) done(tab);
      });
    }, 150);

    timer = setTimeout(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) done(null);
        else done(tab);
      });
    }, timeoutMs);
  });
};

const ensureContentScriptReady = async (tabId) => {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: "PING" });
    if (res && res.status === "ok") return true;
  } catch (e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/search-automator.js"]
    });
    await sleep(150);
    return true;
  } catch (err) {
    console.warn("[Background] Không thể tiêm content script:", err);
    return false;
  }
};

const triggerBackgroundSerpBeaconFallback = async (tabId, query, formCode, cvid) => {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => ({
        href: window.location.href || "",
        ig: window._G?.IG || "",
        html: document.documentElement?.innerHTML?.slice(0, 75000) || ""
      })
    }).catch(() => null);

    const payload = res?.[0]?.result;
    if (!payload?.href || !payload.href.includes("/search")) return false;
    const ig = payload.ig || extractSerpImpressionGuid(payload.html || "");
    if (!ig) return false;

    const beacon = await reportBingSerpActivity({
      serpUrl: payload.href,
      query,
      ig,
      formCode,
      cvid
    });
    return Boolean(beacon?.ok);
  } catch (e) {
    return false;
  }
};

const checkMobileBingSessionViaScripting = async (tabId, hasAuthCookies = null) => {
  const fallback = {
    url: "",
    host: "",
    isBingHost: false,
    width: 0,
    isMobileLayout: false,
    isSignedIn: false,
    hasSearchBox: false,
    signInSource: "scripting_fallback"
  };
  if (!tabId) return fallback;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectBingMobileDomSession,
      args: [hasAuthCookies]
    });
    return res?.[0]?.result || fallback;
  } catch (e) {
    return fallback;
  }
};

const readSerpTelemetryAndBeaconViaScripting = async (tabId, query = "", cvid = "") => {
  if (!tabId) return null;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: inspectSerpAndSendBeaconInDom,
      args: [query || "", cvid || ""]
    });
    return res?.[0]?.result || null;
  } catch (e) {
    return null;
  }
};

/**
 * Điều phối 1 lượt tìm kiếm trong tab: hỗ trợ PC, Mobile CDP, và Pure DNR Tab (không cần CDP)
 */
const executeInPageSearchOnTab = async (tabId, query, isMobile = false, options = {}) => {
  const {
    useCdp = true,
    formCodeOverride = null,
    directUrlOverride = null,
    directNavigateOnly = false
  } = options;

  if (!isMobile) {
    await ensureContentScriptReady(tabId);
  }

  const formCode = formCodeOverride || "ANNTA1";
  const cvid = generateRandomHex(16);
  const directSearchUrl = directUrlOverride
    ? directUrlOverride.replace("{q}", encodeURIComponent(query)).replace("{cvid}", cvid)
    : `https://www.bing.com/search?q=${encodeURIComponent(query)}&PC=U531&FORM=${formCode}&cvid=${cvid}`;

  const beforeTab = await chrome.tabs.get(tabId).catch(() => null);
  const beforeUrl = beforeTab?.url || "";
  const isAlreadySerp = beforeUrl.toLowerCase().includes("/search");

  if (isMobile && (directNavigateOnly || !useCdp)) {
    await chrome.tabs.update(tabId, { url: directSearchUrl }).catch(() => {});
    await waitForSearchNavigation(tabId, beforeUrl, query, 6500, cvid);
    const settleMs = Number(state.config.minSearchDelay ?? 2.5) < 1 ? 50 : 1200;
    await sleep(settleMs);

    const engagementRes = await Promise.race([
      readSerpTelemetryAndBeaconViaScripting(tabId, query, cvid),
      sleep(3500).then(() => null)
    ]);
    const beaconAlreadySent = Boolean(engagementRes?.beacon === true);
    if (!beaconAlreadySent) {
      await triggerBackgroundSerpBeaconFallback(tabId, query, formCode, cvid);
    }
    return { ok: true, engagement: engagementRes || null };
  }

  let navigatingOrNavigated = false;
  if (isMobile && isAlreadySerp) {
    await chrome.tabs.update(tabId, { url: directSearchUrl }).catch(() => {});
    navigatingOrNavigated = true;
  } else {
    if (isMobile) {
      try {
        await simulateMobileSearchForm(tabId, query);
      } catch (e) {}
    } else {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: "EXECUTE_IN_PAGE_SEARCH",
          query
        });
      } catch (e) {}
    }

    const pollAttempts = isMobile ? 4 : 2;
    for (let p = 0; p < pollAttempts; p++) {
      await sleep(isMobile ? 150 : 175);
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab) {
          const urlChanged = Boolean(currentTab.url && currentTab.url !== beforeUrl && currentTab.url.includes("search?"));
          const isLoading = currentTab.status === "loading";
          if (urlChanged || isLoading) {
            navigatingOrNavigated = true;
            break;
          }
        }
      } catch (e) {}
    }
  }

  if (!navigatingOrNavigated) {
    try {
      await chrome.tabs.update(tabId, { url: directSearchUrl });
    } catch (e) {}
  }

  await waitForSearchNavigation(tabId, beforeUrl, query, isMobile ? 6500 : 4500, cvid);

  let engagementRes = null;
  if (isMobile) {
    engagementRes = await Promise.race([
      simulateMobileEngagement(tabId, query, cvid).catch(() => null),
      sleep(3500).then(() => null)
    ]);
    if (!engagementRes || (!engagementRes.beacon && !engagementRes.ig)) {
      const scriptEng = await Promise.race([
        readSerpTelemetryAndBeaconViaScripting(tabId, query, cvid),
        sleep(2500).then(() => null)
      ]);
      if (scriptEng) engagementRes = scriptEng;
    }
  } else {
    await ensureContentScriptReady(tabId);
    engagementRes = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        action: "SIMULATE_HUMAN_ENGAGEMENT",
        query,
        formCode,
        cvid
      }).catch(() => null),
      sleep(900).then(() => null)
    ]);
  }

  const beaconAlreadySent = Boolean(engagementRes?.beacon === true || engagementRes?.beacon?.success);
  if (!beaconAlreadySent) {
    await triggerBackgroundSerpBeaconFallback(tabId, query, formCode, cvid);
  }

  return { ok: true, engagement: engagementRes || null };
};

/**
 * Dọn dẹp triệt để mọi rules giả lập Mobile
 */
const disableMobileHeaders = async () => {
  try {
    const dynRules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
    const dynIds = Array.from(new Set([...dynRules.map((r) => r.id), ...ALL_MOBILE_DNR_RULE_IDS]));
    if (dynIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynIds }).catch(() => {});
    }

    const sessRules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
    const sessIds = Array.from(new Set([...sessRules.map((r) => r.id), ...ALL_MOBILE_DNR_RULE_IDS]));
    if (sessIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessIds }).catch(() => {});
    }
  } catch (e) {
    console.error("Lỗi tắt Mobile Headers:", e);
  }
};

/**
 * Kích hoạt headers Mobile sạch + gỡ headers Desktop Edge & High-Entropy Client Hints.
 * - Khi có targetTabId (Stage 0/1/2): chỉ áp dụng trên tabIds: [targetTabId], KHÔNG gắn -1 để không nhiễu Flyout API.
 * - Khi targetTabId === null (Stage 3 API): chỉ gắn lên ||bing.com/search và ||bing.com/rewardsapp/reportActivity.
 */
export const enableMobileHeaders = async (targetTabId = null, profileIndex = 0) => {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ALL_MOBILE_DNR_RULE_IDS
    }).catch(() => {});

    const { setHeaders, removeHeaders } = getMobileDnrHeaderRules(profileIndex);
    const requestHeaders = [
      ...Object.entries(setHeaders).map(([header, value]) => ({
        header,
        operation: "set",
        value
      })),
      ...removeHeaders.map((header) => ({
        header,
        operation: "remove"
      }))
    ];

    const addRules = targetTabId
      ? [
          {
            id: RULE_ID_MOBILE_HEADERS,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders
            },
            condition: {
              tabIds: [targetTabId],
              urlFilter: "||bing.com/",
              resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "image", "stylesheet", "font", "ping", "other"]
            }
          }
        ]
      : [
          {
            id: RULE_ID_MOBILE_API_SEARCH,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders
            },
            condition: {
              tabIds: [-1],
              urlFilter: "||bing.com/search",
              resourceTypes: ["xmlhttprequest", "other", "main_frame"]
            }
          },
          {
            id: RULE_ID_MOBILE_API_REPORT,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders
            },
            condition: {
              tabIds: [-1],
              urlFilter: "||bing.com/rewardsapp/reportActivity",
              resourceTypes: ["xmlhttprequest", "other"]
            }
          }
        ];

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ALL_MOBILE_DNR_RULE_IDS,
      addRules
    });
  } catch (e) {
    console.error("Lỗi kích hoạt Mobile Headers:", e);
    addLog(`⚠️ [DNR Mobile Headers] Lỗi cấu hình rule: ${e.message}`);
  }
};

export const BING_VOLATILE_SESSION_COOKIES = ["SRCHHPGUSR", "_SS"];

const invokeCookiesApi = (fn, arg) =>
  new Promise((resolve) => {
    try {
      const maybePromise = fn(arg, (result) => {
        if (chrome.runtime?.lastError) resolve(null);
        else resolve(result);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then((res) => resolve(res), () => resolve(null));
      }
    } catch (e) {
      resolve(null);
    }
  });

/**
 * Kiểm tra xem trình duyệt có cookie phiên đăng nhập Bing (_U và _EDGE_S) hay không
 */
export const hasBingAuthCookies = async () => {
  if (!chrome.cookies?.getAll) {
    return { hasU: false, hasEdgeS: false, authenticated: false };
  }
  try {
    const rawList = await invokeCookiesApi(chrome.cookies.getAll.bind(chrome.cookies), { domain: "bing.com" });
    const cookies = Array.isArray(rawList) ? rawList : [];
    const hasU = cookies.some((c) => c?.name === "_U" && Boolean(c?.value));
    const hasEdgeS = cookies.some((c) => c?.name === "_EDGE_S" && Boolean(c?.value));
    return { hasU, hasEdgeS, authenticated: hasU && hasEdgeS };
  } catch (e) {
    return { hasU: false, hasEdgeS: false, authenticated: false };
  }
};

/**
 * Xóa cookie giao diện Desktop (SRCHHPGUSR, _SS), MẶC ĐỊNH GIỮ NGUYÊN _EDGE_S, _U, MUID để bảo toàn phiên đăng nhập.
 */
export const resetBingDesktopSessionCookies = async (logFn = addLog, { includeEdgeSession = false } = {}) => {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) {
    return { clearedNames: [] };
  }
  try {
    const rawList = await invokeCookiesApi(chrome.cookies.getAll.bind(chrome.cookies), { domain: "bing.com" });
    const allCookies = Array.isArray(rawList) ? rawList : [];
    const targetNames = includeEdgeSession
      ? [...BING_VOLATILE_SESSION_COOKIES, "_EDGE_S"]
      : BING_VOLATILE_SESSION_COOKIES;
    const targets = allCookies.filter((c) => targetNames.includes(c?.name));
    const clearedNames = [];

    for (const cookie of targets) {
      const cleanHost = String(cookie.domain || "www.bing.com").replace(/^\./, "");
      const cookiePath = cookie.path || "/";
      const url = `http${cookie.secure ? "s" : ""}://${cleanHost}${cookiePath}`;
      const details = { url, name: cookie.name };
      if (cookie.storeId) details.storeId = cookie.storeId;

      const removed = await invokeCookiesApi(chrome.cookies.remove.bind(chrome.cookies), details);
      if (removed) clearedNames.push(cookie.name);
    }

    if (logFn) {
      const unique = Array.from(new Set(clearedNames));
      logFn(
        unique.length > 0
          ? `🧹 [Mobile Cookies Reset] Đã xóa cookie hiển thị Desktop (${unique.join(", ")}) — giữ nguyên phiên đăng nhập _EDGE_S/_U/MUID.`
          : "🧹 [Mobile Cookies Reset] Không có cookie hiển thị Desktop (SRCHHPGUSR/_SS) cần xóa."
      );
    }
    return { clearedNames };
  } catch (e) {
    return { clearedNames: [] };
  }
};

// Dọn dẹp rule/debugger sót lại lúc Service Worker khởi động (an toàn với mock)
disableMobileHeaders();
detachAllTargets();

// ==============================================================
// HELPER CHUNG CHO BÙ ĐIỂM, COOLDOWN KHÔNG CHẶN & ĐỒNG BỘ TRẠNG THÁI
// ==============================================================
export const fetchRewardsStatus = async () => {
  const overview = await fetchRewardsOverview();
  if (overview.success) return overview;

  const [rsc, flyout] = await Promise.all([
    fetchEarnPageRsc().catch(() => ({ success: false })),
    fetchFlyoutViewModel().catch(() => ({ success: false }))
  ]);

  const points = rsc.availablePoints || flyout.rawModel?.flyoutResult?.userStatus?.availablePoints || 0;
  const userStatus = flyout.rawModel?.flyoutResult?.userStatus || {};
  const pcRaw = userStatus.counters?.PCSearch || userStatus.counters?.pcSearch || [];
  const mobRaw = userStatus.counters?.MobileSearch || userStatus.counters?.mobileSearch || [];
  const sum = (arr) => {
    const seenIds = new Set();
    return (Array.isArray(arr) ? arr : [arr]).reduce(
      (a, x) => {
        if (!x || typeof x !== "object") return a;
        const idKey = String(x.offerId || x.name || x.attributes?.offerid || "").trim();
        if (idKey) {
          if (seenIds.has(idKey)) return a;
          seenIds.add(idKey);
        }
        return {
          earned: a.earned + (Number(x?.pointProgress) || 0),
          max: a.max + (Number(x?.pointProgressMax) || 0)
        };
      },
      { earned: 0, max: 0 }
    );
  };

  if (rsc.success || flyout.success) {
    return {
      success: true,
      availablePoints: points,
      pc: sum(pcRaw),
      mobile: sum(mobRaw),
      earnStreaks: rsc.streaks || [],
      earnOffersCount: rsc.offers?.length || 0
    };
  }
  return overview;
};

export const scheduleSearchCooldownRetry = async (
  { pendingPcRetry = null, pendingMobileRetry = null },
  currentEarned = 0,
  maxPoints = 0
) => {
  const existing = (await storageGet("searchRetryState")).searchRetryState || {};
  const nextState = {
    pendingPcRetry: pendingPcRetry !== null ? pendingPcRetry : Boolean(existing.pendingPcRetry),
    pendingMobileRetry: pendingMobileRetry !== null ? pendingMobileRetry : Boolean(existing.pendingMobileRetry),
    scheduledAt: Date.now()
  };
  await storageSet({ searchRetryState: nextState });
  try {
    chrome.alarms?.create?.(SEARCH_RETRY_ALARM_NAME, { delayInMinutes: 15.5 });
  } catch (e) {}
  addLog(
    `⏳ [Cooldown 15p] Phát hiện Microsoft tạm giới hạn cộng điểm tìm kiếm (${currentEarned}/${maxPoints} pts). Đã hẹn giờ ngầm 15.5 phút chạy bù tiếp để không làm kẹt các việc khác!`
  );
};

export const clearSearchRetryFlag = async (kind) => {
  const existing = (await storageGet("searchRetryState")).searchRetryState || {};
  const nextState = {
    ...existing,
    ...(kind === "pc" ? { pendingPcRetry: false } : { pendingMobileRetry: false })
  };
  if (!nextState.pendingPcRetry && !nextState.pendingMobileRetry) {
    await storageRemove("searchRetryState");
    try {
      await chrome.alarms?.clear?.(SEARCH_RETRY_ALARM_NAME);
    } catch (e) {}
  } else {
    await storageSet({ searchRetryState: nextState });
  }
};

const evaluateSearchCheckpoint = async ({
  kind,
  stepLabel,
  tracker,
  zeroLimit = 2,
  onZeroProgressMobile = null,
  onFirstZeroMobile = null
}) => {
  const mid = await fetchRewardsOverview();
  if (!mid.success) return { stop: false, cooldown: false };

  const bucket = kind === "mobile" ? mid.mobile : mid.pc;
  tracker.maxPoints = bucket.max;
  const currentEarned = bucket.earned;

  if (currentEarned > tracker.lastPoints) {
    const gained = currentEarned - tracker.lastPoints;
    tracker.totalGain += gained;
    tracker.lastPoints = currentEarned;
    tracker.hasGained = true;
    tracker.zeroCheckpoints = 0;
    addLog(`✅ [${stepLabel}] +${gained} pts! (${currentEarned}/${tracker.maxPoints} pts | Ví: ${mid.availablePoints})`);
  } else if (tracker.maxPoints === 0 || currentEarned < tracker.maxPoints) {
    tracker.zeroCheckpoints++;
    addLog(`⏳ [${stepLabel}] Điểm chưa tăng (${currentEarned}/${tracker.maxPoints} pts, mốc 0-tăng ${tracker.zeroCheckpoints}/${zeroLimit})`);

    if (kind === "mobile" && !tracker.hasGained && tracker.zeroCheckpoints < zeroLimit) {
      if (typeof onZeroProgressMobile === "function") {
        await onZeroProgressMobile(tracker.zeroCheckpoints);
      } else if (tracker.zeroCheckpoints === 1 && typeof onFirstZeroMobile === "function") {
        await onFirstZeroMobile();
      }
    }
  }

  if (tracker.maxPoints > 0 && currentEarned >= tracker.maxPoints) {
    addLog(`🎉 [${kind === "mobile" ? "Mobile Search" : "Web Search"}] Đã đạt tối đa ${currentEarned}/${tracker.maxPoints} pts!`);
    return { stop: true, cooldown: false };
  }

  if (tracker.maxPoints > 0 && currentEarned < tracker.maxPoints && tracker.zeroCheckpoints >= zeroLimit) {
    await scheduleSearchCooldownRetry(
      kind === "mobile" ? { pendingMobileRetry: true } : { pendingPcRetry: true },
      currentEarned,
      tracker.maxPoints
    );
    return { stop: true, cooldown: true };
  }

  return { stop: false, cooldown: false };
};

// ==========================================
// MODULE 1: TÌM KIẾM BING PC (WEB SEARCH)
// ==========================================
export const runPcSearch = async ({ isRetry = false } = {}) => {
  if (!state.isRunning) return;

  state.currentStep = "pc_search";
  setTaskStatus("pcSearch", "running");
  updateBadge("PC", "#0078D7");

  const targetCount = state.config.pcSearchCount || 30;
  if (!isRetry) {
    state.searchesTarget = targetCount;
    state.searchesDone = 0;
  }

  addLog(`💻 [Web Search${isRetry ? " Bù Cooldown" : ""}] Bắt đầu tìm kiếm Bing PC (2.5-4.5s/lượt + SERP IG Beacon)...`);

  const initialOverview = await fetchRewardsStatus();
  const tracker = { lastPoints: 0, maxPoints: 0, totalGain: 0, hasGained: false, zeroCheckpoints: 0 };

  if (initialOverview.success) {
    tracker.lastPoints = initialOverview.pc.earned;
    tracker.maxPoints = initialOverview.pc.max;
    addLog(`📊 [Tiến độ PC] Điểm hiện tại: ${tracker.lastPoints}/${tracker.maxPoints} pts | Ví: ${initialOverview.availablePoints}`);

    if (tracker.maxPoints > 0 && tracker.lastPoints >= tracker.maxPoints) {
      addLog(`🎉 [Web Search] Bạn đã đạt tối đa điểm PC hôm nay (${tracker.lastPoints}/${tracker.maxPoints} pts) — tự động bỏ qua!`);
      await clearSearchRetryFlag("pc");
      setTaskStatus("pcSearch", "done", `Đã đủ (${tracker.lastPoints}/${tracker.maxPoints} pts)`);
      return;
    }
  }

  let searchTab = null;
  const ensurePcTab = async () => {
    if (searchTab && searchTab.id) {
      try {
        const tab = await chrome.tabs.get(searchTab.id);
        if (tab && !tab.discarded) return searchTab.id;
      } catch (e) {}
    }
    const { windowId } = await ensureWorkerWindow();
    searchTab = await chrome.tabs.create({ url: "https://www.bing.com", active: true, windowId });
    await waitForTabComplete(searchTab.id, 4500);
    return searchTab.id;
  };

  let cooldownDeferred = false;

  try {
    await ensurePcTab();
    await sleep(300);

    const initialLoopCount = isRetry
      ? Math.min(targetCount, Math.max(5, Math.ceil((tracker.maxPoints - tracker.lastPoints) / 3) + 2))
      : targetCount;

    for (let i = 1; i <= initialLoopCount; i++) {
      if (!state.isRunning) break;

      const tabId = await ensurePcTab();
      const query = getRandomWord();
      addLog(`🔍 [PC ${i}/${initialLoopCount}] Tìm kiếm: "${query}"...`);

      try {
        await executeInPageSearchOnTab(tabId, query, false);
      } catch (tabErr) {
        addLog(`⚠️ Cảnh báo tab PC (${tabErr.message}), đang khôi phục...`);
        searchTab = null;
        await sleep(400);
        continue;
      }

      state.searchesDone++;
      chrome.runtime.sendMessage({
        action: "PROGRESS_UPDATE",
        module: "pcSearch",
        current: i,
        total: initialLoopCount
      }).catch(() => {});

      if (i % 3 === 0 || i === initialLoopCount) {
        const evalRes = await evaluateSearchCheckpoint({
          kind: "pc",
          stepLabel: `PC ${i}/${initialLoopCount}`,
          tracker
        });
        if (evalRes.cooldown) {
          cooldownDeferred = true;
          break;
        }
        if (evalRes.stop) break;
      }

      if (i < initialLoopCount && state.isRunning) {
        const delayUsed = await humanDelay(state.config.minSearchDelay, state.config.maxSearchDelay);
        addLog(`⏱️ Nghỉ ${(delayUsed / 1000).toFixed(1)}s.`);
      }
    }

    if (state.isRunning && !cooldownDeferred) {
      const postMain = await fetchRewardsOverview();
      if (postMain.success && postMain.pc.max > 0 && postMain.pc.earned < postMain.pc.max) {
        tracker.lastPoints = postMain.pc.earned;
        tracker.maxPoints = postMain.pc.max;
        const topUpLimit = Math.min(25, Math.ceil((tracker.maxPoints - tracker.lastPoints) / 3) + 4);
        addLog(`⚡ [Bù điểm PC] Hiện đạt ${tracker.lastPoints}/${tracker.maxPoints} pts — chạy thêm tối đa ${topUpLimit} lượt để đủ 100%...`);

        for (let t = 1; t <= topUpLimit; t++) {
          if (!state.isRunning) break;
          const tabId = await ensurePcTab();
          const query = getRandomWord();
          addLog(`🔍 [PC Bù ${t}/${topUpLimit}] "${query}"...`);
          await executeInPageSearchOnTab(tabId, query, false).catch(() => {});
          state.searchesDone++;

          if (t % 3 === 0 || t === topUpLimit) {
            const evalRes = await evaluateSearchCheckpoint({
              kind: "pc",
              stepLabel: `PC Bù ${t}/${topUpLimit}`,
              tracker
            });
            if (evalRes.cooldown) {
              cooldownDeferred = true;
              break;
            }
            if (evalRes.stop) break;
          }

          if (t < topUpLimit && state.isRunning) {
            await humanDelay(state.config.minSearchDelay, state.config.maxSearchDelay);
          }
        }
      }
    }
  } finally {
    try {
      if (searchTab && searchTab.id) await chrome.tabs.remove(searchTab.id);
    } catch (e) {}
    searchTab = null;
  }

  const finalOverview = await fetchRewardsOverview();
  const finalEarned = finalOverview.success ? finalOverview.pc.earned : tracker.lastPoints;
  const finalMax = finalOverview.success ? finalOverview.pc.max : tracker.maxPoints;
  if (finalOverview.success) {
    addLog(`🎉 [Tổng kết PC] Điểm PC: ${finalEarned}/${finalMax} pts | Ví: ${finalOverview.availablePoints}`);
  }

  if (finalMax > 0 && finalEarned >= finalMax) {
    await clearSearchRetryFlag("pc");
    setTaskStatus("pcSearch", "done", `Đã đủ (${finalEarned}/${finalMax} pts)`);
  } else if (cooldownDeferred) {
    setTaskStatus("pcSearch", "warn", `Đang hẹn bù Cooldown (${finalEarned}/${finalMax} pts)`);
  } else if (finalMax > 0 && finalEarned === 0 && !tracker.hasGained && tracker.totalGain === 0) {
    setTaskStatus("pcSearch", "warn", `Chưa lên điểm (0/${finalMax} pts)`);
  } else {
    const scoreNote = finalMax > 0 ? `${finalEarned}/${finalMax} pts` : `${state.searchesDone} lượt`;
    setTaskStatus("pcSearch", "done", `Đã xong (${scoreNote})`);
  }
  addLog("✅ Hoàn tất phiên Bing PC Search!");
};

// ==========================================
// MODULE 2: TÌM KIẾM BING MOBILE v2.5.0 (SILENT DIRECT API ZERO-WINDOW -> 3 TAB FALLBACKS + CHECKPOINT 4 LƯỢT)
// ==========================================
export const executeDirectMobileApiSearch = async (query) => {
  const cvid = generateRandomHex(16);
  const serpUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`;

  const searchRes = await fetch(serpUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const rawUrl = String(searchRes.url || "");
  if (
    rawUrl.includes("login.live.com") ||
    rawUrl.includes("login.microsoftonline.com") ||
    rawUrl.includes("/fd/auth/signin")
  ) {
    return {
      ok: false,
      ig: "",
      limit: null,
      earned: null,
      balance: null,
      isMobileClient: null,
      isAuthenticated: false,
      rewardsIncrement: null,
      reason: "auth_redirect"
    };
  }

  const html = await searchRes.text().catch(() => "");
  const finalSerpUrl = rawUrl.includes("bing.com/search") ? rawUrl : serpUrl;
  const ig = extractSerpImpressionGuid(html);
  if (!ig) {
    return {
      ok: false,
      ig: "",
      limit: null,
      earned: null,
      balance: null,
      isMobileClient: null,
      isAuthenticated: null,
      rewardsIncrement: null,
      reason: "no_ig"
    };
  }

  const rep = await reportBingSerpActivity({
    serpUrl: finalSerpUrl,
    query,
    ig,
    formCode: "ANNTA1",
    cvid,
    referer: finalSerpUrl
  });

  return {
    ok: rep.ok,
    ig,
    limit: rep.parsedReport?.searchPointsLimit ?? null,
    earned: rep.parsedReport?.searchPointsEarned ?? null,
    balance: rep.parsedReport?.balance ?? null,
    isMobileClient: rep.parsedReport?.isMobileClient ?? null,
    isAuthenticated: rep.parsedReport?.isAuthenticated ?? null,
    rewardsIncrement: rep.parsedReport?.rewardsIncrement ?? null,
    reason: rep.ok ? null : rep.error || `HTTP ${rep.status}`
  };
};

export const runMobileSearch = async ({ isRetry = false } = {}) => {
  if (!state.isRunning) return;

  state.currentStep = "mobile_search";
  setTaskStatus("mobileSearch", "running");
  updateBadge("MOB", "#9B59B6");

  const targetCount = state.config.mobileSearchCount || 25;
  if (!isRetry) {
    state.mobileSearchesTarget = targetCount;
    state.mobileSearchesDone = 0;
  }

  addLog(
    `📱 [Mobile Search${isRetry ? " Bù Cooldown" : ""}] Khởi động v2.5.0 (Stage 0 Silent Direct API Zero-Window -> Android Chrome CDP -> iPhone Safari Zero-CH -> Pure DNR Tab)...`
  );
  await disableMobileHeaders();

  const initialOverview = await fetchRewardsStatus();
  const tracker = { lastPoints: 0, maxPoints: 0, totalGain: 0, hasGained: false, zeroCheckpoints: 0 };
  let lastWalletBalance = 0;

  if (initialOverview.success) {
    tracker.lastPoints = initialOverview.mobile.earned;
    tracker.maxPoints = initialOverview.mobile.max;
    lastWalletBalance = Number(initialOverview.availablePoints) || 0;
    addLog(`📊 [Tiến độ Mobile] Điểm ban đầu: ${tracker.lastPoints}/${tracker.maxPoints} pts | Ví: ${initialOverview.availablePoints}`);

    if (tracker.maxPoints > 0 && tracker.lastPoints >= tracker.maxPoints) {
      addLog(`🎉 [Mobile Search] Bạn đã đạt tối đa điểm Mobile hôm nay (${tracker.lastPoints}/${tracker.maxPoints} pts) — tự động bỏ qua!`);
      await clearSearchRetryFlag("mobile");
      setTaskStatus("mobileSearch", "done", `Đã đủ (${tracker.lastPoints}/${tracker.maxPoints} pts)`);
      return;
    }
  }

  await resetBingDesktopSessionCookies(addLog);

  let searchTab = null;
  // Stage 0: Silent Direct Mobile API (Zero-Window, tabIds:[-1])
  // Stage 1: Android 10 Chrome CDP + DNR Tab
  // Stage 2: iPhone iOS 18.3 Safari CDP + DNR Tab (Zero Client Hints)
  // Stage 3: Pure DNR Normal Tab (Zero chrome.debugger, form=LWS001)
  let stage = 0;
  let mobileEngine = "api"; // "api" | "cdp" | "dnr_tab"
  let activeProfileIndex = 0;
  let cdpAttached = false;
  let desktopLimitHits = 0;
  let signInCheckedForProfile = false;
  let cooldownDeferred = false;
  let lastObservedLimit = null;
  let lastSignedIn = null;
  let lastApiReason = null;

  await enableMobileHeaders(null, 0);

  const waitMobileGap = async () => {
    const rawMin = Number(state.config.minSearchDelay ?? 2.5);
    const rawMax = Number(state.config.maxSearchDelay ?? 4.5);
    const minD = rawMin < 1 ? rawMin : Math.max(5.0, rawMin);
    const maxD = rawMin < 1 ? rawMax : Math.max(7.5, rawMax);
    const delayUsed = await humanDelay(minD, maxD);
    addLog(`⏱️ Nghỉ Mobile ${(delayUsed / 1000).toFixed(1)}s.`);
  };

  const teardownMobileTab = async () => {
    if (searchTab?.id) {
      try {
        await detachMobileEmulation(searchTab.id);
        await chrome.tabs.remove(searchTab.id);
      } catch (e) {}
    }
    searchTab = null;
    cdpAttached = false;
    await disableMobileHeaders();
    await detachAllTargets();
    await closeMobileWindow();
  };

  const ensureMobileTab = async (profileIdx = activeProfileIndex, useDebugger = mobileEngine === "cdp") => {
    if (searchTab && searchTab.id) {
      try {
        const tab = await chrome.tabs.get(searchTab.id);
        if (tab && !tab.discarded) return { tabId: searchTab.id, cdpAttached };
      } catch (e) {}
    }

    if (searchTab && searchTab.id) {
      try {
        await detachMobileEmulation(searchTab.id);
        await chrome.tabs.remove(searchTab.id);
      } catch (e) {}
    }
    searchTab = null;
    cdpAttached = false;

    const { windowId, initialTabId } = await ensureMobileWindow();
    searchTab = initialTabId
      ? { id: initialTabId, windowId }
      : await chrome.tabs.create({ url: "about:blank", active: true, windowId });

    // DNR chỉ gắn tabIds: [searchTab.id] (không gắn -1) trước khi điều hướng khỏi about:blank
    await enableMobileHeaders(searchTab.id, profileIdx);

    if (useDebugger) {
      cdpAttached = await attachMobileEmulation(searchTab.id, profileIdx);
      if (!cdpAttached) {
        await sleep(400);
        cdpAttached = await attachMobileEmulation(searchTab.id, profileIdx);
      }
      if (!cdpAttached) {
        addLog(`⚠️ [CDP Stage ${stage}] Không thể gắn debugger cho tab ${searchTab.id} — dùng Pure DNR + Scripting fallback.`);
      }
    }

    await chrome.tabs.update(searchTab.id, { url: "https://www.bing.com/" });
    await waitForTabComplete(searchTab.id, 6500, "bing.com");
    await sleep(400);

    let verify = { ua: "", isMobileData: false, platform: "", width: 0, isMobileUa: false };
    if (cdpAttached) {
      await applyMobileOverrides(searchTab.id, profileIdx);
      verify = await verifyMobileEmulation(searchTab.id);
      const isDesktopPlat = /^Win|^MacIntel|^Linux x86_64/i.test(verify.platform || "");
      if (!verify.isMobileUa || isDesktopPlat) {
        await attachMobileEmulation(searchTab.id, profileIdx);
        await chrome.tabs.reload(searchTab.id).catch(() => {});
        await waitForTabComplete(searchTab.id, 6500, "bing.com");
        await applyMobileOverrides(searchTab.id, profileIdx);
        verify = await verifyMobileEmulation(searchTab.id);
      }
    }

    const authCookies = await hasBingAuthCookies();
    let session = cdpAttached
      ? await checkMobileBingSession(searchTab.id, authCookies.authenticated)
      : await checkMobileBingSessionViaScripting(searchTab.id, authCookies.authenticated);

    if (session && session.isSignedIn === false && !signInCheckedForProfile) {
      signInCheckedForProfile = true;
      addLog("🔐 [Mobile Session] Phát hiện tab Mobile chưa đồng bộ đăng nhập Bing — tự động đồng bộ qua fd/auth/signin...");
      await chrome.tabs.update(searchTab.id, {
        url: "https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F"
      });
      await waitForBingSignInLanding(searchTab.id, 8000);
      await sleep(400);
      if (cdpAttached) {
        await applyMobileOverrides(searchTab.id, profileIdx);
      }
      const afterAuthCookies = await hasBingAuthCookies();
      session = cdpAttached
        ? await checkMobileBingSession(searchTab.id, afterAuthCookies.authenticated)
        : await checkMobileBingSessionViaScripting(searchTab.id, afterAuthCookies.authenticated);
    }

    lastSignedIn = session?.isSignedIn ?? null;
    const modeTag = cdpAttached
      ? `CDP Stage ${stage}/Profile ${profileIdx}`
      : `DNR Tab Stage ${stage}/Profile ${profileIdx}`;
    addLog(
      `📱 [${modeTag}] MobileUA=${cdpAttached ? verify.isMobileUa : "DNR"}, Platform=${cdpAttached ? verify.platform : "DNR"}, Width=${session?.width || verify.width || 0}, SignedIn=${session?.isSignedIn} (${session?.signInSource || "?"})`
    );
    return { tabId: searchTab.id, cdpAttached };
  };

  const advanceMobileStage = async (reason) => {
    await teardownMobileTab();
    await resetBingDesktopSessionCookies(addLog);
    desktopLimitHits = 0;
    signInCheckedForProfile = false;
    cdpAttached = false;

    if (stage === 0) {
      stage = 1;
      mobileEngine = "cdp";
      activeProfileIndex = 0;
      addLog(`🔄 [Mobile Auto-Switch -> Stage 1] ${reason} -> chuyển sang CDP Android 10 Chrome Tab (PC=U531/ANNTA1)!`);
      await ensureMobileTab(0, true);
      await sleep(400);
    } else if (stage === 1) {
      stage = 2;
      mobileEngine = "cdp";
      activeProfileIndex = 1;
      addLog(`🔄 [Mobile Auto-Switch -> Stage 2] ${reason} -> chuyển sang CDP iPhone iOS 18.3 Safari (Zero Client Hints)!`);
      await ensureMobileTab(1, true);
      await sleep(400);
    } else if (stage === 2) {
      stage = 3;
      mobileEngine = "dnr_tab";
      activeProfileIndex = 2;
      addLog(`🔄 [Mobile Auto-Switch -> Stage 3] ${reason} -> chuyển sang Pure DNR Normal Tab (Không Debugger, form=LWS001)!`);
      await ensureMobileTab(2, false);
      await sleep(400);
    } else {
      await ensureMobileTab(2, false);
    }
  };

  const performOneMobileSearch = async (query, label) => {
    if (mobileEngine === "api") {
      const apiRes = await executeDirectMobileApiSearch(query).catch((e) => ({ ok: false, reason: e.message, limit: null }));
      if (apiRes.limit !== null && apiRes.limit !== undefined) lastObservedLimit = apiRes.limit;
      if (apiRes.reason) lastApiReason = apiRes.reason;
      if (typeof apiRes.isAuthenticated === "boolean") lastSignedIn = apiRes.isAuthenticated;

      if (typeof apiRes.balance === "number" && lastWalletBalance > 0 && apiRes.balance > lastWalletBalance) {
        lastWalletBalance = apiRes.balance;
        tracker.hasGained = true;
        tracker.zeroCheckpoints = 0;
      }

      if (apiRes.reason === "auth_redirect" || apiRes.isAuthenticated === false) {
        addLog(`⚠️ [${label}] Silent Mobile API cần đồng bộ đăng nhập (${apiRes.reason || "unauthenticated"}).`);
        if (stage === 0) {
          await advanceMobileStage("Silent Direct API cần đồng bộ phiên đăng nhập qua Tab");
        }
        return;
      }

      const isDesktopOrFailed =
        !apiRes.ok ||
        apiRes.isMobileClient === false ||
        (apiRes.isMobileClient !== true && (apiRes.limit === 90 || apiRes.limit === 180));

      if (isDesktopOrFailed) {
        desktopLimitHits++;
        addLog(
          `⚠️ [${label}] Silent Mobile API chưa chuẩn Mobile (mobile=${apiRes.isMobileClient}, limit=${apiRes.limit ?? "?"}, reason=${apiRes.reason || "desktop"}, lần ${desktopLimitHits}).`
        );
        if (desktopLimitHits >= 2 && stage === 0) {
          await advanceMobileStage("Silent Direct API trả về Desktop hoặc lỗi");
        }
        return;
      }

      desktopLimitHits = 0;
      addLog(
        `✅ [${label}] Silent Mobile API OK (mobile=${apiRes.isMobileClient ?? true}, auth=${apiRes.isAuthenticated ?? true}, inc=+${apiRes.rewardsIncrement ?? 0}, balance=${apiRes.balance ?? "?"})`
      );
      return;
    }

    let searchRes;
    if (mobileEngine === "dnr_tab") {
      const { tabId } = await ensureMobileTab(activeProfileIndex, false);
      searchRes = await executeInPageSearchOnTab(tabId, query, true, {
        useCdp: false,
        formCodeOverride: "LWS001",
        directUrlOverride: "https://www.bing.com/search?q={q}&form=LWS001&cvid={cvid}",
        directNavigateOnly: true
      });
    } else {
      const { tabId, cdpAttached: usingCdp } = await ensureMobileTab(activeProfileIndex, true);
      const isSafariStage = stage === 2;
      const formCodeOverride = isSafariStage ? "QBRE" : "ANNTA1";
      const directUrlOverride = isSafariStage
        ? "https://www.bing.com/search?q={q}&form=QBRE&cvid={cvid}"
        : "https://www.bing.com/search?q={q}&PC=U531&FORM=ANNTA1&cvid={cvid}";
      searchRes = await executeInPageSearchOnTab(tabId, query, true, {
        useCdp: usingCdp,
        formCodeOverride,
        directUrlOverride
      });
    }

    const eng = searchRes?.engagement;
    if (eng?.limit !== null && eng?.limit !== undefined) lastObservedLimit = eng.limit;
    if (typeof eng?.balance === "number" && lastWalletBalance > 0 && eng.balance > lastWalletBalance) {
      lastWalletBalance = eng.balance;
      tracker.hasGained = true;
      tracker.zeroCheckpoints = 0;
    }
    if (eng && (eng.ig || (eng.limit !== null && eng.limit !== undefined) || (eng.earned !== null && eng.earned !== undefined))) {
      addLog(
        `📡 [${label}] SERP Telemetry: mobile=${eng.isMobileClient ?? "?"}, limit=${eng.limit ?? "?"}, earned=${eng.earned ?? "?"}, balance=${eng.balance ?? "?"}, ig=${eng.ig ? eng.ig.slice(0, 8) + "..." : "none"}`
      );
    }
    if (
      eng?.isMobileClient === false ||
      (eng?.isMobileClient !== true && (eng?.limit === 90 || eng?.limit === 180))
    ) {
      desktopLimitHits++;
      addLog(
        `⚠️ [${label}] Bing báo Desktop (mobile=${eng?.isMobileClient}, limit=${eng?.limit}) trên Stage ${stage} (lần ${desktopLimitHits}).`
      );
      if (desktopLimitHits >= 2 && stage < 3) {
        await advanceMobileStage(`Bing trả Desktop trên Stage ${stage}`);
      }
    } else if (eng?.isMobileClient === true) {
      desktopLimitHits = 0;
    }
  };

  const onZeroProgressMobile = async (zeroCount) => {
    if (zeroCount === 1 && stage < 1) {
      await advanceMobileStage("Điểm Mobile chưa tăng sau 4 lượt ở Stage 0 Silent Direct API");
    } else if (zeroCount === 2 && stage < 2) {
      await advanceMobileStage("Điểm Mobile chưa tăng sau Stage 1 Android Chrome CDP");
    } else if (zeroCount >= 3 && stage < 3) {
      await advanceMobileStage("Điểm Mobile chưa tăng sau Stage 2 iPhone Safari CDP");
    }
  };

  try {
    const initialLoopCount = isRetry
      ? Math.min(targetCount, Math.max(tracker.lastPoints === 0 ? 16 : 6, Math.ceil((tracker.maxPoints - tracker.lastPoints) / 3) + 3))
      : targetCount;

    for (let i = 1; i <= initialLoopCount; i++) {
      if (!state.isRunning) break;

      const query = getRandomWord();
      addLog(`📱 [Mobile ${i}/${initialLoopCount}] (${mobileEngine.toUpperCase()} S${stage}) "${query}"...`);

      try {
        await performOneMobileSearch(query, `Mobile ${i}/${initialLoopCount}`);
      } catch (tabErr) {
        addLog(`⚠️ Cảnh báo Mobile (${tabErr.message}), đang tự động khôi phục...`);
        await teardownMobileTab();
        if (mobileEngine === "api") {
          await enableMobileHeaders(null, 0);
        }
        await sleep(400);
        continue;
      }

      state.mobileSearchesDone++;
      chrome.runtime.sendMessage({
        action: "PROGRESS_UPDATE",
        module: "mobileSearch",
        current: i,
        total: initialLoopCount
      }).catch(() => {});

      // Checkpoint mỗi 4 lượt (vì Microsoft áp dụng "Earning starts with your third search": 2 lượt đầu 0đ + 2 lượt sau +6đ)
      if (i % 4 === 0 || i === initialLoopCount) {
        const evalRes = await evaluateSearchCheckpoint({
          kind: "mobile",
          stepLabel: `Mobile ${i}/${initialLoopCount}`,
          tracker,
          zeroLimit: 4,
          onZeroProgressMobile
        });
        if (evalRes.cooldown) {
          cooldownDeferred = true;
          break;
        }
        if (evalRes.stop) break;
      }

      if (i < initialLoopCount && state.isRunning) {
        await waitMobileGap();
      }
    }

    if (state.isRunning && !cooldownDeferred) {
      const postMain = await fetchRewardsOverview();
      if (postMain.success && postMain.mobile.max > 0 && postMain.mobile.earned < postMain.mobile.max) {
        tracker.lastPoints = postMain.mobile.earned;
        tracker.maxPoints = postMain.mobile.max;
        const topUpLimit = Math.min(24, Math.ceil((tracker.maxPoints - tracker.lastPoints) / 3) + 4);
        addLog(`⚡ [Bù điểm Mobile] Hiện đạt ${tracker.lastPoints}/${tracker.maxPoints} pts — chạy thêm tối đa ${topUpLimit} lượt để đủ 100%...`);

        for (let t = 1; t <= topUpLimit; t++) {
          if (!state.isRunning) break;
          const query = getRandomWord();
          addLog(`📱 [Mobile Bù ${t}/${topUpLimit}] (${mobileEngine.toUpperCase()} S${stage}) "${query}"...`);
          await performOneMobileSearch(query, `Mobile Bù ${t}/${topUpLimit}`).catch(() => {});
          state.mobileSearchesDone++;

          if (t % 4 === 0 || t === topUpLimit) {
            const evalRes = await evaluateSearchCheckpoint({
              kind: "mobile",
              stepLabel: `Mobile Bù ${t}/${topUpLimit}`,
              tracker,
              zeroLimit: 4,
              onZeroProgressMobile
            });
            if (evalRes.cooldown) {
              cooldownDeferred = true;
              break;
            }
            if (evalRes.stop) break;
          }

          if (t < topUpLimit && state.isRunning) {
            await waitMobileGap();
          }
        }
      }
    }
  } finally {
    await teardownMobileTab();
    await closeMobileWindow();
  }

  const finalOverview = await fetchRewardsOverview();
  const finalEarned = finalOverview.success ? finalOverview.mobile.earned : tracker.lastPoints;
  const finalMax = finalOverview.success ? finalOverview.mobile.max : tracker.maxPoints;
  if (finalOverview.success) {
    addLog(`🎉 [Tổng kết Mobile] Điểm Mobile cuối cùng: ${finalEarned}/${finalMax} pts | Ví: ${finalOverview.availablePoints}`);
  }

  const diagParts = [];
  if (lastObservedLimit !== null) diagParts.push(`limit=${lastObservedLimit}`);
  if (lastSignedIn === false) diagParts.push("SignedIn=false");
  if (lastApiReason) diagParts.push(lastApiReason);
  const diagSuffix = diagParts.length > 0 ? ` | ${diagParts.join(", ")}` : "";

  if (finalMax > 0 && finalEarned >= finalMax) {
    await clearSearchRetryFlag("mobile");
    setTaskStatus("mobileSearch", "done", `Đã đủ (${finalEarned}/${finalMax} pts)`);
  } else if (cooldownDeferred) {
    const label =
      lastSignedIn === false && finalEarned === 0
        ? `Chưa đăng nhập Bing Mobile (${finalEarned}/${finalMax} pts${diagSuffix})`
        : `Đang hẹn bù Cooldown (${finalEarned}/${finalMax} pts${diagSuffix})`;
    setTaskStatus("mobileSearch", "warn", label);
  } else if (finalMax > 0 && finalEarned === 0 && !tracker.hasGained && tracker.totalGain === 0) {
    const label =
      lastSignedIn === false
        ? `Chưa đăng nhập Bing Mobile (0/${finalMax} pts${diagSuffix})`
        : `Chưa lên điểm (0/${finalMax} pts${diagSuffix})`;
    setTaskStatus("mobileSearch", "warn", label);
  } else {
    const scoreNote = finalMax > 0 ? `${finalEarned}/${finalMax} pts` : `${state.mobileSearchesDone} lượt`;
    setTaskStatus("mobileSearch", "done", `Đã xong (${scoreNote})`);
  }
  addLog("✅ Hoàn tất phiên Bing Mobile Search!");
};

// ==========================================
// MODULE 3: ĐỌC BÁO MSN NEWS (READ TO EARN - GIỮ NGUYÊN CƠ CHẾ ỔN ĐỊNH)
// ==========================================
const runMsnReading = async () => {
  if (!state.isRunning) return;

  state.currentStep = "reading_msn";
  setTaskStatus("readMsn", "running");
  updateBadge("READ", "#E67E22");

  const targetCount = state.config.readMsnCount || 10;
  state.articlesReadTarget = targetCount;
  state.articlesReadDone = 0;

  addLog(`📰 [Read to Earn] Bắt đầu phiên đọc tin tức Microsoft Rewards (${targetCount} bài)...`);

  const initialOverview = await fetchRewardsOverview();
  let startPoints = 0;
  if (initialOverview.success) {
    startPoints = initialOverview.availablePoints;
    addLog(`📊 [Điểm Rewards ban đầu] ${initialOverview.availablePoints} pts`);
  }

  await executeReadToEarn({
    isRunningCheck: () => state.isRunning,
    addLog,
    onProgress: (current, total) => {
      state.articlesReadDone = current;
      chrome.runtime.sendMessage({
        action: "PROGRESS_UPDATE",
        module: "readMsn",
        current,
        total
      }).catch(() => {});
    },
    targetCount,
    minDelay: 5,
    maxDelay: 8
  });

  const finalOverview = await fetchRewardsOverview();
  if (finalOverview.success) {
    const gained = finalOverview.availablePoints - startPoints;
    addLog(`🎉 [Tổng kết Read to Earn] Điểm Rewards sau khi đọc: ${finalOverview.availablePoints} pts (+${gained} pts)`);
  }

  setTaskStatus("readMsn", "done", `Đã xong (${state.articlesReadDone}/${targetCount} bài)`);
  addLog("✅ Đã hoàn thành trọn vẹn phiên đọc báo Read to Earn!");
};

// ==============================================================
// MODULE 4: TREO MÁY BỀN VỮNG (CỬA SỔ POPUP MINI + CHROME.POWER)
// ==============================================================

let isTickingStayAlive = false;
let isRecreatingStayWindow = false;
let isStoppingStayAlive = false;

const createStayAliveMiniWindow = async (url = STAY_ALIVE_URLS[0]) => {
  try {
    const stayWin = await createWindowSafe({
      url,
      type: "popup",
      width: 360,
      height: 260,
      left: 30,
      top: 30,
      focused: false
    });
    const stayTabId = stayWin.tabs?.[0]?.id || null;
    state.stayAliveWindowId = stayWin.id;
    state.stayAliveTabId = stayTabId;

    if (stayTabId) {
      chrome.tabs.update(stayTabId, { autoDiscardable: false }).catch(() => {});
    }
    return { windowId: stayWin.id, tabId: stayTabId };
  } catch (err) {
    // Fallback tạo pinned tab nếu không mở được cửa sổ popup
    const fallbackTab = await chrome.tabs.create({
      url,
      active: false,
      pinned: state.config.pinTab !== false
    });
    chrome.tabs.update(fallbackTab.id, { autoDiscardable: false }).catch(() => {});
    state.stayAliveWindowId = fallbackTab.windowId || null;
    state.stayAliveTabId = fallbackTab.id;
    return { windowId: null, tabId: fallbackTab.id };
  }
};

const injectStayAliveMainWorld = async (tabId) => {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__msRewardsVisibilitySpoofed) return;
        window.__msRewardsVisibilitySpoofed = true;
        try {
          Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
          Object.defineProperty(document, "webkitHidden", { configurable: true, get: () => false });
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
          Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
          document.hasFocus = () => true;
          const blockEvents = ["visibilitychange", "webkitvisibilitychange", "blur", "freeze", "pagehide"];
          for (const evtName of blockEvents) {
            window.addEventListener(evtName, (e) => e.stopImmediatePropagation(), true);
            document.addEventListener(evtName, (e) => e.stopImmediatePropagation(), true);
          }
        } catch (e) {}
      }
    });
  } catch (e) {}
};

const requestStayAlivePower = () => {
  if (state.config.preventSleepingMin === false) return;
  try {
    chrome.power?.requestKeepAwake?.("system");
  } catch (e) {}
};

const releaseStayAlivePower = () => {
  try {
    chrome.power?.releaseKeepAwake?.();
  } catch (e) {}
};

/**
 * Gỡ sạch state & storage TRƯỚC KHI đóng cửa sổ/tab để tabs.onRemoved không bao giờ mở lại orphan window!
 */
const teardownStayAliveResources = async () => {
  isStoppingStayAlive = true;
  try {
    try {
      await chrome.alarms?.clear?.(STAY_ALIVE_ALARM_NAME);
    } catch (e) {}

    const res = await storageGet("stayAliveSession");
    const session = res.stayAliveSession || state.stayAliveSession;
    const winId = session?.windowId || state.stayAliveWindowId;
    const tabId = session?.tabId || state.stayAliveTabId;

    state.stayAliveSession = null;
    state.stayAliveWindowId = null;
    state.stayAliveTabId = null;
    state.stayAliveSecondsRemaining = 0;

    await storageRemove("stayAliveSession");
    releaseStayAlivePower();

    if (winId) {
      try { await chrome.windows.remove(winId); } catch (e) {}
    } else if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
    }
  } finally {
    isStoppingStayAlive = false;
  }
};

let isRunningDeferredSearch = false;

export const checkStayAliveTick = async () => {
  await ensureStateHydrated();
  if (isTickingStayAlive || isStoppingStayAlive) return;
  isTickingStayAlive = true;

  try {
    const res = await storageGet("stayAliveSession");
    const session = res.stayAliveSession;
    if (!session || !session.active) {
      try { chrome.alarms?.clear?.(STAY_ALIVE_ALARM_NAME); } catch (e) {}
      return;
    }

    const now = Date.now();
    const durationMins = session.durationMinutes || 30;
    const targetSeconds = durationMins * 60;
    const mode = session.mode || "api_silent";

    const lastTick = session.lastTickTimestamp || now;
    const rawDelta = Math.max(0, Math.floor((now - lastTick) / 1000));
    const intervalSec = (session.reportIntervalMinutes || 5) * 60 + 10;
    const nextDue = session.nextReportDueAt || ((session.lastApiReportTimestamp || 0) + intervalSec * 1000);
    const apiDue = now >= nextDue;
    if (rawDelta < 1 && !apiDue) return;

    session.lastTickTimestamp = now;

    // Neo đồng hồ đếm ngược vào tiến độ thực tế trên server: KHÔNG bao giờ tự tụt xuống 0:00 khi server còn kẹt ở 5/30!
    const currentServerMinutes = Math.max(0, Number(session.serverMinutesCompleted || 0));
    const softCeilingSeconds = Math.min(targetSeconds - 5, (currentServerMinutes + 5) * 60 - 5);
    const steppedDelta = rawDelta >= 1 ? Math.min(rawDelta, 60) : 0;
    session.actualActiveSeconds = Math.min(
      softCeilingSeconds,
      Math.max(currentServerMinutes * 60, (session.actualActiveSeconds || 0) + steppedDelta)
    );

    // 1. Gọi EdgeDesktop/EdgeHub API mỗi 5 phút (+8-20s jitter) với cookies & warm-up chạy ngầm trong Service Worker
    if (apiDue) {
      session.lastApiReportTimestamp = now;
      const tickRes = await performEdgeBrowsingTick({
        addLog,
        silentOnly: true,
        skipBingWarmup: state.currentStep === "mobile_search"
      }).catch(() => ({ apiFailed: true }));

      if (tickRes.complete) {
        session.serverMinutesCompleted = durationMins;
        session.actualActiveSeconds = targetSeconds;
        session.mode = mode;
        state.stayAliveSession = session;
        await storageSet({ stayAliveSession: session });
        await finishStayAliveSession();
        return;
      }

      if (tickRes.apiFailed) {
        session.apiErrorCount = (session.apiErrorCount || 0) + 1;
        session.nextReportDueAt = now + 90 * 1000;
        if (mode === "api_silent" && session.apiErrorCount >= 2 && !session.tabId) {
          session.mode = "window_fallback";
          addLog("⚠️ [Edge Browsing API] API tạm thời không phản hồi 2 nhịp — chuyển sang mở tab MSN ngầm dự phòng...");
          const { windowId, tabId } = await createStayAliveMiniWindow(STAY_ALIVE_URLS[0]);
          session.windowId = windowId;
          session.tabId = tabId;
          if (tabId) {
            await waitForTabComplete(tabId, 5000);
            await injectStayAliveMainWorld(tabId);
            chrome.tabs.sendMessage(tabId, { action: "START_STAY_ALIVE_TAB" }).catch(() => {});
          }
        }
      } else if (tickRes.isDuplicate) {
        session.apiErrorCount = 0;
        if (tickRes.serverMinutesKnown) {
          session.serverMinutesCompleted = Math.max(currentServerMinutes, tickRes.minutesCompleted || 0);
        }
        session.actualActiveSeconds = Math.max(session.serverMinutesCompleted * 60, Math.min(softCeilingSeconds, session.actualActiveSeconds));
        session.nextReportDueAt = now + 65 * 1000;
        addLog(`ℹ️ [Edge Browsing API] Server báo duplicate — tự thử lại sau 65s (server hiện tại: ${session.serverMinutesCompleted}/${durationMins}p).`);
      } else if (tickRes.success) {
        session.apiErrorCount = 0;
        session.acceptedReports = (session.acceptedReports || 0) + 1;
        if (tickRes.reportIntervalMinutes) {
          session.reportIntervalMinutes = tickRes.reportIntervalMinutes;
        }
        session.serverMinutesCompleted = tickRes.serverMinutesKnown
          ? Math.max(currentServerMinutes, tickRes.minutesCompleted || 0)
          : Math.min(durationMins, currentServerMinutes + 5);
        session.actualActiveSeconds = session.serverMinutesCompleted * 60;
        const jitterSec = 8 + Math.floor(Math.random() * 12);
        session.nextReportDueAt = now + ((session.reportIntervalMinutes || 5) * 60 + jitterSec) * 1000;
        setTaskStatus("stayAlive", "running", `Đã ghi nhận ${session.serverMinutesCompleted}/${durationMins}p trên server`);
      }
    }

    const actualSeconds = session.actualActiveSeconds;
    const elapsedMinutes = Math.floor(actualSeconds / 60);
    const remainingSeconds = Math.max(0, targetSeconds - actualSeconds);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);

    state.stayAliveSession = session;
    state.stayAliveTabId = session.tabId || null;
    state.stayAliveWindowId = session.windowId || null;
    state.stayAliveSecondsRemaining = remainingSeconds;
    state.stayAliveTotalMinutes = session.durationMinutes || 30;
    state.taskStatus.stayAlive = "running";
    if (!state.currentStep || state.currentStep === "idle") {
      state.currentStep = "staying_alive";
    }

    await storageSet({ stayAliveSession: session });

    if (state.currentStep === "staying_alive") {
      updateBadge(`${remainingMinutes}m`, "#28A745");
    }

    try {
      chrome.runtime.sendMessage({
        action: "PROGRESS_UPDATE",
        module: "stayAlive",
        secondsRemaining: remainingSeconds,
        minutesElapsed: elapsedMinutes,
        summary: state.taskSummary.stayAlive || ""
      }).catch(() => {});
    } catch (e) {}

    // 2. Chỉ duy trì & xoay vòng cửa sổ MSN nếu đang ở chế độ fallback (Zero-Window khi api_silent)
    if (session.mode === "window_fallback") {
      let needRecreate = false;
      if (session.windowId) {
        try {
          const win = await chrome.windows.get(session.windowId);
          if (win && win.state === "minimized" && state.config.preventSleepingMin !== false) {
            await chrome.windows.update(session.windowId, { state: "normal", focused: false }).catch(() => {});
          }
        } catch (e) {
          needRecreate = true;
        }
      }

      if (!needRecreate && session.tabId) {
        try {
          const tab = await chrome.tabs.get(session.tabId);
          if (tab.discarded) {
            await chrome.tabs.reload(session.tabId).catch(() => {});
          }
          chrome.tabs.update(session.tabId, { autoDiscardable: false, active: true }).catch(() => {});
        } catch (e) {
          needRecreate = true;
        }
      } else if (!session.tabId) {
        needRecreate = true;
      }

      if (needRecreate && !isRecreatingStayWindow && !isStoppingStayAlive) {
        isRecreatingStayWindow = true;
        try {
          const { windowId, tabId } = await createStayAliveMiniWindow(STAY_ALIVE_URLS[0]);
          session.windowId = windowId;
          session.tabId = tabId;
          state.stayAliveSession = session;
          await storageSet({ stayAliveSession: session });
          addLog("⚠️ [Treo máy Fallback] Đã khôi phục tab MSN dự phòng.");
          if (tabId) {
            await waitForTabComplete(tabId, 5000);
            await injectStayAliveMainWorld(tabId);
            chrome.tabs.sendMessage(tabId, { action: "START_STAY_ALIVE_TAB" }).catch(() => {});
          }
        } catch (err) {
        } finally {
          isRecreatingStayWindow = false;
        }
      }

      const navInterval = Math.floor(actualSeconds / 150);
      if (navInterval > 0 && navInterval > (session.lastNavInterval || 0) && actualSeconds < targetSeconds) {
        session.lastNavInterval = navInterval;
        state.stayAliveSession = session;
        await storageSet({ stayAliveSession: session });
        if (session.tabId) {
          const nextUrl = STAY_ALIVE_URLS[navInterval % STAY_ALIVE_URLS.length];
          chrome.tabs.update(session.tabId, { url: nextUrl }).catch(() => {});
        }
      }
    }

    // Nhắc nhở mỗi 10 phút
    const currentInterval = Math.floor(elapsedMinutes / 10) * 10;
    if (currentInterval > 0 && currentInterval > (session.lastAlertInterval || 0) && actualSeconds < targetSeconds) {
      session.lastAlertInterval = currentInterval;
      state.stayAliveSession = session;
      await storageSet({ stayAliveSession: session });

      addLog(`🔔 [Mốc ${currentInterval}/${session.durationMinutes || 30} phút] Hệ thống Edge Browsing API vẫn đang chạy ngầm ổn định!`);

      try {
        chrome.notifications?.create?.({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Microsoft Rewards Master",
          message: `Treo máy ngầm đã đạt ${currentInterval}/${session.durationMinutes || 30} phút.`
        });
      } catch (e) {}
    }

    if (actualSeconds >= targetSeconds) {
      await finishStayAliveSession();
    }
  } finally {
    isTickingStayAlive = false;
  }
};

export const finishStayAliveSession = async () => {
  await teardownStayAliveResources();
  setTaskStatus("stayAlive", "done", `Đã hoàn tất ${state.config.stayAliveMinutes || 30} phút`);
  addLog("🎉 ĐÃ HOÀN THÀNH TRỌN VẸN 30/30 PHÚT DUYỆT WEB MICROSOFT EDGE!");

  try {
    chrome.notifications?.create?.({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Treo Máy Hoàn Tất",
      message: "Chúc mừng! Nhiệm vụ Browse with Microsoft Edge (30 phút) đã hoàn thành."
    });
  } catch (e) {}

  updateBadge("DONE", "#28A745");
};

export const stopStayAliveSession = async () => {
  await teardownStayAliveResources();
  if (state.taskStatus.stayAlive === "running") {
    setTaskStatus("stayAlive", "idle");
  } else {
    broadcastState();
  }
};

export const runStayAlive = async () => {
  if (!state.isRunning) return;
  await ensureStateHydrated();

  if (state.currentStep === "idle" || !state.currentStep) {
    state.currentStep = "staying_alive";
  }
  setTaskStatus("stayAlive", "running");
  requestStayAlivePower();

  const durationMins = state.config.stayAliveMinutes || 30;
  const targetSeconds = durationMins * 60;
  addLog(`☕ [Treo máy 30p] Bắt đầu chế độ chạy ngầm 100% qua API EdgeDesktop/EdgeHub (không mở cửa sổ MSN, tự chạy cả khi thu nhỏ Edge / chuyển tab)...`);

  // Gửi nhịp kiểm tra/báo cáo đầu tiên hoàn toàn ngầm trong Service Worker (Zero-Window Default)
  const firstTick = await performEdgeBrowsingTick({ addLog }).catch(() => ({ apiFailed: true, complete: false, minutesCompleted: 0 }));

  if (firstTick.complete) {
    await finishStayAliveSession();
    return;
  }

  const mode = firstTick.apiFailed ? "window_fallback" : "api_silent";
  let stayWinId = null;
  let stayTabId = null;

  if (mode === "window_fallback") {
    addLog(`ℹ️ [Treo máy Fallback] Chưa dùng được Edge API (${firstTick.reason || "mất token"}) — chuyển sang mở tab MSN dự phòng.`);
    const created = await createStayAliveMiniWindow(STAY_ALIVE_URLS[0]);
    stayWinId = created.windowId;
    stayTabId = created.tabId;
    if (stayTabId) {
      await waitForTabComplete(stayTabId, 6000);
      await injectStayAliveMainWorld(stayTabId);
      try {
        await chrome.tabs.sendMessage(stayTabId, { action: "START_STAY_ALIVE_TAB" });
      } catch (e) {}
    }
  }

  const oldRes = await storageGet("stayAliveSession");
  const serverMins = Math.max(0, Number(firstTick.minutesCompleted || 0));
  const previousActiveSeconds = (oldRes.stayAliveSession?.active && oldRes.stayAliveSession?.actualActiveSeconds) || 0;
  const syncedSeconds = Math.max(previousActiveSeconds, serverMins * 60);
  const nowTs = Date.now();
  const nextReportDelayMs = firstTick.isDuplicate
    ? 65 * 1000
    : ((firstTick.reportIntervalMinutes || 5) * 60 + 10) * 1000;

  const session = {
    active: true,
    mode,
    startTime: nowTs,
    durationMinutes: durationMins,
    targetSeconds,
    serverMinutesCompleted: serverMins,
    acceptedReports: firstTick.success && !firstTick.isDuplicate ? 1 : 0,
    actualActiveSeconds: syncedSeconds,
    windowId: stayWinId,
    tabId: stayTabId,
    lastTickTimestamp: nowTs,
    lastApiReportTimestamp: nowTs,
    nextReportDueAt: nowTs + nextReportDelayMs,
    apiErrorCount: firstTick.apiFailed ? 1 : 0,
    reportIntervalMinutes: firstTick.reportIntervalMinutes || 5,
    lastAlertInterval: Math.floor(Math.floor(syncedSeconds / 60) / 10) * 10,
    lastNavInterval: Math.floor(syncedSeconds / 150)
  };

  if (serverMins > 0) {
    setTaskStatus("stayAlive", "running", `Đã ghi nhận ${serverMins}/${durationMins}p trên server`);
  }

  state.stayAliveSession = session;
  state.stayAliveSecondsRemaining = Math.max(0, targetSeconds - syncedSeconds);
  await storageSet({ stayAliveSession: session });

  try {
    chrome.alarms?.create?.(STAY_ALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
  } catch (e) {}

  const remainingMins = Math.ceil(Math.max(0, targetSeconds - syncedSeconds) / 60);
  if (state.currentStep === "staying_alive") {
    updateBadge(`${remainingMins}m`, "#28A745");
  }

  while (
    state.stayAliveSession?.active &&
    (state.stayAliveSession.actualActiveSeconds || 0) < targetSeconds &&
    state.isRunning
  ) {
    await interruptibleSleep(1000);
    await checkStayAliveTick();
  }

  if (!state.isRunning && state.stayAliveSession?.active) {
    await stopStayAliveSession();
    return;
  }

  if (state.stayAliveSession?.active) {
    await finishStayAliveSession();
  }
};

// ==========================================
// MODULE 5, 6, 7: CHECK-IN, VISUAL SEARCH, QUESTS (SILENT API-FIRST)
// ==========================================
const applyWorkflowOutcomeStatus = (moduleKey, res, doneDefault, warnDefault) => {
  if (!res?.dailySetIncomplete && (res?.verified || res?.alreadyDone || (res?.gained || 0) > 0)) {
    setTaskStatus(moduleKey, "done", res.summary || doneDefault);
  } else if (res?.success) {
    setTaskStatus(moduleKey, "warn", res.summary || warnDefault);
  } else {
    setTaskStatus(moduleKey, "error", res?.summary || warnDefault);
  }
};

const lazyWorkerWindow = async () => {
  const { windowId } = await ensureWorkerWindow();
  return windowId;
};

const runDailyCheckin = async () => {
  if (!state.isRunning) return;
  state.currentStep = "daily_checkin";
  setTaskStatus("dailyCheckin", "running");
  updateBadge("CHK", "#107C41");
  addLog("📅 [Daily Check-in] Thực thi Silent API-First (SAIOS startapp/rwgobig -> /earn verify)...");

  try {
    const res = await runDailyCheckinWorkflow({
      isRunningCheck: () => state.isRunning,
      addLog,
      enableHeadersFunc: enableMobileHeaders,
      disableHeadersFunc: disableMobileHeaders,
      windowId: null,
      getWorkerWindowId: lazyWorkerWindow
    });
    applyWorkflowOutcomeStatus("dailyCheckin", res, "Đã điểm danh App Bing", "Chưa xác nhận điểm danh");
  } catch (err) {
    addLog(`❌ [Daily Check-in] Lỗi: ${err.message}`);
    setTaskStatus("dailyCheckin", "error", `Lỗi: ${err.message}`);
  }
};

const runVisualSearch = async () => {
  if (!state.isRunning) return;
  state.currentStep = "visual_search";
  setTaskStatus("visualSearch", "running");
  updateBadge("IMG", "#008080");
  addLog("📷 [Visual Search Streak] Thực thi Silent API-First (kblob -> bcid -> SERP IG Beacon)...");

  try {
    const res = await executeVisualSearchStreak({
      isRunningCheck: () => state.isRunning,
      addLog,
      windowId: null,
      getWorkerWindowId: lazyWorkerWindow,
      enableHeadersFunc: enableMobileHeaders,
      disableHeadersFunc: disableMobileHeaders
    });
    applyWorkflowOutcomeStatus("visualSearch", res, "Đã xác nhận 1/1", "Đã chạy — F5 /earn để kiểm tra");
  } catch (err) {
    addLog(`❌ [Visual Search] Lỗi: ${err.message}`);
    setTaskStatus("visualSearch", "error", `Lỗi: ${err.message}`);
  }
};

const runDailyQuests = async () => {
  if (!state.isRunning) return;
  state.currentStep = "daily_quests";
  setTaskStatus("dailyQuests", "running");
  updateBadge("QST", "#0078D7");
  addLog("🎯 [Daily Quests] Thực thi Silent API-First (/earn RSC Server Actions -> Flyout V1 -> Real Card Click Sync)...");

  state.questsDone = 0;
  state.questsTarget = 0;

  try {
    const res = await runDailyQuestsWorkflow({
      isRunningCheck: () => state.isRunning,
      addLog,
      windowId: null,
      getWorkerWindowId: lazyWorkerWindow,
      onProgress: (current, total) => {
        state.questsDone = current;
        state.questsTarget = total;
        chrome.runtime.sendMessage({
          action: "PROGRESS_UPDATE",
          module: "dailyQuests",
          current,
          total
        }).catch(() => {});
      }
    });
    applyWorkflowOutcomeStatus("dailyQuests", res, "Đã xong mọi quest", "Chưa tìm thấy quest mới");
  } catch (err) {
    addLog(`❌ [Daily Quests] Lỗi: ${err.message}`);
    setTaskStatus("dailyQuests", "error", `Lỗi: ${err.message}`);
  }
};

// ==========================================
// BỘ ĐIỀU PHỐI CHẠY CÁC MỤC ĐÃ CHỌN (BATCH)
// ==========================================
export const runSelectedBatch = async () => {
  await ensureStateHydrated();
  if (state.isRunning) {
    addLog("⚠️ Tiến trình đã đang chạy rồi!");
    return;
  }

  state.isRunning = true;
  Object.keys(state.taskStatus).forEach((k) => { state.taskStatus[k] = "idle"; });
  state.taskSummary = {};
  broadcastState();

  addLog("🚀 BẮT ĐẦU QUY TRÌNH v2.5.0 (SILENT DIRECT MOBILE API & API-FIRST TRƯỚC TOÀN BỘ TÁC VỤ BING WEB)...");

  try {
    let stayAlivePromise = null;

    if (state.selectedTasks.stayAlive) {
      addLog("⚡ [Chạy song song] Khởi động Treo máy 30p chạy ngầm 100% qua API (Zero-Window)...");
      stayAlivePromise = runStayAlive().catch((err) => {
        addLog(`⚠️ Lỗi tiến trình treo máy: ${err.message}`);
      });
      await sleep(350);
    }

    if (state.selectedTasks.dailyCheckin && state.isRunning) {
      await runDailyCheckin().catch((err) => addLog(`⚠️ Lỗi điểm danh: ${err.message}`));
    }

    // Chạy Mobile Search TRƯỚC Quests, Visual Search và PC Search để Bing không bị nhiễm session/cookies Desktop
    if (state.selectedTasks.mobileSearch && state.isRunning) {
      await runMobileSearch().catch((err) => addLog(`⚠️ Lỗi tìm kiếm Mobile: ${err.message}`));
    }

    if (state.selectedTasks.dailyQuests && state.isRunning) {
      await runDailyQuests().catch((err) => addLog(`⚠️ Lỗi Daily Quests: ${err.message}`));
    }

    if (state.selectedTasks.visualSearch && state.isRunning) {
      await runVisualSearch().catch((err) => addLog(`⚠️ Lỗi Visual Search: ${err.message}`));
    }

    if (state.selectedTasks.pcSearch && state.isRunning) {
      await runPcSearch().catch((err) => addLog(`⚠️ Lỗi tìm kiếm PC: ${err.message}`));
    }

    if (state.selectedTasks.readMsn && state.isRunning) {
      await runMsnReading().catch((err) => addLog(`⚠️ Lỗi đọc báo: ${err.message}`));
    }

    await closeMobileWindow();
    await closeWorkerWindow();

    if (stayAlivePromise && state.isRunning) {
      state.currentStep = "staying_alive";
      const remainingMins = Math.ceil((state.stayAliveSecondsRemaining || 0) / 60);
      addLog(`⏳ Các tác vụ khác đã xong! Treo máy 30p chạy ngầm nốt ~${remainingMins} phút còn lại (bạn có thể thu nhỏ Edge hoặc đổi tab thoải mái)...`);
      updateBadge(`${remainingMins}m`, "#28A745");
      broadcastState();
      await stayAlivePromise;
    }

    if (state.isRunning) {
      state.currentStep = "completed";
      updateBadge("DONE", "#28A745");
      broadcastState();
      addLog("🏆 CHÚC MỪNG: ĐÃ HOÀN TẤT TẤT CẢ CÁC MỤC BẠN ĐÃ CHỌN!");

      try {
        chrome.notifications?.create?.({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Microsoft Rewards Master",
          message: "Hoàn tất! Tất cả các mục bạn lựa chọn đã hoàn thành."
        });
      } catch (e) {}
    }
  } catch (err) {
    addLog(`❌ Đã xảy ra lỗi: ${err.message}`);
  } finally {
    state.isRunning = false;
    await disableMobileHeaders();
    await closeMobileWindow();
    await closeWorkerWindow();
    broadcastState();
  }
};

const stopAllWorkflows = async () => {
  await ensureStateHydrated();
  state.isRunning = false;
  state.currentStep = "idle";
  Object.keys(state.taskStatus).forEach((k) => {
    if (state.taskStatus[k] === "running") state.taskStatus[k] = "idle";
  });
  updateBadge("");
  await disableMobileHeaders();
  await stopStayAliveSession();
  await storageRemove("searchRetryState");
  try { await chrome.alarms?.clear?.(SEARCH_RETRY_ALARM_NAME); } catch (e) {}
  await closeMobileWindow();
  await closeWorkerWindow();
  await detachAllTargets();
  broadcastState();
  addLog("🛑 Đã dừng toàn bộ quy trình.");
};

// ==============================================================
// KHỞI ĐỘNG TỰ ĐỘNG & XỬ LÝ SỰ KIỆN ALARMS / STARTUP / TABS
// ==============================================================
chrome.debugger?.onDetach?.addListener((source, reason) => {
  console.log("[MS-Rewards-Master] Debugger detached từ tab:", source?.tabId, "Lý do:", reason);
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  const isStayTab = state.stayAliveSession?.active && (tabId === state.stayAliveTabId || tabId === state.stayAliveSession?.tabId);
  if (!isStayTab) return;

  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    injectStayAliveMainWorld(tabId);
  }
  if (changeInfo.status === "complete") {
    chrome.tabs.sendMessage(tabId, { action: "START_STAY_ALIVE_TAB" }).catch(() => {});
  }
});

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  if (isStoppingStayAlive || isRecreatingStayWindow) return;
  if (!state.stayAliveSession?.active || state.stayAliveSession?.mode !== "window_fallback") return;

  if (tabId === state.stayAliveTabId || tabId === state.stayAliveSession?.tabId) {
    isRecreatingStayWindow = true;
    addLog("⚠️ [CẢNH BÁO] Tab treo máy dự phòng vừa bị đóng! Đang mở lại tab mới...");
    try {
      const { windowId, tabId: newTabId } = await createStayAliveMiniWindow(STAY_ALIVE_URLS[0]);
      if (state.stayAliveSession?.active) {
        state.stayAliveSession.windowId = windowId;
        state.stayAliveSession.tabId = newTabId;
        await storageSet({ stayAliveSession: state.stayAliveSession });
      }
      if (newTabId) {
        await waitForTabComplete(newTabId, 5000);
        await injectStayAliveMainWorld(newTabId);
        chrome.tabs.sendMessage(newTabId, { action: "START_STAY_ALIVE_TAB" }).catch(() => {});
      }
    } catch (e) {
    } finally {
      isRecreatingStayWindow = false;
    }
  }
});

export const handleAlarmEvent = async (alarm) => {
  await ensureStateHydrated();
  if (alarm?.name === STAY_ALIVE_ALARM_NAME) {
    await checkStayAliveTick();
  } else if (alarm?.name === SEARCH_RETRY_ALARM_NAME) {
    if (isRunningDeferredSearch) return;
    if (["pc_search", "mobile_search", "reading_msn"].includes(state.currentStep)) return;

    const retryData = (await storageGet("searchRetryState")).searchRetryState;
    if (!retryData || (!retryData.pendingPcRetry && !retryData.pendingMobileRetry)) return;

    isRunningDeferredSearch = true;
    const prevRunning = state.isRunning;
    const prevStep = state.currentStep;
    state.isRunning = true;
    addLog("⏰ [Cooldown Retry] Đến giờ hẹn 15.5 phút — tự động chạy bù nốt điểm tìm kiếm PC/Mobile còn thiếu!");

    try {
      if (retryData.pendingPcRetry && state.isRunning) {
        await runPcSearch({ isRetry: true }).catch(() => {});
      }
      if (retryData.pendingMobileRetry && state.isRunning) {
        await runMobileSearch({ isRetry: true }).catch(() => {});
      }
      await closeMobileWindow();
      await closeWorkerWindow();
    } finally {
      isRunningDeferredSearch = false;
      state.isRunning = state.stayAliveSession?.active ? true : prevRunning;
      state.currentStep = state.stayAliveSession?.active ? "staying_alive" : prevStep || "completed";
      broadcastState();
    }
  }
};

chrome.alarms?.onAlarm?.addListener(handleAlarmEvent);

chrome.runtime?.onStartup?.addListener(async () => {
  console.log("[MS-Rewards-Master] Trình duyệt Edge vừa khởi động...");
  await disableMobileHeaders();
  await detachAllTargets();
  await ensureStateHydrated();

  const res = await storageGet(["config", "stayAliveSession"]);
  if (res.stayAliveSession && res.stayAliveSession.active) {
    const session = res.stayAliveSession;
    const targetSeconds = (session.durationMinutes || 30) * 60;
    const actualSeconds = session.actualActiveSeconds || 0;
    const remainingMins = Math.ceil(Math.max(0, targetSeconds - actualSeconds) / 60);

    if (actualSeconds < targetSeconds) {
      addLog(`🔄 [Khôi phục phiên] Edge vừa mở lại (${Math.floor(actualSeconds / 60)}/${session.durationMinutes || 30}p). Tiếp tục chạy ngầm...`);
      state.isRunning = true;
      state.currentStep = "staying_alive";
      session.lastTickTimestamp = Date.now();
      await storageSet({ stayAliveSession: session });
      chrome.alarms?.create?.(STAY_ALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
      runStayAlive();
    } else {
      await finishStayAliveSession();
    }
  }

  if (res.config?.autoStart && !state.isRunning) {
    addLog("⚡ [Auto-Start] Tự động khởi chạy các tác vụ đã chọn sau 5 giây...");
    setTimeout(() => {
      if (!state.isRunning) {
        runSelectedBatch();
      }
    }, 5000);
  }
});

chrome.runtime?.onInstalled?.addListener(async () => {
  console.log("[MS-Rewards-Master] Extension được cài đặt / cập nhật v2.5.0.");
  await disableMobileHeaders();
  await detachAllTargets();

  const res = await storageGet(["config", "selectedTasks"]);
  if (res.config) {
    const { config } = migrateStoredConfig(res.config);
    state.config = config;
    await storageSet({ config });
  }
  if (res.selectedTasks && res.selectedTasks.dailyQuests === undefined) {
    const updatedTasks = { ...state.selectedTasks, ...res.selectedTasks, dailyQuests: true };
    state.selectedTasks = updatedTasks;
    await storageSet({ selectedTasks: updatedTasks });
  }
});

// ==========================================
// GIAO TIẾP VỚI POPUP UI & CONTENT SCRIPTS
// ==========================================
export const handleRuntimeMessage = (request, sender, sendResponse) => {
  if (request.action === "START_SELECTED") {
    ensureStateHydrated().then(() => {
      if (request.selectedTasks) {
        state.selectedTasks = { ...state.selectedTasks, ...request.selectedTasks };
        saveConfig();
      }
      runSelectedBatch();
      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "START_MODULE") {
    ensureStateHydrated().then(() => {
      if (state.isRunning) {
        addLog("⚠️ Tiến trình khác đang chạy, vui lòng đợi hoặc bấm Dừng Lại!");
        sendResponse({ success: false, state });
        return;
      }

      state.isRunning = true;
      const mod = request.module;
      let promise = Promise.resolve();
      if (mod === "dailyCheckin") promise = runDailyCheckin();
      else if (mod === "dailyQuests") promise = runDailyQuests();
      else if (mod === "visualSearch") promise = runVisualSearch();
      else if (mod === "pcSearch") promise = runPcSearch();
      else if (mod === "mobileSearch") promise = runMobileSearch();
      else if (mod === "readMsn") promise = runMsnReading();
      else if (mod === "stayAlive") promise = runStayAlive();

      promise.catch((e) => {
        addLog(`❌ Lỗi module ${mod}: ${e.message}`);
      }).finally(async () => {
        state.isRunning = false;
        state.currentStep = "completed";
        if (mod !== "stayAlive") {
          await closeMobileWindow().catch(() => {});
          await closeWorkerWindow().catch(() => {});
        }
        updateBadge("");
        broadcastState();
      });

      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "STOP_ALL") {
    stopAllWorkflows().then(() => {
      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "DISMISS_ALERT") {
    state.pendingUserAlert = null;
    addLog("👍 Người dùng đã xác nhận kiểm tra quest.");
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "GET_STATE") {
    ensureStateHydrated().then(() => {
      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "CLEAR_LOGS") {
    ensureStateHydrated().then(async () => {
      state.logs = [];
      await storageSet({ logs: [] });
      broadcastState();
      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "GET_REWARDS_OVERVIEW") {
    fetchRewardsStatus().then((overview) => {
      sendResponse(overview);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (request.action === "UPDATE_SETTINGS") {
    ensureStateHydrated().then(() => {
      if (request.config) state.config = { ...state.config, ...request.config };
      if (request.selectedTasks) state.selectedTasks = { ...state.selectedTasks, ...request.selectedTasks };
      saveConfig();
      addLog("⚙️ Đã cập nhật cài đặt tác vụ.");
      sendResponse({ success: true, state });
    });
    return true;
  }

  if (request.action === "OPEN_VISUAL_SEARCH") {
    disableMobileHeaders().then(() => {
      chrome.tabs.create({ url: "https://www.bing.com/visualsearch?FORM=SBIVSP", active: true });
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "CHECK_IF_STAY_ALIVE_TAB") {
    ensureStateHydrated().then(() => {
      const isStayAlive = sender?.tab && (sender.tab.id === state.stayAliveTabId || sender.tab.id === state.stayAliveSession?.tabId);
      if (isStayAlive && sender.tab?.id) {
        injectStayAliveMainWorld(sender.tab.id);
      }
      sendResponse({ isStayAliveTab: Boolean(isStayAlive) });
    });
    return true;
  }

  if (request.action === "STAY_ALIVE_HEARTBEAT") {
    checkStayAliveTick().catch(() => {});
    sendResponse({ ok: true, remaining: state.stayAliveSecondsRemaining });
    return true;
  }
};

chrome.runtime?.onMessage?.addListener(handleRuntimeMessage);
