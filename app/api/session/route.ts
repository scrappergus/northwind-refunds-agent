import { accessDenied, hasValidAccessJwt, validateToken } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AGE_SEC = 60 * 60 * 24 * 7;

// POST /api/session — exchange the admin token for an HttpOnly cookie, so the
// admin console never needs the token in its URL. Body: {token}.
export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  let token = "";
  try {
    token = String(((await req.json()) as { token?: unknown }).token ?? "");
  } catch {
    // fall through to the validation failure
  }
  if (token.length > 512 || !validateToken(token)) {
    return Response.json({ ok: false, error: "Invalid token." }, { status: 401 });
  }
  const secure = req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie":
          `admin_token=${encodeURIComponent(token)}; HttpOnly; Path=/; ` +
          `SameSite=Strict; Max-Age=${MAX_AGE_SEC}${secure}`,
      },
    },
  );
}
