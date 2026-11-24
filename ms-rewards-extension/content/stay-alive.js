/**
 * Content Script: Stay-Alive Active Browsing Helper trên MSN News (v2.0.0)
 * 1. Đặt Muted Canvas Video Stream (captureStream(5)) làm kênh chính Autoplay-safe 100% không dính NotAllowedError.
 * 2. Silent Audio & Web Audio chạy best-effort không spam lỗi console; chỉ đặt mediaSession = "playing" khi media thực sự phát.
 * 3. Khóa Web Lock (navigator.locks) ngăn Chromium đưa tab vào Sleeping Tab / Freeze.
 * 4. Dùng Web Worker timer 3s (fallback ngay về setInterval nếu bị CSP chặn blob worker) để cuộn đọc & gửi STAY_ALIVE_HEARTBEAT.
 */

(() => {
  if (window !== window.top) return;
  if (window.__msRewardsStayAliveLoaded) return;
  window.__msRewardsStayAliveLoaded = true;

  console.log("[MS-Rewards] Stay-Alive Active Browsing Helper v2.0.0 đã nạp trên MSN.");

  let isActive = false;
  let tickWorker = null;
  let tickWorkerUrl = null;
  let fallbackTimer = null;
  let canvasDrawTimer = null;
  let audioContext = null;
  let silentAudioElement = null;
  let keepAliveVideo = null;
  let keepAliveCanvas = null;
  let keepAliveStream = null;
  let webLockResolver = null;
  let scrollDirection = 1;
  let scrollStepCount = 0;

  const VALID_SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

  const setMediaSessionPlayingIfReady = () => {
    if (!("mediaSession" in navigator)) return;
    try {
      const videoPlaying = Boolean(keepAliveVideo && !keepAliveVideo.paused);
      const audioPlaying = Boolean(silentAudioElement && !silentAudioElement.paused);
      if (videoPlaying || audioPlaying) {
        if (!navigator.mediaSession.metadata) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: "MSN Active Browsing Session",
            artist: "Microsoft Rewards Master",
            album: "Edge Keep-Alive Engine"
          });
        }
        navigator.mediaSession.playbackState = "playing";
      }
    } catch (e) {}
  };

  /**
   * 1. Kênh chính Autoplay-safe 100%: Muted Canvas Video Stream
   */
  const startCanvasVideoKeepAlive = () => {
    try {
      if (!keepAliveCanvas) {
        keepAliveCanvas = document.createElement("canvas");
        keepAliveCanvas.width = 16;
        keepAliveCanvas.height = 16;
        keepAliveCanvas.style.cssText = "position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;";
        document.documentElement.appendChild(keepAliveCanvas);
      }

      const ctx = keepAliveCanvas.getContext("2d");
      const drawFrame = () => {
        if (!ctx || !isActive) return;
        const tick = Math.floor(Date.now() / 1000) % 255;
        ctx.fillStyle = `rgb(${tick}, 120, 215)`;
        ctx.fillRect(0, 0, 16, 16);
      };
      drawFrame();

      if (!canvasDrawTimer) {
        canvasDrawTimer = setInterval(drawFrame, 1000);
      }

      if (typeof keepAliveCanvas.captureStream === "function" && !keepAliveVideo) {
        keepAliveStream = keepAliveCanvas.captureStream(5);
        keepAliveVideo = document.createElement("video");
        keepAliveVideo.id = "ms-rewards-keepalive-video";
        keepAliveVideo.muted = true;
        keepAliveVideo.autoplay = true;
        keepAliveVideo.playsInline = true;
        keepAliveVideo.style.cssText = "position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;";
        keepAliveVideo.srcObject = keepAliveStream;
        document.documentElement.appendChild(keepAliveVideo);
        keepAliveVideo.play().then(setMediaSessionPlayingIfReady).catch(() => {});
      }
    } catch (e) {}
  };

  const stopCanvasVideoKeepAlive = () => {
    try {
      if (canvasDrawTimer) {
        clearInterval(canvasDrawTimer);
        canvasDrawTimer = null;
      }
      if (keepAliveVideo) {
        keepAliveVideo.pause();
        keepAliveVideo.srcObject = null;
        keepAliveVideo.remove();
        keepAliveVideo = null;
      }
      if (keepAliveStream) {
        keepAliveStream.getTracks().forEach((t) => t.stop());
        keepAliveStream = null;
      }
      if (keepAliveCanvas) {
        keepAliveCanvas.remove();
        keepAliveCanvas = null;
      }
    } catch (e) {}
  };

  /**
   * 2. Kênh phụ best-effort: Silent HTML5 Audio & Web Audio (bỏ qua êm nếu trình duyệt chặn autoplay)
   */
  const startBestEffortAudio = () => {
    try {
      if (!silentAudioElement) {
        silentAudioElement = document.createElement("audio");
        silentAudioElement.id = "ms-rewards-keepalive-audio";
        silentAudioElement.src = VALID_SILENT_WAV_BASE64;
        silentAudioElement.loop = true;
        silentAudioElement.volume = 0.0001;
        document.documentElement.appendChild(silentAudioElement);
      }
      silentAudioElement.play().then(setMediaSessionPlayingIfReady).catch(() => {});
    } catch (e) {}

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (audioContext && audioContext.state !== "closed") {
        if (audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
        }
        return;
      }
      audioContext = new AudioCtx();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0.00001;
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start();
    } catch (e) {}
  };

  const stopBestEffortAudio = () => {
    try {
      if (silentAudioElement) {
        silentAudioElement.pause();
        silentAudioElement.remove();
        silentAudioElement = null;
      }
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
      if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => {});
      }
      audioContext = null;
    } catch (e) {}
  };

  /**
   * 3. Web Lock API giữ kết nối khóa ngăn trình duyệt ngủ đông / freeze tab
   */
  const acquireWebLock = () => {
    try {
      if (navigator.locks && !webLockResolver) {
        navigator.locks.request("ms_rewards_stay_alive_lock", () => {
          return new Promise((resolve) => {
            webLockResolver = resolve;
          });
        }).catch(() => {});
      }
    } catch (e) {}
  };

  const releaseWebLock = () => {
    try {
      if (webLockResolver) {
        webLockResolver();
        webLockResolver = null;
      }
    } catch (e) {}
  };

  /**
   * 4. Nhịp tick mỗi 3 giây: cuộn đọc bài + phát tín hiệu hoạt động + gửi STAY_ALIVE_HEARTBEAT
   */
  const onStayAliveTick = () => {
    if (!isActive) return;

    try {
      const scrollAmount = (Math.floor(Math.random() * 110) + 90) * scrollDirection;
      window.scrollBy({ top: scrollAmount, behavior: "smooth" });
      scrollStepCount++;

      const atBottom = (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 300);
      if (atBottom || scrollStepCount > 18) {
        scrollDirection = -1;
        if (window.scrollY < 200) {
          scrollDirection = 1;
          scrollStepCount = 0;
        }
      }

      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100 + (scrollStepCount % 50), clientY: 100 }));
      document.dispatchEvent(new Event("pointermove", { bubbles: true }));

      if (keepAliveVideo && keepAliveVideo.paused) {
        keepAliveVideo.play().then(setMediaSessionPlayingIfReady).catch(() => {});
      }
    } catch (e) {}

    chrome.runtime.sendMessage({
      action: "STAY_ALIVE_HEARTBEAT",
      currentUrl: window.location.href
    }).catch(() => {});
  };

  const ensureFallbackTimer = () => {
    if (isActive && !fallbackTimer) {
      fallbackTimer = setInterval(onStayAliveTick, 3000);
    }
  };

  const startUnthrottledTimer = () => {
    stopUnthrottledTimer();
    let workerOk = false;
    try {
      const workerCode = "setInterval(() => { postMessage('tick'); }, 3000);";
      const blob = new Blob([workerCode], { type: "application/javascript" });
      tickWorkerUrl = URL.createObjectURL(blob);
      tickWorker = new Worker(tickWorkerUrl);
      tickWorker.onmessage = () => onStayAliveTick();
      tickWorker.onerror = () => {
        stopUnthrottledTimer();
        ensureFallbackTimer();
      };
      workerOk = true;
    } catch (e) {
      workerOk = false;
    }
    if (!workerOk) {
      ensureFallbackTimer();
    }
  };

  const stopUnthrottledTimer = () => {
    if (tickWorker) {
      try { tickWorker.terminate(); } catch (e) {}
      tickWorker = null;
    }
    if (tickWorkerUrl) {
      try { URL.revokeObjectURL(tickWorkerUrl); } catch (e) {}
      tickWorkerUrl = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const startSession = () => {
    if (isActive) return;
    isActive = true;

    startCanvasVideoKeepAlive();
    startBestEffortAudio();
    acquireWebLock();
    startUnthrottledTimer();

    chrome.runtime.sendMessage({
      action: "STAY_ALIVE_HEARTBEAT",
      currentUrl: window.location.href
    }).catch(() => {});

    console.log("[MS-Rewards] Đã bắt đầu phiên Treo Máy Tích Cực v2.0.0 trên MSN.");
  };

  const stopSession = () => {
    isActive = false;
    stopUnthrottledTimer();
    stopCanvasVideoKeepAlive();
    stopBestEffortAudio();
    releaseWebLock();
    console.log("[MS-Rewards] Đã dừng phiên Treo Máy trên MSN.");
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_STAY_ALIVE_TAB") {
      startSession();
      sendResponse({ success: true });
      return true;
    }

    if (request.action === "STOP_STAY_ALIVE_TAB") {
      stopSession();
      sendResponse({ success: true });
      return true;
    }

    if (request.action === "PING_STAY_ALIVE") {
      sendResponse({ active: isActive });
      return true;
    }
  });

  chrome.runtime.sendMessage({ action: "CHECK_IF_STAY_ALIVE_TAB" }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.isStayAliveTab) {
      startSession();
    }
  });
})();
