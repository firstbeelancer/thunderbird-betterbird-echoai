/**
 * OpenAI-compatible API клиент EchoAI:
 * - умная нормализация URL
 * - загрузка списка моделей (/models)
 * - тестирование подключения с понятной диагностикой
 * - SSE-стриминг (/chat/completions) с фильтрацией скрытых рассуждений (<think>, reasoning_content)
 * - поддержка прямого аудио input_audio (WAV base64)
 * - точный подсчёт токенов с fallback-оценкой
 */

import { buildEndpointUrl, normalizeBaseUrl } from "./providers.js";

function buildHeaders(profile) {
  const headers = {
    "Content-Type": "application/json"
  };
  const key = String(profile?.apiKey || "").trim();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  if (profile?.providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/firstbeelancer/thunderbird-betterbird-echoai";
    headers["X-Title"] = "EchoAI";
  }
  return headers;
}

function humanizeHttpError(status, bodyText) {
  let apiMessage = "";
  try {
    const parsed = JSON.parse(bodyText);
    apiMessage = parsed?.error?.message || parsed?.message || "";
  } catch {
    apiMessage = (bodyText || "").slice(0, 220).trim();
  }

  if (status === 401) {
    return `Неверный API-ключ (HTTP 401). Проверьте ключ.${apiMessage ? ` Детали: ${apiMessage}` : ""}`;
  }
  if (status === 403) {
    return `Доступ запрещён (HTTP 403). Возможно, ключ не имеет прав на эту модель.${apiMessage ? ` Детали: ${apiMessage}` : ""}`;
  }
  if (status === 404) {
    return `Эндпойнт или модель не найдены (HTTP 404). Проверьте URL и имя модели.${apiMessage ? ` Детали: ${apiMessage}` : ""}`;
  }
  if (status === 429) {
    return `Превышен лимит запросов или закончился баланс (HTTP 429).${apiMessage ? ` Детали: ${apiMessage}` : ""}`;
  }
  if (status >= 500) {
    return `Ошибка сервера провайдера (HTTP ${status}). Попробуйте повторить чуть позже.${apiMessage ? ` Детали: ${apiMessage}` : ""}`;
  }
  return `Ошибка API (HTTP ${status})${apiMessage ? `: ${apiMessage}` : ""}`;
}

function estimateTokensFromText(text) {
  const str = String(text || "");
  if (!str) return 0;
  // Примерная эвристика для смешанного RU/EN текста (~3.2 символа на токен)
  return Math.max(1, Math.ceil(str.length / 3.2));
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages || []) {
    total += 4;
    if (typeof msg.content === "string") {
      total += estimateTokensFromText(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          total += estimateTokensFromText(part.text);
        } else if (part.type === "input_audio") {
          // ~32 токена в секунду аудио (примерно base64 / 42000 * 32)
          const approxBytes = (part.input_audio?.data?.length || 0) * 0.75;
          const approxSec = approxBytes / 32000;
          total += Math.max(25, Math.ceil(approxSec * 32));
        }
      }
    }
  }
  return total;
}

/**
 * Загружает список доступных моделей с /models.
 */
export async function fetchModels(profile) {
  const url = buildEndpointUrl(profile.baseUrl, "/models");
  if (!url) {
    throw new Error("Некорректный URL эндпойнта.");
  }

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(profile)
    });
  } catch (err) {
    throw new Error(`Сетевая ошибка при обращении к ${url}. Проверьте URL и доступ к хосту. (${err.message})`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(humanizeHttpError(response.status, text));
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Сервер вернул не JSON вместо списка моделей. Проверьте URL эндпойнта.");
  }

  const rawList = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : Array.isArray(data?.models)
        ? data.models
        : [];

  const ids = rawList
    .map((item) => (typeof item === "string" ? item : item?.id || item?.name || ""))
    .filter(Boolean);

  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Полная проверка подключения:
 * 1) валидация URL
 * 2) попытка забрать /models
 * 3) мини-запрос к /chat/completions для выбранной модели (если задана)
 */
