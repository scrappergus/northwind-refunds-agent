import { armChaos, db } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/chaos — arm a one-shot simulated CRM outage: the next tool call
// (any conversation) throws a transient error. Used from the admin console to
// demo the tool_error → retry → recovery path in the reasoning trace.
export async function POST(): Promise<Response> {
  armChaos();
  return Response.json({ armed: true });
}

export async function GET(): Promise<Response> {
  return Response.json({ armed: db.chaosArmed });
}
