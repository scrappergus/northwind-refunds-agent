// Client-side voice plumbing for the chat page: a sequential player for
// /api/speech audio and a MediaRecorder wrapper for /api/transcribe. Both
// are plain browser APIs, so voice works in Safari/Firefox/Chrome alike —
// the Web Speech API remains only as the keyless-dev fallback in page.tsx.

// Strip markdown/emoji so the synthesized voice doesn't read "asterisk asterisk".
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_`#]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .trim();
}

// Shortest valid silent WAV; played once inside the mic-tap gesture so
// Safari/iOS treat later programmatic playback on the same element as
// user-initiated.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

// Plays reply segments through one shared <audio> element. Segments are
// fetched the moment they're enqueued (synthesis overlaps playback) but
// always play in order.
export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private queue: Promise<string | null>[] = [];
  private draining = false;
  private stopped = false;
  private finishCurrent: (() => void) | null = null;

  // Call from a user gesture (the mic tap) before any playback.
  unlock() {
    if (this.audio) return;
    this.audio = new Audio(SILENT_WAV);
    this.audio.play().catch(() => undefined);
  }

  enqueue(text: string) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    this.stopped = false;
    this.queue.push(
      fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : null))
        .catch(() => null),
    );
    void this.drain();
  }

  // Cut playback and drop anything queued (mic opening, leaving the chat).
  stop() {
    this.stopped = true;
    this.audio?.pause();
    this.finishCurrent?.();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length) {
      const url = await this.queue.shift()!;
      if (!url) continue;
      if (!this.stopped) await this.play(url);
      URL.revokeObjectURL(url);
    }
    this.draining = false;
  }

  private play(url: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = this.audio ?? (this.audio = new Audio());
      const finish = () => {
        this.finishCurrent = null;
        audio.onended = null;
        audio.onerror = null;
        resolve();
      };
      this.finishCurrent = finish;
      audio.src = url;
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });
  }
}

// How long a post-speech pause counts as "done talking", and the level a
// frame must clear to count as speech (byte-RMS, adapted to the room's
// noise floor during the first ~half second).
const SILENCE_MS = 1400;
const MIN_SPEECH_RMS = 0.04;

// Mic capture for /api/transcribe. MediaRecorder emits webm/opus in
// Chrome/Firefox and mp4/aac in Safari; ElevenLabs accepts both.
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioCtx: AudioContext | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;

  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined"
    );
  }

  // Throws if the user denies the mic permission prompt. When onSilence is
  // given, the recorder watches the mic level and calls it once the speaker
  // has said something and then paused — hands-free end-of-turn.
  async start(onSilence?: () => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    if (onSilence) this.watchSilence(stream, onSilence);
  }

  // Level meter on the live stream (getByteTimeDomainData for Safari
  // compatibility). Never fires before speech is heard, so a slow start
  // doesn't cut the mic — the caller's hard cap covers never-speaking.
  private watchSilence(stream: MediaStream, onSilence: () => void) {
    if (typeof AudioContext === "undefined") return; // cap still applies
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    let threshold = MIN_SPEECH_RMS;
    let calibrationTicks = 6; // ~0.5s of ambient level → noise floor
    let heardSpeech = false;
    let lastSpokeAt = performance.now();

    this.vadTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Adapt the threshold to a noisy room, but only from frames that are
      // plausibly ambience: someone who starts talking the instant they tap
      // the mic must not have their own voice calibrated in as "noise" (that
      // pins the threshold above their speech and the detector never fires).
      if (calibrationTicks > 0 && rms < MIN_SPEECH_RMS) {
        calibrationTicks--;
        threshold = Math.max(threshold, Math.min(rms * 2.5, 0.12));
      }
      const now = performance.now();
      if (rms > threshold) {
        heardSpeech = true;
        lastSpokeAt = now;
      }
      if (heardSpeech && now - lastSpokeAt >= SILENCE_MS) {
        onSilence(); // the caller's stop() tears this timer down
      }
    }, 80);
  }

  private stopWatching() {
    if (this.vadTimer) clearInterval(this.vadTimer);
    this.vadTimer = null;
    this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  // Resolves with the finished recording, or null if nothing was captured.
  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      this.stopWatching();
      const rec = this.recorder;
      this.recorder = null;
      if (!rec || rec.state === "inactive") return resolve(null);
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        resolve(this.chunks.length ? new Blob(this.chunks, { type }) : null);
      };
      rec.stop();
    });
  }

  // Discard without transcribing (leaving the chat mid-recording).
  abort() {
    this.stopWatching();
    const rec = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
    }
    rec?.stream.getTracks().forEach((t) => t.stop());
  }
}
