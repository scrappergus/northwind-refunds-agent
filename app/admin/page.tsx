"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

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

export default function AdminPage() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [refunds, setRefunds] = useState<RefundRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [convFilter, setConvFilter] = useState("all");
  const [follow, setFollow] = useState(true);
  const [chaosArmed, setChaosArmed] = useState(false);
  // Deployed with DEMO_ADMIN_TOKEN, this page is opened as /admin?token=…
  const [token] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("token") ?? ""),
  );
  const [authorized, setAuthorized] = useState(true);
  const traceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";

    const refreshLedger = () =>
      fetch(`/api/state${qs}`)
        .then((r) => r.json())
        .then((d) => {
          setRefunds(d.refunds ?? []);
          setAuthorized(d.admin !== false);
        })
        .catch(() => undefined);
    refreshLedger();

    const es = new EventSource(`/api/logs${qs}`);
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
  }, [token]);

  useEffect(() => {
    if (follow && traceRef.current) {
      traceRef.current.scrollTop = traceRef.current.scrollHeight;
    }
  }, [events, follow]);

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
        <div className="auth-banner">
          This deployment protects the console with an admin token. Open this page as
          <code> /admin?token=&lt;DEMO_ADMIN_TOKEN&gt;</code> to see the trace and ledger.
        </div>
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
              <div key={r.id} className="ledger-card">
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
              </div>
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
                fetch("/api/chaos", {
                  method: "POST",
                  headers: token ? { "x-admin-token": token } : undefined,
                }).then((r) => r.ok && setChaosArmed(true))
              }
            >
              {chaosArmed ? "⚡ outage armed — next tool call fails" : "⚡ simulate CRM outage"}
            </button>
          </div>

          <div className="trace" ref={traceRef}>
            {visible.length === 0 && (
              <div className="empty" style={{ padding: "14px 16px" }}>
                Waiting for agent activity. Events stream here in real time: model
                reasoning, tool calls with inputs and outputs, retries, failures, and
                final decisions.
              </div>
            )}
            {visible.map((e) => {
              const s = summarize(e);
              return (
                <div key={e.id} className={`tr ${e.type}`}>
                  <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="tag">{TAGS[e.type] ?? e.type}</span>
                  <div className="body">
                    {convFilter === "all" && (
                      <span className="convo">{e.conversationId.slice(0, 16)}</span>
                    )}
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
            })}
          </div>
        </main>
      </div>
    </div>
  );
}
