import { db } from "@/lib/store";
import { isAdmin } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/state — decision ledger + customer roster for the UIs. The roster
// stays public (the chat's persona picker needs it); the ledger is admin-only
// when a DEMO_ADMIN_TOKEN is configured.
export async function GET(req: Request): Promise<Response> {
  const admin = isAdmin(req);
  return Response.json({
    admin,
    refunds: admin ? [...db.refunds].reverse() : [],
    customers: db.customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      loyalty_tier: c.loyalty_tier,
      orders: c.orders.map((o) => ({ id: o.id, status: o.status })),
    })),
  });
}
