import { createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "crypto";

// Request guards for public deployments: per-IP rate limiting on the
// expensive chat endpoint, and an optional shared-token gate for the admin
// surfaces. Both are no-ops in the default local setup.

const CHAT_LIMIT = Number(process.env.CHAT_RATE_LIMIT ?? 20); // turns per window
const CHAT_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_SEC ?? 300) * 1000;
// Voice requests fan out from chat turns (a few TTS segments plus one
// transcription per spoken turn), so they get their own, roomier bucket.
const VOICE_LIMIT = Number(process.env.VOICE_RATE_LIMIT ?? CHAT_LIMIT * 8);
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

export function checkRateLimit(
  req: Request,
  scope: "chat" | "voice" = "chat",
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  const limit = scope === "voice" ? VOICE_LIMIT : CHAT_LIMIT;
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count < limit) {
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

// ─── Cloudflare Access JWT validation ────────────────────────────────────
// When the app sits behind a Cloudflare Access application, the edge injects
// a signed JWT into every authenticated request (Cf-Access-Jwt-Assertion).
// With CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set, we verify it on every API
// call, which seals the direct-origin bypass: requests that didn't pass the
// Access gate (e.g. straight to the *.ondigitalocean.app URL) are refused.
// Unset (local dev), this is a no-op.

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_RETRY_MS = 5 * 60 * 1000;
const CLOCK_LEEWAY_SEC = 10;

interface JwksCache {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}
const gJwks = globalThis as unknown as { __cfJwks?: JwksCache };

function b64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function fetchJwks(teamDomain: string): Promise<JwksCache> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: Array<Record<string, string>> };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty === "RSA" && jwk.kid) {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
  }
  return { keys, fetchedAt: Date.now() };
}

async function accessKey(teamDomain: string, kid: string): Promise<KeyObject | undefined> {
  let cache = gJwks.__cfJwks;
  const stale = !cache || Date.now() - cache.fetchedAt > JWKS_TTL_MS;
  const unknownKid = cache && !cache.keys.has(kid) && Date.now() - cache.fetchedAt > JWKS_RETRY_MS;
  if (stale || unknownKid) {
    cache = gJwks.__cfJwks = await fetchJwks(teamDomain);
  }
  return cache!.keys.get(kid);
}

// True when the request carries a valid Access JWT (or the check is disabled).
export async function hasValidAccessJwt(req: Request): Promise<boolean> {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !expectedAud) return true;

  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    const header = JSON.parse(b64url(parts[0]).toString()) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return false;
    const key = await accessKey(teamDomain, header.kid);
    if (!key) return false;

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!cryptoVerify("RSA-SHA256", signed, key, b64url(parts[2]))) return false;

    const payload = JSON.parse(b64url(parts[1]).toString()) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      nbf?: number;
    };
    const now = Math.floor(Date.now() / 1000);
    const audOk = Array.isArray(payload.aud)
      ? payload.aud.includes(expectedAud)
      : payload.aud === expectedAud;
    return (
      audOk &&
      payload.iss === `https://${teamDomain}` &&
      typeof payload.exp === "number" &&
      payload.exp > now - CLOCK_LEEWAY_SEC &&
      (payload.nbf === undefined || payload.nbf <= now + CLOCK_LEEWAY_SEC)
    );
  } catch {
    return false;
  }
}

export function accessDenied(): Response {
  return Response.json(
    { error: "This deployment requires authentication through its Cloudflare Access gate." },
    { status: 403 },
  );
}
