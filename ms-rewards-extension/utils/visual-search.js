/**
 * Visual Search Streak Automation Module (v2.1.0) - Microsoft Rewards Master
 * - Kiểm tra & tự kích hoạt streak "visual-search" từ Next.js /earn RSC (loại bỏ hoàn toàn /api/getuserinfo chết).
 * - Silent API-First: POST /images/kblob (với ảnh Bing HPImageArchive) -> lấy bcid -> tải SERP lấy IG -> POST /rewardsapp/reportActivity?...&bcid=...
 * - Chỉ mở Worker Window UI Fallback (#sb_cam_island/#sb_sbi -> #sb_imgpst -> submit -> bcid=) nếu API không sinh được bcid.
 */

import { sleep } from "./delay.js";
import { generateRandomHex } from "./read-to-earn.js";
import {
  fetchEarnPageRsc,
  fetchFlyoutViewModel,
  activateEarnOffer,
  extractSerpImpressionGuid,
  reportBingSerpActivity
} from "./rsc-parser.js";
import {
  attachMobileEmulation,
  detachMobileEmulation,
  detachAllTargets
} from "./mobile-cdp.js";

const BING_HP_ARCHIVE_URL = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US";
const REWARDS_SEED_IMAGE_URL = "https://th.bing.com/th?id=OMR.VisualSearch.VNext.BackgroundImage.png&pid=Rewards";

const CURATED_IMAGE_URLS = [
  REWARDS_SEED_IMAGE_URL,
  "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1511497584788-87676104235f?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=800&q=80"
];

export const getRandomSampleImage = () => {
  const index = Math.floor(Math.random() * CURATED_IMAGE_URLS.length);
  return CURATED_IMAGE_URLS[index];
};

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
};

const fetchImageAsBase64 = async (url, timeoutMs = 4500) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength < 1024) return null;
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: "image/jpeg",
      sourceUrl: url,
      byteLength: buffer.byteLength
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Lấy danh sách URL ảnh thật từ Bing Homepage Archive + fallback chính thức
 */
export const getVisualSearchSeedUrls = async () => {
  const seeds = [];
  try {
    const res = await fetch(BING_HP_ARCHIVE_URL);
    if (res.ok) {
      const json = await res.json();
      const images = Array.isArray(json?.images) ? json.images : [];
      for (const img of images) {
        const rawUrl = img?.url || (img?.urlbase ? `${img.urlbase}_800x480.jpg` : "");
        if (rawUrl) {
          seeds.push(rawUrl.startsWith("http") ? rawUrl : `https://www.bing.com${rawUrl}`);
        }
      }
    }
  } catch (e) {}

  for (const fallback of CURATED_IMAGE_URLS) {
    if (!seeds.includes(fallback)) seeds.push(fallback);
  }
  return seeds;
};

/**
 * Tải ảnh JPEG thực tế dưới dạng base64 (dùng cho DOM file upload fallback nếu cần)
 */
export const fetchRealPhotoBase64 = async (addLog) => {
  const seeds = await getVisualSearchSeedUrls();
  for (const url of seeds.slice(0, 3)) {
    const photo = await fetchImageAsBase64(url, 4500);
    if (photo) {
      if (addLog) addLog(`🖼️ [Visual Search] Đã chuẩn bị ảnh thực tế (${Math.round(photo.byteLength / 1024)} KB).`);
      return photo;
    }
  }
  return null;
};

/**
 * Kiểm tra trạng thái Visual Search Streak từ Next.js /earn RSC & Bing Flyout V1
 */
export const checkVisualSearchStreakStatus = async () => {
  // Nguồn 1: Next.js /earn RSC Streaks & Offers
  try {
    const rsc = await fetchEarnPageRsc("https://rewards.bing.com/earn");
    if (rsc.success) {
      const streak = rsc.streaks.find(
        (s) => /visual.?search/i.test(s.partner) || /visual.?search/i.test(s.offerId)
      );
      if (streak) {
        return {
          known: true,
          completed: Boolean(streak.isCurrentDayCompleted),
          isEnabled: Boolean(streak.isEnabled),
          progress: streak.isCurrentDayCompleted ? 1 : 0,
          max: 1,
          destinationUrl: null,
          offerId: streak.offerId || "visualsearch_streak"
        };
      }

      const offer = rsc.offers.find((o) =>
        /visual.?search/i.test(o.offerId) || /visual.?search/i.test(o.title)
      );
      if (offer) {
        return {
          known: true,
          completed: Boolean(offer.isCompleted),
          isEnabled: true,
          progress: offer.isCompleted ? 1 : 0,
          max: 1,
          destinationUrl: offer.destinationUrl || null,
          offerId: offer.offerId
        };
      }
    }
  } catch (e) {}

  // Nguồn 2: Bing Flyout V1 ViewModel
  try {
    const flyout = await fetchFlyoutViewModel();
    if (flyout.success) {
      const card = flyout.cards.find(
        (c) => /visual.?search/i.test(c.offerId) || /visual.?search/i.test(c.title)
      );
      if (card) {
        return {
          known: true,
          completed: Boolean(card.isCompleted),
          isEnabled: true,
          progress: card.isCompleted ? 1 : 0,
          max: 1,
          destinationUrl: card.destinationUrl || null,
          offerId: card.offerId
        };
      }
    }
  } catch (e) {}

  return {
    known: false,
    completed: false,
    isEnabled: true,
    progress: 0,
    max: 1,
    destinationUrl: null,
    offerId: ""
  };
};

