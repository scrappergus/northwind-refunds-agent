"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cleanForSpeech, Recorder, Speaker } from "@/lib/speech";

interface Persona {
  id: string;
  name: string;
  email: string;
  loyalty_tier: string;
  orders: { id: string; status: string }[];
}

interface ChatMsg {
  kind: "user" | "agent";
  text: string;
}

// Customer-facing labels for the activity indicator — raw tool names
// stay in the admin trace, not the chat.
const ACTIVITY_LABELS: Record<string, string> = {
  thinking: "thinking…",
  lookup_customer: "looking up your account…",
  get_order: "pulling up your order…",
  check_refund_eligibility: "checking the refund policy…",
  process_refund: "processing your refund…",
  deny_refund: "finalizing the decision…",
  escalate_to_human: "looping in a human teammate…",
};

const SUGGESTIONS = [
  "I'd like a refund on my last order.",
  "My order arrived damaged.",
  "Can you refund me to a different card?",
];

// Minimal typings for the Web Speech API (not in TS's DOM lib).
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// Keyless-dev fallback voice (window.speechSynthesis); the real path speaks
// through /api/speech via the Speaker queue.
function speak(text: string) {
  const clean = cleanForSpeech(text);
  if (!clean || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

export default function ChatPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [transcript, setTranscript] = useState<ChatMsg[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // True when the server has an ElevenLabs key: mic + voice go through
  // /api/transcribe and /api/speech (any browser). False → Web Speech
  // fallback so keyless local dev keeps a voice mode in Chrome.
  const [serverVoice, setServerVoice] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const recordCapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    speakerRef.current = new Speaker();
    recorderRef.current = new Recorder();
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => {
        setPersonas(d.customers ?? []);
        const voice = Boolean(d.voice);
        setServerVoice(voice);
        setMicSupported(voice ? Recorder.supported() : Boolean(getRecognitionCtor()));
      })
      .catch(() => setPersonas([]));
    return () => {
      recognitionRef.current?.abort();
      recorderRef.current?.abort();
      speakerRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript, activity]);

  function pick(p: Persona) {
    setPersona(p);
    setConversationId(
      `conv_${p.id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    );
    setTranscript([
      {
        kind: "agent",
        text: `Hi ${p.name.split(" ")[0]} — welcome to the Northwind returns desk. What can I help you with today?`,
      },
    ]);
    setHistory([]);
  }

  function backToPicker() {
    recognitionRef.current?.abort();
    recorderRef.current?.abort();
    speakerRef.current?.stop();
    if (recordCapRef.current) clearTimeout(recordCapRef.current);
    setListening(false);
    window.speechSynthesis?.cancel();
    setPersona(null);
    setTranscript([]);
    setHistory([]);
    setInput("");
    setActivity(null);
  }

  // `voice: true` marks a turn that came in through the mic: the agent's reply
  // segments are then spoken aloud as each one completes (segments queue up
  // in the Speaker, so "Let me check…" plays while tools run).
  async function send(text: string, voice = false) {
    if (!persona || busy || !text.trim()) return;
    const userMessage = text.trim();
    setInput("");
    setBusy(true);
    setTranscript((t) => [...t, { kind: "user", text: userMessage }]);

    let agentText = "";
    let lastSpoken = "";
    const flushSpeech = () => {
      if (!voice) return;
      const segment = agentText.trim();
      if (segment && segment !== lastSpoken) {
        if (serverVoice) speakerRef.current?.enqueue(segment);
        else speak(segment);
        lastSpoken = segment;
      }
    };
    const appendAgent = (delta: string) => {
      agentText += delta;
      setTranscript((t) => {
        const copy = [...t];
        const last = copy[copy.length - 1];
        if (last?.kind === "agent" && copy.length > 0 && agentText.startsWith(last.text)) {
          copy[copy.length - 1] = { kind: "agent", text: agentText };
          return copy;
        }
        return [...copy, { kind: "agent", text: agentText }];
      });
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: history,
          userMessage,
          customerEmail: persona.email,
        }),
      });
      if (res.status === 429) {
        throw new Error("You're sending messages quickly — please wait a moment and try again.");
      }
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let started = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === "delta") {
            if (!started) {
              started = true;
              setActivity(null);
              setTranscript((t) => [...t, { kind: "agent", text: "" }]);
              agentText = "";
            }
            appendAgent(msg.text);
          } else if (msg.type === "trace") {
            if (msg.event === "tool_call") {
              flushSpeech(); // current reply segment is complete — say it
              setActivity(String(msg.data.tool));
              started = false; // next deltas begin a fresh agent bubble
            } else if (msg.event === "thinking") {
              flushSpeech();
              setActivity("thinking");
              started = false;
            }
          } else if (msg.type === "done") {
            setHistory(msg.messages);
          } else if (msg.type === "error") {
            appendAgent(`\n\n[Something went wrong: ${msg.message}]`);
          }
        }
      }
    } catch (err) {
      setTranscript((t) => [
        ...t,
        {
          kind: "agent",
          text: `[Connection error: ${err instanceof Error ? err.message : err}]`,
        },
      ]);
    } finally {
      flushSpeech();
      setActivity(null);
      setBusy(false);
    }
  }

  // Server voice: tap to record, tap again to send. The recording goes to
  // /api/transcribe and the text enters the normal send() path as a voice turn.
  async function finishRecording() {
    if (recordCapRef.current) clearTimeout(recordCapRef.current);
    setListening(false);
    const blob = await recorderRef.current?.stop();
    if (!blob) return;
    setTranscribing(true);
    try {
      const form = new FormData();
      form.append("audio", blob, blob.type.includes("mp4") ? "say.mp4" : "say.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const text = res.ok ? ((await res.json()).text as string) : "";
      if (text) {
        void send(text, true);
      } else {
        setTranscript((t) => [
          ...t,
          { kind: "agent", text: "[I couldn't make that out — mind trying again?]" },
        ]);
      }
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleRecorder() {
    if (listening) {
      void finishRecording();
      return;
    }
    const speaker = speakerRef.current;
    speaker?.unlock(); // inside the tap gesture, so Safari allows playback later
    speaker?.stop(); // don't record our own voice
    try {
      // Auto-send once the speaker pauses; finishRecording is idempotent,
      // so a tap racing the silence detector is harmless.
      await recorderRef.current?.start(() => void finishRecording());
    } catch {
      return; // mic permission denied
    }
    setListening(true);
    // Backstop against silence detection never firing — auto-send after 60s.
    recordCapRef.current = setTimeout(() => void finishRecording(), 60_000);
  }

  function toggleMic() {
    if (serverVoice) {
      void toggleRecorder();
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = getRecognitionCtor();
    if (!Recognition) return;
    window.speechSynthesis?.cancel(); // don't transcribe our own voice

    const rec = new Recognition();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let transcribed = "";
      let isFinal = false;
      for (let i = 0; i < e.results.length; i++) {
        transcribed += e.results[i][0].transcript;
        if (e.results[i].isFinal) isFinal = true;
      }
      if (isFinal) {
        setInput("");
        rec.stop();
        send(transcribed, true);
      } else {
        setInput(transcribed);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="wordmark">
          Northwind Outfitters
          <small>Returns desk</small>
        </div>
        <div className="header-links">
          {persona && (
            <button type="button" className="back-link" onClick={backToPicker} disabled={busy}>
              ← Customers
            </button>
          )}
          {persona && <span className="persona-chip">{persona.email}</span>}
          <Link href="/admin">Agent console →</Link>
        </div>
      </header>

      {!persona ? (
        <section className="picker">
          <h1>Refunds, decided by the book.</h1>
          <p className="lede">
            This demo store is staffed by an AI support agent that grounds every refund decision in
            a strict written policy. Pick a customer to chat as — each one exercises a different
            corner of the policy.
          </p>
          <div className="persona-grid">
            {personas.map((p) => (
              <button key={p.id} className="persona-card" onClick={() => pick(p)}>
                <div className="p-name">{p.name}</div>
                <div className="p-email">{p.email}</div>
                <div className="p-meta">
                  {p.loyalty_tier !== "none" && (
                    <span className={`tier ${p.loyalty_tier}`}>{p.loyalty_tier}</span>
                  )}
                  <span>
                    {p.orders.length} order{p.orders.length === 1 ? "" : "s"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          <main className="transcript">
            {transcript.map((m, i) =>
              m.kind === "user" ? (
                <div key={i} className="msg user">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="msg agent">
                  <div className="agent-mark">N</div>
                  <div>{m.text || "…"}</div>
                </div>
              ),
            )}
            {activity && (
              <div className="activity">
                <span className="dot" />
                {ACTIVITY_LABELS[activity] ?? "working on it…"}
              </div>
            )}
            <div ref={endRef} />
          </main>

          <div className="composer">
            {transcript.length <= 1 && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // Mid-recording, Send means "I'm done talking" — same path
                // as the silence detector and the mic tap.
                if (serverVoice && listening) void finishRecording();
                else send(input);
              }}
            >
              {micSupported && (
                <button
                  type="button"
                  className={`mic-btn ${listening ? "listening" : ""} ${transcribing ? "transcribing" : ""}`}
                  onClick={toggleMic}
                  disabled={busy || transcribing}
                  aria-label={listening ? "Stop and send" : "Speak your message"}
                  title={
                    listening
                      ? serverVoice
                        ? "Stop and send"
                        : "Stop listening"
                      : "Speak your message — the agent's reply is read aloud"
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <rect x="6" y="1.5" width="4" height="8" rx="2" />
                    <path
                      d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  listening
                    ? serverVoice
                      ? "Listening — click Done when you're finished (or just pause)…"
                      : "Listening…"
                    : transcribing
                      ? "Transcribing…"
                      : "Write a message…"
                }
                disabled={busy || listening || transcribing}
                autoFocus
              />
              <button
                type="submit"
                disabled={
                  busy || transcribing || (listening ? !serverVoice : !input.trim())
                }
              >
                {serverVoice && listening ? "Done" : "Send"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
