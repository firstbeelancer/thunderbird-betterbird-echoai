/* global ChromeUtils, Components */
"use strict";

/**
 * Thunderbird / Betterbird Experiment API (addon_parent): echoMicParent
 *
 * Отвечает за:
 * 1) Нативный диалог подтверждения микрофона строго для EchoAI и хранение выбора в Services.perms.
 * 2) Кратковременный scoped-bypass только на время одного подтверждённого вызова getUserMedia(),
 *    если в конкретной сборке Betterbird IPC-слой WebRTC игнорирует ответ child-observer'а.
 *    Прежнее состояние настройки мгновенно восстанавливается в finally и на onShutdown.
 */

var ExtensionCommonRef =
  globalThis.ExtensionCommon ||
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;

var ServicesRef =
  globalThis.Services ||
  ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;

const MEDIA_PERM_PREF = "media.navigator.permission.disabled";

var echoMicParent = class extends ExtensionCommonRef.ExtensionAPI {
  onStartup() {
    this._bypassActive = false;
    this._prevHasUserValue = false;
    this._prevValue = false;
    this._safetyTimer = null;
  }

  onShutdown() {
    this._restoreCapturePref();
  }

  _getExtensionOrigin(originHint) {
    if (this.extension?.uuid) {
      return `moz-extension://${this.extension.uuid}/`;
    }
    if (this.extension?.baseURL && this.extension.baseURL.startsWith("moz-extension://")) {
      return this.extension.baseURL;
    }
    if (originHint && String(originHint).startsWith("moz-extension://")) {
      return originHint.endsWith("/") ? originHint : `${originHint}/`;
    }
    return this.extension?.baseURI?.spec || "moz-extension://echoai/";
  }

  _getExtensionPrincipal(originHint) {
    const uri = ServicesRef.io.newURI(this._getExtensionOrigin(originHint));
    return ServicesRef.scriptSecurityManager.createContentPrincipal(uri, {});
  }

  _getParentWindow() {
    try {
      return (
        ServicesRef.wm.getMostRecentWindow(null) ||
        ServicesRef.wm.getMostRecentWindow("mail:3pane") ||
        null
      );
    } catch {
      return null;
    }
  }

  _restoreCapturePref() {
    if (this._safetyTimer) {
      try {
        const timerRef = this._safetyTimer;
        this._safetyTimer = null;
        timerRef.cancel();
      } catch { /* ignore */ }
    }

    if (!this._bypassActive) return;
    this._bypassActive = false;

    try {
      if (this._prevHasUserValue) {
        ServicesRef.prefs.setBoolPref(MEDIA_PERM_PREF, this._prevValue);
      } else if (ServicesRef.prefs.prefHasUserValue(MEDIA_PERM_PREF)) {
        ServicesRef.prefs.clearUserPref(MEDIA_PERM_PREF);
      }
    } catch (err) {
      console.error("[EchoAI echoMicParent] Failed to restore pref:", err);
    }
  }

  getAPI() {
    const self = this;
    return {
      echoMicParent: {
        async getPermissionStatus(originHint) {
          try {
            const principal = self._getExtensionPrincipal(originHint);
            const perm = ServicesRef.perms.testExactPermissionFromPrincipal(principal, "microphone");
            let state = "prompt";
            if (perm === ServicesRef.perms.ALLOW_ACTION) state = "allow";
            else if (perm === ServicesRef.perms.DENY_ACTION) state = "deny";
            return { state, ok: true };
          } catch (err) {
            return { state: "prompt", ok: false, error: String(err) };
          }
        },

        async ensurePermission(originHint) {
          try {
            const principal = self._getExtensionPrincipal(originHint);
            const perm = ServicesRef.perms.testExactPermissionFromPrincipal(principal, "microphone");

            if (perm === ServicesRef.perms.ALLOW_ACTION) {
              return { allowed: true, state: "allow" };
            }
            if (perm === ServicesRef.perms.DENY_ACTION) {
              return { allowed: false, state: "deny" };
            }

            const rememberCheck = { value: true };
            const parentWin = self._getParentWindow();
            let approved = false;

            try {
              approved = ServicesRef.prompt.confirmCheck(
                parentWin,
                "EchoAI — доступ к микрофону",
                "Разрешить расширению EchoAI использовать микрофон для голосовых заметок?",
                "Запомнить выбор для EchoAI",
                rememberCheck
              );
            } catch {
              approved = ServicesRef.prompt.confirmCheck(
                null,
                "EchoAI — доступ к микрофону",
                "Разрешить расширению EchoAI использовать микрофон для голосовых заметок?",
                "Запомнить выбор для EchoAI",
                rememberCheck
              );
            }

            if (!approved) {
              if (rememberCheck.value) {
                ServicesRef.perms.addFromPrincipal(principal, "microphone", ServicesRef.perms.DENY_ACTION);
              }
              return { allowed: false, state: rememberCheck.value ? "deny" : "prompt" };
            }

            if (rememberCheck.value) {
              ServicesRef.perms.addFromPrincipal(principal, "microphone", ServicesRef.perms.ALLOW_ACTION);
            }
            return { allowed: true, state: rememberCheck.value ? "allow" : "once" };
          } catch (err) {
            return { allowed: false, state: "error", error: String(err) };
          }
        },

        async resetPermission(originHint) {
          try {
            const principal = self._getExtensionPrincipal(originHint);
            ServicesRef.perms.removeFromPrincipal(principal, "microphone");
            return { ok: true };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },

        async beginScopedCapture() {
          try {
            if (!self._bypassActive) {
              self._prevHasUserValue = ServicesRef.prefs.prefHasUserValue(MEDIA_PERM_PREF);
              self._prevValue = ServicesRef.prefs.getBoolPref(MEDIA_PERM_PREF, false);
              self._bypassActive = true;
            }

            ServicesRef.prefs.setBoolPref(MEDIA_PERM_PREF, true);

            // Гарантированный авто-откат на случай внезапного закрытия окна
            if (self._safetyTimer) {
              try { self._safetyTimer.cancel(); } catch { /* ignore */ }
            }
            const CcRef = globalThis.Cc || Components.classes;
            const CiRef = globalThis.Ci || Components.interfaces;
            const timer = CcRef["@mozilla.org/timer;1"].createInstance(CiRef.nsITimer);
            timer.initWithCallback(
              { notify: () => self._restoreCapturePref() },
              4000,
              CiRef.nsITimer.TYPE_ONE_SHOT
            );
            self._safetyTimer = timer;
            return { ok: true };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },

        async endScopedCapture() {
          self._restoreCapturePref();
          return { ok: true };
        }
      }
    };
  }
};
