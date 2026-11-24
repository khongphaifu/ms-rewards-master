/**
 * Next.js RSC & Bing Flyout V1 Protocol Parser (v2.3.0)
 * - Giải mã payload Next.js App Router (self.__next_f.push) trên rewards.bing.com/earn & /dashboard.
 * - Trích xuất buildId (X-Deployment-Id), chuẩn hóa date (MM/DD/YYYY & YYYY-MM-DD), resetAt, StreakState.
 * - Tự động dò mã Server Action (Next-Action) từ /_next/static/(chunks|immutable|media)/*.js & dynamic chunks.
 * - Gửi Server Action đúng (nav) Router-State-Tree + timezoneOffset string + kiểm tra ack /^\d+:true$/m.
 * - Parse window.flyoutViewModel từ www.bing.com/rewards/panelflyout & gọi /msrewards/api/v1/reportactivity.
 * - Trích xuất SERP IG (32 hex), gửi /rewardsapp/reportActivity và parse ModernRewards.ReportActivity.
 */

const EARN_URL = "https://rewards.bing.com/earn";
const DASHBOARD_URL = "https://rewards.bing.com/dashboard";
const FLYOUT_HTML_URL =
  "https://www.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards&isDarkMode=0&ru=https%3A%2F%2Fwww.bing.com%2F";
const FLYOUT_JSON_URL =
  "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards";
const FLYOUT_REPORT_URL = "https://www.bing.com/msrewards/api/v1/reportactivity";
const BING_REPORT_ACTIVITY_URL = "https://www.bing.com/rewardsapp/reportActivity";

let cachedServerActions = null;
let lastKnownBuildId = null;

/**
 * Tìm cặp dấu ngoặc nhọn cân bằng { ... } bao quanh một khóa neo (anchorKey) mà vẫn tôn trọng chuỗi JSON.
 */
const parseBalancedObjectAroundIndex = (text, insideIdx, minStart = 0, maxSpan = 16000) => {
  const lowerBound = Math.max(minStart, insideIdx - maxSpan);

  // Tìm về phía trái để xác định tất cả các dấu '{' ứng viên bao quanh insideIdx
  const findEnclosingOpenBrace = () => {
    let depth = 0;
    let inString = false;
    for (let i = insideIdx - 1; i >= lowerBound; i--) {
      const ch = text[i];
      if (ch === '"') {
        let backslashes = 0;
        for (let b = i - 1; b >= lowerBound && text[b] === "\\"; b--) {
          backslashes++;
        }
        if (backslashes % 2 === 0) {
          inString = !inString;
        }
        continue;
      }
      if (inString) continue;
      if (ch === "}") {
        depth++;
      } else if (ch === "{") {
        if (depth === 0) {
          return i;
        }
        depth--;
      }
    }
    return -1;
  };

  const startIdx = findEnclosingOpenBrace();
  if (startIdx < 0) return null;

  const upperBound = Math.min(text.length, startIdx + maxSpan);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < upperBound; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const rawSlice = text.slice(startIdx, i + 1);
        try {
          return {
            start: startIdx,
            end: i + 1,
            value: JSON.parse(rawSlice)
          };
        } catch (e) {
          return null;
        }
      }
    }
  }

  return null;
};

/**
 * Đọc object JSON bắt đầu ngay tại vị trí startIdx ('{')
 */
const parseJsonFromOpenBrace = (text, openBraceIdx, maxLen = 400000) => {
  if (openBraceIdx < 0 || text[openBraceIdx] !== "{") return null;
  const upperBound = Math.min(text.length, openBraceIdx + maxLen);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIdx; i < upperBound; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(openBraceIdx, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }

  return null;
};

/**
 * Trích xuất mọi JSON object cân bằng chứa anchorKey (ví dụ "offerId", "isCurrentDayCompleted")
 */
export const extractBalancedJsonObjects = (text, anchorKey) => {
  if (!text || !anchorKey) return [];
  const results = [];
  const seenRanges = new Set();
  const needle = `"${anchorKey}":`;

  let pos = 0;
  while (pos < text.length) {
    const foundIdx = text.indexOf(needle, pos);
    if (foundIdx === -1) break;

    const parsed = parseBalancedObjectAroundIndex(text, foundIdx);
    if (parsed && parsed.value && typeof parsed.value === "object") {
      const rangeKey = `${parsed.start}:${parsed.end}`;
      if (!seenRanges.has(rangeKey)) {
        seenRanges.add(rangeKey);
        results.push(parsed.value);
      }
      pos = Math.max(foundIdx + needle.length, parsed.end);
    } else {
      pos = foundIdx + needle.length;
    }
  }

  return results;
};

