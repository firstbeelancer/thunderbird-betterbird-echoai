import {
  loadSettings,
  saveSettings,
  createDefaultProfile,
  getActiveProfile,
  applyTheme
} from "../lib/storage.js";
import {
  PROVIDER_PRESETS,
  getPresetById,
  buildEndpointUrl,
  extractOriginPattern
} from "../lib/providers.js";
import { DEFAULT_PROMPTS, LANGUAGE_OPTIONS } from "../lib/prompts.js";
import { fetchModels, testConnection } from "../lib/api-client.js";
import { requestMicrophoneStream, MIC_TIMEOUT_CODE } from "../lib/audio-recorder.js";
import { createIcon } from "../lib/icons.js";

// Navigation
const navButtons = Array.from(document.querySelectorAll(".nav-btn"));
const sections = {
  api: document.getElementById("section-api"),
  prompts: document.getElementById("section-prompts"),
  mic: document.getElementById("section-mic")
};

// Elements
const saveBtn = document.getElementById("saveBtn");
const saveIndicator = document.getElementById("saveIndicator");
const profilesList = document.getElementById("profilesList");
const addProfileBtn = document.getElementById("addProfileBtn");
const deleteProfileBtn = document.getElementById("deleteProfileBtn");
const presetHint = document.getElementById("presetHint");

const profileNameInput = document.getElementById("profileNameInput");
const providerSelect = document.getElementById("providerSelect");
const baseUrlInput = document.getElementById("baseUrlInput");
const urlPreview = document.getElementById("urlPreview");
const apiKeyInput = document.getElementById("apiKeyInput");
const toggleKeyBtn = document.getElementById("toggleKeyBtn");
const modelInput = document.getElementById("modelInput");
const fetchModelsBtn = document.getElementById("fetchModelsBtn");
const modelsListWrap = document.getElementById("modelsListWrap");
const modelSearchInput = document.getElementById("modelSearchInput");
const modelsCount = document.getElementById("modelsCount");
const modelsSelectList = document.getElementById("modelsSelectList");
const testConnBtn = document.getElementById("testConnBtn");
const testResult = document.getElementById("testResult");

const resetPromptsBtn = document.getElementById("resetPromptsBtn");
const userNameInput = document.getElementById("userNameInput");
const globalStyleInput = document.getElementById("globalStyleInput");
const promptImproveInput = document.getElementById("promptImproveInput");
const promptQuickReplyInput = document.getElementById("promptQuickReplyInput");
const promptChatInput = document.getElementById("promptChatInput");
const promptSummaryInput = document.getElementById("promptSummaryInput");
const promptTranslateInput = document.getElementById("promptTranslateInput");
const defaultReadLangSelect = document.getElementById("defaultReadLangSelect");
const defaultComposeLangSelect = document.getElementById("defaultComposeLangSelect");

const checkMicBtn = document.getElementById("checkMicBtn");
const resetMicBtn = document.getElementById("resetMicBtn");
const micStatus = document.getElementById("micStatus");
const themeButtons = Array.from(document.querySelectorAll(".theme-opt"));
const privacyShield = document.getElementById("privacyShield");

// Inject crisp linear SVG icons (zero emojis)
for (const span of document.querySelectorAll(".nav-icon[data-icon]")) {
  span.appendChild(createIcon(span.dataset.icon));
}
addProfileBtn.replaceChildren(createIcon("plus", "icon-sm"), document.createTextNode("Добавить профиль"));
deleteProfileBtn.replaceChildren(createIcon("trash", "icon-sm"), document.createTextNode("Удалить"));
toggleKeyBtn.appendChild(createIcon("eye"));
fetchModelsBtn.replaceChildren(createIcon("refresh", "icon-sm"), document.createTextNode("Загрузить модели"));
testConnBtn.replaceChildren(createIcon("shield", "icon-sm"), document.createTextNode("Протестировать подключение"));
checkMicBtn.replaceChildren(createIcon("mic", "icon-sm"), document.createTextNode("Проверить микрофон"));
resetMicBtn.replaceChildren(createIcon("refresh", "icon-sm"), document.createTextNode("Сбросить разрешение"));
privacyShield.appendChild(createIcon("shield", "icon-lg"));

let settings = null;
let saveToastTimer = null;

