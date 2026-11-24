/**
 * Chrome DevTools Protocol (CDP) & Dynamic Mobile Identity Helper (v2.4.0)
 * - Tự động đọc phiên bản Chromium/Edge thực tế đang chạy.
 * - Cung cấp 3 Mobile Profiles sạch Client Hints:
 *   0: Android 10 Mobile Chrome (Chuẩn TheNetsky v5 - PC=U531/ANNTA1)
 *   1: iPhone iOS 18.3 Mobile Safari (Zero sec-ch-ua* Client Hints)
 *   2: Android 14 Mobile Chrome Pixel 8 (Pure DNR Normal Tab không cần CDP)
 * - Xuất danh sách header Desktop Edge & High-Entropy Client Hints cần gỡ để Bing không nhận nhầm Desktop.
 * - Parse ModernRewards.ReportActivity trong SERP để phát hiện DailySearchPointsLimit (120 vs 180).
 */

export const DESKTOP_EDGE_STRIP_HEADERS = [
  "sec-ms-gec",
  "sec-ms-gec-version",
  "x-edge-shopping-flag",
  "x-client-data",
  "x-rewards-source"
];

export const HIGH_ENTROPY_CLIENT_HINT_HEADERS = [
  "sec-ch-ua-platform-version",
  "sec-ch-ua-model",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-wow64",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list"
];

export const ALL_CLIENT_HINT_HEADERS = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  ...HIGH_ENTROPY_CLIENT_HINT_HEADERS
];

export const detectRunningChromiumVersion = () => {
  try {
    const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
    const match = ua.match(/(?:Edg|Chrome)\/(\d+\.\d+\.\d+\.\d+)/);
    if (match?.[1]) {
      const fullVersion = match[1];
      const major = fullVersion.split(".")[0];
      return { major, fullVersion };
    }
  } catch (e) {}
  return { major: "142", fullVersion: "142.0.0.0" };
};

const formatBrandList = (list) =>
  list.map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");

export const buildMobileProfiles = () => {
  const { major, fullVersion } = detectRunningChromiumVersion();

  const chromeAndroid = {
    title: `Android 10 Mobile Chrome ${major}`,
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    acceptLanguage: "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    platform: "Linux armv8l",
    clientHintsMode: "android",
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Not/A)Brand", version: "99" }
      ],
      fullVersionList: [
        { brand: "Chromium", version: fullVersion },
        { brand: "Not/A)Brand", version: "99.0.0.0" }
      ],
      platform: "Android",
      platformVersion: "14.0.0",
      architecture: "",
      model: "Pixel 8",
      mobile: true,
      bitness: "",
      uaFullVersion: fullVersion,
      wow64: false
    }
  };

  const iphoneSafari = {
    title: "iPhone iOS 18.3 Mobile Safari (Zero Client Hints)",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    acceptLanguage: "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    platform: "iPhone",
    clientHintsMode: "strip_all",
    userAgentMetadata: null
  };

  const pixelAndroidChrome = {
    title: `Android 14 Mobile Chrome ${major} (Pixel 8)`,
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    acceptLanguage: "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    platform: "Linux armv8l",
    clientHintsMode: "android",
    userAgentMetadata: {
      brands: [
        { brand: "Google Chrome", version: major },
        { brand: "Chromium", version: major },
        { brand: "Not_A Brand", version: "24" }
      ],
      fullVersionList: [
        { brand: "Google Chrome", version: fullVersion },
        { brand: "Chromium", version: fullVersion },
        { brand: "Not_A Brand", version: "24.0.0.0" }
      ],
      platform: "Android",
      platformVersion: "14.0.0",
      architecture: "",
      model: "Pixel 8",
      mobile: true,
      bitness: "",
      uaFullVersion: fullVersion,
      wow64: false
    }
  };

  return [chromeAndroid, iphoneSafari, pixelAndroidChrome];
};

export const getMobileDeviceConfig = (profileIndex = 0) => {
  const profiles = buildMobileProfiles();
  return profiles[profileIndex] || profiles[0];
};

export const MOBILE_DEVICE_CONFIG = getMobileDeviceConfig(0);

