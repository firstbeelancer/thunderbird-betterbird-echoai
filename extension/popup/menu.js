import { loadSettings, getActiveProfile, applyTheme } from "../lib/storage.js";
import { createIcon } from "../lib/icons.js";

const DISPLAY_ITEMS = [
  {
    mode: "quick_reply",
    icon: "reply",
    title: "Быстрый ответ",
    desc: "Сразу готовый ответ по всей переписке"
  },
  {
    mode: "chat",
    icon: "chat",
    title: "Чат с ассистентом",
    desc: "Развёрнутый диалог текстом или голосом"
  },
  {
    mode: "summary",
    icon: "summary",
    title: "Краткое саммари",
    desc: "Главная суть письма или всей ветки"
  },
  {
    mode: "translate",
    icon: "translate",
    title: "Перевод",
    desc: "Перевести письмо на нужный язык"
  }
];

const COMPOSE_ITEMS = [
  {
    mode: "improve",
    icon: "improve",
    title: "Улучшить текст",
    desc: "Выделенный фрагмент или весь черновик"
  },
  {
    mode: "chat",
    icon: "chat",
    title: "Чат с ассистентом",
    desc: "Составить с нуля текстом или голосом"
  },
  {
    mode: "quick_reply",
    icon: "reply",
    title: "Быстрый ответ",
    desc: "Черновик ответа по контексту переписки"
  },
  {
    mode: "summary",
    icon: "summary",
    title: "Краткое саммари",
    desc: "Выжимка переписки или черновика"
  },
  {
    mode: "translate",
    icon: "translate",
    title: "Перевод",
    desc: "Перевести выделение или весь черновик"
  }
];

const params = new URLSearchParams(window.location.search);
const context = params.get("context") === "compose" ? "compose" : "display";

const modelBadge = document.getElementById("modelBadge");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const setupNotice = document.getElementById("setupNotice");
const setupNoticeIcon = document.getElementById("setupNoticeIcon");
const setupNoticeBtn = document.getElementById("setupNoticeBtn");
const errorBox = document.getElementById("errorBox");
const menuList = document.getElementById("menuList");
const shieldIcon = document.getElementById("shieldIcon");

openOptionsBtn.appendChild(createIcon("settings"));
setupNoticeIcon.appendChild(createIcon("alert", "icon-sm"));
shieldIcon.appendChild(createIcon("shield", "icon-sm"));

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

async function openOptions() {
  await browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  window.close();
}

openOptionsBtn.addEventListener("click", openOptions);
setupNoticeBtn.addEventListener("click", openOptions);

async function triggerMode(mode, clickedBtn) {
  errorBox.hidden = true;
  const allBtns = Array.from(menuList.querySelectorAll(".menu-item"));
  allBtns.forEach((b) => { b.disabled = true; });

  const iconSlot = clickedBtn.querySelector(".menu-item-icon");
  const prevIcon = iconSlot.firstChild;
  iconSlot.replaceChildren(createIcon("loader", "spin"));

  try {
    const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTabs?.[0]?.id;

    const result = await browser.runtime.sendMessage({
      type: "OPEN_ASSISTANT",
      payload: { context, mode, tabId }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Не удалось открыть окно ассистента.");
    }

    window.close();
  } catch (err) {
    showError(err?.message || String(err));
    if (prevIcon) iconSlot.replaceChildren(prevIcon);
    allBtns.forEach((b) => { b.disabled = false; });
  }
}

async function init() {
  const settings = await loadSettings();
  applyTheme(settings.theme);

  const profile = getActiveProfile(settings);
  if (profile && profile.baseUrl && profile.model) {
    modelBadge.textContent = `${profile.name} · ${profile.model}`;
  } else {
    modelBadge.textContent = "Требуется настройка";
  }

  const isConfigured = Boolean(profile?.baseUrl && profile?.model);
  if (!isConfigured) {
    setupNotice.hidden = false;
  }

  const items = context === "compose" ? COMPOSE_ITEMS : DISPLAY_ITEMS;
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";

    const iconWrap = document.createElement("span");
    iconWrap.className = "menu-item-icon";
    iconWrap.appendChild(createIcon(item.icon));

    const textWrap = document.createElement("span");
    textWrap.className = "menu-item-text";

    const title = document.createElement("span");
    title.className = "menu-item-title";
    title.textContent = item.title;

    const desc = document.createElement("span");
    desc.className = "menu-item-desc";
    desc.textContent = item.desc;

    textWrap.append(title, desc);
    btn.append(iconWrap, textWrap);
    btn.addEventListener("click", () => triggerMode(item.mode, btn));
    menuList.appendChild(btn);
  }
}

init();
