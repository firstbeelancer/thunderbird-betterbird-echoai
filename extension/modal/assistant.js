import { loadSettings, getActiveProfile, getSession, applyTheme } from "../lib/storage.js";
import { buildSystemPrompt, LANGUAGE_OPTIONS } from "../lib/prompts.js";
import { streamChatCompletion } from "../lib/api-client.js";
import { WavAudioRecorder, formatDuration } from "../lib/audio-recorder.js";
import { renderMarkdownToFragment } from "../lib/markdown.js";
import { createIcon } from "../lib/icons.js";

const MODE_META = {
  quick_reply: { title: "Быстрый ответ", icon: "reply", autoRun: true },
  chat: { title: "Чат с ассистентом", icon: "chat", autoRun: false },
  improve: { title: "Улучшить текст", icon: "improve", autoRun: true },
  summary: { title: "Краткое саммари", icon: "summary", autoRun: true },
  translate: { title: "Перевод", icon: "translate", autoRun: true }
};

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");

// DOM Elements
const modeIcon = document.getElementById("modeIcon");
const modeTitle = document.getElementById("modeTitle");
const contextPill = document.getElementById("contextPill");
const subjectLine = document.getElementById("subjectLine");
const translateLangWrap = document.getElementById("translateLangWrap");
const translateLangSelect = document.getElementById("translateLangSelect");
const modelPill = document.getElementById("modelPill");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const chatScroll = document.getElementById("chatScroll");
const contextBanner = document.getElementById("contextBanner");
const messagesList = document.getElementById("messagesList");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const errorBanner = document.getElementById("errorBanner");
const errorIcon = document.getElementById("errorIcon");
const errorText = document.getElementById("errorText");
const errorActions = document.getElementById("errorActions");

const primaryApplyBtn = document.getElementById("primaryApplyBtn");
const copyLastBtn = document.getElementById("copyLastBtn");
const regenBtn = document.getElementById("regenBtn");
const tokenPillBtn = document.getElementById("tokenPillBtn");
const tokenPillValue = document.getElementById("tokenPillValue");
const tokenChevron = document.getElementById("tokenChevron");
const tokenPopover = document.getElementById("tokenPopover");
const tokPrompt = document.getElementById("tokPrompt");
const tokCompletion = document.getElementById("tokCompletion");
const tokTotal = document.getElementById("tokTotal");
const tokEstimatedNote = document.getElementById("tokEstimatedNote");
const closeBtn = document.getElementById("closeBtn");

const textComposer = document.getElementById("textComposer");
const promptInput = document.getElementById("promptInput");
const micBtn = document.getElementById("micBtn");
const sendBtn = document.getElementById("sendBtn");

const recordBar = document.getElementById("recordBar");
const recordTimer = document.getElementById("recordTimer");
const recordMeter = document.getElementById("recordMeter");
const cancelRecordBtn = document.getElementById("cancelRecordBtn");
const sendRecordBtn = document.getElementById("sendRecordBtn");

// Static Icons (zero emojis)
openSettingsBtn.appendChild(createIcon("settings"));
errorIcon.appendChild(createIcon("alert"));
tokenChevron.appendChild(createIcon("chevronDown", "icon-sm"));
micBtn.appendChild(createIcon("mic", "icon-lg"));
sendBtn.appendChild(createIcon("arrowUp", "icon-lg"));
sendRecordBtn.appendChild(createIcon("arrowUp", "icon-lg"));

function setButtonIconAndLabel(btn, iconName, label) {
  btn.replaceChildren(createIcon(iconName, "icon-sm"), document.createTextNode(label));
}

setButtonIconAndLabel(copyLastBtn, "copy", "Copy");
setButtonIconAndLabel(regenBtn, "refresh", "Заново");

// App State
let settings = null;
let profile = null;
let session = null;
let currentMode = "chat";
let targetLanguage = "Русский";
let isGenerating = false;
let activeAbortController = null;
let recorder = null;
let activeAudioEl = null;

/**
 * apiMessages: массив сообщений OpenAI (без системного — системный собирается динамически)
 * uiMessages: элементы для рендера в чате
 */
