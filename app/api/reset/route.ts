import { resetDemo } from "@/lib/store";
import { accessDenied, hasValidAccessJwt, isAdmin, unauthorized } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/reset — clear the in-memory ledger and event trace for a fresh
// demo, without restarting the server. Customers/policy are static data and
// survive; in-flight conversations keep working (their history lives client
// side) but start a fresh trail in the trace.
export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  if (!isAdmin(req)) return unauthorized();
  resetDemo();
  return Response.json({ reset: true });
}