function switchSection(name) {
  const target = sections[name] ? name : "api";
  for (const [key, sec] of Object.entries(sections)) {
    sec.hidden = key !== target;
  }
  for (const btn of navButtons) {
    btn.classList.toggle("is-active", btn.dataset.section === target);
  }
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

function showSavedIndicator(label = "Сохранено") {
  saveIndicator.replaceChildren(createIcon("check", "icon-sm"), document.createTextNode(label));
  saveIndicator.hidden = false;
  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => {
    saveIndicator.hidden = true;
  }, 2200);
}

function showStatusBox(el, kind, message) {
  el.className = `test-result is-${kind}`;
  const iconName = kind === "ok" ? "check" : kind === "error" ? "alert" : "loader";
  const icon = createIcon(iconName, kind === "info" ? "spin" : "");
  const span = document.createElement("span");
  span.textContent = message;
  el.replaceChildren(icon, span);
  el.hidden = false;
}

function updateUrlPreview() {
  const endpoint = buildEndpointUrl(baseUrlInput.value, "/chat/completions");
  urlPreview.replaceChildren();
  if (endpoint) {
    urlPreview.append(document.createTextNode("Итоговый адрес запросов: "));
    const code = document.createElement("code");
    code.textContent = endpoint;
    urlPreview.appendChild(code);
  } else {
    urlPreview.textContent = "Введите корректный URL (можно указать базовый домен, путь /v1 или полный /v1/chat/completions).";
  }
}

function renderModelsList(models, filter = "") {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) {
    modelsListWrap.hidden = true;
    return;
  }

  modelsListWrap.hidden = false;
  const q = filter.trim().toLowerCase();
  const filtered = q ? list.filter((id) => id.toLowerCase().includes(q)) : list;
  modelsCount.textContent = `${filtered.length} из ${list.length}`;

  modelsSelectList.replaceChildren();
  const currentModel = modelInput.value.trim();

  for (const id of filtered.slice(0, 200)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-option" + (id === currentModel ? " is-selected" : "");
    btn.textContent = id;
    btn.addEventListener("click", () => {
      modelInput.value = id;
      syncFormToActiveProfile();
      renderModelsList(list, modelSearchInput.value);
    });
    modelsSelectList.appendChild(btn);
  }
}

function renderProfilesBar() {
  profilesList.replaceChildren();
  for (const p of settings.profiles) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "profile-chip" + (p.id === settings.activeProfileId ? " is-active" : "");

    const dot = document.createElement("span");
    dot.className = "profile-dot";
    chip.append(dot, document.createTextNode(p.name || "Без названия"));

    chip.addEventListener("click", () => {
      syncFormToActiveProfile();
      settings.activeProfileId = p.id;
      testResult.hidden = true;
      renderActiveProfileForm();
      renderProfilesBar();
      persistSettings();
    });

    profilesList.appendChild(chip);
  }

  deleteProfileBtn.hidden = settings.profiles.length <= 1;
}

function renderActiveProfileForm() {
  const p = getActiveProfile(settings);
  if (!p) return;

  profileNameInput.value = p.name || "";
  providerSelect.value = p.providerId || "custom";
  baseUrlInput.value = p.baseUrl || "";
  apiKeyInput.value = p.apiKey || "";
  apiKeyInput.type = "password";
  toggleKeyBtn.replaceChildren(createIcon("eye"));
  modelInput.value = p.model || "";

  const preset = getPresetById(p.providerId);
  presetHint.textContent = preset.hint || "";
  apiKeyInput.placeholder = preset.keyPlaceholder || "sk-...";

  updateUrlPreview();
  modelSearchInput.value = "";
  renderModelsList(p.cachedModels || []);
}

function syncFormToActiveProfile() {
  const p = getActiveProfile(settings);
  if (!p) return;
  p.name = profileNameInput.value.trim() || getPresetById(providerSelect.value).name;
  p.providerId = providerSelect.value;
  p.baseUrl = baseUrlInput.value.trim();
  p.apiKey = apiKeyInput.value.trim();
  p.model = modelInput.value.trim();
}

function syncPromptsFromForm() {
  settings.prompts = {
    userName: userNameInput.value.trim(),
    globalStyle: globalStyleInput.value.trim(),
    improveText: promptImproveInput.value.trim(),
    quickReply: promptQuickReplyInput.value.trim(),
    chat: promptChatInput.value.trim(),
    summary: promptSummaryInput.value.trim(),
    translate: promptTranslateInput.value.trim()
  };
  settings.defaultTranslateReadLang = defaultReadLangSelect.value;
  settings.defaultTranslateComposeLang = defaultComposeLangSelect.value;
}