const apiMessages = [];
const uiMessages = [];

const tokenTotals = {
  prompt: 0,
  completion: 0,
  total: 0,
  estimated: false
};

function formatNumber(n) {
  return Math.max(0, Math.round(n || 0)).toLocaleString("ru-RU");
}

function updateTokenDisplay() {
  tokenPillValue.textContent = `${formatNumber(tokenTotals.total)} tokens`;
  tokPrompt.textContent = formatNumber(tokenTotals.prompt);
  tokCompletion.textContent = formatNumber(tokenTotals.completion);
  tokTotal.textContent = formatNumber(tokenTotals.total);
  tokEstimatedNote.hidden = !tokenTotals.estimated;
  tokenPillBtn.disabled = tokenTotals.total === 0;
}

function showStatus(stage) {
  if (!stage) {
    statusIndicator.hidden = true;
    return;
  }
  const labels = {
    connecting: "Отправляю запрос…",
    thinking: "Думает…",
    streaming: "Печатает ответ…"
  };
  statusText.textContent = labels[stage] || "Работает…";
  statusIndicator.hidden = false;
  scrollToBottom();
}

function showError(message, actions = []) {
  errorText.textContent = message;
  errorActions.replaceChildren();
  for (const act of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-pill";
    btn.textContent = act.label;
    btn.addEventListener("click", act.onClick);
    errorActions.appendChild(btn);
  }
  errorBanner.hidden = false;
  scrollToBottom();
}

function clearError() {
  errorBanner.hidden = true;
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function copyTextWithFeedback(text, btn, defaultLabel = "Copy") {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add("is-copied");
    setButtonIconAndLabel(btn, "check", "Скопировано");
    setTimeout(() => {
      btn.classList.remove("is-copied");
      setButtonIconAndLabel(btn, "copy", defaultLabel);
    }, 1500);
  } catch (err) {
    showError(`Не удалось скопировать в буфер обмена: ${err.message}`);
  }
}

function getApplyActionConfig() {
  if (!session) return null;
  if (session.context === "display") {
    return {
      label: "Вставить в ответ",
      applyMode: "insert",
      originalSelection: ""
    };
  }
  const sel = session.composeState?.selectedText || "";
  if (currentMode === "improve" || currentMode === "translate") {
    if (sel) {
      return {
        label: "Заменить выделенное",
        applyMode: "replace_selection",
        originalSelection: sel
      };
    }
    return {
      label: "Заменить в письме",
      applyMode: "replace_draft",
      originalSelection: ""
    };
  }
  return {
    label: "Вставить в письмо",
    applyMode: "insert",
    originalSelection: ""
  };
}

async function applyAssistantText(text, triggerBtn) {
  const cfg = getApplyActionConfig();
  if (!cfg || !text) return;

  const prevChildren = Array.from(triggerBtn.childNodes);
  triggerBtn.disabled = true;
  setButtonIconAndLabel(triggerBtn, "loader", "Вставляю…");
  const svg = triggerBtn.querySelector("svg");
  if (svg) svg.classList.add("spin");

  try {
    const res = await browser.runtime.sendMessage({
      type: "APPLY_TO_EMAIL",
      payload: {
        context: session.context,
        sourceMessageId: session.sourceMessageId,
        composeTabId: session.composeTabId,
        text,
        applyMode: cfg.applyMode,
        originalSelection: cfg.originalSelection
      }
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Не удалось вставить текст в письмо.");
    }
    setButtonIconAndLabel(triggerBtn, "check", "Вставлено");
    setTimeout(() => {
      triggerBtn.disabled = false;
      triggerBtn.replaceChildren(...prevChildren);
    }, 1600);
  } catch (err) {
    triggerBtn.disabled = false;
    triggerBtn.replaceChildren(...prevChildren);
    showError(err?.message || String(err));
  }
}

function getLatestAssistantText() {
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    if (uiMessages[i].role === "assistant" && uiMessages[i].text.trim()) {
      return uiMessages[i].text.trim();
    }
  }
  return "";
}