/**
 * Giải mã toàn bộ chunk self.__next_f.push([1, "..."]) từ HTML Next.js App Router
 */
export const decodeFlightData = (html) => {
  if (!html || typeof html !== "string") return "";
  const chunks = [];
  const regex = /self\.__next_f\.push\(\[\s*1\s*,\s*"((?:\\.|[^"\\])*)"\s*\]\)/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const rawContent = match[1];
    try {
      chunks.push(JSON.parse(`"${rawContent}"`));
    } catch (e) {
      chunks.push(
        rawContent
          .replace(/\\"/g, '"')
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\")
      );
    }
  }

  return chunks.join("\n");
};

const extractScriptUrlsFromHtml = (html, baseOrigin = "https://rewards.bing.com") => {
  if (!html) return [];
  const urls = new Set();
  const regex = /(?:src=["']|["'])(\/_next\/static\/(?:(?:chunks|immutable|media)\/)?[^"'\s)]+\.js(?:\?[^"'\s)]*)?)["']/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      urls.add(new URL(m[1], baseOrigin).toString());
    } catch (e) {}
  }
  return Array.from(urls);
};

export const normaliseEarnDate = (rawDate) => {
  if (typeof rawDate !== "string" || !rawDate.trim()) return null;
  const cleaned = rawDate.replace(/^\$D/, "").trim();
  const usMatch = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
  }
  const isoMatch = cleaned.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }
  return null;
};

const normalizeEarnOffer = (obj) => {
  const parsedDate = normaliseEarnDate(obj.date);
  const attrs = obj.attributes && typeof obj.attributes === "object" ? obj.attributes : {};
  return {
    offerId: String(obj.offerId),
    hash: String(obj.hash || obj.authKey || ""),
    title: String(obj.title || obj.id || obj.offerId),
    points: Number(obj.points ?? obj.pointProgressMax ?? obj.pointTotal ?? 0),
    isCompleted: Boolean(obj.isCompleted || obj.complete || obj.isComplete),
    isLocked: Boolean(obj.isLocked),
    isAvailable: obj.isAvailable !== false,
    isPromotional: Boolean(obj.isPromotional || String(attrs.promotional || "").toLowerCase() === "true"),
    promotionSubtype: String(obj.promotionSubtype || ""),
    date: parsedDate,
    destinationUrl: String(obj.destinationUrl || obj.url || obj.destination || ""),
    activityType: Number(obj.activityType ?? attrs.activityType ?? 11)
  };
};

const normalizeStreakObj = (obj, resetTimes = null) => {
  const partnerRaw = String(obj.partner || obj.streakType || obj.id || obj.name || "").toLowerCase();
  const dailyPoints = Array.isArray(obj.dailyPoints) ? obj.dailyPoints : [];
  const actOfferId =
    typeof obj.activationOfferId === "string" && obj.activationOfferId !== "$undefined"
      ? obj.activationOfferId
      : String(obj.offerId || "");
  const actHash =
    typeof obj.activationHash === "string" && obj.activationHash !== "$undefined"
      ? obj.activationHash
      : String(obj.hash || "");
  const actType = Number(obj.activationActivityType);
  const rawReset =
    (typeof obj.resetAt === "string" && obj.resetAt) ||
    resetTimes?.get(partnerRaw) ||
    null;

  return {
    partner: partnerRaw,
    resetAt: rawReset,
    offerId: String(obj.offerId || actOfferId || obj.name || ""),
    hash: String(obj.hash || actHash || ""),
    activationOfferId: actOfferId,
    activationHash: actHash,
    activationActivityType: Number.isInteger(actType) && actType > 0 ? actType : null,
    isEnabled: obj.isEnabled !== undefined ? Boolean(obj.isEnabled) : true,
    isCurrentDayCompleted: Boolean(obj.isCurrentDayCompleted ?? obj.isCompletedToday ?? obj.complete),
    activitiesCompleted: Number(obj.activitiesCompleted ?? 0),
    activitiesTotal: Number(obj.activitiesTotal ?? 0),
    completedDays: Number(obj.completedDays ?? 0),
    totalDays: Number(obj.totalDays ?? obj.goalLength ?? obj.streakGoal ?? obj.max ?? 7),
    currentStreakLength: Number(obj.currentStreakLength ?? obj.streakLength ?? obj.completedDays ?? obj.progress ?? dailyPoints.length ?? 0),
    goalLength: Number(obj.goalLength ?? obj.streakGoal ?? obj.totalDays ?? obj.max ?? 7)
  };
};