function renderPromptsForm() {
  const pr = { ...DEFAULT_PROMPTS, ...(settings.prompts || {}) };
  userNameInput.value = pr.userName || "";
  globalStyleInput.value = pr.globalStyle || "";
  promptImproveInput.value = pr.improveText || "";
  promptQuickReplyInput.value = pr.quickReply || "";
  promptChatInput.value = pr.chat || "";
  promptSummaryInput.value = pr.summary || "";
  promptTranslateInput.value = pr.translate || "";

  defaultReadLangSelect.value = settings.defaultTranslateReadLang || "Русский";
  defaultComposeLangSelect.value = settings.defaultTranslateComposeLang || "English";
}

function renderThemeSelector() {
  for (const btn of themeButtons) {
    btn.classList.toggle("is-active", btn.dataset.themeVal === settings.theme);
  }
}

async function persistSettings(showToast = true) {
  syncFormToActiveProfile();
  syncPromptsFromForm();
  await saveSettings(settings);
  renderProfilesBar();
  if (showToast) showSavedIndicator();
}

async function ensureHostPermissionIfNeeded(rawUrl) {
  const origin = extractOriginPattern(rawUrl);
  if (!origin) return true;

  try {
    const has = await browser.permissions.contains({ origins: [origin] });
    if (has) return true;
    // Для нестандартных http:// хостов запрашиваем разрешение по клику пользователя
    return await browser.permissions.request({ origins: [origin] });
  } catch {
    return true;
  }
}

/* ---------- Events ---------- */

providerSelect.addEventListener("change", () => {
  const p = getActiveProfile(settings);
  const preset = getPresetById(providerSelect.value);
  p.providerId = preset.id;

  if (preset.baseUrl) {
    baseUrlInput.value = preset.baseUrl;
  }
  if (preset.defaultModel && !modelInput.value.trim()) {
    modelInput.value = preset.defaultModel;
  }
  // Если имя профиля совпадало со старым названием пресета, обновим и имя
  const knownPresetNames = PROVIDER_PRESETS.map((pr) => pr.name);
  if (!profileNameInput.value.trim() || knownPresetNames.includes(profileNameInput.value.trim())) {
    profileNameInput.value = preset.name;
  }

  presetHint.textContent = preset.hint || "";
  apiKeyInput.placeholder = preset.keyPlaceholder || "sk-...";
  updateUrlPreview();
  syncFormToActiveProfile();
  renderProfilesBar();
});

baseUrlInput.addEventListener("input", updateUrlPreview);

toggleKeyBtn.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleKeyBtn.replaceChildren(createIcon(showing ? "eye" : "eyeOff"));
});

modelSearchInput.addEventListener("input", () => {
  const p = getActiveProfile(settings);
  renderModelsList(p?.cachedModels || [], modelSearchInput.value);
});

addProfileBtn.addEventListener("click", async () => {
  syncFormToActiveProfile();
  const next = createDefaultProfile("openrouter");
  next.name = `Профиль ${settings.profiles.length + 1}`;
  settings.profiles.push(next);
  settings.activeProfileId = next.id;
  testResult.hidden = true;
  renderProfilesBar();
  renderActiveProfileForm();
  await persistSettings(false);
});

deleteProfileBtn.addEventListener("click", async () => {
  if (settings.profiles.length <= 1) return;
  settings.profiles = settings.profiles.filter((p) => p.id !== settings.activeProfileId);
  settings.activeProfileId = settings.profiles[0].id;
  testResult.hidden = true;
  renderProfilesBar();
  renderActiveProfileForm();
  await persistSettings();
});

fetchModelsBtn.addEventListener("click", async () => {
  syncFormToActiveProfile();
  const p = getActiveProfile(settings);
  await ensureHostPermissionIfNeeded(p.baseUrl);

  fetchModelsBtn.disabled = true;
  showStatusBox(testResult, "info", "Загружаю список моделей с сервера…");

  try {
    const models = await fetchModels(p);
    p.cachedModels = models;
    if (!p.model && models.length > 0) {
      p.model = models[0];
      modelInput.value = models[0];
    }
    await persistSettings(false);
    renderModelsList(models);
    showStatusBox(testResult, "ok", `Загружено моделей: ${models.length}. Выберите нужную из списка или впишите вручную.`);
  } catch (err) {
    showStatusBox(testResult, "error", err?.message || String(err));
  } finally {
    fetchModelsBtn.disabled = false;
  }
});

