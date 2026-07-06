"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";

interface AgentEvent {
  id: number;
  conversationId: string;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

interface RefundRecord {
  id: string;
  customerName: string;
  orderId: string;
  outcome: "refunded" | "denied" | "escalated";
  amount: number | null;
  rules: string[];
  reason: string;
  at: string;
}

const TAGS: Record<string, string> = {
  turn_start: "turn ▸",
  turn_end: "turn ■",
  thinking: "thinking",
  assistant_text: "assistant",
  tool_call: "tool ▸",
  tool_result: "tool ✓",
  tool_error: "tool ✗",
  retry: "retry",
  decision: "decision",
  agent_error: "error",
};

function summarize(e: AgentEvent): { text: string; detail?: unknown } {
  const d = e.data;
  switch (e.type) {
    case "turn_start":
      return { text: `model=${d.model} history=${d.messages} msgs` };
    case "turn_end":
      return { text: `stop_reason=${d.stop_reason}`, detail: d.usage };
    case "thinking":
    case "assistant_text":
      return { text: String(d.text ?? "") };
    case "tool_call":
      return { text: String(d.tool), detail: d.input };
    case "tool_result":
      return { text: String(d.tool), detail: d.result };
    case "tool_error":
      return { text: `${d.tool}: ${d.error}`, detail: d.input };
    case "retry":
      return { text: `attempt ${d.attempt}/${d.of} — backoff ${d.backoff_ms}ms · ${d.error}` };
    case "decision":
      return { text: String(d.tool).replace(/_/g, " "), detail: { input: d.input, result: d.result } };
    case "agent_error":
      return { text: String(d.message) };
    default:
      return { text: JSON.stringify(d) };
  }
}

// Memoized row: without this, every SSE event re-renders every visible row
// (including a per-row toLocaleTimeString(), which is slow in Firefox) and
// scrolling during an active conversation stutters.
const TraceRow = memo(function TraceRow({
  e,
  showConvo,
}: {
  e: AgentEvent;
  showConvo: boolean;
}) {
  const s = summarize(e);
  return (
    <div className={`tr ${e.type}`}>
      <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
      <span className="tag">{TAGS[e.type] ?? e.type}</span>
      <div className="body">
        {showConvo && <span className="convo">{e.conversationId.slice(0, 16)}</span>}
        {s.text}
        {s.detail !== undefined && (
          <details>
            <summary>payload</summary>
            <pre>{JSON.stringify(s.detail, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
});

export default function AdminPage() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [refunds, setRefunds] = useState<RefundRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [convFilter, setConvFilter] = useState("all");
  const [follow, setFollow] = useState(true);
  const [chaosArmed, setChaosArmed] = useState(false);
  const [authorized, setAuthorized] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  // Bumped after a successful unlock to reconnect the feeds with the cookie.
  const [session, setSession] = useState(0);
  const traceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refreshLedger = () =>
      fetch("/api/state")
        .then((r) => r.json())
        .then((d) => {
          setRefunds(d.refunds ?? []);
          setAuthorized(d.admin !== false);
        })
        .catch(() => undefined);
    refreshLedger();

    const es = new EventSource("/api/logs");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const frame = JSON.parse(m.data);
      if (frame.type === "history") {
        setEvents(frame.events);
      } else if (frame.type === "event") {
        setEvents((prev) => [...prev.slice(-1500), frame.event]);
        if (frame.event.type === "decision") refreshLedger();
        if (frame.event.type === "tool_error") setChaosArmed(false);
      }
    };
    return () => es.close();
  }, [session]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenInput }),
    }).catch(() => null);
    if (res?.ok) {
      setTokenInput("");
      setLoginError(false);
      setAuthorized(true);
      setSession((n) => n + 1); // reconnect /api/logs and refetch state with the cookie
    } else {
      setLoginError(true);
    }
  }

  useEffect(() => {
    if (follow && traceRef.current) {
      traceRef.current.scrollTop = traceRef.current.scrollHeight;
    }
  }, [events, follow, convFilter]);

  const conversations = useMemo(
    () => [...new Set(events.map((e) => e.conversationId))],
    [events],
  );
  const visible = useMemo(
    () => (convFilter === "all" ? events : events.filter((e) => e.conversationId === convFilter)),
    [events, convFilter],
  );
  const counts = useMemo(
    () => ({
      refunded: refunds.filter((r) => r.outcome === "refunded").length,
      denied: refunds.filter((r) => r.outcome === "denied").length,
      escalated: refunds.filter((r) => r.outcome === "escalated").length,
    }),
    [refunds],
  );

  return (
    <div className="console">
      <header className="console-header">
        <div className="wordmark">
          Northwind Outfitters
          <small>Agent operations</small>
        </div>
        <Link href="/">← Customer chat</Link>
      </header>

      {!authorized && (
        <form className="auth-banner" onSubmit={unlock}>
          <span>This deployment protects the console with an admin token.</span>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Admin token"
            autoFocus
          />
          <button type="submit" disabled={!tokenInput}>
            Unlock
          </button>
          {loginError && <span className="auth-error">That token didn&apos;t match.</span>}
        </form>
      )}

      <div className="console-body">
        <aside className="ledger">
          <h2>Decision ledger</h2>
          <div className="stat-row">
            <div className="stat ok">
              <div className="n">{counts.refunded}</div>
              <div className="l">Refunded</div>
            </div>
            <div className="stat deny">
              <div className="n">{counts.denied}</div>
              <div className="l">Denied</div>
            </div>
            <div className="stat esc">
              <div className="n">{counts.escalated}</div>
              <div className="l">Escalated</div>
            </div>
          </div>

          <div className="ledger-list">
            {refunds.length === 0 && (
              <div className="empty">
                No decisions yet. Open the customer chat and run a refund conversation —
                every processed, denied, or escalated case lands here.
              </div>
            )}
            {refunds.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`ledger-card ${convFilter === r.conversationId ? "active" : ""}`}
                title="Show this conversation in the trace (click again for all)"
                onClick={() =>
                  setConvFilter((f) => (f === r.conversationId ? "all" : r.conversationId))
                }
              >
                <div className="row1">
                  <span className="who">{r.customerName}</span>
                  <span className={`stamp ${r.outcome}`}>{r.outcome}</span>
                </div>
                <div className="row2">
                  <span>{r.orderId}</span>
                  {r.amount !== null && <span>${r.amount.toFixed(2)}</span>}
                  {r.rules.length > 0 && <span>{r.rules.join(" ")}</span>}
                  <span>{new Date(r.at).toLocaleTimeString()}</span>
                </div>
                {r.reason && <div className="reason">{r.reason}</div>}
              </button>
            ))}
          </div>
        </aside>

        <main className="trace-pane">
          <h2>Live reasoning trace</h2>
          <div className="trace-controls">
            <label>
              <span className={`live-dot ${connected ? "" : "off"}`} />
              {connected ? "live" : "reconnecting…"}
            </label>
            <select value={convFilter} onChange={(e) => setConvFilter(e.target.value)}>
              <option value="all">all conversations ({conversations.length})</option>
              {conversations.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              follow
            </label>
            <button
              className={`chaos-btn ${chaosArmed ? "armed" : ""}`}
              disabled={chaosArmed}
              title="Arm a one-shot simulated CRM outage: the next tool call fails so you can watch the agent hit the error and recover in the trace."
              onClick={() =>
                fetch("/api/chaos", { method: "POST" }).then((r) => r.ok && setChaosArmed(true))
              }
            >
              {chaosArmed ? "⚡ outage armed — next tool call fails" : "⚡ simulate CRM outage"}
            </button>
          </div>

          <div
            className="trace"
            ref={traceRef}
            onScroll={() => {
              // Scrolling up while events stream would otherwise fight the
              // follow-yank to the bottom; unfollow the moment the user
              // leaves the tail. (The follow effect's own scroll lands at
              // the bottom, so it never triggers this.)
              const el = traceRef.current;
              if (!el || !follow) return;
              const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (!nearBottom) setFollow(false);
            }}
          >
            {visible.length === 0 && (
              <div className="empty" style={{ padding: "14px 16px" }}>
                Waiting for agent activity. Events stream here in real time: model
                reasoning, tool calls with inputs and outputs, retries, failures, and
                final decisions.
              </div>
            )}
            {visible.map((e) => (
              <TraceRow key={e.id} e={e} showConvo={convFilter === "all"} />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