/**
 * Tìm StreakState theo loại ("edge-browsing" | "daily-set" | "bing-app" | "visual-search" | "bing-search")
 */
export const findStreakByKind = (streaks = [], kind) => {
  if (!Array.isArray(streaks)) return undefined;
  return streaks.find((s) => {
    const normalized = String(s?.partner || "").replace(/[^a-z]/gi, "").toLowerCase();
    if (!normalized) return false;
    if (kind === "edge-browsing") {
      return normalized === "edge" || normalized.includes("edgebrows");
    }
    if (kind === "daily-set") {
      return (
        ["rewards", "bingrewards", "msrewards", "microsoftrewards"].includes(normalized) ||
        normalized.includes("dailyset")
      );
    }
    if (kind === "bing-app") {
      return (
        ["app", "appstreak", "bingapp", "bingappstreak", "sapphire", "sapphirestreak"].includes(normalized) ||
        /^(?:bingapp|app|sapphire)?(?:daily)?checkin(?:streak)?$/.test(normalized)
      );
    }
    if (kind === "visual-search") {
      return normalized.includes("visualsearch");
    }
    if (kind === "bing-search") {
      if (/visual|image|edge/.test(normalized)) return false;
      return (
        ["bing", "search", "searchstreak", "microsoftbing"].includes(normalized) ||
        (normalized.includes("bing") && normalized.includes("search"))
      );
    }
    return normalized.includes(String(kind || "").replace(/[^a-z]/gi, "").toLowerCase());
  });
};

