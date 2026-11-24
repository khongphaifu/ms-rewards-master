/**
 * Content Script tự động giải quyết các nhiệm vụ khi mở trên Bing / MSN (v2.0.0):
 * - Khảo sát hàng ngày (Daily Poll)
 * - Trắc nghiệm (Supersonic Quiz, Lightspeed Quiz, This or That, 10-point trivia, Warpspeed)
 * - Thẻ click khám phá thông tin (Click & Explore)
 * Sửa triệt để lỗi bấm liền hết mọi đáp án trước khi trang chuyển câu bằng snapshot getQuestionSignature().
 */

(() => {
  if (window.__msRewardsQuizSolverLoaded) return;
  window.__msRewardsQuizSolverLoaded = true;

  console.log("[MS-Rewards-Master] Quiz Solver Content Script v2.3.0 đã được tiêm.");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let isSolving = false;

  const isVisible = (el) => {
    if (!el || !document.contains(el)) return false;
    if (el.offsetParent !== null) return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const POLL_OPTION_SELECTOR =
    "#btoption0, #btoption1, #ChoiceRowId_0, #ChoiceRowId_1, .btOption, div[id^='btoption'], .bt_pollOption, div[id^='Option']";

  const QUIZ_WIDGET_SELECTOR =
    "#quizHeader, #rqStartQuiz, #rqHeaderCredits, #rqAnswerOption0, .rqOption, [id*='quiz' i], .wk_choicesInstLink, div[id^='questionOptionChoice'], .b_poll, .btOptionCard";

  const NEXT_BTN_SELECTOR =
    "#rqNextQuestion, .nextQuestion, input[value*='Next' i], input[value*='Continue' i], input[value*='Tiếp' i], button[value*='Next' i], button[aria-label*='Next' i], .wk_button, a.wk_button";

  const OPTION_SELECTOR = [
    "#rqAnswerOption0", "#rqAnswerOption1", "#rqAnswerOption2", "#rqAnswerOption3",
    "#rqAnswerOption4", "#rqAnswerOption5", "#rqAnswerOption6", "#rqAnswerOption7",
    ".rqOption", ".btOptionCard", ".wk_choicesInstLink", ".wk_option",
    "div[id^='questionOptionChoice']", "#check",
    ".btOption", "input[type='radio']", "input[type='button'].b_btn",
    "[class*='answerOption' i]", "[data-option]"
  ].join(", ");

  const getQuestionSignature = (visibleOptions) => {
    const promptEl =
      document.querySelector("#rqQuestion, .rqQuestion, .bt_queText, #questionText, .wk_ques, h2, .c-heading") ||
      null;
    const creditsText = document.querySelector("#rqHeaderCredits")?.innerText || "";
    const promptText = promptEl?.innerText || "";
    const optTexts = visibleOptions.slice(0, 8).map((o) => (o.innerText || o.value || "").trim()).join("|");
    return `${creditsText}::${promptText}::${optTexts}`;
  };

  /**
   * Tự động giải quyết Daily Poll
   */
  const handleDailyPoll = async () => {
    const pollOptions = Array.from(document.querySelectorAll(POLL_OPTION_SELECTOR)).filter(isVisible);

    if (pollOptions.length > 0) {
      console.log("[MS-Rewards-Master] Phát hiện Daily Poll, đang chọn đáp án...");
      const targetOption = pollOptions[0];
      targetOption.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(450);
      targetOption.click();
      await sleep(1600);
      return { handled: true, stepsDone: 1 };
    }
    return { handled: false, stepsDone: 0 };
  };

  /**
   * Tự động giải quyết các dạng Quiz trắc nghiệm (Supersonic, Lightspeed, This or That, Trivia)
   */
  const handleQuiz = async () => {
    let stepsDone = 0;

    // 1. Nút bắt đầu Quiz nếu có
    const startBtn = document.querySelector(
      "#rqStartQuiz, input[value*='Start' i], input[value*='Bắt đầu' i], a[id*='StartQuiz' i], button[id*='StartQuiz' i], .rq_button, input.b_btn[value*='Test' i]"
    );
    if (startBtn && isVisible(startBtn)) {
      console.log("[MS-Rewards-Master] Bắt đầu làm Quiz...");
      startBtn.click();
      stepsDone++;
      await sleep(1400);
    }

    // 2. Vòng lặp từng câu hỏi (tối đa 35 lượt cho This or That / 3-4 câu hỏi nhiều đáp án)
    const maxAttempts = 35;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Kiểm tra hoàn thành quiz
      const completeContainer = document.querySelector("#quizCompleteContainer");
      const creditsText = document.querySelector("#rqHeaderCredits")?.innerText || "";
      const creditsMatch = creditsText.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
      const creditsFull = Boolean(creditsMatch && Number(creditsMatch[1]) > 0 && Number(creditsMatch[1]) >= Number(creditsMatch[2]));
      const completeBanner = document.querySelector(
        "#rqHeaderCredits, .quizCompletion, .c-subheading, [class*='congrats' i], [class*='complete' i], .rq_complete"
      );
      if (
        (completeContainer && isVisible(completeContainer)) ||
        creditsFull ||
        (completeBanner?.innerText && /congrat|chúc mừng|hoàn thành|you earned|bạn đã nhận/i.test(completeBanner.innerText))
      ) {
        console.log("[MS-Rewards-Master] Quiz đã hoàn tất!");
        await sleep(800);
        return { handled: true, stepsDone };
      }

      // Kiểm tra nút Next trước
      const nextBtnPre = document.querySelector(NEXT_BTN_SELECTOR);
      if (nextBtnPre && isVisible(nextBtnPre)) {
        nextBtnPre.click();
        stepsDone++;
        await sleep(1100);
        continue;
      }

      const options = Array.from(document.querySelectorAll(OPTION_SELECTOR))
        .filter((el) => isVisible(el) && !el.classList.contains("disabled") && !el.disabled);

      if (options.length === 0) {
        break;
      }

      const beforeSig = getQuestionSignature(options);

      // Ưu tiên đáp án có hint đúng nếu trang nhúng data hint (nhiều Lightspeed quiz không lộ, fallback tuần tự)
      let targetOpt =
        options.find((el) => el.dataset.msClicked !== "1" && (el.getAttribute("data-correct") === "true" || el.classList.contains("b_correct"))) ||
        options.find((el) => el.dataset.msClicked !== "1");

      if (!targetOpt) {
        targetOpt = options[0];
      }

      targetOpt.dataset.msClicked = "1";
      targetOpt.scrollIntoView({ behavior: "smooth", block: "center" });
      targetOpt.click();
      stepsDone++;

      await sleep(1100);

      // Nếu hiện nút Next -> bấm Next ngay để sang câu mới
      const nextBtnAfter = document.querySelector(NEXT_BTN_SELECTOR);
      if (nextBtnAfter && isVisible(nextBtnAfter)) {
        nextBtnAfter.click();
        stepsDone++;
        await sleep(1100);
        continue;
      }

      // Nếu câu hỏi tự chuyển hoặc DOM đáp án vừa click bị thay thế -> chuyển vòng kế với câu mới
      const currentOptions = Array.from(document.querySelectorAll(OPTION_SELECTOR))
        .filter((el) => isVisible(el) && !el.classList.contains("disabled") && !el.disabled);
      const afterSig = getQuestionSignature(currentOptions);

      if (!document.contains(targetOpt) || afterSig !== beforeSig) {
        await sleep(300);
        continue;
      }

      await sleep(450);
    }

    return { handled: true, stepsDone };
  };

  /**
   * Xử lý thẻ click khám phá (~2.0s)
   */
  const handleExploreCard = async () => {
    console.log("[MS-Rewards-Master] Đang xử lý thẻ đọc tin / khám phá thông tin (~2s)...");
    window.scrollBy({ top: 320, behavior: "smooth" });
    await sleep(800);
    window.scrollBy({ top: 340, behavior: "smooth" });
    await sleep(700);
    window.scrollBy({ top: -180, behavior: "smooth" });
    await sleep(400);
    return { handled: true, stepsDone: 1 };
  };

  /**
   * Bộ điều phối chính trên trang
   */
  const executeTaskOnPage = async () => {
    if (isSolving) return { success: true, taskType: "already_running", stepsDone: 0 };
    isSolving = true;

    try {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const hasPoll = Array.from(document.querySelectorAll(POLL_OPTION_SELECTOR)).some(isVisible);
        const hasQuiz = Boolean(document.querySelector(QUIZ_WIDGET_SELECTOR));
        if (hasPoll || hasQuiz) break;
        await sleep(250);
      }

      // 1. Thử Daily Poll
      const pollRes = await handleDailyPoll();
      if (pollRes.handled) {
        chrome.runtime.sendMessage({ action: "TASK_PAGE_COMPLETED", taskType: "poll" }).catch(() => {});
        return { success: true, taskType: "poll", stepsDone: pollRes.stepsDone };
      }

      // 2. Thử Quiz trắc nghiệm
      const hasQuizWidget = document.querySelector(QUIZ_WIDGET_SELECTOR);
      if (hasQuizWidget) {
        const quizRes = await handleQuiz();
        chrome.runtime.sendMessage({ action: "TASK_PAGE_COMPLETED", taskType: "quiz" }).catch(() => {});
        return { success: true, taskType: "quiz", stepsDone: quizRes.stepsDone };
      }

      // 3. Mặc định: thẻ khám phá / click URL
      const exploreRes = await handleExploreCard();
      chrome.runtime.sendMessage({ action: "TASK_PAGE_COMPLETED", taskType: "explore" }).catch(() => {});
      return { success: true, taskType: "explore", stepsDone: exploreRes.stepsDone };
    } finally {
      isSolving = false;
    }
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING_QUIZ_SOLVER") {
      sendResponse({ status: "ok" });
      return true;
    }

    if (request.action === "SOLVE_QUEST_ON_PAGE") {
      executeTaskOnPage()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ success: false, error: err.message, stepsDone: 0 }));
      return true;
    }
  });
})();
