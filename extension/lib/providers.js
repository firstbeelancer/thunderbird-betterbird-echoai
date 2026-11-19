/**
 * Предустановленные OpenAI-compatible провайдеры и умная нормализация URL.
 */

export const PROVIDER_PRESETS = [
  {
    id: "clodex",
    name: "Clodex",
    baseUrl: "https://clodex.xyz/v1",
    defaultModel: "gemini-4-hydrogen-high",
    docsUrl: "https://clodex.xyz/docs",
    keyPlaceholder: "sk-...",
    hint: "Агрегатор моделей с поддержкой мультимодального аудио (например, gemini-4-hydrogen-high)."
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.5-flash",
    docsUrl: "https://openrouter.ai/docs",
    keyPlaceholder: "sk-or-v1-...",
    hint: "Единый шлюз к сотням моделей OpenAI, Anthropic, Google и open-source."
  },
  {
    id: "cometapi",
    name: "CometAPI",
    baseUrl: "https://api.cometapi.com/v1",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://api.cometapi.com",
    keyPlaceholder: "sk-...",
    hint: "Мультимодельный OpenAI-compatible агрегатор."
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    docsUrl: "https://platform.openai.com/docs",
    keyPlaceholder: "sk-proj-...",
    hint: "Официальный OpenAI API."
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    keyPlaceholder: "AIza...",
    hint: "Официальный OpenAI-compatible эндпойнт Google AI Studio."
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible API",
    baseUrl: "",
    defaultModel: "",
    docsUrl: "",
    keyPlaceholder: "sk-...",
    hint: "Любой сторонний агрегатор или локальный сервер (Ollama, LM Studio, LiteLLM и др.)."
  }
];

export function getPresetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

/**
 * Нормализует любой пользовательский URL в чистый baseUrl (без хвостового /chat/completions и /models),
 * гарантируя отсутствие дублирования /v1.
 *
 * Примеры:
 * - https://clodex.xyz                          -> https://clodex.xyz/v1
 * - https://clodex.xyz/v1                       -> https://clodex.xyz/v1
 * - https://clodex.xyz/v1/chat/completions      -> https://clodex.xyz/v1
 * - https://openrouter.ai/api/v1/chat/completions -> https://openrouter.ai/api/v1
 * - https://generativelanguage.googleapis.com/v1beta/openai -> остаётся как есть
 */
export function normalizeBaseUrl(rawUrl) {
  let value = String(rawUrl || "").trim();
  if (!value) return "";

  if (!/^https?:\/\//i.test(value)) {
    value = "https://" + value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }

  let path = parsed.pathname.replace(/\/+$/, "");

  // Срезаем известные конечные эндпойнты, если пользователь вставил полный URL
  const suffixes = [
    "/chat/completions",
    "/completions",
    "/responses",
    "/models",
    "/audio/transcriptions"
  ];
  for (const suffix of suffixes) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }

  path = path.replace(/\/+$/, "");

  // Если путь пустой (например https://clodex.xyz), добавляем /v1
  if (!path) {
    path = "/v1";
  }

  // Защита от двойного /v1/v1
  path = path.replace(/(\/v1)+$/i, "/v1");

  return `${parsed.origin}${path}`;
}

export function buildEndpointUrl(rawBaseUrl, endpointPath) {
  const base = normalizeBaseUrl(rawBaseUrl);
  if (!base) return "";
  const cleanEndpoint = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  return `${base}${cleanEndpoint}`;
}

export function extractOriginPattern(rawUrl) {
  const base = normalizeBaseUrl(rawUrl);
  if (!base) return null;
  try {
    const parsed = new URL(base);
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}
