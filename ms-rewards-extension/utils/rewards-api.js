/**
 * Rewards API Helper
 * Gọi trực tiếp Bing Flyout User Info API trên www.bing.com (không dính lỗi gallery sandbox)
 * Lấy điểm số thời gian thực và hạn mức nhiệm vụ PC/Mobile Search trong ngày.
 */

const FLYOUT_USER_INFO_URL = "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards";

export const fetchRewardsOverview = async () => {
  try {
    const res = await fetch(FLYOUT_USER_INFO_URL, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    if (data.isError || !data.flyoutResult?.userStatus) {
      return { success: false, error: data.errorMessage || "Chưa đăng nhập Bing Rewards" };
    }

    const status = data.flyoutResult.userStatus;
    const counters = status.counters || {};

    const summarizeCounter = (counterData) => {
      if (!counterData) return { earned: 0, max: 0 };
      if (Array.isArray(counterData)) {
        const seenIds = new Set();
        return counterData.reduce(
          (acc, item) => {
            if (!item || typeof item !== "object") return acc;
            const idKey = String(item.offerId || item.name || item.attributes?.offerid || "").trim();
            if (idKey) {
              if (seenIds.has(idKey)) return acc;
              seenIds.add(idKey);
            }
            return {
              earned: acc.earned + (Number(item.pointProgress) || 0),
              max: acc.max + (Number(item.pointProgressMax) || 0)
            };
          },
          { earned: 0, max: 0 }
        );
      }
      return {
        earned: Number(counterData.pointProgress) || 0,
        max: Number(counterData.pointProgressMax) || 0
      };
    };

    const pcCounters = counters.PCSearch || counters.pcSearch || [];
    const mobileCounters = counters.MobileSearch || counters.mobileSearch || [];

    const pcStats = summarizeCounter(pcCounters);
    const mobileStats = summarizeCounter(mobileCounters);

    const availablePoints = status.availablePoints ?? data.userInfo?.balance ?? 0;

    return {
      success: true,
      availablePoints,
      pc: pcStats,
      mobile: mobileStats,
      raw: data
    };
  } catch (error) {
    console.warn("[RewardsAPI] Lỗi lấy điểm:", error);
    return { success: false, error: error.message };
  }
};
