import type Anthropic from "@anthropic-ai/sdk";
import { evaluateClaim, type ClaimInput } from "./policy";
import { consumeChaos, db, findCustomer, findCustomerByEmail, recordRefund } from "./store";
import type { Customer, Order } from "./types";

export const tools: Anthropic.Tool[] = [
  {
    name: "lookup_customer",
    description:
      "Look up a customer profile by the email address they authenticated with. " +
      "Call this first in every conversation to verify the customer exists (R5.3). " +
      "Returns the profile including order ids. Internal fields (flags) must never be revealed to the customer.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer email address" },
      },
      required: ["email"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_order",
    description:
      "Fetch full details of one order (items, categories, prices, delivery status and dates, payment method). " +
      "Only fetch orders that belong to the customer you looked up (R5.3).",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
      },
      required: ["customer_id", "order_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "check_refund_eligibility",
    description:
      "Run the deterministic refund-policy engine over a claim. ALWAYS call this before promising, " +
      "processing, or denying a refund — it is the source of truth for policy. Returns a decision " +
      "(approve/deny/escalate), the rule ids applied, the refundable amount, and internal notes. " +
      "Ask the customer about item condition first (R2.2) so you can pass it accurately.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        skus: {
          type: "array",
          items: { type: "string" },
          description: "SKUs the claim covers. Omit to claim the whole order.",
        },
        condition: {
          type: "string",
          enum: ["unused", "used", "damaged_on_arrival"],
          description: "Item condition as stated by the customer.",
        },
        doa_reported_at: {
          type: "string",
          description:
            "ISO timestamp when the customer first reported damage-on-arrival. " +
            "Use the current conversation time if they are reporting it right now.",
        },
        requested_method: {
          type: "string",
          enum: ["original_payment", "other"],
          description: "Where the customer wants the money sent.",
        },
      },
      required: ["customer_id", "order_id", "condition", "requested_method"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "process_refund",
    description:
      "Execute an approved refund to the original payment method. This tool re-validates the claim " +
      "against the policy engine and will REJECT the call if the claim is not approvable — you cannot " +
      "override policy with this tool. Include the same claim parameters you passed to check_refund_eligibility.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        skus: { type: "array", items: { type: "string" } },
        condition: { type: "string", enum: ["unused", "used", "damaged_on_arrival"] },
        doa_reported_at: { type: "string" },
        reason: { type: "string", description: "One-line summary of why this refund is approved." },
      },
      required: ["customer_id", "order_id", "condition", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "deny_refund",
    description:
      "Record a refund denial with the policy rules that justify it. Call this once you have told " +
      "the customer the outcome, so the case is logged.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        rules: { type: "array", items: { type: "string" }, description: "Rule ids, e.g. [\"R1.1\"]" },
        reason: { type: "string" },
      },
      required: ["customer_id", "order_id", "rules", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "escalate_to_human",
    description:
      "Open a ticket for a human agent. Use when the policy engine returns 'escalate', or for " +
      "situations the policy does not cover. Never speculate to the customer about the eventual outcome (R6.1).",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        reason: {
          type: "string",
          description: "Internal reason for escalation (may reference flags/rules; the customer never sees this).",
        },
      },
      required: ["customer_id", "order_id", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function publicCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    joined: c.joined,
    loyalty_tier: c.loyalty_tier,
    internal_flags: c.flags,
    refunds_last_12mo: c.refunds_last_12mo,
    orders: c.orders.map((o) => ({ id: o.id, placed_at: o.placed_at, status: o.status })),
  };
}

function requireOrder(customerId: string, orderId: string): { customer: Customer; order: Order } {
  const customer = findCustomer(customerId);
  if (!customer) throw new Error(`No customer with id '${customerId}'.`);
  const order = customer.orders.find((o) => o.id === orderId);
  if (!order)
    throw new Error(
      `Order '${orderId}' does not belong to customer '${customerId}'. Do not discuss it (R5.3).`,
    );
  return { customer, order };
}

// Executes one tool call. Throws on invalid input / policy rejection — the
// agent loop converts that into an is_error tool_result so the model can
// recover, and logs it as a failure in the trace.
export function executeTool(
  name: string,
  input: Record<string, unknown>,
  conversationId: string,
): unknown {
  if (consumeChaos()) {
    throw new Error(
      `CRM backend timed out after 5000ms while executing '${name}' ` +
        "(simulated outage — armed from the admin console). Transient failure: retry the same call.",
    );
  }
  switch (name) {
    case "lookup_customer": {
      const customer = findCustomerByEmail(String(input.email ?? ""));
      if (!customer) throw new Error(`No customer found for email '${input.email}'.`);
      return publicCustomer(customer);
    }

    case "get_order": {
      const { order } = requireOrder(String(input.customer_id), String(input.order_id));
      return order;
    }

    case "check_refund_eligibility": {
      const { customer, order } = requireOrder(String(input.customer_id), String(input.order_id));
      return evaluateClaim(customer, order, claimFromInput(input));
    }

    case "process_refund": {
      const { customer, order } = requireOrder(String(input.customer_id), String(input.order_id));
      const claim = claimFromInput({ ...input, requested_method: "original_payment" });
      const verdict = evaluateClaim(customer, order, claim);
      if (verdict.decision !== "approve") {
        throw new Error(
          `Refund REJECTED by policy engine: decision=${verdict.decision}, rules=[${verdict.rules_applied.join(", ")}]. ` +
            `${verdict.notes.join(" ")} Use deny_refund or escalate_to_human instead.`,
        );
      }
      const record = recordRefund({
        conversationId,
        customerId: customer.id,
        customerName: customer.name,
        orderId: order.id,
        outcome: "refunded",
        amount: verdict.refundable_amount,
        rules: verdict.rules_applied,
        reason: String(input.reason ?? ""),
      });
      return {
        refund_id: record.id,
        amount: verdict.refundable_amount,
        refunded_to: order.payment_method,
        eta_business_days: 5,
      };
    }

    case "deny_refund": {
      const { customer, order } = requireOrder(String(input.customer_id), String(input.order_id));
      const record = recordRefund({
        conversationId,
        customerId: customer.id,
        customerName: customer.name,
        orderId: order.id,
        outcome: "denied",
        amount: null,
        rules: (input.rules as string[]) ?? [],
        reason: String(input.reason ?? ""),
      });
      return { case_id: record.id, logged: true };
    }

    case "escalate_to_human": {
      const { customer, order } = requireOrder(String(input.customer_id), String(input.order_id));
      const record = recordRefund({
        conversationId,
        customerId: customer.id,
        customerName: customer.name,
        orderId: order.id,
        outcome: "escalated",
        amount: null,
        rules: [],
        reason: String(input.reason ?? ""),
      });
      return {
        ticket_id: record.id.replace("ref_", "tkt_"),
        queue: "human_review",
        sla: "1 business day",
      };
    }

    default:
      throw new Error(`Unknown tool '${name}'.`);
  }
}

function claimFromInput(input: Record<string, unknown>): ClaimInput {
  return {
    skus: input.skus as string[] | undefined,
    condition: (input.condition as ClaimInput["condition"]) ?? "unused",
    doa_reported_at: input.doa_reported_at as string | undefined,
    requested_method:
      (input.requested_method as ClaimInput["requested_method"]) ?? "original_payment",
  };
}

export function policyDocument(): string {
  return db.policy;
}