/**
 * Trả về tập HTTP headers sạch:
 * - iPhone Safari ("strip_all"): chỉ gửi User-Agent.
 * - Android Chrome ("android"): chỉ gửi 4 header low-entropy chuẩn (không gửi high-entropy Client Hints khi chưa được hỏi).
 */
export const getMobileHeaderSet = (profileIndex = 0) => {
  const cfg = getMobileDeviceConfig(profileIndex);
  if (cfg.clientHintsMode === "strip_all" || !cfg.userAgentMetadata) {
    return {
      "User-Agent": cfg.userAgent
    };
  }
  const meta = cfg.userAgentMetadata;
  return {
    "User-Agent": cfg.userAgent,
    "sec-ch-ua": formatBrandList(meta.brands),
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"'
  };
};

/**
 * Trả về quy tắc DNR gồm header cần ghi đè (setHeaders) và header cần gỡ bỏ (removeHeaders).
 */
export const getMobileDnrHeaderRules = (profileIndex = 0) => {
  const cfg = getMobileDeviceConfig(profileIndex);
  const setHeaders = getMobileHeaderSet(profileIndex);
  const removeHeaders =
    cfg.clientHintsMode === "strip_all"
      ? [...DESKTOP_EDGE_STRIP_HEADERS, ...ALL_CLIENT_HINT_HEADERS]
      : [...DESKTOP_EDGE_STRIP_HEADERS, ...HIGH_ENTROPY_CLIENT_HINT_HEADERS];
  return { setHeaders, removeHeaders };
};

const attachedTabIds = new Set();

export const getAttachedTabIds = () => Array.from(attachedTabIds);

export const sendCdpCommand = (tabId, method, params = {}, timeoutMs = 3500) => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          done(null);
        } else {
          done(result);
        }
      });
    } catch (e) {
      done(null);
    }
  });
};

/**
 * Chỉ gỡ các session debugger do chính mobile-cdp gắn (không đụng tới DevTools/extension target khác, chống treo 32s)
 */
export const detachAllTargets = async () => {
  const ownedIds = Array.from(attachedTabIds);
  attachedTabIds.clear();
  for (const tId of ownedIds) {
    try {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 2000);
        chrome.debugger.detach({ tabId: tId }, () => {
          chrome.runtime.lastError;
          done();
        });
      });
    } catch (e) {}
  }
};

/**
 * Tắt cache trên tab + ép toàn bộ UA & metrics qua CDP (không gọi Network.clearBrowserCache để tránh treo ổ đĩa)
 */
