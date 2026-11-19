/**
 * Локальное хранилище настроек, профилей подключений и временных сессий модалок.
 * Все данные хранятся строго локально в профиле Betterbird / Thunderbird.
 */

import { DEFAULT_PROMPTS } from "./prompts.js";
import { getPresetById } from "./providers.js";

const SETTINGS_KEY = "echoai_settings_v1";
const SESSIONS_KEY = "echoai_sessions_v1";

export function createDefaultProfile(presetId = "clodex") {
  const preset = getPresetById(presetId);
  return {
    id: `profile_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: preset.name,
    providerId: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.defaultModel,
    cachedModels: []
  };
}

export function getDefaultSettings() {
  const firstProfile = createDefaultProfile("clodex");
  firstProfile.id = "default_clodex";
  return {
    activeProfileId: firstProfile.id,
    profiles: [firstProfile],
    theme: "auto", // "auto" | "light" | "dark"
    defaultTranslateReadLang: "Русский",
    defaultTranslateComposeLang: "English",
    maxThreadChars: 48000,
    prompts: { ...DEFAULT_PROMPTS }
  };
}

export async function loadSettings() {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const raw = stored?.[SETTINGS_KEY];
  const defaults = getDefaultSettings();

  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const profiles = Array.isArray(raw.profiles) && raw.profiles.length > 0
    ? raw.profiles
    : defaults.profiles;

  const activeProfileId = profiles.some((p) => p.id === raw.activeProfileId)
    ? raw.activeProfileId
    : profiles[0].id;

  return {
    ...defaults,
    ...raw,
    profiles,
    activeProfileId,
    prompts: {
      ...DEFAULT_PROMPTS,
      ...(raw.prompts || {})
    }
  };
}

export async function saveSettings(settings) {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export function getActiveProfile(settings) {
  if (!settings?.profiles?.length) return null;
  return settings.profiles.find((p) => p.id === settings.activeProfileId) || settings.profiles[0];
}

export function applyTheme(theme = "auto") {
  const valid = theme === "light" || theme === "dark" ? theme : "auto";
  document.documentElement.setAttribute("data-theme", valid);
}

/* ---------- Временные сессии для передачи контекста в окно модалки ---------- */

export async function saveSession(sessionData) {
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stored = await browser.storage.local.get(SESSIONS_KEY);
  const sessions = stored?.[SESSIONS_KEY] || {};

  // Чистим старые сессии старше 3 часов, чтобы хранилище не пухло
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [key, val] of Object.entries(sessions)) {
    if (!val?.createdAt || val.createdAt < cutoff) {
      delete sessions[key];
    }
  }

  sessions[id] = {
    ...sessionData,
    id,
    createdAt: Date.now()
  };

  await browser.storage.local.set({ [SESSIONS_KEY]: sessions });
  return id;
}

export async function getSession(sessionId) {
  const stored = await browser.storage.local.get(SESSIONS_KEY);
  return stored?.[SESSIONS_KEY]?.[sessionId] || null;
}

export async function removeSession(sessionId) {
  const stored = await browser.storage.local.get(SESSIONS_KEY);
  const sessions = stored?.[SESSIONS_KEY] || {};
  if (sessions[sessionId]) {
    delete sessions[sessionId];
    await browser.storage.local.set({ [SESSIONS_KEY]: sessions });
  }
}