export async function testConnection(profile) {
  const normalized = normalizeBaseUrl(profile.baseUrl);
  if (!normalized) {
    return {
      ok: false,
      summary: "Некорректный URL эндпойнта. Укажите адрес вида https://clodex.xyz/v1",
      models: [],
      latencyMs: 0
    };
  }

  const startedAt = performance.now();
  let models = [];
  let modelsNote = "";

  try {
    models = await fetchModels(profile);
    modelsNote = models.length > 0 ? `Найдено моделей: ${models.length}` : "Список моделей пуст";
  } catch (err) {
    // Если 401/403 — сразу останавливаемся, ключ точно невалиден
    if (/401|403/.test(err.message)) {
      return {
        ok: false,
        summary: err.message,
        models: [],
        latencyMs: Math.round(performance.now() - startedAt)
      };
    }
    modelsNote = `Список /models недоступен (${err.message})`;
  }

  const modelToTest = String(profile.model || "").trim() || models[0] || "";
  if (!modelToTest) {
    return {
      ok: models.length > 0,
      summary: models.length > 0
        ? `Подключение установлено (${modelsNote}), выберите или введите модель.`
        : `Не удалось получить список моделей и не указана модель вручную. ${modelsNote}`,
      models,
      latencyMs: Math.round(performance.now() - startedAt)
    };
  }

  const chatUrl = buildEndpointUrl(normalized, "/chat/completions");
  let resp;
  try {
    resp = await fetch(chatUrl, {
      method: "POST",
      headers: buildHeaders(profile),
      body: JSON.stringify({
        model: modelToTest,
        messages: [{ role: "user", content: "Reply with a single word: OK" }],
        max_tokens: 16,
        temperature: 0
      })
    });
  } catch (err) {
    return {
      ok: false,
      summary: `Сетевая ошибка при тестовом запросе к ${chatUrl}: ${err.message}`,
      models,
      latencyMs: Math.round(performance.now() - startedAt)
    };
  }

  const bodyText = await resp.text();
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!resp.ok) {
    return {
      ok: false,
      summary: humanizeHttpError(resp.status, bodyText),
      models,
      latencyMs
    };
  }

  return {
    ok: true,
    summary: `Подключение работает · модель «${modelToTest}» ответила за ${latencyMs} мс${models.length ? ` · загружено моделей: ${models.length}` : ""}`,
    models,
    testedModel: modelToTest,
    latencyMs
  };
}

/**
 * Фильтр потокового вывода: вырезает блоки <think>...</think> даже на стыке чанков
 * и сообщает коллбеку, когда модель в фазе рассуждения.
 */
class ThinkFilter {
  constructor() {
    this.inThink = false;
    this.pending = "";
  }

  push(chunk) {
    this.pending += chunk;
    let visible = "";
    let sawThinking = false;

    while (this.pending.length > 0) {
      if (this.inThink) {
        const closeIdx = this.pending.indexOf("</think>");
        if (closeIdx !== -1) {
          this.pending = this.pending.slice(closeIdx + 8);
          this.inThink = false;
          sawThinking = true;
        } else {
          // Сохраняем хвост длиной 7 символов на случай разорванного </think>
          if (this.pending.length > 7) {
            this.pending = this.pending.slice(-7);
          }
          sawThinking = true;
          break;
        }
      } else {
        const openIdx = this.pending.indexOf("<think>");
        if (openIdx !== -1) {
          visible += this.pending.slice(0, openIdx);
          this.pending = this.pending.slice(openIdx + 7);
          this.inThink = true;
          sawThinking = true;
        } else {
          // Проверяем возможный частичный тег <think> на конце строки
          const lastLt = this.pending.lastIndexOf("<");
          if (lastLt !== -1 && "<think>".startsWith(this.pending.slice(lastLt))) {
            visible += this.pending.slice(0, lastLt);
            this.pending = this.pending.slice(lastLt);
          } else {
            visible += this.pending;
            this.pending = "";
          }
          break;
        }
      }
    }

    return { visible, sawThinking };
  }