function updateBottomToolbar() {
  const latest = getLatestAssistantText();
  copyLastBtn.disabled = !latest || isGenerating;

  const showApplyInDock = currentMode !== "summary";
  const cfg = getApplyActionConfig();

  if (showApplyInDock && cfg && latest && !isGenerating) {
    setButtonIconAndLabel(primaryApplyBtn, "insert", cfg.label);
    primaryApplyBtn.hidden = false;
    primaryApplyBtn.disabled = false;
  } else {
    primaryApplyBtn.hidden = true;
  }

  regenBtn.hidden = !(MODE_META[currentMode]?.autoRun && latest && !isGenerating && uiMessages.length <= 2);
}

function createVoiceChipElement(audioData) {
  const chip = document.createElement("div");
  chip.className = "voice-chip";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "voice-play-btn";
  playBtn.setAttribute("aria-label", "Прослушать голосовую заметку");
  playBtn.appendChild(createIcon("play", "icon-sm"));

  const audio = new Audio(audioData.objectUrl);

  const resetIcon = () => {
    playBtn.replaceChildren(createIcon("play", "icon-sm"));
  };

  audio.addEventListener("ended", resetIcon);
  audio.addEventListener("pause", resetIcon);

  playBtn.addEventListener("click", () => {
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (activeAudioEl && activeAudioEl !== audio) {
      activeAudioEl.pause();
    }
    activeAudioEl = audio;
    audio.play().catch(() => {});
    playBtn.replaceChildren(createIcon("pause", "icon-sm"));
  });

  const info = document.createElement("div");
  info.className = "voice-chip-info";

  const wave = document.createElement("span");
  wave.className = "voice-chip-wave";
  wave.appendChild(createIcon("waveform", "icon-sm"));

  const label = document.createElement("span");
  label.textContent = "Голосовая заметка";

  const dur = document.createElement("span");
  dur.className = "voice-chip-dur tabular";
  dur.textContent = formatDuration(audioData.durationSec);

  info.append(wave, label, dur);
  chip.append(playBtn, info);
  return chip;
}

