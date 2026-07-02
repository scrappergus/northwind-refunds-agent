import fs from "fs";
import path from "path";
import type { AgentEvent, AgentEventType, Customer, RefundRecord } from "./types";

// All mutable state hangs off globalThis so it survives Next.js dev-mode HMR
// module reloads and is shared between the /api/chat and /api/logs routes.

interface Db {
  customers: Customer[];
  policy: string;
  refunds: RefundRecord[];
  events: AgentEvent[];
  nextEventId: number;
  subscribers: Set<(e: AgentEvent) => void>;
  // One-shot failure injection, armed from the admin console to demo the
  // tool_error → recovery path in the trace.
  chaosArmed: boolean;
}

const MAX_EVENTS = 2000;

function load(): Db {
  const dataDir = path.join(process.cwd(), "data");
  const customers = JSON.parse(
    fs.readFileSync(path.join(dataDir, "customers.json"), "utf-8"),
  ).customers as Customer[];
  const policy = fs.readFileSync(path.join(dataDir, "refund-policy.md"), "utf-8");
  return {
    customers,
    policy,
    refunds: [],
    events: [],
    nextEventId: 1,
    subscribers: new Set(),
    chaosArmed: false,
  };
}

const g = globalThis as unknown as { __agentDb?: Db };
export const db: Db = g.__agentDb ?? (g.__agentDb = load());

export function emitEvent(
  conversationId: string,
  type: AgentEventType,
  data: Record<string, unknown>,
): AgentEvent {
  const event: AgentEvent = {
    id: db.nextEventId++,
    conversationId,
    ts: new Date().toISOString(),
    type,
    data,
  };
  db.events.push(event);
  if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
  for (const fn of db.subscribers) {
    try {
      fn(event);
    } catch {
      // dead subscriber; cleaned up on unsubscribe
    }
  }
  return event;
}

export function subscribe(fn: (e: AgentEvent) => void): () => void {
  db.subscribers.add(fn);
  return () => db.subscribers.delete(fn);
}

export function recordRefund(record: Omit<RefundRecord, "id" | "at">): RefundRecord {
  const full: RefundRecord = {
    ...record,
    id: `ref_${String(db.refunds.length + 1).padStart(4, "0")}`,
    at: new Date().toISOString(),
  };
  db.refunds.push(full);
  return full;
}

export function armChaos(): void {
  db.chaosArmed = true;
}

// Returns true (and disarms) if a simulated failure is pending.
export function consumeChaos(): boolean {
  if (!db.chaosArmed) return false;
  db.chaosArmed = false;
  return true;
}

export function findCustomerByEmail(email: string): Customer | undefined {
  return db.customers.find((c) => c.email.toLowerCase() === email.trim().toLowerCase());
}

export function findCustomer(id: string): Customer | undefined {
  return db.customers.find((c) => c.id === id);
}