  flush() {
    if (this.inThink) {
      this.pending = "";
      return "";
    }
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/**
 * Стриминговый запрос к /chat/completions.
 */
export async function streamChatCompletion({
  profile,
  messages,
  signal,
  onStatus,
  onDelta,
  onUsage
}) {
  const url = buildEndpointUrl(profile.baseUrl, "/chat/completions");
  if (!url) {
    throw new Error("Не задан корректный URL эндпойнта. Откройте настройки EchoAI.");
  }
  if (!String(profile.model || "").trim()) {
    throw new Error("Не выбрана модель. Укажите модель в настройках EchoAI.");
  }

  onStatus?.("connecting");

  const makeRequest = async (includeStreamOptions) => {
    const payload = {
      model: profile.model.trim(),
      messages,
      stream: true
    };
    if (includeStreamOptions) {
      payload.stream_options = { include_usage: true };
    }
    return fetch(url, {
      method: "POST",
      headers: buildHeaders(profile),
      body: JSON.stringify(payload),
      signal
    });
  };

  let response;
  try {
    response = await makeRequest(true);
    // Некоторые OpenAI-compatible шлюзы не поддерживают stream_options -> повторяем без него
    if (response.status === 400) {
      const errText = await response.clone().text();
      if (/stream_options/i.test(errText)) {
        response = await makeRequest(false);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`Не удалось подключиться к ${url}: ${err.message}`);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(humanizeHttpError(response.status, errText));
  }

  onStatus?.("thinking");

  const contentType = response.headers.get("content-type") || "";
  let fullText = "";
  let usage = null;

  // Если сервер проигнорировал stream: true и вернул обычный JSON
  if (contentType.includes("application/json")) {
    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content || "";
    const filter = new ThinkFilter();
    const { visible } = filter.push(rawContent);
    fullText = (visible + filter.flush()).trimStart();
    if (fullText) {
      onStatus?.("streaming");
      onDelta?.(fullText, fullText);
    }
    if (data?.usage) {
      usage = {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || ((data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0)),
        estimated: false
      };
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const filter = new ThinkFilter();
    let buffer = "";
    let hasVisibleStarted = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const payloadStr = line.slice(5).trim();
        if (payloadStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(payloadStr);
        } catch {
          continue;
        }

        if (parsed?.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens || 0,
            completionTokens: parsed.usage.completion_tokens || 0,
            totalTokens: parsed.usage.total_tokens || ((parsed.usage.prompt_tokens || 0) + (parsed.usage.completion_tokens || 0)),
            estimated: false
          };
          onUsage?.(usage);
        }

        const choice = parsed?.choices?.[0];
        const delta = choice?.delta || {};

        // Скрытые поля рассуждений разных провайдеров — переводим в статус "Думает..."
        if (delta.reasoning_content || delta.reasoning || delta.thinking) {
          if (!hasVisibleStarted) {
            onStatus?.("thinking");
          }
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          const { visible, sawThinking } = filter.push(delta.content);
          if (sawThinking && !hasVisibleStarted) {
            onStatus?.("thinking");
          }
          if (visible) {
            if (!hasVisibleStarted) {
              hasVisibleStarted = true;
              onStatus?.("streaming");
            }
            fullText += visible;
            onDelta?.(visible, fullText);
          }
        }
      }
    }

    const tail = filter.flush();
    if (tail) {
      fullText += tail;
      onDelta?.(tail, fullText);
    }
  }

  // Fallback-оценка токенов, если провайдер не прислал usage
  if (!usage) {
    const promptTokens = estimateMessagesTokens(messages);
    const completionTokens = estimateTokensFromText(fullText);
    usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: true
    };
    onUsage?.(usage);
  }

  return {
    text: fullText.trim(),
    usage
  };
}