const extractBuildIdFromEarn = (html, decoded) => {
  return (
    html?.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ||
    decoded?.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ||
    decoded?.match(/"buildId"\s*:\s*"([A-Za-z0-9._-]+)"/)?.[1] ||
    decoded?.match(/"b"\s*:\s*"([A-Za-z0-9._-]{8,})"/)?.[1] ||
    html?.match(/\/_next\/static\/(?!chunks\/|css\/|media\/)([A-Za-z0-9._-]+)\//)?.[1] ||
    null
  );
};

/**
 * Phân tích HTML Next.js từ rewards.bing.com/earn hoặc /dashboard
 */
export const parseEarnRscHtml = (html, baseOrigin = "https://rewards.bing.com") => {
  const decoded = decodeFlightData(html);
  const sourceText = decoded || html || "";

  const rawOffers = extractBalancedJsonObjects(sourceText, "offerId");
  const offerMap = new Map();
  for (const raw of rawOffers) {
    if (!raw?.offerId) continue;
    // Bỏ qua object cấu hình streak (những object này đi vào mảng streaks)
    if ("partner" in raw && "isCurrentDayCompleted" in raw) continue;
    const norm = normalizeEarnOffer(raw);
    const prev = offerMap.get(norm.offerId);
    if (!prev || (!prev.hash && norm.hash) || (!prev.isCompleted && norm.isCompleted)) {
      offerMap.set(norm.offerId, norm);
    }
  }

  const resetTimes = new Map();
  for (const carrier of extractBalancedJsonObjects(sourceText, "expiresAt")) {
    const streakObj = carrier?.streak;
    if (typeof streakObj?.partner !== "string" || typeof carrier?.expiresAt !== "string") continue;
    const ts = Date.parse(carrier.expiresAt.replace(/^\$D/, ""));
    if (Number.isFinite(ts)) {
      resetTimes.set(streakObj.partner.toLowerCase(), new Date(ts).toISOString());
    }
  }

  const rawStreaks = [
    ...extractBalancedJsonObjects(sourceText, "isCurrentDayCompleted"),
    ...extractBalancedJsonObjects(sourceText, "dailyPoints")
  ];
  const streakMap = new Map();
  for (const raw of rawStreaks) {
    if (!raw || typeof raw !== "object") continue;
    const norm = normalizeStreakObj(raw, resetTimes);
    const key = norm.partner || norm.offerId;
    if (!key) continue;
    const prev = streakMap.get(key);
    if (
      !prev ||
      (!prev.isCurrentDayCompleted && norm.isCurrentDayCompleted) ||
      norm.activitiesCompleted > (prev.activitiesCompleted || 0)
    ) {
      streakMap.set(key, norm);
    }
  }

  let pointClaim = 0;
  const directClaimMatch = sourceText.match(/"pointClaim"\s*:\s*(\d+)/);
  if (directClaimMatch?.[1]) {
    pointClaim = Number(directClaimMatch[1]);
  } else {
    const claimObjs = extractBalancedJsonObjects(sourceText, "pointClaim");
    for (const c of claimObjs) {
      const pts = Number(c?.pointClaim?.points ?? c?.pointClaim ?? 0);
      if (Number.isFinite(pts) && pts > 0) pointClaim = pts;
    }
  }

  const availMatch =
    sourceText.match(/"availablePoints"\s*:\s*(?:"(\d+)"|(\d+))/) ||
    sourceText.match(/"balance"\s*:\s*(?:"(\d+)"|(\d+))/);
  const countryMatch =
    sourceText.match(/"geoLocale"\s*:\s*"([a-z]{2})"/i) ||
    sourceText.match(/"country"\s*:\s*"([a-z]{2})"/i);
  const langMatch =
    sourceText.match(/"language"\s*:\s*"([a-z]{2})(?:-[a-z]{2})?"/i) ||
    html.match(/<html[^>]*lang=["']([a-z]{2})/i);

  const buildId = extractBuildIdFromEarn(html, decoded);
  if (buildId) lastKnownBuildId = buildId;

  return {
    offers: Array.from(offerMap.values()),
    streaks: Array.from(streakMap.values()),
    pointClaim,
    availablePoints: availMatch ? Number(availMatch[1] ?? availMatch[2]) : 0,
    geoLocale: countryMatch ? countryMatch[1].toLowerCase() : "",
    langCode: langMatch ? langMatch[1].toLowerCase() : "",
    buildId,
    scriptUrls: extractScriptUrlsFromHtml(html, baseOrigin),
    decodedLength: decoded.length
  };
};

/**
 * Tải và phân tích trang Next.js RSC (/earn mặc định)
 */
export const fetchEarnPageRsc = async (url = EARN_URL) => {
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        url: res.url || url,
        offers: [],
        streaks: [],
        pointClaim: 0,
        availablePoints: 0,
        geoLocale: "",
        langCode: "",
        scriptUrls: [],
        html: ""
      };
    }

    const html = await res.text();
    const parsed = parseEarnRscHtml(html, new URL(res.url || url).origin);
    const needsLogin =
      (res.url || "").includes("login.live.com") ||
      (res.url || "").includes("login.microsoftonline.com") ||
      (parsed.offers.length === 0 && parsed.streaks.length === 0 && /sign in/i.test(html) && !/self\.__next_f/.test(html));

    return {
      success: !needsLogin,
      needsLogin,
      status: res.status,
      url: res.url || url,
      ...parsed,
      html
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      url,
      offers: [],
      streaks: [],
      pointClaim: 0,
      availablePoints: 0,
      geoLocale: "",
      langCode: "",
      scriptUrls: [],
      html: ""
    };
  }
};

export const invalidateServerActionsCache = () => {
  cachedServerActions = null;
};

/**
 * Quét bundle Next.js để trích xuất các 40-64 char hex Server Action IDs cho reportActivity & reportClaimAllPoints
 */
