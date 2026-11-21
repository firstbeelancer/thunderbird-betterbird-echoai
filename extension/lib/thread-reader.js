/**
 * Сбор полного контекста переписки (всех реплик ветки в хронологическом порядке).
 * Запускается строго по вызову пользователя.
 */

function normalizeSubject(subject) {
  return String(subject || "")
    .replace(/^(\s*(re|fwd|fw|aw|ответ|пересл)\s*(\[\d+\])?:\s*)+/gi, "")
    .trim();
}

function extractMessageIds(headerValue) {
  if (!headerValue) return [];
  const raw = Array.isArray(headerValue) ? headerValue.join(" ") : String(headerValue);
  const matches = raw.match(/<[^>]+>/g) || [];
  return matches.map((id) => id.slice(1, -1).trim()).filter(Boolean);
}

function htmlToCleanText(html, stripQuotes = false) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || "", "text/html");

  for (const el of doc.querySelectorAll("script, style, head, title, noscript")) {
    el.remove();
  }

  if (stripQuotes) {
    for (const q of doc.querySelectorAll("blockquote, .moz-cite-prefix, .gmail_quote, .yahoo_quoted")) {
      q.remove();
    }
  }

  // Добавляем переносы вокруг блочных элементов для читаемости
  for (const br of doc.querySelectorAll("br")) {
    br.replaceWith("\n");
  }
  for (const block of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6")) {
    block.prepend(doc.createTextNode("\n"));
  }

  const raw = doc.body?.textContent || "";
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPlainTextQuotes(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Классический маркер начала цитированного письма в ответе
    if (
      /^On .+ wrote:$/i.test(trimmed) ||
      /^\d{2}\.\d{2}\.\d{4}.+пишет:$/i.test(trimmed) ||
      /^-{3,}\s*(Original Message|Пересылаемое сообщение|Исходное сообщение)/i.test(trimmed)
    ) {
      break;
    }

    if (trimmed.startsWith(">")) {
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractBodyFromPart(part, stripQuotes = false) {
  let plain = "";
  let html = "";

  const walk = (node) => {
    if (!node) return;
    const contentType = String(node.contentType || "").toLowerCase();
    if (contentType.startsWith("text/plain") && node.body && !plain) {
      plain = node.body;
    } else if (contentType.startsWith("text/html") && node.body && !html) {
      html = node.body;
    }
    if (Array.isArray(node.parts)) {
      for (const child of node.parts) {
        walk(child);
      }
    }
  };

  walk(part);

  if (plain) {
    const cleaned = stripQuotes ? stripPlainTextQuotes(plain) : plain.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (cleaned) return cleaned;
  }
  if (html) {
    const cleaned = htmlToCleanText(html, stripQuotes);
    if (cleaned) return cleaned;
  }
  // Если после вырезания цитат ничего не осталось, возвращаем полный текст
  if (stripQuotes) {
    return extractBodyFromPart(part, false);
  }
  return "";
}

function formatDate(dateVal) {
  try {
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

async function collectQueryMessages(queryInfo, limit = 60) {
  const results = [];
  try {
    let page = await browser.messages.query(queryInfo);
    while (page) {
      if (Array.isArray(page.messages)) {
        for (const m of page.messages) {
          results.push(m);
          if (results.length >= limit) return results;
        }
      }
      if (page.id) {
        page = await browser.messages.continueList(page.id);
      } else {
        break;
      }
    }
  } catch {
    // Некоторые фильтры могут быть недоступны в конкретной папке — игнорируем безопасно
  }
  return results;
}

/**
 * Собирает полную переписку вокруг messageId в хронологическом порядке.
 */
export async function readFullThread(messageId, maxChars = 48000) {
  const rootHeader = await browser.messages.get(messageId);
  const rootFull = await browser.messages.getFull(messageId);

  const byId = new Map();
  byId.set(rootHeader.id, { header: rootHeader, full: rootFull });

  const headers = rootFull?.headers || {};
  const refIds = new Set([
    ...extractMessageIds(headers["references"]),
    ...extractMessageIds(headers["in-reply-to"]),
    ...extractMessageIds(headers["message-id"])
  ]);

  if (rootHeader.headerMessageId) {
    refIds.add(rootHeader.headerMessageId.replace(/^<|>$/g, ""));
  }

  // 1. Точный поиск по Message-ID всех упомянутых писем ветки
  for (const hmid of refIds) {
    if (byId.size >= 35) break;
    const found = await collectQueryMessages({ headerMessageId: hmid }, 5);
    for (const m of found) {
      if (!byId.has(m.id)) {
        byId.set(m.id, { header: m, full: null });
      }
    }
  }

  // 2. Поиск ответов, которые ссылаются на эту ветку (по нормализованной теме)
  const normSubj = normalizeSubject(rootHeader.subject);
  if (normSubj && normSubj.length >= 3) {
    const candidates = await collectQueryMessages({ subject: normSubj }, 40);
    for (const cand of candidates) {
      if (byId.has(cand.id) || byId.size >= 35) continue;
      if (normalizeSubject(cand.subject).toLowerCase() !== normSubj.toLowerCase()) continue;

      try {
        const full = await browser.messages.getFull(cand.id);
        const candHeaders = full?.headers || {};
        const candRefs = [
          ...extractMessageIds(candHeaders["references"]),
          ...extractMessageIds(candHeaders["in-reply-to"]),
          ...extractMessageIds(candHeaders["message-id"])
        ];
        // Берём письмо, только если оно связано по References/In-Reply-To.
        // Без заголовков связи (редкие клиенты) — только из того же аккаунта и с явным "Re:"/"Fwd:" в теме,
        // чтобы не подтягивать посторонние письма с совпадающей темой ("Счёт", "Отчёт" и т.п.).
        const linked = candRefs.some((id) => refIds.has(id));
        const sameAccount =
          Boolean(cand.folder?.accountId && rootHeader.folder?.accountId) &&
          cand.folder.accountId === rootHeader.folder.accountId;
        const hasNoThreadHeaders = !candHeaders["references"] && !candHeaders["in-reply-to"];
        const looksLikeReply = /^\s*(re|fwd|fw|aw|ответ|пересл)\s*(\[\d+\])?:/i.test(cand.subject || "");
        const weakLink = hasNoThreadHeaders && sameAccount && looksLikeReply;

        if (linked || weakLink) {
          byId.set(cand.id, { header: cand, full });
          for (const id of candRefs) refIds.add(id);
        }
      } catch {
        // Пропускаем недоступное сообщение
      }
    }
  }

  // Догружаем полные тела для всех найденных сообщений ветки
  const items = Array.from(byId.values());
  for (const item of items) {
    if (!item.full) {
      try {
        item.full = await browser.messages.getFull(item.header.id);
      } catch {
        item.full = null;
      }
    }
  }

  // Дедупликация по headerMessageId (например, Sent + Archive копии одного письма)
  const deduped = [];
  const seenMsgIds = new Set();
  items.sort((a, b) => new Date(a.header.date).getTime() - new Date(b.header.date).getTime());

  for (const item of items) {
    const mid = (item.header.headerMessageId || "").trim().toLowerCase();
    if (mid && seenMsgIds.has(mid)) continue;
    if (mid) seenMsgIds.add(mid);
    deduped.push(item);
  }

  const isThread = deduped.length > 1;
  const formattedMessages = deduped.map((item, idx) => {
    // Если ветка из нескольких писем — чистим вложенные цитаты, чтобы не дублировать текст
    // Если письмо одно — оставляем цитаты внутри, чтобы не потерять историю
    const body = item.full ? extractBodyFromPart(item.full, isThread && idx > 0) : "";
    const recipients = Array.isArray(item.header.recipients) ? item.header.recipients.join(", ") : "";
    return {
      id: item.header.id,
      subject: item.header.subject || "(без темы)",
      author: item.header.author || "Неизвестный отправитель",
      recipients,
      date: formatDate(item.header.date),
      body: body || "(пустой текст письма)"
    };
  });

  // Формируем единый текстовый контекст переписки с мягкой защитой от переполнения
  const renderBlock = (m, index) => [
    `--- Письмо ${index + 1} из ${formattedMessages.length} ---`,
    `От: ${m.author}`,
    m.recipients ? `Кому: ${m.recipients}` : null,
    m.date ? `Дата: ${m.date}` : null,
    `Тема: ${m.subject}`,
    "",
    m.body
  ].filter((v) => v !== null).join("\n");

  let blocks = formattedMessages.map((m, idx) => renderBlock(m, idx));
  let fullContextText = blocks.join("\n\n");
  let truncated = false;

  if (fullContextText.length > maxChars && blocks.length > 2) {
    truncated = true;
    const first = blocks[0];
    const keptTail = [];
    let budget = maxChars - first.length - 200;

    for (let i = blocks.length - 1; i >= 1; i--) {
      if (blocks[i].length <= budget) {
        keptTail.unshift(blocks[i]);
        budget -= blocks[i].length;
      } else if (keptTail.length === 0) {
        keptTail.unshift(blocks[i].slice(0, Math.max(1000, budget)));
        break;
      } else {
        break;
      }
    }

    fullContextText = [
      first,
      "\n[... часть промежуточных писем сокращена из-за большого объёма переписки ...]\n",
      ...keptTail
    ].join("\n\n");
  } else if (fullContextText.length > maxChars) {
    truncated = true;
    fullContextText = fullContextText.slice(0, maxChars) + "\n\n[... текст сокращён из-за большого объёма ...]";
  }

  return {
    rootMessageId: rootHeader.id,
    subject: rootHeader.subject || "(без темы)",
    author: rootHeader.author || "",
    messageCount: formattedMessages.length,
    isThread,
    truncated,
    messages: formattedMessages,
    contextText: fullContextText
  };
}
