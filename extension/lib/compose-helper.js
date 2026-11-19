/**
 * Работа с окном написания письма (Compose):
 * - чтение выделенного текста и черновика
 * - вставка и замена текста СТРОГО с сохранением HTML-подписи Betterbird (moz-signature)
 *   и цитаты переписки (moz-cite-prefix / blockquote)
 */

import { readFullThread } from "./thread-reader.js";

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainTextToHtmlParagraphs(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const paragraphs = normalized.split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Безопасное выполнение функции в контексте compose-вкладки (Thunderbird 128/140 MV3).
 */
async function runInComposeTab(tabId, func, args = []) {
  try {
    if (browser.scripting?.executeScript) {
      const res = await browser.scripting.executeScript({
        target: { tabId },
        func,
        args
      });
      return res?.[0]?.result ?? null;
    }
  } catch {
    // fallback ниже
  }
  try {
    if (browser.scripting?.compose?.executeScript) {
      const res = await browser.scripting.compose.executeScript(tabId, {
        func,
        args
      });
      return res?.[0]?.result ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Извлекает только пользовательский черновик из HTML тела письма,
 * не захватывая HTML-подпись Betterbird (.moz-signature) и цитату переписки.
 */
function extractDraftOnlyFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || "", "text/html");
  const body = doc.body;
  if (!body) return { draftText: "", quoteText: "" };

  const cloneDraft = body.cloneNode(true);
  for (const el of cloneDraft.querySelectorAll(".moz-signature, .moz-cite-prefix, blockquote, .moz-forward-container")) {
    el.remove();
  }

  for (const br of cloneDraft.querySelectorAll("br")) {
    br.replaceWith("\n");
  }
  for (const block of cloneDraft.querySelectorAll("p, div, li")) {
    block.prepend(doc.createTextNode("\n"));
  }

  const draftText = (cloneDraft.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Собираем текст цитируемого письма, если он есть в теле
  const quoteNodes = body.querySelectorAll(".moz-cite-prefix, blockquote, .moz-forward-container");
  const quoteParts = [];
  for (const node of quoteNodes) {
    const text = (node.textContent || "").replace(/\u00a0/g, " ").trim();
    if (text) quoteParts.push(text);
  }

  return {
    draftText,
    quoteText: quoteParts.join("\n\n").trim()
  };
}

function extractDraftOnlyFromPlainText(plain) {
  const text = String(plain || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const draftLines = [];
  const quoteLines = [];
  let inTail = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      !inTail &&
      (line === "-- " ||
        line === "--" ||
        /^On .+ wrote:$/i.test(line.trim()) ||
        /^\d{2}\.\d{2}\.\d{4}.+пишет:$/i.test(line.trim()) ||
        /^>/.test(line.trim()))
    ) {
      inTail = true;
    }
    if (inTail) {
      quoteLines.push(line);
    } else {
      draftLines.push(line);
    }
  }

  return {
    draftText: draftLines.join("\n").trim(),
    quoteText: quoteLines.join("\n").trim()
  };
}

/**
 * Считывает состояние открытого окна написания письма (выделение, черновик, связанная ветка).
 */
export async function readComposeState(tabId, maxThreadChars = 48000) {
  const details = await browser.compose.getComposeDetails(tabId);
  const selectedText = await runInComposeTab(tabId, () => {
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : "";
  });

  const extracted = details.isPlainText
    ? extractDraftOnlyFromPlainText(details.plainTextBody || "")
    : extractDraftOnlyFromHtml(details.body || "");

  let thread = null;
  if (details.relatedMessageId) {
    try {
      thread = await readFullThread(details.relatedMessageId, maxThreadChars);
    } catch {
      thread = null;
    }
  }

  const hasReplyContext = Boolean(thread || extracted.quoteText);

  return {
    tabId,
    subject: details.subject || "",
    to: Array.isArray(details.to) ? details.to : [],
    isPlainText: Boolean(details.isPlainText),
    selectedText: selectedText || "",
    draftText: extracted.draftText || "",
    quoteText: extracted.quoteText || "",
    relatedMessageId: details.relatedMessageId || null,
    thread,
    hasReplyContext
  };
}

/**
 * Аккуратно обновляет HTML тела письма, НЕ затирая HTML-подпись (.moz-signature) и цитату переписки.
 */
function buildUpdatedHtml(existingHtml, newText, replaceExistingDraft) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(existingHtml || "<html><body></body></html>", "text/html");
  const body = doc.body;

  // Ищем первый «защищённый» узел (подпись или цитата переписки)
  const preservedSelectors = ".moz-signature, .moz-cite-prefix, blockquote, .moz-forward-container";
  const firstProtected = body.querySelector(preservedSelectors);

  if (replaceExistingDraft) {
    // Удаляем только пользовательский черновик строго ДО первого защищённого блока
    let node = body.firstChild;
    while (node && node !== firstProtected) {
      const next = node.nextSibling;
      // Если защищённый элемент вложен внутрь этого узла — не удаляем контейнер целиком
      if (node.nodeType === Node.ELEMENT_NODE && firstProtected && node.contains(firstProtected)) {
        break;
      }
      body.removeChild(node);
      node = next;
    }
  }

  // Вставляем новый текст строго в начало (выше подписи и цитаты)
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = plainTextToHtmlParagraphs(newText);

  const insertBeforeNode = body.firstChild;
  while (wrapper.firstChild) {
    body.insertBefore(wrapper.firstChild, insertBeforeNode);
  }

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

function buildUpdatedPlainText(existingPlain, newText, replaceExistingDraft) {
  const cleanNew = String(newText || "").replace(/\r\n/g, "\n").trim();
  const lines = String(existingPlain || "").replace(/\r\n/g, "\n").split("\n");

  let splitIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      lines[i] === "-- " ||
      lines[i] === "--" ||
      /^On .+ wrote:$/i.test(trimmed) ||
      /^\d{2}\.\d{2}\.\d{4}.+пишет:$/i.test(trimmed) ||
      trimmed.startsWith(">")
    ) {
      splitIdx = i;
      break;
    }
  }

  const protectedTail = lines.slice(splitIdx).join("\n").trimStart();
  const existingDraft = lines.slice(0, splitIdx).join("\n").trim();

  if (replaceExistingDraft) {
    return protectedTail ? `${cleanNew}\n\n${protectedTail}` : cleanNew;
  }

  const parts = [cleanNew, existingDraft, protectedTail].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Открывает новое окно-черновик ответа на письмо и вставляет готовый текст
 * строго выше HTML-подписи Betterbird и цитируемого письма.
 */
export async function openReplyWithText(sourceMessageId, text) {
  const composeTab = await browser.compose.beginReply(sourceMessageId, "replyToSender");

  // Даём Betterbird момент на инициализацию HTML-подписи и цитаты
  await new Promise((r) => setTimeout(r, 150));

  const details = await browser.compose.getComposeDetails(composeTab.id);
  if (details.isPlainText) {
    const updated = buildUpdatedPlainText(details.plainTextBody || "", text, false);
    await browser.compose.setComposeDetails(composeTab.id, { plainTextBody: updated });
  } else {
    const updated = buildUpdatedHtml(details.body || "", text, false);
    await browser.compose.setComposeDetails(composeTab.id, { body: updated });
  }

  try {
    await browser.windows.update(composeTab.windowId, { focused: true });
  } catch {
    // ignore
  }

  return composeTab;
}

/**
 * Вставляет или заменяет текст в уже открытом окне Compose,
 * всегда сохраняя HTML-подпись Betterbird и цитату переписки.
 */
export async function applyTextToComposeTab(tabId, text, { mode = "insert", originalSelection = "" } = {}) {
  if (mode === "replace_selection" && originalSelection) {
    const replacedInDom = await runInComposeTab(
      tabId,
      (replacementText, targetSelection) => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && sel.toString().trim() === targetSelection.trim()) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const lines = replacementText.replace(/\r\n/g, "\n").split("\n");
          const frag = document.createDocumentFragment();
          lines.forEach((line, idx) => {
            if (idx > 0) frag.appendChild(document.createElement("br"));
            frag.appendChild(document.createTextNode(line));
          });
          range.insertNode(frag);
          range.collapse(false);
          return true;
        }
        return false;
      },
      [text, originalSelection]
    );

    if (replacedInDom) {
      return { ok: true, method: "selection" };
    }
  }

  const details = await browser.compose.getComposeDetails(tabId);
  const replaceDraft = mode === "replace_draft";

  if (details.isPlainText) {
    let updated;
    if (mode === "replace_selection" && originalSelection && (details.plainTextBody || "").includes(originalSelection)) {
      updated = details.plainTextBody.replace(originalSelection, text.trim());
    } else {
      updated = buildUpdatedPlainText(details.plainTextBody || "", text, replaceDraft);
    }
    await browser.compose.setComposeDetails(tabId, { plainTextBody: updated });
  } else {
    const updated = buildUpdatedHtml(details.body || "", text, replaceDraft);
    await browser.compose.setComposeDetails(tabId, { body: updated });
  }

  try {
    const tab = await browser.tabs.get(tabId);
    if (tab?.windowId) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // ignore
  }

  return { ok: true, method: "composeDetails" };
}
