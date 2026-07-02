import { armChaos, db } from "@/lib/store";
import { accessDenied, hasValidAccessJwt, isAdmin, unauthorized } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chaos — arm a one-shot simulated CRM outage: the next tool call
// (any conversation) throws a transient error. Used from the admin console to
// demo the tool_error → retry → recovery path in the reasoning trace.
export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  if (!isAdmin(req)) return unauthorized();
  armChaos();
  return Response.json({ armed: true });
}

export async function GET(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  if (!isAdmin(req)) return unauthorized();
  return Response.json({ armed: db.chaosArmed });
}