/**
 * Kích hoạt streak Visual Search trên /earn nếu đang bị tắt (isEnabled === false)
 */
const ensureVisualSearchStreakEnabled = async (addLog) => {
  if (addLog) addLog("🔧 [Visual Search] Phát hiện streak chưa kích hoạt trên /earn — đang bật tự động...");
  await activateEarnOffer("visualsearch_streak_activation_v2", 714).catch(() => {});
  await activateEarnOffer("ww_visualsearch_summerjuly26_activation_banner", 11).catch(() => {});
};

/**
 * Luồng chính Silent API: POST /images/kblob -> bcid -> tải SERP lấy IG -> POST /rewardsapp/reportActivity?...&bcid=...
 */
export const performApiVisualSearch = async (addLog) => {
  const seeds = await getVisualSearchSeedUrls();

  for (const seed of seeds.slice(0, 3)) {
    try {
      const kblobUrl = `https://www.bing.com/images/kblob?iss=sbi&form=SBIHMP&sbisrc=UrlPaste&vsimg=${encodeURIComponent(seed)}&imgurl=${encodeURIComponent(seed)}`;
      const formData = new FormData();
      formData.append("cbir", "sbi");
      formData.append("imageBin", "");
      formData.append("imgurl", "");

      const kblobRes = await fetch(kblobUrl, {
        method: "POST",
        credentials: "include",
        body: formData
      });

      if (!kblobRes.ok) {
        if (addLog) addLog(`ℹ️ [Visual Search API] /images/kblob trả HTTP ${kblobRes.status}, thử ảnh khác...`);
        continue;
      }

      const rawBody = await kblobRes.text().catch(() => "");
      let redirectPath = "";
      try {
        const json = JSON.parse(rawBody);
        redirectPath = json?.redirectUrl || json?.url || "";
      } catch (e) {
        const match = rawBody.match(/"redirectUrl"\s*:\s*"([^"]+)"/i);
        redirectPath = match?.[1] || (kblobRes.url?.includes("bcid=") ? kblobRes.url : "");
      }

      if (!redirectPath) {
        if (addLog) addLog("ℹ️ [Visual Search API] Không tìm thấy redirectUrl trong phản hồi kblob.");
        continue;
      }

      const parsedSerp = new URL(redirectPath, "https://www.bing.com");
      const bcid = parsedSerp.searchParams.get("bcid") || "";
      const q = parsedSerp.searchParams.get("q") || "visual search";

      if (!bcid) {
        if (addLog) addLog("ℹ️ [Visual Search API] redirectUrl chưa có tham số bcid, thử ảnh tiếp...");
        continue;
      }

      const serpUrl = parsedSerp.toString();
      let ig = "";
      try {
        const serpRes = await fetch(serpUrl, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "text/html,application/xhtml+xml" }
        });
        if (serpRes.ok) {
          const serpHtml = await serpRes.text();
          ig = extractSerpImpressionGuid(serpHtml);
        }
      } catch (e) {}

      if (!ig) {
        ig = generateRandomHex(16).toUpperCase();
      }

      const repRes = await reportBingSerpActivity({
        serpUrl,
        query: q,
        ig,
        formCode: "SBIHMP",
        bcid,
        referer: serpUrl
      });

      if (repRes.ok) {
        await sleep(1200);
        const postCheck = await checkVisualSearchStreakStatus();
        if (addLog) {
          addLog(
            `✅ [Visual Search API] Đã gửi beacon bcid=${bcid.slice(0, 12)}... (IG=${ig.slice(0, 8)}..., verified=${postCheck.completed}).`
          );
        }
        return {
          success: true,
          verified: Boolean(postCheck.completed),
          bcid,
          ig,
          method: "kblob_api"
        };
      }
    } catch (e) {
      if (addLog) addLog(`⚠️ [Visual Search API] Lỗi thử kblob: ${e.message}`);
    }
  }

  return { success: false, verified: false, bcid: "", ig: "", method: "kblob_failed" };
};

