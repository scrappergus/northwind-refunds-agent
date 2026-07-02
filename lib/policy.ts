import type { Customer, EligibilityResult, Order, OrderItem } from "./types";

// Deterministic refund-policy engine. This is the source of truth for every
// refund decision — the LLM asks it via the check_refund_eligibility tool and
// process_refund re-runs it before moving money. Rule IDs refer to
// data/refund-policy.md.

export interface ClaimInput {
  skus?: string[];
  condition: "unused" | "used" | "damaged_on_arrival";
  doa_reported_at?: string; // ISO timestamp the customer reported the damage
  requested_method: "original_payment" | "other";
}

const WINDOW_DAYS: Record<string, number> = {
  standard: 30,
  electronics: 14,
  perishable: 0,
};

const GOLD_STANDARD_WINDOW = 60;
const AUTO_APPROVE_LIMIT = 400;
const DOA_REPORT_HOURS = 48;

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
}

export function evaluateClaim(
  customer: Customer,
  order: Order,
  claim: ClaimInput,
  now: Date = new Date(),
): EligibilityResult {
  const rules: string[] = [];
  const notes: string[] = [];

  // §5 fraud & abuse controls come first — they trump everything.
  if (customer.flags.includes("fraud_watch")) {
    return {
      decision: "escalate",
      rules_applied: ["R5.2"],
      refundable_amount: 0,
      notes: [
        "Account requires manual review before any refund action.",
        "Do NOT disclose the reason or the existence of an account flag to the customer.",
      ],
    };
  }
  if (customer.refunds_last_12mo >= 3) {
    return {
      decision: "escalate",
      rules_applied: ["R5.1"],
      refundable_amount: 0,
      notes: [`Customer has ${customer.refunds_last_12mo} refunds in the trailing 12 months.`],
    };
  }

  // §1.3 must be delivered.
  if (order.status !== "delivered" || !order.delivered_at) {
    notes.push(
      order.status === "processing"
        ? "Order has not shipped; offer to cancel it instead of refunding."
        : "Order is in transit; the customer must wait for delivery before a refund claim.",
    );
    return { decision: "deny", rules_applied: ["R1.3"], refundable_amount: 0, notes };
  }

  const claimedItems: OrderItem[] = claim.skus?.length
    ? order.items.filter((i) => claim.skus!.includes(i.sku))
    : order.items;
  if (claimedItems.length === 0) {
    return {
      decision: "deny",
      rules_applied: [],
      refundable_amount: 0,
      notes: ["None of the provided SKUs are on this order."],
    };
  }

  // §4 damaged on arrival.
  if (claim.condition === "damaged_on_arrival") {
    const reportedAt = claim.doa_reported_at ? new Date(claim.doa_reported_at) : now;
    const hoursSinceDelivery =
      (reportedAt.getTime() - new Date(order.delivered_at).getTime()) / 3_600_000;
    if (hoursSinceDelivery <= DOA_REPORT_HOURS) {
      const amount =
        claimedItems.reduce((s, i) => s + i.price * i.qty, 0) + order.shipping_fee;
      if (amount > AUTO_APPROVE_LIMIT) {
        return {
          decision: "escalate",
          rules_applied: ["R4.2", "R3.3"],
          refundable_amount: amount,
          notes: ["Valid DOA claim but over the auto-approval limit; requires human sign-off."],
        };
      }
      return {
        decision: "approve",
        rules_applied: ["R4.1", "R4.2"],
        refundable_amount: Math.round(amount * 100) / 100,
        notes: ["Valid DOA claim: full refund including shipping."],
      };
    }
    rules.push("R4.1");
    notes.push(
      `DOA claim reported ~${Math.round(hoursSinceDelivery)}h after delivery (limit ${DOA_REPORT_HOURS}h); falling back to standard rules.`,
    );
    // fall through to §1–§2
  }

  // §2 condition (used items are out, except valid DOA handled above).
  if (claim.condition === "used") {
    return {
      decision: "deny",
      rules_applied: [...rules, "R2.1"],
      refundable_amount: 0,
      notes: [...notes, "Customer states the item has been used/worn."],
    };
  }

  // §1 per-item category windows.
  const age = daysSince(order.delivered_at, now);
  const deniedItems: { item: OrderItem; rule: string; why: string }[] = [];
  const eligibleItems: OrderItem[] = [];

  for (const item of claimedItems) {
    if (item.final_sale) {
      deniedItems.push({ item, rule: "R1.1", why: "final-sale item: no refund, no exceptions" });
      continue;
    }
    if (item.category === "perishable") {
      deniedItems.push({ item, rule: "R1.1", why: "perishable: refundable only via valid DOA claim" });
      continue;
    }
    let window = WINDOW_DAYS[item.category] ?? 0;
    if (item.category === "standard" && customer.loyalty_tier === "gold") {
      window = GOLD_STANDARD_WINDOW;
      notes.push("Gold-tier extended window (60 days) applies to standard items (R1.2).");
    }
    if (age > window) {
      deniedItems.push({
        item,
        rule: "R1.1",
        why: `outside the ${window}-day window (delivered ${Math.floor(age)} days ago)`,
      });
    } else {
      eligibleItems.push(item);
    }
  }

  for (const d of deniedItems) notes.push(`${d.item.sku} (${d.item.name}): ${d.why}`);

  if (eligibleItems.length === 0) {
    return {
      decision: "deny",
      rules_applied: [...new Set([...rules, ...deniedItems.map((d) => d.rule)])],
      refundable_amount: 0,
      notes,
    };
  }

  // §3 method + amount.
  if (claim.requested_method === "other") {
    return {
      decision: "deny",
      rules_applied: [...rules, "R3.1"],
      refundable_amount: 0,
      notes: [
        ...notes,
        "Refunds go to the original payment method only; store credit may be offered instead.",
      ],
    };
  }

  const amount = eligibleItems.reduce((s, i) => s + i.price * i.qty, 0);
  rules.push("R1.1", "R2.1", "R3.2");
  if (amount > AUTO_APPROVE_LIMIT) {
    return {
      decision: "escalate",
      rules_applied: [...rules, "R3.3"],
      refundable_amount: amount,
      notes: [...notes, "Over the $400 auto-approval limit; requires human sign-off."],
    };
  }

  if (deniedItems.length > 0) {
    notes.push("Partial approval: only the eligible items listed are refundable.");
  }
  notes.push("Shipping fee is non-refundable for standard returns (R3.2).");

  return {
    decision: "approve",
    rules_applied: [...new Set(rules)],
    refundable_amount: Math.round(amount * 100) / 100,
    notes,
  };
}
