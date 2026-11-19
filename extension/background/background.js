/**
 * Фоновый скрипт EchoAI.
 * Работает СТРОГО по вызову пользователя (Zero Background Activity).
 */

import { loadSettings, saveSession } from "../lib/storage.js";
import { readFullThread } from "../lib/thread-reader.js";
import { readComposeState, openReplyWithText, applyTextToComposeTab } from "../lib/compose-helper.js";

async function resolveDisplayedMessage(tabId) {
  try {
    if (browser.messageDisplay?.getDisplayedMessage) {
      const msg = await browser.messageDisplay.getDisplayedMessage(tabId);
      if (msg) return msg;
    }
  } catch {
    // fallback ниже
  }

  try {
    if (browser.messageDisplay?.getDisplayedMessages) {
      const res = await browser.messageDisplay.getDisplayedMessages(tabId);
      if (Array.isArray(res) && res.length > 0) return res[0];
      if (res?.messages?.length > 0) return res.messages[0];
    }
  } catch {
    // ignore
  }

  return null;
}

async function resolveActiveTab(preferredTabId, context) {
  if (preferredTabId) {
    try {
      return await browser.tabs.get(preferredTabId);
    } catch {
      // fallback ниже
    }
  }

  const query = context === "compose"
    ? { active: true, currentWindow: true, type: "messageCompose" }
    : { active: true, currentWindow: true };

  let tabs = await browser.tabs.query(query);
  if (!tabs.length) {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  }
  return tabs[0] || null;
}

async function handleOpenAssistant(payload) {
  const settings = await loadSettings();
  const context = payload.context === "compose" ? "compose" : "display";
  const mode = payload.mode || "chat";
  const tab = await resolveActiveTab(payload.tabId, context);

  if (!tab) {
    throw new Error("Не удалось определить активную вкладку письма.");
  }

  let sessionData = {
    context,
    mode,
    tabId: tab.id
  };

  if (context === "display") {
    const displayedMsg = await resolveDisplayedMessage(tab.id);
    if (!displayedMsg) {
      throw new Error("Откройте письмо, чтобы вызвать EchoAI.");
    }
    const thread = await readFullThread(displayedMsg.id, settings.maxThreadChars || 48000);
    sessionData = {
      ...sessionData,
      sourceMessageId: displayedMsg.id,
      subject: thread.subject,
      author: thread.author,
      thread
    };
  } else {
    const composeState = await readComposeState(tab.id, settings.maxThreadChars || 48000);
    sessionData = {
      ...sessionData,
      composeTabId: tab.id,
      sourceMessageId: composeState.relatedMessageId,
      subject: composeState.subject || composeState.thread?.subject || "(новое письмо)",
      composeState,
      thread: composeState.thread
    };
  }

  const sessionId = await saveSession(sessionData);
  const url = browser.runtime.getURL(`modal/assistant.html?session=${encodeURIComponent(sessionId)}`);

  await browser.windows.create({
    url,
    type: "popup",
    width: 650,
    height: 760
  });

  return { ok: true, sessionId };
}

async function handleApplyToEmail(payload) {
  const { context, sourceMessageId, composeTabId, text, applyMode, originalSelection } = payload;
  if (!String(text || "").trim()) {
    throw new Error("Пустой текст для вставки.");
  }

  if (context === "compose" && composeTabId) {
    return applyTextToComposeTab(composeTabId, text, {
      mode: applyMode || "insert",
      originalSelection: originalSelection || ""
    });
  }

  if (sourceMessageId) {
    await openReplyWithText(sourceMessageId, text);
    return { ok: true, method: "beginReply" };
  }

  throw new Error("Нет связанного письма для вставки текста.");
}

async function openOptionsTab(hash = "") {
  const baseUrl = browser.runtime.getURL("options/options.html");
  const targetUrl = hash ? `${baseUrl}#${hash}` : baseUrl;

  try {
    const allTabs = await browser.tabs.query({});
    const existing = allTabs.find((t) => t.url && t.url.startsWith(baseUrl));
    if (existing) {
      await browser.tabs.update(existing.id, { active: true, url: targetUrl });
      if (existing.windowId) {
        await browser.windows.update(existing.windowId, { focused: true });
      }
      return { ok: true, reused: true };
    }
  } catch {
    // fallback ниже
  }

  try {
    const normalWindows = await browser.windows.getAll({ windowTypes: ["normal"] });
    const mainWin = normalWindows?.[0];
    if (mainWin) {
      await browser.tabs.create({ windowId: mainWin.id, url: targetUrl, active: true });
      await browser.windows.update(mainWin.id, { focused: true });
      return { ok: true, windowId: mainWin.id };
    }
  } catch {
    // fallback ниже
  }

  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 980,
    height: 760
  });
  return { ok: true, standalone: true };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return undefined;

  if (message.type === "OPEN_ASSISTANT") {
    return handleOpenAssistant(message.payload || {}).catch((err) => ({
      ok: false,
      error: err?.message || String(err)
    }));
  }

  if (message.type === "APPLY_TO_EMAIL") {
    return handleApplyToEmail(message.payload || {}).catch((err) => ({
      ok: false,
      error: err?.message || String(err)
    }));
  }

  if (message.type === "OPEN_OPTIONS") {
    return openOptionsTab("").catch((err) => ({
      ok: false,
      error: err?.message || String(err)
    }));
  }

  if (message.type === "OPEN_MIC_PERMISSION_TAB") {
    return openOptionsTab("mic").catch((err) => ({
      ok: false,
      error: err?.message || String(err)
    }));
  }

  return undefined;
});
