import { timingSafeEqual } from "crypto";

// Request guards for public deployments: per-IP rate limiting on the
// expensive chat endpoint, and an optional shared-token gate for the admin
// surfaces. Both are no-ops in the default local setup.

const CHAT_LIMIT = Number(process.env.CHAT_RATE_LIMIT ?? 20); // turns per window
const CHAT_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_SEC ?? 300) * 1000;
const MAX_TRACKED_IPS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

// On globalThis so dev-mode HMR reloads don't reset the counters.
const g = globalThis as unknown as { __rateBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = g.__rateBuckets ?? (g.__rateBuckets = new Map());

function clientIp(req: Request): string {
  // First hop of x-forwarded-for; DigitalOcean (and most proxies) set it.
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}

export function checkRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const ip = clientIp(req);
  const bucket = buckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      for (const [key, b] of buckets) if (now >= b.resetAt) buckets.delete(key);
    }
    buckets.set(ip, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count < CHAT_LIMIT) {
    bucket.count++;
    return { ok: true };
  }
  return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
}

function tokenMatches(supplied: string): boolean {
  const expected = process.env.DEMO_ADMIN_TOKEN ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: Request): string {
  const cookies = req.headers.get("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)admin_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

// True when the request may see admin surfaces (trace feed, ledger, chaos).
// With DEMO_ADMIN_TOKEN unset (local dev), everything is open as before.
// The normal browser flow is the HttpOnly cookie set by POST /api/session
// (EventSource sends cookies but can't set headers); the header and query
// forms remain for curl/scripting.
export function isAdmin(req: Request): boolean {
  if (!process.env.DEMO_ADMIN_TOKEN) return true;
  const supplied =
    req.headers.get("x-admin-token") ??
    new URL(req.url).searchParams.get("token") ??
    cookieToken(req);
  return tokenMatches(supplied);
}

// POST /api/session helper: validates a token for the login form.
export function validateToken(supplied: string): boolean {
  if (!process.env.DEMO_ADMIN_TOKEN) return true;
  return tokenMatches(supplied);
}

export function unauthorized(): Response {
  return Response.json(
    { error: "Admin token required (x-admin-token header or ?token=)." },
    { status: 401 },
  );
}
