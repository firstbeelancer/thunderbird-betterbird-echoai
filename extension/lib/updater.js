/**
 * Проверка обновлений EchoAI — СТРОГО по клику пользователя (без фоновых запросов).
 * Источник: updates.json на GitHub Pages проекта (формат Mozilla update manifest).
 */

export const ADDON_ID = "echoai@firstbeelancer.github.io";
export const PROJECT_PAGE_URL = "https://firstbeelancer.github.io/thunderbird-betterbird-echoai/";
export const UPDATES_URL = `${PROJECT_PAGE_URL}updates.json`;
export const RELEASES_URL = "https://github.com/firstbeelancer/thunderbird-betterbird-echoai/releases/latest";

export function getCurrentVersion() {
  return browser.runtime.getManifest().version;
}

/**
 * Сравнение версий вида 1.2.0 / 1.10.3. Возвращает 1, -1 или 0.
 */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Запрашивает updates.json и возвращает самую свежую запись.
 * { current, latest, isNewer, updateLink, updateHash }
 */
export async function checkForUpdate() {
  const current = getCurrentVersion();

  let response;
  try {
    response = await fetch(`${UPDATES_URL}?t=${Date.now()}`, { cache: "no-store" });
  } catch (err) {
    throw new Error(`Нет связи с GitHub. Проверьте интернет и попробуйте ещё раз. (${err.message})`);
  }
  if (!response.ok) {
    throw new Error(`GitHub вернул ошибку HTTP ${response.status} при проверке обновлений.`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Файл обновлений на GitHub повреждён или недоступен.");
  }

  const updates = data?.addons?.[ADDON_ID]?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("В файле обновлений нет информации о версиях EchoAI.");
  }

  const latestEntry = updates.reduce((best, u) =>
    !best || compareVersions(u.version, best.version) > 0 ? u : best, null);

  return {
    current,
    latest: latestEntry.version,
    isNewer: compareVersions(latestEntry.version, current) > 0,
    updateLink: latestEntry.update_link || "",
    updateHash: latestEntry.update_hash || ""
  };
}

export async function openExternal(url) {
  try {
    if (browser.windows?.openDefaultBrowser) {
      await browser.windows.openDefaultBrowser(url);
      return;
    }
  } catch { /* fallback ниже */ }
  await browser.tabs.create({ url });
}
