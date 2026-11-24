/**
 * Logic điều khiển giao diện Popup - Microsoft Rewards Master v2.0.0
 * - Hiển thị trung thực 5 trạng thái: idle (⏳), running (🔄), done (✅), warn (⚠️), error (❌).
 * - Nút 📋 Copy log + Xóa log đồng bộ Service Worker.
 * - Cho phép Dừng phiên Stay-Alive ngay cả sau khi Service Worker vừa wake-up.
 */

document.addEventListener("DOMContentLoaded", () => {
  const statusBadge = document.getElementById("status-badge");
  const btnStartSelected = document.getElementById("btn-start-selected");
  const btnStop = document.getElementById("btn-stop");

  const scoreTotal = document.getElementById("score-total");
  const scorePc = document.getElementById("score-pc");
  const scoreMobile = document.getElementById("score-mobile");
  const btnRefreshScore = document.getElementById("btn-refresh-score");

  const chkDailyCheckin = document.getElementById("chk-daily-checkin");
  const chkDailyQuests = document.getElementById("chk-daily-quests");
  const chkVisualSearch = document.getElementById("chk-visual-search");
  const chkPcSearch = document.getElementById("chk-pc-search");
  const chkMobileSearch = document.getElementById("chk-mobile-search");
  const chkReadMsn = document.getElementById("chk-read-msn");
  const chkStayAlive = document.getElementById("chk-stay-alive");

  const txtCheckinStatus = document.getElementById("txt-checkin-status");
  const iconCheckin = document.getElementById("icon-checkin");

  const txtQuestsStatus = document.getElementById("txt-quests-status");
  const iconQuests = document.getElementById("icon-quests");

  const txtVisualStatus = document.getElementById("txt-visual-status");
  const iconVisual = document.getElementById("icon-visual");

  const txtPcProgress = document.getElementById("txt-pc-progress");
  const iconPc = document.getElementById("icon-pc");

  const txtMobileProgress = document.getElementById("txt-mobile-progress");
  const iconMobile = document.getElementById("icon-mobile");

  const txtReadProgress = document.getElementById("txt-read-progress");
  const iconRead = document.getElementById("icon-read");

  const txtStayTimer = document.getElementById("txt-stay-timer");
  const iconStay = document.getElementById("icon-stay");

  const alertBanner = document.getElementById("check-alert-banner");
  const alertTitle = document.getElementById("alert-title");
  const alertDesc = document.getElementById("alert-desc");
  const btnDismissAlert = document.getElementById("btn-dismiss-alert");

  const btnRunCheckin = document.getElementById("btn-run-checkin");
  const btnRunQuests = document.getElementById("btn-run-quests");
  const btnRunVisual = document.getElementById("btn-run-visual");
  const btnRunPc = document.getElementById("btn-run-pc");
  const btnRunMobile = document.getElementById("btn-run-mobile");
  const btnRunRead = document.getElementById("btn-run-read");
  const btnRunStay = document.getElementById("btn-run-stay");
  const btnOpenVisual = document.getElementById("btn-open-visual");

  const logsContainer = document.getElementById("logs-container");
  const btnCopyLogs = document.getElementById("btn-copy-logs");
  const btnClearLogs = document.getElementById("btn-clear-logs");

  const inputPcCount = document.getElementById("input-pc-count");
  const inputMobileCount = document.getElementById("input-mobile-count");
  const inputReadCount = document.getElementById("input-read-count");
  const inputStayMinutes = document.getElementById("input-stay-minutes");
  const inputMinDelay = document.getElementById("input-min-delay");
  const inputMaxDelay = document.getElementById("input-max-delay");
  const chkForceCount = document.getElementById("chk-force-count");
  const chkPreventSleeping = document.getElementById("chk-prevent-sleeping");
  const chkCooldownSafe = document.getElementById("chk-cooldown-safe");
  const inputCooldownRest = document.getElementById("input-cooldown-rest");
  const chkAutoStart = document.getElementById("chk-auto-start");
  const chkPinTab = document.getElementById("chk-pin-tab");

  const updateScoreOverview = () => {
    if (scoreTotal) scoreTotal.textContent = "Đang tải...";
    chrome.runtime.sendMessage({ action: "GET_REWARDS_OVERVIEW" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) {
        if (scoreTotal) scoreTotal.textContent = "Chưa kết nối Bing";
        if (scorePc) scorePc.textContent = "--/--";
        if (scoreMobile) scoreMobile.textContent = "--/--";
        return;
      }
      if (scoreTotal) scoreTotal.textContent = `${res.availablePoints.toLocaleString("vi-VN")} pts`;
      if (scorePc) scorePc.textContent = `${res.pc.earned} / ${res.pc.max} pts`;
      if (scoreMobile) scoreMobile.textContent = `${res.mobile.earned} / ${res.mobile.max} pts`;
    });
  };

  if (btnRefreshScore) {
    btnRefreshScore.addEventListener("click", updateScoreOverview);
  }

  const applyIndicator = (iconEl, textEl, status, messages) => {
    if (!iconEl || !textEl) return;
    if (status === "running") {
      iconEl.textContent = "🔄";
      iconEl.className = "status-indicator running";
      textEl.textContent = messages.running;
    } else if (status === "done") {
      iconEl.textContent = "✅";
      iconEl.className = "status-indicator success";
      textEl.textContent = messages.done;
    } else if (status === "warn") {
      iconEl.textContent = "⚠️";
      iconEl.className = "status-indicator warn";
      textEl.textContent = messages.warn || messages.done;
    } else if (status === "error") {
      iconEl.textContent = "❌";
      iconEl.className = "status-indicator error";
      textEl.textContent = messages.error || messages.warn;
    } else {
      iconEl.textContent = "⏳";
      iconEl.className = "status-indicator pending";
      textEl.textContent = messages.idle;
    }
  };

  const renderState = (state) => {
    if (!state) return;

    const stayActiveOnly = !state.isRunning && Boolean(state.stayAliveSession?.active);

    if (state.isRunning) {
      statusBadge.textContent = "Đang chạy";
      statusBadge.className = "status-badge running";
      btnStartSelected.disabled = true;
      btnStop.disabled = false;
      [btnRunCheckin, btnRunQuests, btnRunVisual, btnRunPc, btnRunMobile, btnRunRead, btnRunStay].forEach((b) => {
        if (b) b.disabled = true;
      });
    } else if (stayActiveOnly) {
      statusBadge.textContent = "Đang treo máy";
      statusBadge.className = "status-badge running";
      btnStartSelected.disabled = false;
      btnStop.disabled = false;
      [btnRunCheckin, btnRunQuests, btnRunVisual, btnRunPc, btnRunMobile, btnRunRead, btnRunStay].forEach((b) => {
        if (b) b.disabled = false;
      });
    } else {
      statusBadge.textContent = state.currentStep === "completed" ? "Hoàn thành" : "Sẵn sàng";
      statusBadge.className = "status-badge idle";
      btnStartSelected.disabled = false;
      btnStop.disabled = true;
      [btnRunCheckin, btnRunQuests, btnRunVisual, btnRunPc, btnRunMobile, btnRunRead, btnRunStay].forEach((b) => {
        if (b) b.disabled = false;
      });
    }

    if (state.selectedTasks) {
      if (chkDailyCheckin) chkDailyCheckin.checked = state.selectedTasks.dailyCheckin !== false;
      if (chkDailyQuests) chkDailyQuests.checked = state.selectedTasks.dailyQuests !== false;
      if (chkVisualSearch) chkVisualSearch.checked = state.selectedTasks.visualSearch !== false;
      chkPcSearch.checked = !!state.selectedTasks.pcSearch;
      chkMobileSearch.checked = !!state.selectedTasks.mobileSearch;
      chkReadMsn.checked = !!state.selectedTasks.readMsn;
      chkStayAlive.checked = !!state.selectedTasks.stayAlive;
    }

    const ts = state.taskStatus || {};
    const sum = state.taskSummary || {};

    // 0. Daily Check-in
    const checkinStatus = ts.dailyCheckin !== "idle" && ts.dailyCheckin
      ? ts.dailyCheckin
      : (state.currentStep === "daily_checkin" ? "running" : "idle");
    applyIndicator(iconCheckin, txtCheckinStatus, checkinStatus, {
      running: "Đang điểm danh...",
      done: sum.dailyCheckin || "Đã điểm danh / kiểm tra",
      warn: sum.dailyCheckin || "Chưa xác nhận điểm danh",
      error: sum.dailyCheckin || "Lỗi điểm danh (xem log)",
      idle: "Sẵn sàng điểm danh"
    });

    // 0.2. Daily Quests
    const questsStatus = ts.dailyQuests !== "idle" && ts.dailyQuests
      ? ts.dailyQuests
      : (state.currentStep === "daily_quests" ? "running" : "idle");
    applyIndicator(iconQuests, txtQuestsStatus, questsStatus, {
      running: state.questsTarget > 0 ? `Đang làm ${state.questsDone}/${state.questsTarget} quest...` : "Đang quét quest...",
      done: sum.dailyQuests || "Đã hoàn tất quest hàng ngày",
      warn: sum.dailyQuests || "Chưa thấy quest mới",
      error: sum.dailyQuests || "Lỗi làm quest (xem log)",
      idle: "Sẵn sàng làm quest"
    });

    // 0.5. Visual Search Streak
    const visualStatus = ts.visualSearch !== "idle" && ts.visualSearch
      ? ts.visualSearch
      : (state.currentStep === "visual_search" ? "running" : "idle");
    applyIndicator(iconVisual, txtVisualStatus, visualStatus, {
      running: "Đang tìm kiếm ảnh...",
      done: sum.visualSearch || "Đã xác nhận 1/1",
      warn: sum.visualSearch || "Đã chạy — F5 Rewards kiểm tra 1/1",
      error: sum.visualSearch || "Lỗi Visual Search (xem log)",
      idle: "Tự động hoàn thành streak"
    });

    // 1. PC Search
    const pcStatus = ts.pcSearch !== "idle" && ts.pcSearch
      ? ts.pcSearch
      : (state.currentStep === "pc_search" ? "running" : "idle");
    applyIndicator(iconPc, txtPcProgress, pcStatus, {
      running: `${state.searchesDone} / ${state.searchesTarget} lượt`,
      done: sum.pcSearch || `Đã xong (${state.searchesDone} lượt)`,
      warn: sum.pcSearch || "Chưa lên điểm (xem log)",
      error: sum.pcSearch || "Lỗi Web PC Search",
      idle: `${state.searchesDone || 0} / ${state.config?.pcSearchCount || 30} lượt`
    });

    // 2. Mobile Search
    const mobStatus = ts.mobileSearch !== "idle" && ts.mobileSearch
      ? ts.mobileSearch
      : (state.currentStep === "mobile_search" ? "running" : "idle");
    applyIndicator(iconMobile, txtMobileProgress, mobStatus, {
      running: `${state.mobileSearchesDone} / ${state.mobileSearchesTarget} lượt`,
      done: sum.mobileSearch || `Đã xong (${state.mobileSearchesDone} lượt)`,
      warn: sum.mobileSearch || "Chưa lên điểm Mobile (xem log)",
      error: sum.mobileSearch || "Lỗi Mobile Search",
      idle: `${state.mobileSearchesDone || 0} / ${state.config?.mobileSearchCount || 20} lượt`
    });

    // 3. Read MSN
    const readStatus = ts.readMsn !== "idle" && ts.readMsn
      ? ts.readMsn
      : (state.currentStep === "reading_msn" ? "running" : "idle");
    applyIndicator(iconRead, txtReadProgress, readStatus, {
      running: `${state.articlesReadDone} / ${state.articlesReadTarget} bài`,
      done: sum.readMsn || `Đã xong (${state.articlesReadDone}/${state.articlesReadTarget} bài)`,
      warn: sum.readMsn || "Hoàn tất (kiểm tra điểm)",
      error: sum.readMsn || "Lỗi đọc báo",
      idle: `${state.articlesReadDone || 0} / ${state.config?.readMsnCount || 10} bài`
    });

    // 4. Treo máy
    const remainingSecs = Math.max(0, state.stayAliveSecondsRemaining || 0);
    const rMins = Math.floor(remainingSecs / 60);
    const rSecs = remainingSecs % 60;
    const stayIsRunning = ts.stayAlive === "running" || state.currentStep === "staying_alive" || Boolean(state.stayAliveSession?.active);
    const stayStatus = stayIsRunning ? "running" : (ts.stayAlive || "idle");
    applyIndicator(iconStay, txtStayTimer, stayStatus, {
      running: sum.stayAlive ? `${rMins}:${rSecs < 10 ? "0" : ""}${rSecs} (${sum.stayAlive})` : `${rMins}:${rSecs < 10 ? "0" : ""}${rSecs} còn lại`,
      done: sum.stayAlive || `Đã hoàn tất ${state.config?.stayAliveMinutes || 30} phút`,
      warn: sum.stayAlive || "Đã dừng sớm",
      error: sum.stayAlive || "Lỗi Treo máy",
      idle: `${state.config?.stayAliveMinutes || 30}:00 còn lại (Chạy ngầm 100%, hỗ trợ thu nhỏ Edge)`
    });
    if (stayIsRunning) iconStay.textContent = "⏳";

    // Khung cảnh báo 10 phút
    if (state.pendingUserAlert) {
      alertTitle.textContent = `🔔 Đã treo được ${state.pendingUserAlert.minutes} phút!`;
      alertDesc.textContent = state.pendingUserAlert.message;
      alertBanner.style.display = "flex";
    } else {
      alertBanner.style.display = "none";
    }

    // Logs
    if (state.logs && state.logs.length > 0) {
      logsContainer.innerHTML = "";
      state.logs.forEach((log) => {
        const div = document.createElement("div");
        div.className = "log-entry";
        div.textContent = log;
        logsContainer.appendChild(div);
      });
      logsContainer.scrollTop = logsContainer.scrollHeight;
    } else {
      logsContainer.innerHTML = '<div class="log-entry">[Sẵn sàng] Chọn các mục bên trên và bấm "Bắt Đầu".</div>';
    }

    // Cài đặt
    if (state.config) {
      inputPcCount.value = state.config.pcSearchCount || 30;
      inputMobileCount.value = state.config.mobileSearchCount || 20;
      inputReadCount.value = state.config.readMsnCount || 10;
      inputStayMinutes.value = state.config.stayAliveMinutes || 30;
      inputMinDelay.value = state.config.minSearchDelay ?? 2.5;
      inputMaxDelay.value = state.config.maxSearchDelay ?? 4.5;
      if (chkForceCount) chkForceCount.checked = state.config.forceSearchCount === true;
      if (chkPreventSleeping) chkPreventSleeping.checked = state.config.preventSleepingMin !== false;
      if (chkCooldownSafe) chkCooldownSafe.checked = state.config.cooldownSafeMode === true;
      if (inputCooldownRest) inputCooldownRest.value = state.config.cooldownRestMinutes || 1;
      if (chkAutoStart) chkAutoStart.checked = !!state.config.autoStart;
      if (chkPinTab) chkPinTab.checked = state.config.pinTab !== false;
    }
  };

  const savePreferences = () => {
    const selectedTasks = {
      dailyCheckin: chkDailyCheckin ? chkDailyCheckin.checked : true,
      dailyQuests: chkDailyQuests ? chkDailyQuests.checked : true,
      visualSearch: chkVisualSearch ? chkVisualSearch.checked : true,
      pcSearch: chkPcSearch.checked,
      mobileSearch: chkMobileSearch.checked,
      readMsn: chkReadMsn.checked,
      stayAlive: chkStayAlive.checked
    };

    const config = {
      pcSearchCount: parseInt(inputPcCount.value, 10) || 30,
      mobileSearchCount: parseInt(inputMobileCount.value, 10) || 20,
      readMsnCount: parseInt(inputReadCount.value, 10) || 10,
      stayAliveMinutes: parseInt(inputStayMinutes.value, 10) || 30,
      minSearchDelay: parseFloat(inputMinDelay.value) || 2.5,
      maxSearchDelay: parseFloat(inputMaxDelay.value) || 4.5,
      forceSearchCount: chkForceCount ? chkForceCount.checked : false,
      preventSleepingMin: chkPreventSleeping ? chkPreventSleeping.checked : true,
      cooldownSafeMode: chkCooldownSafe ? chkCooldownSafe.checked : false,
      cooldownRestMinutes: inputCooldownRest ? parseInt(inputCooldownRest.value, 10) || 1 : 1,
      autoStart: chkAutoStart ? chkAutoStart.checked : false,
      pinTab: chkPinTab ? chkPinTab.checked : true
    };

    chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      selectedTasks,
      config
    });
  };

  btnStartSelected.addEventListener("click", () => {
    savePreferences();
    chrome.runtime.sendMessage({
      action: "START_SELECTED",
      selectedTasks: {
        dailyCheckin: chkDailyCheckin ? chkDailyCheckin.checked : true,
        dailyQuests: chkDailyQuests ? chkDailyQuests.checked : true,
        visualSearch: chkVisualSearch ? chkVisualSearch.checked : true,
        pcSearch: chkPcSearch.checked,
        mobileSearch: chkMobileSearch.checked,
        readMsn: chkReadMsn.checked,
        stayAlive: chkStayAlive.checked
      }
    }, (res) => {
      if (res && res.state) renderState(res.state);
    });
  });

  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "STOP_ALL" }, (res) => {
      if (res && res.state) renderState(res.state);
    });
  });

  btnDismissAlert.addEventListener("click", () => {
    alertBanner.style.display = "none";
    chrome.runtime.sendMessage({ action: "DISMISS_ALERT" });
  });

  const wireModuleButton = (btn, modName) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "START_MODULE", module: modName }, (res) => {
        if (res && res.state) renderState(res.state);
      });
    });
  };

  wireModuleButton(btnRunCheckin, "dailyCheckin");
  wireModuleButton(btnRunQuests, "dailyQuests");
  wireModuleButton(btnRunVisual, "visualSearch");
  wireModuleButton(btnRunPc, "pcSearch");
  wireModuleButton(btnRunMobile, "mobileSearch");
  wireModuleButton(btnRunRead, "readMsn");
  wireModuleButton(btnRunStay, "stayAlive");

  if (btnOpenVisual) {
    btnOpenVisual.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "OPEN_VISUAL_SEARCH" }, () => {});
    });
  }

  if (btnCopyLogs) {
    btnCopyLogs.addEventListener("click", async () => {
      const entries = Array.from(logsContainer.querySelectorAll(".log-entry")).map((el) => el.textContent);
      const text = entries.join("\n");
      try {
        await navigator.clipboard.writeText(text);
        const orig = btnCopyLogs.textContent;
        btnCopyLogs.textContent = "✅ Đã copy!";
        setTimeout(() => {
          btnCopyLogs.textContent = orig;
        }, 1500);
      } catch (e) {}
    });
  }

  btnClearLogs.addEventListener("click", () => {
    logsContainer.innerHTML = '<div class="log-entry">[Đã xóa nhật ký]</div>';
    chrome.runtime.sendMessage({ action: "CLEAR_LOGS" }, (res) => {
      if (res && res.state) renderState(res.state);
    });
  });

  [chkDailyCheckin, chkDailyQuests, chkVisualSearch, chkPcSearch, chkMobileSearch, chkReadMsn, chkStayAlive,
    inputPcCount, inputMobileCount, inputReadCount, inputStayMinutes, inputMinDelay, inputMaxDelay,
    chkForceCount, chkPreventSleeping, chkCooldownSafe, inputCooldownRest, chkAutoStart, chkPinTab].forEach((el) => {
    if (el) el.addEventListener("change", savePreferences);
  });

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "STATE_UPDATED" && request.state) {
      renderState(request.state);
      return;
    }

    if (request.action === "NEW_LOG") {
      const div = document.createElement("div");
      div.className = "log-entry";
      div.textContent = request.log;
      logsContainer.appendChild(div);
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    if (request.action === "PROGRESS_UPDATE") {
      if (request.module === "dailyQuests") {
        if (iconQuests) {
          iconQuests.textContent = request.current >= request.total ? "✅" : "🔄";
          iconQuests.className = request.current >= request.total ? "status-indicator success" : "status-indicator running";
        }
        if (txtQuestsStatus) {
          txtQuestsStatus.textContent = request.current >= request.total
            ? `Đã xong ${request.current}/${request.total} quest`
            : `Đang làm ${request.current} / ${request.total} quest...`;
        }
      } else if (request.module === "pcSearch") {
        iconPc.textContent = "🔄";
        iconPc.className = "status-indicator running";
        txtPcProgress.textContent = `${request.current} / ${request.total} lượt`;
      } else if (request.module === "mobileSearch") {
        iconMobile.textContent = "🔄";
        iconMobile.className = "status-indicator running";
        txtMobileProgress.textContent = `${request.current} / ${request.total} lượt`;
      } else if (request.module === "readMsn") {
        iconRead.textContent = "🔄";
        iconRead.className = "status-indicator running";
        txtReadProgress.textContent = `${request.current} / ${request.total} bài`;
      } else if (request.module === "stayAlive") {
        iconStay.textContent = "⏳";
        iconStay.className = "status-indicator running";
        const mins = Math.floor(request.secondsRemaining / 60);
        const secs = request.secondsRemaining % 60;
        const padSecs = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
        txtStayTimer.textContent = request.summary ? `${padSecs} (${request.summary})` : `${padSecs} còn lại`;
      }

      if (request.current && (request.current % 3 === 0 || request.current === request.total)) {
        updateScoreOverview();
      }
    }

    if (request.action === "USER_CHECK_ALERT") {
      alertTitle.textContent = `🔔 Đã treo được ${request.alert.minutes} phút!`;
      alertDesc.textContent = request.alert.message;
      alertBanner.style.display = "flex";
    }
  });

  chrome.runtime.sendMessage({ action: "GET_STATE" }, (res) => {
    if (res && res.state) {
      renderState(res.state);
    }
  });

  updateScoreOverview();
});
