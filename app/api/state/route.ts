import { db } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/state — decision ledger + customer roster for the UIs.
export async function GET(): Promise<Response> {
  return Response.json({
    refunds: [...db.refunds].reverse(),
    customers: db.customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      loyalty_tier: c.loyalty_tier,
      orders: c.orders.map((o) => ({ id: o.id, status: o.status })),
    })),
  });
}