function renderMessageElement(msgObj) {
  const wrapper = document.createElement("div");
  wrapper.className = `msg-item role-${msgObj.role}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  const content = document.createElement("div");
  content.className = "msg-content";

  if (msgObj.audio) {
    content.appendChild(createVoiceChipElement(msgObj.audio));
    if (msgObj.text) {
      const note = document.createElement("p");
      note.style.marginTop = "8px";
      note.textContent = msgObj.text;
      content.appendChild(note);
    }
  } else if (msgObj.role === "assistant") {
    content.appendChild(renderMarkdownToFragment(msgObj.text));
  } else {
    const p = document.createElement("p");
    p.textContent = msgObj.text;
    content.appendChild(p);
  }

  bubble.appendChild(content);
  wrapper.appendChild(bubble);

  // Per-message action buttons: Copy for EVERY message (user & assistant) + Insert for assistant
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  if (msgObj.text || msgObj.role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-action-btn";
    setButtonIconAndLabel(copyBtn, "copy", "Copy");
    copyBtn.addEventListener("click", () => {
      if (msgObj.text) copyTextWithFeedback(msgObj.text, copyBtn, "Copy");
    });
    actions.appendChild(copyBtn);
    msgObj._copyBtn = copyBtn;
  }

  if (msgObj.role === "assistant" && currentMode !== "summary") {
    const cfg = getApplyActionConfig();
    if (cfg) {
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "msg-action-btn is-primary";
      setButtonIconAndLabel(applyBtn, "insert", cfg.label);
      applyBtn.addEventListener("click", () => {
        if (msgObj.text) applyAssistantText(msgObj.text, applyBtn);
      });
      actions.appendChild(applyBtn);
      msgObj._applyBtn = applyBtn;
    }
  }

  if (actions.childNodes.length > 0) {
    wrapper.appendChild(actions);
  }

  msgObj._el = wrapper;
  msgObj._contentEl = content;
  msgObj._actionsEl = actions;

  messagesList.appendChild(wrapper);
  scrollToBottom();
  return msgObj;
}

/**
 * Формирует базовый контекстный блок письма/переписки для первой отправки в LLM.
 */
function buildEmailContextString() {
  if (!session) return "";

  if (session.context === "display" && session.thread) {
    return [
      `Переписка (${session.thread.messageCount} ${session.thread.messageCount === 1 ? "письмо" : "писем в ветке"}):`,
      session.thread.contextText
    ].join("\n\n");
  }

  const cs = session.composeState || {};
  const parts = [];

  if (cs.subject) {
    parts.push(`Тема письма: ${cs.subject}`);
  }
  if (cs.to?.length) {
    parts.push(`Получатели: ${cs.to.join(", ")}`);
  }
  if (cs.selectedText) {
    parts.push(`Выделенный пользователем фрагмент текста:\n"""\n${cs.selectedText}\n"""`);
  }
  if (cs.draftText) {
    parts.push(`Текущий черновик пользователя:\n"""\n${cs.draftText}\n"""`);
  }
  if (session.thread?.contextText) {
    parts.push(`Исходная переписка (полная ветка для контекста):\n${session.thread.contextText}`);
  } else if (cs.quoteText) {
    parts.push(`Цитируемое предыдущее письмо (для контекста):\n${cs.quoteText}`);
  }

  return parts.join("\n\n");
}

function buildAutoPromptForMode(mode) {
  const emailContext = buildEmailContextString();
  const cs = session.composeState || {};

  if (mode === "quick_reply") {
    return `${emailContext}\n\nЗадача: подготовь готовый, точный ответ на это письмо с учётом всей переписки.`;
  }

  if (mode === "improve") {
    const targetText = cs.selectedText || cs.draftText;
    if (!targetText) {
      return null; // Черновик пустой — переводим в ручной ввод
    }
    const bgContext = session.thread?.contextText || cs.quoteText;
    const blocks = [];
    if (bgContext) {
      blocks.push(`Справочный контекст переписки (НЕ переписывай его, используй только чтобы понимать ситуацию):\n${bgContext}`);
    }
    blocks.push(`Текст пользователя, который нужно улучшить:\n"""\n${targetText}\n"""`);
    blocks.push("Задача: перепиши этот текст по правилам системного промпта. Верни только улучшенный текст.");
    return blocks.join("\n\n");
  }

  if (mode === "summary") {
    return `${emailContext}\n\nЗадача: сделай краткое и структурированное саммари.`;
  }

  if (mode === "translate") {
    if (session.context === "compose") {
      const targetText = cs.selectedText || cs.draftText || session.thread?.contextText || cs.quoteText;
      if (!targetText) return null;
      return `Переведи следующий текст на язык «${targetLanguage}»:\n\n"""\n${targetText}\n"""`;
    }
    return `Переведи следующее письмо/переписку на язык «${targetLanguage}»:\n\n${emailContext}`;
  }

  return emailContext;
}

function setGeneratingState(active) {
  isGenerating = active;
  micBtn.disabled = active;
  translateLangSelect.disabled = active;

  if (active) {
    sendBtn.classList.add("is-stop");
    sendBtn.title = "Остановить генерацию";
    sendBtn.setAttribute("aria-label", "Остановить генерацию");
    sendBtn.replaceChildren(createIcon("stop", "icon-sm"));
  } else {
    sendBtn.classList.remove("is-stop");
    sendBtn.title = "Отправить (Enter)";
    sendBtn.setAttribute("aria-label", "Отправить");
    sendBtn.replaceChildren(createIcon("arrowUp", "icon-lg"));
  }
  updateBottomToolbar();
}

async function runModelTurn() {
  if (!profile?.baseUrl || !profile?.model) {
    showError("Не настроено подключение к ИИ. Укажите URL, API-ключ и модель в настройках.", [
      {
        label: "Открыть настройки",
        onClick: () => browser.runtime.sendMessage({ type: "OPEN_OPTIONS" })
      }
    ]);
    return;
  }

  clearError();
  setGeneratingState(true);
  showStatus("connecting");

  const systemPrompt = buildSystemPrompt(settings, currentMode, { targetLanguage });
  const requestMessages = [
    { role: "system", content: systemPrompt },
    ...apiMessages
  ];

  const assistantUiMsg = {
    role: "assistant",
    text: ""
  };
  let rendered = false;

  activeAbortController = new AbortController();

  try {
    const result = await streamChatCompletion({
      profile,
      messages: requestMessages,
      signal: activeAbortController.signal,
      onStatus: (stage) => {
        showStatus(stage);
      },
      onDelta: (_chunk, fullText) => {
        assistantUiMsg.text = fullText;
        if (!rendered) {
          rendered = true;
          uiMessages.push(assistantUiMsg);
          renderMessageElement(assistantUiMsg);
          assistantUiMsg._actionsEl.hidden = true;
        }
        assistantUiMsg._contentEl.replaceChildren(renderMarkdownToFragment(fullText));
        scrollToBottom();
      },
      onUsage: () => {}
    });

    const finalText = result.text || assistantUiMsg.text;
    if (finalText) {
      assistantUiMsg.text = finalText;
      if (!rendered) {
        rendered = true;
        uiMessages.push(assistantUiMsg);
        renderMessageElement(assistantUiMsg);
      } else {
        assistantUiMsg._contentEl.replaceChildren(renderMarkdownToFragment(finalText));
      }
      assistantUiMsg._actionsEl.hidden = false;
      apiMessages.push({ role: "assistant", content: finalText });
    } else {
      showError("Модель вернула пустой ответ. Попробуйте переформулировать запрос или проверить выбранную модель.");
    }

    if (result.usage) {
      tokenTotals.prompt += result.usage.promptTokens || 0;
      tokenTotals.completion += result.usage.completionTokens || 0;
      tokenTotals.total += result.usage.totalTokens || 0;
      if (result.usage.estimated) tokenTotals.estimated = true;
      updateTokenDisplay();
    }
  } catch (err) {
    if (err.name === "AbortError") {
      if (rendered && assistantUiMsg.text) {
        assistantUiMsg._actionsEl.hidden = false;
        apiMessages.push({ role: "assistant", content: assistantUiMsg.text });
      }
    } else {
      showError(err?.message || String(err), [
        {
          label: "Проверить настройки",
          onClick: () => browser.runtime.sendMessage({ type: "OPEN_OPTIONS" })
        }
      ]);
    }
  } finally {
    activeAbortController = null;
    showStatus(null);
    setGeneratingState(false);
  }
}

function ensureChatContextSeeded() {
  if (apiMessages.length > 0) return;
  const emailContext = buildEmailContextString();
  if (emailContext) {
    apiMessages.push({
      role: "user",
      content: `Вот контекст письма/переписки, с которым мы работаем:\n\n${emailContext}\n\nЖди моих дальнейших текстовых или голосовых инструкций.`
    });
    apiMessages.push({
      role: "assistant",
      content: "Понял, я вижу контекст переписки. Готов к твоим инструкциям."
    });
  }
}

async function sendUserText() {
  if (isGenerating) return;
  const text = promptInput.value.trim();
  if (!text) return;

  promptInput.value = "";
  autoResizeTextarea();

  // Если пользователь написал доп. инструкцию из авто-режима — плавно продолжаем как диалог
  ensureChatContextSeeded();

  const userUi = { role: "user", text };
  uiMessages.push(userUi);
  renderMessageElement(userUi);

  apiMessages.push({ role: "user", content: text });
  await runModelTurn();
}

async function sendVoiceRecording(audioData) {
  if (!audioData || isGenerating) return;

  ensureChatContextSeeded();

  const userUi = {
    role: "user",
    text: "",
    audio: audioData
  };
  uiMessages.push(userUi);
  renderMessageElement(userUi);

  // Отправляем WAV напрямую в мультимодальную LLM (без отдельного STT)
  apiMessages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Прослушай эту голосовую заметку пользователя и выполни его просьбу в контексте переписки."
      },
      {
        type: "input_audio",
        input_audio: {
          data: audioData.base64,
          format: "wav"
        }
      }
    ]
  });

  await runModelTurn();
}

/* ---------- Voice Recording Controls ---------- */

function updateMeterBars(level) {
  const bars = Array.from(recordMeter.querySelectorAll("span"));
  const weights = [0.45, 0.75, 0.95, 1, 0.9, 0.7, 0.5];
  bars.forEach((bar, idx) => {
    const jitter = 0.8 + Math.random() * 0.4;
    const h = Math.max(4, Math.min(20, Math.round(4 + level * 18 * weights[idx] * jitter)));
    bar.style.height = `${h}px`;
  });
}

async function startRecording() {
  if (isGenerating) return;
  clearError();

  recorder = new WavAudioRecorder({
    onLevel: (lvl) => updateMeterBars(lvl),
    onTick: (sec) => {
      recordTimer.textContent = formatDuration(sec);
    }
  });

  try {
    recordTimer.textContent = "0:00";
    await recorder.start();
    textComposer.hidden = true;
    recordBar.hidden = false;
  } catch (err) {
    recorder = null;
    const msg = err?.name === "NotAllowedError" || /permission|denied/i.test(err?.message || "")
      ? "Нет доступа к микрофону. В Betterbird разрешение на микрофон нужно один раз выдать во вкладке настроек."
      : `Не удалось включить микрофон: ${err?.message || err}`;

    showError(msg, [
      {
        label: "Выдать доступ к микрофону",
        onClick: () => browser.runtime.sendMessage({ type: "OPEN_MIC_PERMISSION_TAB" })
      }
    ]);
  }
}

function cancelRecording() {
  if (recorder) {
    recorder.cancel();
    recorder = null;
  }
  recordBar.hidden = true;
  textComposer.hidden = false;
}

async function finishAndSendRecording() {
  if (!recorder) return;
  const activeRec = recorder;
  recorder = null;
  recordBar.hidden = true;
  textComposer.hidden = false;

  const audioData = await activeRec.stop();
  if (!audioData) {
    showError("Запись получилась пустой. Попробуйте ещё раз.");
    return;
  }
  await sendVoiceRecording(audioData);
}

/* ---------- Auto-resize Textarea ---------- */

function autoResizeTextarea() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(132, promptInput.scrollHeight)}px`;
}

