/**
 * Запись с микрофона и локальное кодирование в WAV (PCM 16-bit, 16 kHz, mono)
 * для прямой отправки в мультимодальную LLM (input_audio) без отдельных STT-сервисов.
 */

const TARGET_SAMPLE_RATE = 16000;

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (outputRate >= inputRate) {
    return buffer;
  }
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function encodeWavPcm16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

export const MIC_TIMEOUT_CODE = "MIC_PROMPT_TIMEOUT";

export async function requestMicrophoneStream(timeoutMs = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("В этом окне недоступен API микрофона (mediaDevices).");
  }

  // Гарантируем, что встроенный обработчик диалога микрофона EchoAI активен до вызова getUserMedia
  let helperActive = false;
  try {
    if (browser?.echoMic?.getPermissionStatus) {
      const st = await browser.echoMic.getPermissionStatus();
      helperActive = Boolean(st?.observerActive);
    }
  } catch {
    helperActive = false;
  }

  // Если нативный диалог активен, даём пользователю достаточно времени нажать «OK»
  const effectiveTimeout = timeoutMs ?? (helperActive ? 35000 : 4500);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(
        "Не удалось получить отклик от микрофона вовремя. Попробуйте ещё раз или проверьте настройки микрофона в Windows и EchoAI."
      );
      err.code = MIC_TIMEOUT_CODE;
      reject(err);
    }, effectiveTimeout);

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      .catch((err) => {
        if (err?.name === "OverconstrainedError") {
          return navigator.mediaDevices.getUserMedia({ audio: true });
        }
        throw err;
      })
      .then((stream) => {
        clearTimeout(timer);
        if (settled) {
          for (const t of stream.getTracks()) {
            try { t.stop(); } catch { /* ignore */ }
          }
          return;
        }
        settled = true;
        resolve(stream);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });
  });
}

export class WavAudioRecorder {
  constructor({ onLevel, onTick } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.stream = null;
    this.audioCtx = null;
    this.source = null;
    this.processor = null;
    this.chunks = [];
    this.sampleRate = 48000;
    this.startedAt = 0;
    this.tickTimer = null;
    this.recording = false;
  }

  async start() {
    if (this.recording) return;
    this.stream = await requestMicrophoneStream();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
    this.sampleRate = this.audioCtx.sampleRate || 48000;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    this.chunks = [];
    this.recording = true;
    this.startedAt = Date.now();

    this.processor.onaudioprocess = (event) => {
      if (!this.recording) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));

      if (this.onLevel) {
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        this.onLevel(Math.min(1, rms * 5.5));
      }
    };

    // Подключаем через нулевой Gain, чтобы не было слышно эха микрофона в колонках
    const silentGain = this.audioCtx.createGain();
    silentGain.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.audioCtx.destination);

    if (this.onTick) {
      this.tickTimer = setInterval(() => {
        const sec = Math.floor((Date.now() - this.startedAt) / 1000);
        this.onTick(sec);
      }, 250);
    }
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    const durationSec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    this._cleanup();

    const totalLen = this.chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLen === 0) return null;

    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const resampled = downsampleBuffer(merged, this.sampleRate, TARGET_SAMPLE_RATE);
    const wavBuffer = encodeWavPcm16(resampled, TARGET_SAMPLE_RATE);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const base64 = arrayBufferToBase64(wavBuffer);
    const objectUrl = URL.createObjectURL(blob);

    this.chunks = [];
    return {
      blob,
      base64,
      format: "wav",
      durationSec,
      sizeBytes: wavBuffer.byteLength,
      objectUrl
    };
  }

  cancel() {
    this.recording = false;
    this.chunks = [];
    this._cleanup();
  }

  _cleanup() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    this.processor = null;
    this.source = null;
    this.audioCtx = null;
    this.stream = null;
  }
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