export const applyMobileOverrides = async (tabId, profileIndex = 0) => {
  if (!tabId) return false;
  const cfg = getMobileDeviceConfig(profileIndex);
  const uaPayload = {
    userAgent: cfg.userAgent,
    acceptLanguage: cfg.acceptLanguage,
    platform: cfg.platform
  };
  if (cfg.userAgentMetadata) {
    uaPayload.userAgentMetadata = cfg.userAgentMetadata;
  }

  await sendCdpCommand(tabId, "Network.setCacheDisabled", { cacheDisabled: true });
  await sendCdpCommand(tabId, "Network.setExtraHTTPHeaders", {
    headers: { "Accept-Language": cfg.acceptLanguage }
  });
  await sendCdpCommand(tabId, "Network.setUserAgentOverride", uaPayload);
  await sendCdpCommand(tabId, "Emulation.setUserAgentOverride", uaPayload);

  if (cfg.clientHintsMode === "strip_all") {
    await sendCdpCommand(tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        try {
          Object.defineProperty(Navigator.prototype, "userAgentData", {
            get: () => undefined,
            configurable: true
          });
        } catch (e) {}
      })();`
    });
  }

  await sendCdpCommand(tabId, "Emulation.setDeviceMetricsOverride", {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: cfg.deviceScaleFactor,
    mobile: true,
    screenWidth: cfg.width,
    screenHeight: cfg.height,
    positionX: 0,
    positionY: 0,
    screenOrientation: { type: "portraitPrimary", angle: 0 }
  });

  await sendCdpCommand(tabId, "Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5
  });

  return true;
};

/**
 * Hàm DOM tự chứa kiểm tra phiên đăng nhập Bing & giao diện Mobile (dùng chung cho CDP & chrome.scripting)
 */
export const inspectBingMobileDomSession = (hasAuthCookies = null) => {
  const url = window.location.href || "";
  const host = (window.location.hostname || "").toLowerCase();
  const isBingHost = host === "bing.com" || host.endsWith(".bing.com");
  const w = window.innerWidth || 0;
  const isMobileLayout = w > 0 && w <= 600;
  const hasSearchBox = Boolean(
    document.querySelector("#sb_form_q, textarea[name='q'], input[name='q'], .b_searchbox")
  );

  if (!isBingHost) {
    return {
      url,
      host,
      isBingHost: false,
      width: w,
      isMobileLayout,
      isSignedIn: false,
      hasSearchBox,
      signInSource: "not_bing_host"
    };
  }

  const model = window._model;
  const modelSignOut = Boolean(model && model.EnforceNotSignedIn === true);
  const modelSignedIn = Boolean(
    model &&
      !modelSignOut &&
      String(model.UserType || "").trim().toLowerCase() === "msa" &&
      Boolean(String(model.UserEmail || "").trim())
  );

  const badgeSelectors = ["#id_n", "#hb_s", "#id_rc", ".id_avatar"];
  let hasAccountBadge = false;
  for (const sel of badgeSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    const txt = (el.textContent || "").trim();
    if (sel === ".id_avatar" || (txt && !/^(?:sign|log)\s*in|đăng\s*nhập$/i.test(txt))) {
      hasAccountBadge = true;
      break;
    }
  }

  let explicitSignInLinkVisible = false;
  const signInCandidates = document.querySelectorAll('a[href*="/fd/auth/signin"], #id_l, #id_s');
  for (const el of signInCandidates) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    if (el.offsetParent !== null || st.display === "inline" || st.display === "block" || st.display === "flex") {
      explicitSignInLinkVisible = true;
      break;
    }
  }

  let isSignedIn = false;
  let signInSource = "unconfirmed";
  if (modelSignOut) {
    isSignedIn = false;
    signInSource = "model_enforce_signed_out";
  } else if (modelSignedIn) {
    isSignedIn = true;
    signInSource = "model_msa";
  } else if (hasAccountBadge) {
    isSignedIn = true;
    signInSource = "dom_badge";
  } else if (explicitSignInLinkVisible) {
    isSignedIn = false;
    signInSource = "dom_signin_link";
  } else if (hasAuthCookies !== null) {
    isSignedIn = Boolean(hasAuthCookies);
    signInSource = hasAuthCookies ? "auth_cookies" : "no_auth_cookies";
  }

  return {
    url,
    host,
    isBingHost,
    width: w,
    isMobileLayout,
    isSignedIn,
    hasSearchBox,
    signInSource
  };
};

/**
 * Kiểm tra trạng thái giao diện Bing Mobile, phiên đăng nhập và ô tìm kiếm trong tab qua CDP
 */
export const checkMobileBingSession = async (tabId, hasAuthCookies = null) => {
  const fallback = {
    url: "",
    host: "",
    isBingHost: false,
    width: 0,
    isMobileLayout: false,
    isSignedIn: false,
    hasSearchBox: false,
    signInSource: "cdp_fallback"
  };
  if (!tabId) return fallback;
  try {
    const res = await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(${inspectBingMobileDomSession.toString()})(${JSON.stringify(hasAuthCookies)})`,
      returnByValue: true
    });
    return res?.result?.value || fallback;
  } catch (e) {
    return fallback;
  }
};

/**
 * Kiểm tra ngay bên trong renderer xem trình duyệt đã nhận UA Mobile chưa
 */
