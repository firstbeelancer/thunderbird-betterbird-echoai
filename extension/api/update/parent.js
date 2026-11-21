/* global ChromeUtils */
"use strict";

/**
 * Thunderbird / Betterbird Experiment API (addon_parent): echoUpdate
 *
 * Устанавливает новую версию EchoAI строго по клику пользователя в настройках.
 * Никаких фоновых проверок: в manifest.json намеренно НЕТ update_url.
 *
 * Безопасность: принимается только .xpi с официальной страницы проекта на GitHub Pages
 * и только с контрольной суммой sha256 из updates.json.
 */

var ExtensionCommonRef =
  globalThis.ExtensionCommon ||
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;

var ServicesRef =
  globalThis.Services ||
  ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;

const ALLOWED_PREFIX = "https://firstbeelancer.github.io/thunderbird-betterbird-echoai/download/";

function loadAddonManager() {
  try {
    return ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
  } catch {
    return ChromeUtils.import("resource://gre/modules/AddonManager.jsm").AddonManager;
  }
}

var echoUpdate = class extends ExtensionCommonRef.ExtensionAPI {
  getAPI() {
    return {
      echoUpdate: {
        async installFromUrl(url, hash) {
          const cleanUrl = String(url || "");
          if (!cleanUrl.startsWith(ALLOWED_PREFIX) || !/\.xpi$/i.test(cleanUrl)) {
            return { ok: false, error: "Ссылка на обновление не относится к официальной странице EchoAI." };
          }
          const cleanHash = String(hash || "");
          if (!/^sha256:[0-9a-f]{64}$/i.test(cleanHash)) {
            return { ok: false, error: "В описании обновления нет корректной контрольной суммы sha256." };
          }

          try {
            const AddonManager = loadAddonManager();
            const install = await AddonManager.getInstallForURL(cleanUrl, {
              hash: cleanHash.toLowerCase(),
              telemetryInfo: { source: "extension" }
            });

            const done = new Promise((resolve, reject) => {
              install.addListener({
                onDownloadFailed: () => reject(new Error("Не удалось скачать файл обновления.")),
                onInstallFailed: () => reject(new Error("Betterbird не смог установить обновление.")),
                onInstallCancelled: () => reject(new Error("Установка обновления отменена.")),
                onInstallEnded: (_install, addon) => resolve(addon)
              });
            });

            // Сбрасываем кэш скриптов, чтобы Experiment API новой версии подхватились без сюрпризов
            try {
              ServicesRef.obs.notifyObservers(null, "startupcache-invalidate");
            } catch { /* ignore */ }

            install.install();
            const addon = await done;
            return { ok: true, version: addon?.version || "" };
          } catch (err) {
            return { ok: false, error: err?.message || String(err) };
          }
        }
      }
    };
  }
};