const waitTabComplete = (tabId, timeoutMs = 8000, expectPart = null) => {
  return new Promise((resolve) => {
    let done = false;
    let pollTimer = null;
    let timer = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
    };

    const ready = (tab) => {
      if (!tab || tab.status !== "complete") return false;
      if (expectPart && (!tab.url || !tab.url.includes(expectPart))) return false;
      return true;
    };

    const finish = (tab) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(tab || null);
    };

    const listener = (uTabId, changeInfo, tab) => {
      if (uTabId === tabId && changeInfo.status === "complete" && ready(tab)) {
        finish(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) finish(null);
      else if (ready(tab)) finish(tab);
    });

    if (done) return;

    pollTimer = setInterval(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) finish(null);
        else if (ready(tab)) finish(tab);
      });
    }, 200);

    timer = setTimeout(() => {
      chrome.tabs.get(tabId, (tab) => finish(chrome.runtime.lastError ? null : tab));
    }, timeoutMs);
  });
};

/**
 * UI Fallback: Mở Bing trên Worker Window -> bấm #sb_cam_island/#sb_sbi -> dán URL ảnh vào #sb_imgpst -> submit chờ bcid=
 */
const performVisualSearchDomFallback = async (tabId, seedUrl, photoData) => {
  const execRes = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [seedUrl, photoData],
    func: async (targetUrl, photo) => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const cookieBtn = document.querySelector("#bnp_btn_accept");
        if (cookieBtn && cookieBtn.offsetParent !== null) cookieBtn.click();
      } catch (e) {}

      const queryDeepOne = (selectors) => {
        const roots = [document];
        const walk = (root) => {
          const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
          for (const el of all) {
            if (el.shadowRoot) {
              roots.push(el.shadowRoot);
              walk(el.shadowRoot);
            }
          }
        };
        walk(document);
        for (const sel of selectors) {
          for (const r of roots) {
            const hit = r.querySelector?.(sel);
            if (hit) return hit;
          }
        }
        return null;
      };

      const camBtn = queryDeepOne([
        "#sb_cam_island",
        "#sb_sbi",
        ".camera.icon",
        "#vsk_btn",
        'button[aria-label*="Search using an image" i]',
        'button[aria-label*="Tìm kiếm bằng hình ảnh" i]'
      ]);
      if (camBtn) {
        camBtn.click();
        await pause(900);
      }

      const pasteBox = queryDeepOne(["#sb_imgpst", "input[placeholder*='URL' i]"]);
      if (pasteBox) {
        pasteBox.focus();
        const proto = HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(pasteBox, targetUrl);
        else pasteBox.value = targetUrl;
        pasteBox.dispatchEvent(new Event("input", { bubbles: true }));
        pasteBox.dispatchEvent(new Event("change", { bubbles: true }));
        await pause(300);

        const submitBtn = queryDeepOne([
          "#sb_sbiap button[type='submit']",
          "#sb_sbidialog button[type='submit']",
          "#sb_imgpst + button"
        ]);
        if (submitBtn) {
          submitBtn.click();
        } else {
          pasteBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
        return { method: "paste_url_submit", camClicked: Boolean(camBtn) };
      }

      const fileInput = queryDeepOne(["#sb_fileinput", 'input[type="file"]']);
      if (fileInput && photo?.base64 && typeof DataTransfer !== "undefined") {
        const binary = atob(photo.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([new Blob([bytes], { type: "image/jpeg" })], `vs_${Date.now()}.jpg`, { type: "image/jpeg" });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        return { method: "file_upload", camClicked: Boolean(camBtn) };
      }

      return { method: "none", camClicked: Boolean(camBtn) };
    }
  });
  return execRes?.[0]?.result || { method: "none" };
};

/**
 * Thực thi chuỗi tìm kiếm bằng hình ảnh (Silent API-First -> UI Fallback chỉ khi API lỗi)
 */