export const verifyMobileEmulation = async (tabId) => {
  if (!tabId) return { ua: "", isMobileData: false, platform: "", width: 0, isMobileUa: false };
  try {
    const res = await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(() => ({
        ua: navigator.userAgent || "",
        isMobileData: Boolean(navigator.userAgentData && navigator.userAgentData.mobile),
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
        width: window.innerWidth || 0,
        isMobileUa: /Mobile|Android|iPhone|iPad|EdgA/i.test(navigator.userAgent || "")
      }))()`,
      returnByValue: true
    });
    return res?.result?.value || { ua: "", isMobileData: false, platform: "", width: 0, isMobileUa: false };
  } catch (e) {
    return { ua: "", isMobileData: false, platform: "", width: 0, isMobileUa: false };
  }
};

/**
 * Gắn debugger (có timeout 3s chống treo) và kích hoạt giả lập mobile chuẩn theo profileIndex
 */
export const attachMobileEmulation = async (tabId, profileIndex = 0) => {
  if (!tabId) return false;
  try {
    if (attachedTabIds.has(tabId)) {
      await detachMobileEmulation(tabId);
    }

    const tryAttachOnce = () =>
      new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), 3000);
        try {
          chrome.debugger.attach({ tabId }, "1.3", () => {
            if (chrome.runtime.lastError) {
              console.warn("[CDP] Lỗi attach debugger:", chrome.runtime.lastError.message);
              done(false);
            } else {
              done(true);
            }
          });
        } catch (e) {
          done(false);
        }
      });

    let attachSuccess = await tryAttachOnce();
    if (!attachSuccess) {
      await detachAllTargets();
      attachSuccess = await tryAttachOnce();
    }

    if (!attachSuccess) {
      console.warn(`[CDP] Thất bại khi gắn debugger cho tab ${tabId}.`);
      return false;
    }

    attachedTabIds.add(tabId);
    await sendCdpCommand(tabId, "Network.enable");
    await sendCdpCommand(tabId, "Page.enable");
    await applyMobileOverrides(tabId, profileIndex);

    return true;
  } catch (error) {
    console.warn("[CDP] Lỗi khi kích hoạt giả lập Mobile:", error);
    return false;
  }
};

/**
 * Gỡ bỏ debugger khỏi tab (có timeout 2s chống treo)
 */
export const detachMobileEmulation = async (tabId) => {
  if (!tabId) return false;
  attachedTabIds.delete(tabId);
  try {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      try {
        chrome.debugger.detach({ tabId }, () => {
          chrome.runtime.lastError;
          done();
        });
      } catch (e) {
        done();
      }
    });
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Gửi phím cứng Enter qua CDP
 */
export const dispatchCdpEnter = async (tabId) => {
  if (!tabId) return;
  try {
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      macCharCode: 13,
      unmodifiedText: "\r",
      text: "\r",
      key: "Enter",
      code: "Enter"
    });
    await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      macCharCode: 13,
      unmodifiedText: "\r",
      text: "\r",
      key: "Enter",
      code: "Enter"
    });
  } catch (e) {}
};

/**
 * Hàm DOM tự chứa thực hiện cuộn + gửi /rewardsapp/reportActivity cùng origin + đọc IsMobileClient/DailySearchPointsLimit
 */
export const inspectSerpAndSendBeaconInDom = async (query = "", cvid = "") => {
  try {
    await new Promise((r) => setTimeout(r, 350));
    window.scrollBy({ top: 340, behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 250));
    window.scrollBy({ top: 200, behavior: "smooth" });

    if (!window.location.pathname.toLowerCase().includes("/search")) {
      return { scrolled: true, beacon: false, reason: "not_serp", origin: window.location.origin || "" };
    }

    let ig = (window._G && typeof window._G.IG === "string") ? window._G.IG : "";
    if (!ig) {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const m = html.match(/\b["']?IG["']?\s*:\s*["']([A-F0-9]{32})["']/i);
      if (m && m[1]) ig = m[1];
    }
    if (!ig) {
      return { scrolled: true, beacon: false, reason: "no_ig", origin: window.location.origin || "" };
    }

    const u = new URL(window.location.href);
    const q = query || u.searchParams.get("q") || "";
    const formCode = u.searchParams.get("FORM") || u.searchParams.get("form") || "ANNTA1";
    const cid = cvid || u.searchParams.get("cvid") || "";
    const p = new URLSearchParams({
      IG: ig,
      IID: "SERP.5064",
      q,
      FORM: formCode,
      ajaxreq: "1"
    });
    if (cid) p.set("cvid", cid);

    const origin = window.location.origin || "https://www.bing.com";
    const rep = await fetch(`${origin}/rewardsapp/reportActivity?${p.toString()}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: "url=" + encodeURIComponent(window.location.href) + "&V=web"
    });
    const text = await rep.text().catch(() => "");
    let limit = null;
    let earned = null;
    let balance = null;
    let isMobileClient = null;
    let isAuthenticated = null;
    let rewardsIncrement = null;
    const match = text.match(/ModernRewards\.ReportActivity\((\{[\s\S]*?\})\)\s*;/);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]) || {};
        if (typeof parsed.IsMobileClient === "boolean") isMobileClient = parsed.IsMobileClient;
        if (typeof parsed.IsAuthenticated === "boolean") isAuthenticated = parsed.IsAuthenticated;
        if (typeof parsed.RewardsIncrement === "number") rewardsIncrement = parsed.RewardsIncrement;
        const s = parsed.RewardsSessionData || {};
        if (typeof s.DailySearchPointsLimit === "number") limit = s.DailySearchPointsLimit;
        if (typeof s.DailySearchPointsEarned === "number") earned = s.DailySearchPointsEarned;
        if (typeof s.Balance === "number") balance = s.Balance;
      } catch (e) {}
    }
    return {
      scrolled: true,
      beacon: rep.ok,
      status: rep.status,
      origin,
      ig,
      limit,
      earned,
      balance,
      isMobileClient,
      isAuthenticated,
      rewardsIncrement
    };
  } catch (e) {
    return { scrolled: true, beacon: false, origin: window.location.origin || "", error: e.message };
  }
};

