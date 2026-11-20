/* global ExtensionCommon, Services, Cc, Ci */
"use strict";

/**
 * Thunderbird / Betterbird Experiment API: echoMic
 *
 * В Thunderbird/Betterbird отсутствует браузерный диалог WebRTC (webrtcUI.sys.mjs),
 * из-за чего вызов getUserMedia() в расширениях зависает навечно.
 *
 * Этот модуль регистрирует обработчик getUserMedia:request СТРОГО для собственного
 * origin расширения EchoAI (moz-extension://<uuid>/), показывает нативный диалог
 * подтверждения пользователю и сохраняет его выбор в Services.perms только для EchoAI.
 * Глобальные настройки безопасности клиента НЕ изменяются.
 */

function extractDevicesList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  const list = [];
  if (typeof raw.length === "number" && typeof raw.queryElementAt === "function") {
    for (let i = 0; i < raw.length; i++) {
      try {
        list.push(raw.queryElementAt(i, Ci.nsIMediaDevice));
      } catch {
        // ignore
      }
    }
    return list;
  }

  if (typeof raw.enumerate === "function") {
    const en = raw.enumerate();
    while (en.hasMoreElements()) {
      try {
        list.push(en.getNext().QueryInterface(Ci.nsIMediaDevice));
      } catch {
        // ignore
      }
    }
    return list;
  }

  try {
    return Array.from(raw);
  } catch {
    return [];
  }
}

var echoMic = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    this._extOrigin = this.extension.baseURI.spec;
    this._observerRegistered = false;

    this._observer = {
      observe: (subject, topic) => {
        if (topic !== "getUserMedia:request") return;
        this._handleMediaRequest(subject);
      }
    };

    try {
      Services.obs.addObserver(this._observer, "getUserMedia:request");
      this._observerRegistered = true;
    } catch (err) {
      console.error("[EchoAI echoMic] Failed to register getUserMedia observer:", err);
    }
  }

  onShutdown() {
    if (this._observerRegistered && this._observer) {
      try {
        Services.obs.removeObserver(this._observer, "getUserMedia:request");
      } catch {
        // ignore
      }
      this._observerRegistered = false;
    }
  }

  _getExtensionPrincipal() {
    const uri = Services.io.newURI(this._extOrigin);
    return Services.scriptSecurityManager.createContentPrincipal(uri, {});
  }

  _resolveRequestWindow(req) {
    let win = null;
    try {
      if (req.innerWindowID) {
        win = Services.wm.getCurrentInnerWindowWithId(req.innerWindowID);
      }
    } catch { /* ignore */ }

    if (!win) {
      try {
        if (req.windowID) {
          win = Services.wm.getCurrentInnerWindowWithId(req.windowID) ||
                Services.wm.getOuterWindowWithId(req.windowID);
        }
      } catch { /* ignore */ }
    }

    return win;
  }

  _handleMediaRequest(subject) {
    const req = subject?.wrappedJSObject || subject;
    if (!req || !req.callID) return;

    const win = this._resolveRequestWindow(req);
    const docUri = win?.document?.documentURI || "";

    // Строгая изоляция: обрабатываем ТОЛЬКО запросы от страниц самого EchoAI
    if (!docUri.startsWith(this._extOrigin)) {
      return;
    }

    const callID = req.callID;
    let constraints = {};
    try {
      constraints = req.getConstraints ? req.getConstraints() : {};
    } catch {
      constraints = { audio: true };
    }

    // EchoAI использует только микрофон (без камеры)
    if (!constraints.audio || constraints.video) {
      Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
      return;
    }

    const principal = win.document.nodePrincipal || this._getExtensionPrincipal();
    let perm = Services.perms.testExactPermissionFromPrincipal(principal, "microphone");

    if (perm === Services.perms.DENY_ACTION) {
      Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
      return;
    }

    if (perm !== Services.perms.ALLOW_ACTION) {
      const rememberCheck = { value: true };
      let parentWin = null;
      try {
        parentWin = win.browsingContext?.topChromeWindow || win.top || null;
      } catch {
        parentWin = null;
      }

      const approved = Services.prompt.confirmCheck(
        parentWin,
        "EchoAI — доступ к микрофону",
        "Разрешить расширению EchoAI использовать микрофон для голосовых заметок?",
        "Запомнить выбор для EchoAI",
        rememberCheck
      );

      if (!approved) {
        if (rememberCheck.value) {
          Services.perms.addFromPrincipal(principal, "microphone", Services.perms.DENY_ACTION);
        }
        Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
        return;
      }

      if (rememberCheck.value) {
        Services.perms.addFromPrincipal(principal, "microphone", Services.perms.ALLOW_ACTION);
      }
    }

    // Выбираем доступное аудиоустройство (микрофон)
    let devices = [];
    try {
      devices = extractDevicesList(req.getDevices ? req.getDevices() : []);
    } catch (err) {
      console.error("[EchoAI echoMic] getDevices() error:", err);
    }

    const audioDevice = devices.find((d) => {
      const t = String(d?.type || "").toLowerCase();
      return t === "audioinput" || t === "audio";
    });

    if (!audioDevice) {
      Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
      return;
    }

    const allowed = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    allowed.appendElement(audioDevice);
    Services.obs.notifyObservers(allowed, "getUserMedia:response:allow", callID);
  }

  getAPI() {
    const self = this;
    return {
      echoMic: {
        async getPermissionStatus() {
          try {
            const principal = self._getExtensionPrincipal();
            const perm = Services.perms.testExactPermissionFromPrincipal(principal, "microphone");
            let state = "prompt";
            if (perm === Services.perms.ALLOW_ACTION) state = "allow";
            else if (perm === Services.perms.DENY_ACTION) state = "deny";
            return {
              state,
              observerActive: Boolean(self._observerRegistered)
            };
          } catch (err) {
            return {
              state: "prompt",
              observerActive: Boolean(self._observerRegistered),
              error: String(err)
            };
          }
        },

        async resetPermission() {
          try {
            const principal = self._getExtensionPrincipal();
            Services.perms.removeFromPrincipal(principal, "microphone");
            return { ok: true };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        }
      }
    };
  }
};