export const discoverServerActionsFromText = (scriptText, found = {}) => {
  if (!scriptText) return found;

  const targetNames = ["reportActivity", "reportClaimAllPoints"];
  const HEX = "[a-f0-9]{40,64}";
  const KNOWN_NON_NAMES = new Set(["callServer", "findSourceMapURL", "encodeFormAction", "default"]);
  const strLitRe = /"([A-Za-z_$][\w$]*)"/g;

  const processTurbopack = (regex) => {
    for (const m of scriptText.matchAll(regex)) {
      const id = m[1];
      const argsBlock = m[2] || "";
      const candidates = [...argsBlock.matchAll(strLitRe)]
        .map((x) => x[1])
        .filter((n) => !KNOWN_NON_NAMES.has(n) && n.length > 3);
      for (const name of targetNames) {
        if (!found[name] && candidates.includes(name)) {
          found[name] = id;
        }
      }
    }
  };

  processTurbopack(new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*["'](${HEX})["']([\\s\\S]{0,800}?)\\)`, "g"));
  processTurbopack(new RegExp(`registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*["'](${HEX})["']([\\s\\S]{0,800}?)\\)`, "g"));

  for (const name of targetNames) {
    if (found[name]) continue;

    // Fallback patterns cho định dạng đóng gói ngắn
    const directPatterns = [
      new RegExp(`createServerReference\\)\\(["']([a-f0-9]{40,64})["'][^)]*["']${name}["']`, "i"),
      new RegExp(`createServerReference\\(["']([a-f0-9]{40,64})["'][^)]*["']${name}["']`, "i"),
      new RegExp(`registerServerReference\\)\\([^,]+,["']([a-f0-9]{40,64})["'],["']${name}["']`, "i"),
      new RegExp(`["']([a-f0-9]{40,64})["']\\s*,\\s*(?:void 0|[a-zA-Z0-9_$]+)\\s*,\\s*["']${name}["']`, "i"),
      new RegExp(`["']${name}["'][^;]{0,120}["']([a-f0-9]{40,64})["']`, "i"),
      new RegExp(`["']([a-f0-9]{40,64})["'][^;]{0,120}["']${name}["']`, "i")
    ];

    for (const pat of directPatterns) {
      const m = scriptText.match(pat);
      if (m?.[1]) {
        found[name] = m[1];
        break;
      }
    }
  }

  return found;
};

const extractDynamicChunkUrls = (js, baseOrigin = "https://rewards.bing.com") => {
  if (!js) return [];
  const urls = new Set();
  const pushRel = (rel) => {
    try {
      const path = rel.startsWith("/_next/") ? rel : `/_next/${rel.replace(/^\/+/, "")}`;
      urls.add(new URL(path, baseOrigin).toString());
    } catch (e) {}
  };

  const builder = /static\/chunks\/"\s*\+\s*\w+\s*\+\s*"([-.])"\s*\+\s*\{([\s\S]*?)\}\s*\[/g;
  for (const match of js.matchAll(builder)) {
    for (const [, id, hash] of match[2].matchAll(/(\d+)\s*:\s*"([a-f0-9]+)"/g)) {
      pushRel(`static/chunks/${id}${match[1]}${hash}.js`);
    }
  }
  for (const [, id, hash] of js.matchAll(/\b(\d{2,6}):"([a-f0-9]{12,})"/g)) {
    pushRel(`static/chunks/${id}-${hash}.js`);
    pushRel(`static/chunks/${id}.${hash}.js`);
  }
  for (const match of js.matchAll(/(?:\/_next\/)?(static\/(?:immutable|chunks|media)\/[\w\-./()]+?\.js)/g)) {
    pushRel(match[1]);
  }
  return Array.from(urls);
};

/**
 * Tải tối đa 50 script /_next/static/(chunks|immutable|media)/*.js (+ dynamic chunks) để tìm mã Server Actions
 */
export const discoverServerActions = async (scriptUrls = [], forceRefresh = false) => {
  if (!forceRefresh && cachedServerActions?.reportActivity && cachedServerActions?.reportClaimAllPoints) {
    return cachedServerActions;
  }

  const found = {
    reportActivity: (!forceRefresh && cachedServerActions?.reportActivity) || null,
    reportClaimAllPoints: (!forceRefresh && cachedServerActions?.reportClaimAllPoints) || null
  };

  if (!Array.isArray(scriptUrls) || scriptUrls.length === 0) {
    return found;
  }

  let baseOrigin = "https://rewards.bing.com";
  try {
    baseOrigin = new URL(scriptUrls[0]).origin || baseOrigin;
  } catch (e) {}

  const priorityScore = (u) => (/earn|dashboard|layout|page|app/i.test(u) ? 0 : 1);
  const queue = [...scriptUrls].sort((a, b) => priorityScore(a) - priorityScore(b));
  const queuedSet = new Set(queue);
  const visited = new Set();

  while (queue.length > 0 && visited.size < 50) {
    if (found.reportActivity && found.reportClaimAllPoints) break;
    const scriptUrl = queue.shift();
    if (!scriptUrl || visited.has(scriptUrl)) continue;
    visited.add(scriptUrl);

    try {
      const res = await fetch(scriptUrl, { method: "GET", credentials: "include" });
      if (!res.ok) continue;
      const text = await res.text();
      discoverServerActionsFromText(text, found);

      if (!(found.reportActivity && found.reportClaimAllPoints)) {
        for (const childUrl of extractDynamicChunkUrls(text, baseOrigin)) {
          if (!visited.has(childUrl) && !queuedSet.has(childUrl)) {
            queuedSet.add(childUrl);
            queue.push(childUrl);
          }
        }
      }
    } catch (e) {}
  }

  cachedServerActions = found;
  return found;
};

/**
 * Chuẩn Next.js App Router State Tree kèm route group (nav) trên rewards.bing.com
 */
export const buildRouterStateTree = (segment = "earn") => {
  const normalized = String(segment || "earn").replace(/^\/+/, "") || "earn";
  const tree = [
    "",
    {
      children: [
        "(nav)",
        {
          children: [normalized, { children: ["__PAGE__", {}, null, null, 0] }, null, null, 0]
        },
        null,
        null,
        0
      ]
    },
    null,
    null,
    16
  ];
  return encodeURIComponent(JSON.stringify(tree));
};

/**
 * Thực thi 1 Next.js Server Action bằng header Next-Action + Next-Router-State-Tree chuẩn (nav) + X-Deployment-Id
 */
export const callNextServerAction = async ({ pagePath = "/earn", actionId, args = [], buildId = null }) => {
  if (!actionId) {
    return { ok: false, acknowledged: false, status: 0, text: "", error: "Thiếu Next-Action ID" };
  }

  const normalizedPath = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
  const segment = normalizedPath.replace(/^\/+/, "") || "earn";
  const resolvedBuildId = buildId || lastKnownBuildId;

  try {
    const res = await fetch(`https://rewards.bing.com${normalizedPath}`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Next-Action": actionId,
        "Next-Router-State-Tree": buildRouterStateTree(segment),
        ...(resolvedBuildId ? { "X-Deployment-Id": resolvedBuildId } : {})
      },
      body: JSON.stringify(args)
    });

    const text = await res.text().catch(() => "");
    const acknowledged = /^\d+:true\s*$/m.test(text);
    const hasActionError =
      /"error"\s*:\s*true/i.test(text) ||
      /^0:E\{/m.test(text) ||
      /failed to find server action/i.test(text);

    if (!res.ok || /failed to find server action/i.test(text)) {
      invalidateServerActionsCache();
    }

    return {
      ok: Boolean(res.ok && acknowledged && !hasActionError),
      acknowledged,
      status: res.status,
      text,
      error: !res.ok
        ? `HTTP ${res.status}`
        : hasActionError
          ? "Server Action error"
          : !acknowledged
            ? "Server Action not acknowledged"
            : null
    };
  } catch (e) {
    return { ok: false, acknowledged: false, status: 0, text: "", error: e.message };
  }
};

/**
 * Gửi reportActivity qua Next.js Server Action trên /earn (timezoneOffset dạng String của Date.getTimezoneOffset())
 */
export const reportEarnOfferViaServerAction = async (offer, actionId) => {
  if (!offer?.offerId || !actionId) {
    return { ok: false, acknowledged: false, error: "Thiếu offerId hoặc actionId" };
  }

  const timezoneOffset = String(new Date().getTimezoneOffset());
  const args = [
    String(offer.hash || ""),
    Number(offer.activityType || 11),
    {
      offerid: String(offer.offerId),
      isPromotional: offer.isPromotional ? true : "$undefined",
      timezoneOffset
    }
  ];

  return callNextServerAction({ pagePath: "/earn", actionId, args });
};

/**
 * Tự động kích hoạt một promotion/streak offer trên /earn (ví dụ edge_browsing hoặc visualsearch_streak_activation_v2)
 */
export const activateEarnOffer = async (offerId, activityType = 714, hash = "") => {
  if (!offerId) return { ok: false, error: "Thiếu offerId" };
  const rsc = await fetchEarnPageRsc(EARN_URL);
  if (!rsc.success) {
    return { ok: false, error: rsc.error || `HTTP ${rsc.status}` };
  }

  const actions = await discoverServerActions(rsc.scriptUrls);
  if (!actions?.reportActivity) {
    return { ok: false, error: "Không tìm thấy Server Action reportActivity trên /earn" };
  }

  const matchedOffer = rsc.offers.find((o) => o.offerId === offerId);
  const matchedStreak = rsc.streaks.find((s) => s.offerId === offerId);
  const resolvedHash = hash || matchedOffer?.hash || matchedStreak?.hash || "";

  return reportEarnOfferViaServerAction(
    {
      offerId,
      hash: resolvedHash,
      activityType: matchedOffer?.activityType || activityType,
      isPromotional: Boolean(matchedOffer?.isPromotional)
    },
    actions.reportActivity
  );
};

/**
 * Claim toàn bộ điểm chờ (pointClaim > 0) qua reportClaimAllPoints trên /dashboard
 */
export const claimPointsViaServerAction = async (actionId) => {
  if (!actionId) return { ok: false, error: "Thiếu reportClaimAllPoints actionId" };
  const dashRes = await callNextServerAction({ pagePath: "/dashboard", actionId, args: [] });
  if (dashRes.ok) return dashRes;
  return callNextServerAction({ pagePath: "/earn", actionId, args: [] });
};

/**
 * Tách và chuẩn hóa danh sách card từ window.flyoutViewModel HTML hoặc panelflyout JSON
 */
export const parseFlyoutViewModelHtml = (html) => {
  if (!html || typeof html !== "string") return null;
  const assignMatch = html.match(/window\.flyoutViewModel\s*=\s*\{/);
  if (!assignMatch) return null;

  const braceIdx = assignMatch.index + assignMatch[0].length - 1;
  return parseJsonFromOpenBrace(html, braceIdx);
};

const normalizeFlyoutCards = (model) => {
  const flyout = model?.flyoutResult || model || {};
  const userId = String(model?.userId || flyout?.userStatus?.userId || "");
  const cards = [];

  const pushPromo = (item, sourceGroup) => {
    if (!item || typeof item !== "object") return;
    const offerId = String(item.offerId || item.name || item.attributes?.offerid || "").trim();
    if (!offerId) return;
    cards.push({
      offerId,
      hash: String(item.hash || item.authKey || ""),
      title: String(item.title || item.attributes?.title || offerId),
      activityType: String(item.activityType || item.promotionType || "bingredirect"),
      promotionSubtype: String(item.promotionSubtype || item.attributes?.subtype || ""),
      isCompleted: Boolean(item.complete || item.isCompleted || String(item.attributes?.complete || "").toLowerCase() === "true"),
      isLocked: Boolean(item.isLocked),
      destinationUrl: String(item.destinationUrl || item.destination || item.url || ""),
      points: Number(item.pointProgressMax ?? item.pointTotal ?? item.points ?? 0),
      sourceGroup
    });
  };

  if (flyout.dailySetPromotions && typeof flyout.dailySetPromotions === "object") {
    const entries = Array.isArray(flyout.dailySetPromotions)
      ? flyout.dailySetPromotions
      : Object.values(flyout.dailySetPromotions).flat();
    for (const item of entries) pushPromo(item, "dailySetPromotions");
  }

  for (const groupName of ["morePromotions", "morePromotionsWithoutPromotionalItems", "morePromotionsWithoutStreaks", "promotionalItems"]) {
    const list = flyout[groupName];
    if (Array.isArray(list)) {
      for (const item of list) pushPromo(item, groupName);
    }
  }

  return { userId, cards, rawModel: model };
};

/**
 * Lấy window.flyoutViewModel từ Bing Flyout V1 HTML (fallback JSON getuserinfo)
 */
export const fetchFlyoutViewModel = async () => {
  try {
    const res = await fetch(FLYOUT_HTML_URL, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    if (res.ok) {
      const html = await res.text();
      const model = parseFlyoutViewModelHtml(html);
      if (model) {
        return { success: true, source: "flyout_html", ...normalizeFlyoutCards(model) };
      }
    }
  } catch (e) {}

  try {
    const jsonRes = await fetch(FLYOUT_JSON_URL, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (jsonRes.ok) {
      const data = await jsonRes.json();
      if (data?.flyoutResult) {
        return { success: true, source: "flyout_json", ...normalizeFlyoutCards(data) };
      }
    }
  } catch (e) {}

  return { success: false, userId: "", cards: [], rawModel: null };
};

/**
 * Báo cáo hoàn thành thẻ trực tiếp qua Bing Flyout V1 API (/msrewards/api/v1/reportactivity)
 */
export const reportFlyoutOfferV1 = async (card, userId) => {
  if (!card?.offerId || !card?.hash) {
    return { success: false, OfferComplete: false, error: "Thiếu OfferId hoặc AuthKey(hash)" };
  }

  try {
    const res = await fetch(FLYOUT_REPORT_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ActivityType: String(card.activityType || "bingredirect"),
        ActivitySubType: String(card.promotionSubtype || ""),
        OfferId: String(card.offerId),
        Channel: "BingFlyout",
        PartnerId: "BingRewards",
        UserId: String(userId || ""),
        AuthKey: String(card.hash),
        ActivityCount: 1
      })
    });

    const data = await res.json().catch(() => null);
    const errCode = data?.ErrorDetail?.ErrorCode;
    const ok = Boolean(res.ok && (errCode === 0 || data?.OfferComplete === true || data?.ActivityComplete === true));
    return {
      success: ok,
      status: res.status,
      OfferComplete: Boolean(data?.OfferComplete),
      raw: data
    };
  } catch (e) {
    return { success: false, OfferComplete: false, error: e.message };
  }
};

/**
 * Trích xuất mã 32 ký tự hex IG (Impression GUID) từ HTML trang tìm kiếm Bing SERP
 */
export const extractSerpImpressionGuid = (html) => {
  if (!html || typeof html !== "string") return "";
  const gMatch = html.match(/_G\s*=\s*\{[^}]*\bIG\s*:\s*["']([A-F0-9]{32})["']/i);
  if (gMatch?.[1]) return gMatch[1];

  const propMatch = html.match(/\b["']?IG["']?\s*:\s*["']([A-F0-9]{32})["']/i);
  if (propMatch?.[1]) return propMatch[1];

  const paramMatch = html.match(/[?&]IG=([A-F0-9]{32})\b/i);
  return paramMatch?.[1] || "";
};

/**
 * Phân tích phản hồi ModernRewards.ReportActivity({...}) từ Bing /rewardsapp/reportActivity
 */
export const parseBingSearchReportResponse = (data) => {
  const empty = {
    balance: null,
    previousBalance: null,
    sessionBalanceDelta: null,
    searchPointsEarned: null,
    searchPointsLimit: null,
    isMobileClient: null,
    isAuthenticated: null,
    rewardsIncrement: null
  };
  if (typeof data !== "string") return empty;
  const match = data.match(/ModernRewards\.ReportActivity\((\{[\s\S]*?\})\)\s*;/);
  if (!match) return empty;

  try {
    const root = JSON.parse(match[1] || "{}") || {};
    const session = root.RewardsSessionData || {};
    const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const balance = numOrNull(session.Balance);
    const previousBalance = numOrNull(session.PreviousBalance);
    return {
      balance,
      previousBalance,
      sessionBalanceDelta: balance !== null && previousBalance !== null ? balance - previousBalance : null,
      searchPointsEarned: numOrNull(session.DailySearchPointsEarned),
      searchPointsLimit: numOrNull(session.DailySearchPointsLimit),
      isMobileClient: typeof root.IsMobileClient === "boolean" ? root.IsMobileClient : null,
      isAuthenticated: typeof root.IsAuthenticated === "boolean" ? root.IsAuthenticated : null,
      rewardsIncrement: numOrNull(root.RewardsIncrement)
    };
  } catch (e) {
    return empty;
  }
};

/**
 * Gửi trực tiếp beacon /rewardsapp/reportActivity kèm IG & IID=SERP.5064
 */
export const reportBingSerpActivity = async ({
  serpUrl,
  query = "",
  ig,
  formCode = "ANNTA1",
  cvid = "",
  bcid = "",
  referer = ""
}) => {
  if (!serpUrl || !ig) {
    return { ok: false, status: 0, error: "Thiếu serpUrl hoặc IG", parsedReport: parseBingSearchReportResponse("") };
  }

  const params = new URLSearchParams({
    IG: ig,
    IID: "SERP.5064",
    q: query || "",
    FORM: formCode || "ANNTA1",
    ajaxreq: "1"
  });
  if (cvid) params.set("cvid", cvid);
  if (bcid) params.set("bcid", bcid);

  try {
    const res = await fetch(`${BING_REPORT_ACTIVITY_URL}?${params.toString()}`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        ...(referer ? { Referer: referer } : {})
      },
      body: `url=${encodeURIComponent(serpUrl)}&V=web`
    });
    const text = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      text,
      parsedReport: parseBingSearchReportResponse(text)
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, parsedReport: parseBingSearchReportResponse("") };
  }
};
