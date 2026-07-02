"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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

const SUGGESTIONS = [
  "I'd like a refund on my last order.",
  "My order arrived damaged.",
  "Can you refund me to a different card?",
];

export default function ChatPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [transcript, setTranscript] = useState<ChatMsg[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => setPersonas(d.customers ?? []))
      .catch(() => setPersonas([]));
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

  async function send(text: string) {
    if (!persona || busy || !text.trim()) return;
    const userMessage = text.trim();
    setInput("");
    setBusy(true);
    setTranscript((t) => [...t, { kind: "user", text: userMessage }]);

    let agentText = "";
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
              setActivity(String(msg.data.tool));
              started = false; // next deltas begin a fresh agent bubble
            } else if (msg.event === "thinking") {
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
        { kind: "agent", text: `[Connection error: ${err instanceof Error ? err.message : err}]` },
      ]);
    } finally {
      setActivity(null);
      setBusy(false);
    }
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div className="wordmark">
          Northwind Outfitters
          <small>Returns desk</small>
        </div>
        <div className="header-links">
          {persona && <span className="persona-chip">{persona.email}</span>}
          <Link href="/admin">Agent console →</Link>
        </div>
      </header>

      {!persona ? (
        <section className="picker">
          <h1>Refunds, decided by the book.</h1>
          <p className="lede">
            This demo store is staffed by an AI support agent that grounds every refund
            decision in a strict written policy. Pick a customer to chat as — each one
            exercises a different corner of the policy.
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
                {activity === "thinking" ? "thinking…" : `running ${activity}…`}
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
                send(input);
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Write a message…"
                disabled={busy}
                autoFocus
              />
              <button type="submit" disabled={busy || !input.trim()}>
                Send
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