/**
 * Giả lập cuộn, gửi SERP IG /rewardsapp/reportActivity và đọc ModernRewards.ReportActivity (limit 120 vs 180)
 */
export const simulateMobileEngagement = async (tabId, query = "", cvid = "") => {
  if (!tabId) return { ok: false };
  try {
    const res = await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(${inspectSerpAndSendBeaconInDom.toString()})(${JSON.stringify(query || "")}, ${JSON.stringify(cvid || "")})`,
      awaitPromise: true,
      returnByValue: true
    });
    return res?.result?.value || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

/**
 * Nhập từ khóa vào ô tìm kiếm Bing bằng native setter và gửi form (chỉ click nút submit đang hiển thị)
 */
export const simulateMobileSearchForm = async (tabId, query) => {
  if (!tabId) return false;
  try {
    const res = await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `
        (() => {
          const cookieBtn = document.querySelector("#bnp_btn_accept");
          if (cookieBtn && cookieBtn.offsetParent !== null) {
            try { cookieBtn.click(); } catch (e) {}
          }

          const qInput = document.querySelector("#sb_form_q")
            || document.querySelector("textarea[name='q']")
            || document.querySelector("input[name='q']")
            || document.querySelector(".b_searchbox");
          if (!qInput) return "no_input";

          qInput.focus();
          qInput.click();

          const proto = qInput.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (nativeSetter) {
            nativeSetter.call(qInput, ${JSON.stringify(query)});
          } else {
            qInput.value = ${JSON.stringify(query)};
          }

          qInput.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: ${JSON.stringify(query)} }));
          qInput.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

          const isVisible = (el) => {
            if (!el) return false;
            const st = getComputedStyle(el);
            return el.offsetParent !== null && st.visibility !== "hidden" && st.display !== "none";
          };

          const submitSelectors = ["#sb_form_go", "#search_icon", "input[type='submit']", "button[type='submit']", ".b_searchboxSubmit", ".search.icon"];
          let visibleBtn = null;
          for (const sel of submitSelectors) {
            for (const el of document.querySelectorAll(sel)) {
              if (isVisible(el)) {
                visibleBtn = el;
                break;
              }
            }
            if (visibleBtn) break;
          }

          if (visibleBtn) {
            visibleBtn.click();
            return "submitted_btn";
          }

          const form = document.querySelector("#sb_form") || qInput.closest("form");
          if (form) {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else {
              form.submit();
            }
            return "submitted_form";
          }

          return "need_cdp_enter";
        })()
      `,
      returnByValue: true
    });

    const outcome = res?.result?.value;
    if (outcome === "need_cdp_enter") {
      await dispatchCdpEnter(tabId);
      return true;
    }
    return outcome === "submitted_btn" || outcome === "submitted_form";
  } catch (e) {
    return false;
  }
};