testConnBtn.addEventListener("click", async () => {
  syncFormToActiveProfile();
  const p = getActiveProfile(settings);
  const permitted = await ensureHostPermissionIfNeeded(p.baseUrl);
  if (!permitted) {
    showStatusBox(testResult, "error", "Разрешение на доступ к указанному хосту не было выдано.");
    return;
  }

  testConnBtn.disabled = true;
  showStatusBox(testResult, "info", "Проверяю подключение, ключ и отклик модели…");

  try {
    const result = await testConnection(p);
    if (result.models?.length > 0) {
      p.cachedModels = result.models;
      renderModelsList(result.models);
    }
    if (!p.model && result.testedModel) {
      p.model = result.testedModel;
      modelInput.value = result.testedModel;
    }
    await persistSettings(false);
    showStatusBox(testResult, result.ok ? "ok" : "error", result.summary);
  } catch (err) {
    showStatusBox(testResult, "error", err?.message || String(err));
  } finally {
    testConnBtn.disabled = false;
  }
});

resetPromptsBtn.addEventListener("click", async () => {
  settings.prompts = { ...DEFAULT_PROMPTS };
  renderPromptsForm();
  await persistSettings();
});

themeButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    settings.theme = btn.dataset.themeVal;
    applyTheme(settings.theme);
    renderThemeSelector();
    await persistSettings();
  });
});

async function refreshMicPermissionUi() {
  try {
    if (!browser?.echoMic?.getPermissionStatus) return;
    const st = await browser.echoMic.getPermissionStatus();
    if (st.state === "allow") {
      showStatusBox(micStatus, "ok", "Доступ к микрофону для EchoAI разрешён.");
      resetMicBtn.hidden = false;
    } else if (st.state === "deny") {
      showStatusBox(micStatus, "error", "Доступ к микрофону для EchoAI сейчас запрещён. Нажмите «Сбросить разрешение», чтобы запросить его снова.");
      resetMicBtn.hidden = false;
    } else {
      resetMicBtn.hidden = true;
    }
  } catch { /* ignore */ }
}

resetMicBtn.addEventListener("click", async () => {
  try {
    await browser.echoMic?.resetPermission?.();
    resetMicBtn.hidden = true;
    showStatusBox(micStatus, "info", "Выбор сброшен. Нажмите «Проверить микрофон» или кнопку микрофона в чате, чтобы выдать доступ заново.");
  } catch (err) {
    showStatusBox(micStatus, "error", `Не удалось сбросить разрешение: ${err?.message || err}`);
  }
});

checkMicBtn.addEventListener("click", async () => {
  checkMicBtn.disabled = true;
  showStatusBox(micStatus, "info", "Подключаюсь к микрофону (при первом запуске подтвердите диалог Betterbird)…");
  try {
    const stream = await requestMicrophoneStream();
    for (const track of stream.getTracks()) track.stop();
    showStatusBox(micStatus, "ok", "Микрофон работает. Голосовой ввод готов в окне ассистента.");
    resetMicBtn.hidden = false;
  } catch (err) {
    if (err?.code === MIC_TIMEOUT_CODE) {
      showStatusBox(micStatus, "error", err.message);
    } else {
      showStatusBox(
        micStatus,
        "error",
        `Доступ к микрофону не получен (${err?.message || err}). Если вы ранее нажали «Отмена», нажмите «Сбросить разрешение» и проверьте доступ микрофона в настройках Windows.`
      );
    }
    await refreshMicPermissionUi();
  } finally {
    checkMicBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", () => persistSettings(true));

/* ---------- Init ---------- */

async function init() {
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.name;
    providerSelect.appendChild(opt);
  }

  for (const lang of LANGUAGE_OPTIONS) {
    const opt1 = document.createElement("option");
    opt1.value = lang.code;
    opt1.textContent = lang.label;
    defaultReadLangSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = lang.code;
    opt2.textContent = lang.label;
    defaultComposeLangSelect.appendChild(opt2);
  }

  settings = await loadSettings();
  applyTheme(settings.theme);

  renderProfilesBar();
  renderActiveProfileForm();
  renderPromptsForm();
  renderThemeSelector();
  await refreshMicPermissionUi();

  if (window.location.hash === "#mic") {
    switchSection("mic");
  }
}

init();