/* ---------- Event Listeners ---------- */

promptInput.addEventListener("input", autoResizeTextarea);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserText();
  }
});

sendBtn.addEventListener("click", () => {
  if (isGenerating && activeAbortController) {
    activeAbortController.abort();
    return;
  }
  sendUserText();
});

micBtn.addEventListener("click", startRecording);
cancelRecordBtn.addEventListener("click", cancelRecording);
sendRecordBtn.addEventListener("click", finishAndSendRecording);

copyLastBtn.addEventListener("click", () => {
  const latest = getLatestAssistantText();
  if (latest) copyTextWithFeedback(latest, copyLastBtn, "Copy");
});

primaryApplyBtn.addEventListener("click", () => {
  const latest = getLatestAssistantText();
  if (latest) applyAssistantText(latest, primaryApplyBtn);
});

regenBtn.addEventListener("click", async () => {
  if (isGenerating) return;
  apiMessages.length = 0;
  uiMessages.length = 0;
  messagesList.replaceChildren();
  const prompt = buildAutoPromptForMode(currentMode);
  if (prompt) {
    apiMessages.push({ role: "user", content: prompt });
    await runModelTurn();
  }
});

tokenPillBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = tokenPopover.hidden;
  tokenPopover.hidden = !willOpen;
  tokenPillBtn.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (e) => {
  if (!tokenPopover.hidden && !tokenPopover.contains(e.target) && !tokenPillBtn.contains(e.target)) {
    tokenPopover.hidden = true;
    tokenPillBtn.setAttribute("aria-expanded", "false");
  }
});

openSettingsBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
});

closeBtn.addEventListener("click", () => {
  if (recorder) recorder.cancel();
  if (activeAbortController) activeAbortController.abort();
  window.close();
});

translateLangSelect.addEventListener("change", async () => {
  targetLanguage = translateLangSelect.value;
  if (currentMode === "translate" && !isGenerating) {
    apiMessages.length = 0;
    uiMessages.length = 0;
    messagesList.replaceChildren();
    const prompt = buildAutoPromptForMode("translate");
    if (prompt) {
      apiMessages.push({ role: "user", content: prompt });
      await runModelTurn();
    }
  }
});

/* ---------- Initialization ---------- */

function renderContextHeader() {
  const meta = MODE_META[currentMode] || MODE_META.chat;
  document.title = `${meta.title} — EchoAI`;
  modeTitle.textContent = meta.title;
  modeIcon.replaceChildren(createIcon(meta.icon, "icon-lg"));
  subjectLine.textContent = session.subject || "(без темы)";

  if (session.context === "display" && session.thread) {
    const count = session.thread.messageCount;
    contextPill.textContent = count > 1 ? `Ветка: ${count} писем` : "1 письмо";
  } else if (session.context === "compose") {
    const cs = session.composeState || {};
    if (cs.selectedText) {
      contextPill.textContent = "Выделенный фрагмент";
    } else if (session.thread?.messageCount > 1) {
      contextPill.textContent = `Ответ · ветка ${session.thread.messageCount}`;
    } else if (cs.draftText) {
      contextPill.textContent = "Черновик";
    } else {
      contextPill.textContent = "Новое письмо";
    }
  }

  // В чате и при улучшении показываем спокойный баннер о загруженном контексте
  if (currentMode === "chat") {
    const cs = session.composeState || {};
    const bannerParts = [];
    if (session.thread) {
      bannerParts.push(
        session.thread.messageCount > 1
          ? `Загружена вся переписка (${session.thread.messageCount} реплик).`
          : "Загружен текст письма."
      );
    } else if (cs.draftText) {
      bannerParts.push("Загружен текущий черновик письма.");
    } else {
      bannerParts.push("Новое письмо — напишите или надиктуйте голосом, что нужно составить.");
    }

    contextBanner.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = "Контекст готов. ";
    contextBanner.append(strong, document.createTextNode(bannerParts.join(" ")));
    contextBanner.hidden = false;
  } else if (currentMode === "improve" && session.composeState) {
    const targetText = session.composeState.selectedText || session.composeState.draftText;
    if (targetText) {
      contextBanner.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = session.composeState.selectedText
        ? "Улучшаю выделенный фрагмент:"
        : "Улучшаю ваш черновик (HTML-подпись и цитата сохранятся):";
      const snippet = document.createElement("div");
      snippet.className = "context-snippet";
      snippet.textContent = targetText.slice(0, 260) + (targetText.length > 260 ? "…" : "");
      contextBanner.append(strong, snippet);
      contextBanner.hidden = false;
    }
  }
}

