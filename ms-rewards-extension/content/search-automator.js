/**
 * Search Automator Content Script - Microsoft Rewards Master (v2.0.0)
 * - Chống đăng ký listener trùng lặp khi tiêm lại (idempotent guard).
 * - Gán từ khóa qua native prototype value setter + InputEvent chuẩn.
 * - Chỉ submit đúng 1 lần qua nút submit hoặc form.requestSubmit() (tránh double-navigate).
 * - Tự đóng banner cookie #bnp_btn_accept nếu che giao diện.
 */

(() => {
  if (window !== window.top) return;
  if (window.__msRewardsSearchAutomatorLoaded) return;
  window.__msRewardsSearchAutomatorLoaded = true;

  const currentHref = window.location.href.toLowerCase();
  if (
    currentHref.includes("/visualsearch") ||
    currentHref.includes("iss=sbi") ||
    currentHref.includes("iss=sbiimg") ||
    currentHref.includes("view=detailv2")
  ) {
    return;
  }

  console.log("[MS-Rewards] Search Automator Content Script v2.0.0 đã sẵn sàng trên Bing.");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const findSearchBox = async (timeoutMs = 1500) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const box = document.querySelector("#sb_form_q")
        || document.querySelector("textarea[name='q']")
        || document.querySelector("input[name='q']")
        || document.querySelector(".b_searchbox");
      if (box) return box;
      await sleep(100);
    }
    return null;
  };

  const findSubmitButton = () => {
    return document.querySelector("#sb_form_go")
      || document.querySelector("#search_icon")
      || document.querySelector("input[type='submit']")
      || document.querySelector("button[type='submit']")
      || document.querySelector(".b_searchboxSubmit")
      || document.querySelector(".search.icon");
  };

  const setNativeValue = (el, val) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, val);
    } else {
      el.value = val;
    }
  };

  const executeInPageSearch = async (query) => {
    try {
      const cookieBtn = document.querySelector("#bnp_btn_accept");
      if (cookieBtn && cookieBtn.offsetParent !== null) {
        try { cookieBtn.click(); } catch (e) {}
      }

      const oldUrl = window.location.href;
      const searchBox = await findSearchBox(1500);
      if (!searchBox) {
        const targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&FORM=QBLH`;
        window.location.href = targetUrl;
        return { success: true, fallback: true, targetUrl };
      }

      searchBox.focus();
      searchBox.click();
      await sleep(30);

      setNativeValue(searchBox, query);
      searchBox.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: query
      }));
      searchBox.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

      await sleep(60);

      const submitBtn = findSubmitButton();
      if (submitBtn) {
        submitBtn.click();
        return { success: true, method: "button_click", oldUrl };
      }

      const form = document.querySelector("#sb_form") || searchBox.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
        return { success: true, method: "form_submit", oldUrl };
      }

      const targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&FORM=QBLH`;
      window.location.href = targetUrl;
      return { success: true, method: "location_href", targetUrl };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const extractPageIg = () => {
    try {
      if (window._G && typeof window._G.IG === "string" && /^[A-F0-9]{32}$/i.test(window._G.IG)) {
        return window._G.IG;
      }
      const html = document.documentElement?.innerHTML || "";
      const m =
        html.match(/_G\s*=\s*\{[^}]*\bIG\s*:\s*["']([A-F0-9]{32})["']/i) ||
        html.match(/\b["']?IG["']?\s*:\s*["']([A-F0-9]{32})["']/i);
      return m?.[1] || "";
    } catch (e) {
      return "";
    }
  };

  const reportSerpActivityInPage = async (queryOverride = "", formOverride = "", cvidOverride = "") => {
    try {
      if (!window.location.pathname.toLowerCase().includes("/search")) {
        return { success: false, skipped: true, reason: "not_serp" };
      }

      const ig = extractPageIg();
      if (!ig) {
        return { success: false, skipped: true, reason: "no_ig" };
      }

      const parsedUrl = new URL(window.location.href);
      const q = queryOverride || parsedUrl.searchParams.get("q") || "";
      const formCode = formOverride || parsedUrl.searchParams.get("FORM") || "ANNTA1";
      const cvid = cvidOverride || parsedUrl.searchParams.get("cvid") || "";

      const params = new URLSearchParams({
        IG: ig,
        IID: "SERP.5064",
        q,
        FORM: formCode,
        ajaxreq: "1"
      });
      if (cvid) params.set("cvid", cvid);

      const res = await fetch(`https://www.bing.com/rewardsapp/reportActivity?${params.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: `url=${encodeURIComponent(window.location.href)}&V=web`
      });

      return { success: res.ok, status: res.status, ig };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  const simulateHumanEngagement = async (meta = {}) => {
    try {
      await sleep(150);

      const scroll1 = 260 + Math.floor(Math.random() * 160);
      window.scrollBy({ top: scroll1, behavior: "smooth" });
      await sleep(280);

      const resultLink = document.querySelector(".b_algo h2 a") || document.querySelector("h2 a");
      if (resultLink) {
        resultLink.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
        resultLink.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
      }

      const scroll2 = 140 + Math.floor(Math.random() * 110);
      window.scrollBy({ top: scroll2, behavior: "smooth" });
      await sleep(180);

      const beaconRes = await reportSerpActivityInPage(meta.query || "", meta.formCode || "", meta.cvid || "");

      return { success: true, beacon: beaconRes };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING") {
      sendResponse({ status: "ok" });
      return true;
    }

    if (request.action === "EXECUTE_IN_PAGE_SEARCH") {
      executeInPageSearch(request.query).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    if (request.action === "SIMULATE_HUMAN_ENGAGEMENT") {
      simulateHumanEngagement({
        query: request.query || "",
        formCode: request.formCode || "",
        cvid: request.cvid || ""
      }).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    if (request.action === "REPORT_SERP_ACTIVITY") {
      reportSerpActivityInPage(
        request.query || "",
        request.formCode || "",
        request.cvid || ""
      ).then((res) => {
        sendResponse(res);
      });
      return true;
    }
  });
})();
