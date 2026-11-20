/* global ChromeUtils, Components */
"use strict";

/**
 * Thunderbird / Betterbird Experiment API (addon_child): echoMicChild
 *
 * Работает В ТОМ ЖЕ процессе, где открыто окно EchoAI (assistant.html / options.html).
 * Ловит getUserMedia:request строго для текущего окна EchoAI после явного подтверждения
 * пользователя и мгновенно отвечает getUserMedia:response:allow с аудиоустройством.
 */

var ExtensionCommonRef =
  globalThis.ExtensionCommon ||
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;

var ServicesRef =
  globalThis.Services ||
  ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;

var CcRef = globalThis.Cc || Components.classes;
var CiRef = globalThis.Ci || Components.interfaces;

function extractDevicesList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  const list = [];
  if (typeof raw.length === "number" && typeof raw.queryElementAt === "function") {
    for (let i = 0; i < raw.length; i++) {
      try {
        list.push(raw.queryElementAt(i, CiRef.nsIMediaDevice));
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
        list.push(en.getNext().QueryInterface(CiRef.nsIMediaDevice));
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

var echoMicChild = class extends ExtensionCommonRef.ExtensionAPI {
  getAPI(context) {
    let armedUntil = 0;
    let targetOrigin = "";
    let lastDiag = { events: 0, matched: false, devicesCount: 0, error: null };
    const handledCalls = new Set();

    const getMyInnerWindowId = () => {
      try {
        const win = context.contentWindow;
        if (!win) return null;
        return (
          win.windowGlobalChild?.innerWindowId ??
          win.windowUtils?.currentInnerWindowID ??
          null
        );
      } catch {
        return null;
      }
    };

    const observer = {
      observe(subject, topic) {
        if (topic !== "getUserMedia:request") return;
        if (Date.now() > armedUntil) return;

        lastDiag.events += 1;
        const req = subject?.wrappedJSObject || subject;
        if (!req || !req.callID) return;
        if (handledCalls.has(req.callID)) return;

        const myWinId = getMyInnerWindowId();
        const reqWinId = req.innerWindowID;

        if (myWinId != null && reqWinId != null && Number(myWinId) !== Number(reqWinId)) {
          return;
        }

        if (myWinId == null && targetOrigin) {
          try {
            const win = ServicesRef.wm?.getCurrentInnerWindowWithId?.(reqWinId);
            const docUri = win?.document?.documentURI || "";
            if (!docUri.startsWith(targetOrigin)) return;
          } catch {
            // если wm недоступен в child, полагаемся на armedUntil + constraints
          }
        }

        let constraints = {};
        try {
          constraints = req.getConstraints ? req.getConstraints() : {};
        } catch {
          constraints = { audio: true };
        }
        if (!constraints.audio || constraints.video) return;

        handledCalls.add(req.callID);
        lastDiag.matched = true;

        try {
          const devices = extractDevicesList(req.getDevices ? req.getDevices() : []);
          lastDiag.devicesCount = devices.length;

          const audioDevice = devices.find((d) => {
            const t = String(d?.type || "").toLowerCase();
            return t === "audioinput" || t === "audio";
          });

          if (!audioDevice) {
            lastDiag.error = "Не найдено устройство ввода звука (audioinput)";
            return;
          }

          const allowed = CcRef["@mozilla.org/array;1"].createInstance(CiRef.nsIMutableArray);
          allowed.appendElement(audioDevice);
          ServicesRef.obs.notifyObservers(allowed, "getUserMedia:response:allow", req.callID);
        } catch (err) {
          lastDiag.error = String(err);
        }
      }
    };

    let registered = false;
    const ensureRegistered = () => {
      if (registered) return;
      ServicesRef.obs.addObserver(observer, "getUserMedia:request");
      registered = true;
    };

    const cleanup = () => {
      armedUntil = 0;
      if (registered) {
        try {
          ServicesRef.obs.removeObserver(observer, "getUserMedia:request");
        } catch { /* ignore */ }
        registered = false;
      }
    };

    context.callOnClose({ close: cleanup });

    return {
      echoMicChild: {
        async armCapture(originHint) {
          try {
            ensureRegistered();
            targetOrigin =
              originHint ||
              context.contentWindow?.location?.origin ||
              "";
            lastDiag = { events: 0, matched: false, devicesCount: 0, error: null };
            armedUntil = Date.now() + 8000;
            return { ok: true, myWinId: getMyInnerWindowId() };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        },

        async disarmCapture() {
          armedUntil = 0;
          return { ok: true };
        },

        async getDiagnostics() {
          return { ...lastDiag, registered };
        }
      }
    };
  }
};