export const executeVisualSearchStreak = async ({
  isRunningCheck,
  addLog,
  windowId = null,
  getWorkerWindowId = null,
  enableHeadersFunc,
  disableHeadersFunc
}) => {
  addLog("📷 [Visual Search Streak] Đang kiểm tra & thực thi ngầm theo giao thức kblob -> bcid -> IG Beacon...");

  const preStatus = await checkVisualSearchStreakStatus();
  if (preStatus.known && preStatus.completed) {
    addLog("🎉 [Visual Search Streak] Hệ thống /earn xác nhận hôm nay đã đạt 1/1 sẵn rồi!");
    return {
      success: true,
      verified: true,
      alreadyDone: true,
      summary: "Đã đạt 1/1 hôm nay"
    };
  }

  if (preStatus.known && preStatus.isEnabled === false) {
    await ensureVisualSearchStreakEnabled(addLog);
    await sleep(600);
  }

  // TẦNG 1: Silent API Primary (không mở cửa sổ)
  const apiRes = await performApiVisualSearch(addLog);
  if (apiRes.verified || (apiRes.success && apiRes.bcid)) {
    return {
      success: true,
      verified: true,
      bcid: apiRes.bcid,
      summary: "Đã hoàn thành Visual Search (API kblob/bcid)"
    };
  }

  if (!isRunningCheck()) {
    return { success: false, verified: false, aborted: true, summary: "Đã dừng" };
  }

  // TẦNG 2: UI Fallback trong Worker Window (chỉ chạy khi API không sinh được bcid)
  const resolvedWinId = windowId || (typeof getWorkerWindowId === "function" ? await getWorkerWindowId().catch(() => null) : null);
  addLog("🌐 [Visual Search Fallback] API kblob chưa lấy được bcid — mở trình duyệt ngầm bấm camera Visual Search...");

  const seeds = await getVisualSearchSeedUrls();
  const seedUrl = seeds[0] || REWARDS_SEED_IMAGE_URL;
  const realPhoto = await fetchRealPhotoBase64(null).catch(() => null);

  let tab = null;
  try {
    tab = await chrome.tabs.create({
      url: "https://www.bing.com/",
      active: true,
      ...(resolvedWinId ? { windowId: resolvedWinId } : {})
    });
    await waitTabComplete(tab.id, 7000);
    await sleep(1000);

    const domRes = await performVisualSearchDomFallback(tab.id, seedUrl, realPhoto).catch(() => ({ method: "error" }));
    addLog(`📷 [Visual Search Fallback] DOM action: ${domRes.method}`);

    const waitRes = await waitTabComplete(tab.id, 7000, "bcid=");
    await sleep(1800);

    const tabUrl = waitRes?.url || (await chrome.tabs.get(tab.id).catch(() => null))?.url || "";
    if (tabUrl.includes("bcid=")) {
      const parsed = new URL(tabUrl);
      const bcid = parsed.searchParams.get("bcid") || "";
      const q = parsed.searchParams.get("q") || "visual search";
      const pageHtmlRes = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => ({
          ig: window._G?.IG || "",
          html: document.documentElement?.innerHTML?.slice(0, 80000) || ""
        })
      }).catch(() => null);

      const rawIg = pageHtmlRes?.[0]?.result?.ig || extractSerpImpressionGuid(pageHtmlRes?.[0]?.result?.html || "") || generateRandomHex(16).toUpperCase();
      await reportBingSerpActivity({ serpUrl: tabUrl, query: q, ig: rawIg, formCode: "SBIHMP", bcid, referer: tabUrl });
    }

    await sleep(1500);
    const postStatus = await checkVisualSearchStreakStatus();
    if (postStatus.known && postStatus.completed) {
      addLog("✅ [Visual Search Streak] ĐÃ XÁC NHẬN HOÀN TẤT (1/1) sau UI Fallback!");
      return { success: true, verified: true, known: true, summary: "Đã xác nhận 1/1" };
    }

    if (isRunningCheck() && enableHeadersFunc) {
      try {
        await chrome.tabs.update(tab.id, { url: "about:blank" });
        await enableHeadersFunc(tab.id);
        await attachMobileEmulation(tab.id);
        await chrome.tabs.update(tab.id, {
          url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&FORM=SBIHMP&sbisrc=UrlPaste&imgurl=${encodeURIComponent(seedUrl)}`
        });
        await waitTabComplete(tab.id, 7000);
        await sleep(2000);
      } finally {
        await detachMobileEmulation(tab.id).catch(() => {});
        if (disableHeadersFunc) await disableHeadersFunc().catch(() => {});
        await detachAllTargets().catch(() => {});
      }
    }

    const finalCheck = await checkVisualSearchStreakStatus();
    return {
      success: Boolean(finalCheck.completed || tabUrl.includes("bcid=")),
      verified: Boolean(finalCheck.completed),
      known: finalCheck.known,
      summary: finalCheck.completed ? "Đã xác nhận 1/1" : "Đã chạy Visual Search — kiểm tra lại 1/1 trên /earn"
    };
  } catch (err) {
    addLog(`❌ [Visual Search] Lỗi: ${err.message}`);
    return { success: false, verified: false, error: err.message, summary: `Lỗi: ${err.message}` };
  } finally {
    if (tab && tab.id) {
      try {
        await detachMobileEmulation(tab.id).catch(() => {});
        await chrome.tabs.remove(tab.id);
      } catch (e) {}
    }
    if (disableHeadersFunc) await disableHeadersFunc().catch(() => {});
  }
};