async function init() {
  settings = await loadSettings();
  applyTheme(settings.theme);
  profile = getActiveProfile(settings);

  modelPill.textContent = profile?.model || "Модель не выбрана";

  if (!sessionId) {
    showError("Сессия не найдена. Вызовите EchoAI через кнопку в письме.");
    return;
  }

  session = await getSession(sessionId);
  if (!session) {
    showError("Сессия устарела. Закройте окно и вызовите EchoAI снова из письма.");
    return;
  }

  currentMode = session.mode || "chat";

  // Настройка селектора языка для режима Перевода
  targetLanguage = session.context === "compose"
    ? (settings.defaultTranslateComposeLang || "English")
    : (settings.defaultTranslateReadLang || "Русский");

  for (const lang of LANGUAGE_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.label;
    if (lang.code === targetLanguage) opt.selected = true;
    translateLangSelect.appendChild(opt);
  }
  translateLangWrap.hidden = currentMode !== "translate";

  renderContextHeader();
  updateTokenDisplay();
  updateBottomToolbar();

  if (MODE_META[currentMode]?.autoRun) {
    const initialPrompt = buildAutoPromptForMode(currentMode);
    if (!initialPrompt) {
      contextBanner.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = "Текст пока пуст. ";
      contextBanner.append(
        strong,
        document.createTextNode("Напишите или надиктуйте голосом внизу, что нужно составить или улучшить.")
      );
      contextBanner.hidden = false;
      promptInput.focus();
      return;
    }
    apiMessages.push({ role: "user", content: initialPrompt });
    await runModelTurn();
  } else {
    promptInput.focus();
  }
}

init();
