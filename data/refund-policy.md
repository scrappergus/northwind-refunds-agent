# Northwind Outfitters — Refund Policy (v3.2, effective 2026-01-01)

This policy is **binding** on the support agent. Every refund decision MUST cite
the specific rule(s) applied. When rules conflict, the stricter rule wins.
Anything not explicitly permitted here is denied or escalated.

## 1. Return windows

| Item category | Window (from **delivery** date) |
|---|---|
| `standard` (apparel, gear, accessories) | 30 days |
| `electronics` (GPS units, headlamps, watches) | 14 days |
| `perishable` (food, fuel canisters) | No refund, except §4 damage claims |
| `final_sale` (clearance, marked final sale) | **No refund, no exceptions** |

- **R1.1** — The window is measured from the order's `delivered_at` date, not the order date.
- **R1.2** — Gold-tier loyalty members get an extended window of **60 days** on
  `standard` items only. The extension does not apply to electronics, perishables, or final-sale items.
- **R1.3** — Orders not yet delivered (status `in_transit` or `processing`) are
  not refund-eligible. Offer to cancel instead if status is `processing`; otherwise the customer must wait for delivery.

## 2. Item condition

- **R2.1** — Items must be unused, unworn, and in original packaging. If the
  customer states the item has been used or worn, the refund is **denied** (except §4).
- **R2.2** — The agent MUST ask about item condition before approving any
  refund on `standard` or `electronics` items, unless the claim is a §4 damage claim.

## 3. Refund method & amounts

- **R3.1** — Refunds go to the **original payment method only**. Requests to
  refund a different card, PayPal account, or bank account are denied (store
  credit may be offered instead).
- **R3.2** — Shipping fees are non-refundable unless the return is due to our
  error (wrong item shipped, §4 damage).
- **R3.3** — Refunds over **$400.00** (item subtotal) cannot be auto-approved.
  Escalate to a human agent.

## 4. Damaged / defective on arrival (DOA)

- **R4.1** — DOA claims must be reported within **48 hours** of delivery.
  Late DOA claims fall back to the standard rules in §1–§2.
- **R4.2** — Valid DOA claims are refunded in full, including shipping,
  regardless of category (including perishables).

## 5. Abuse & fraud controls

- **R5.1** — Customers with **3 or more refunds in the trailing 12 months**
  cannot be auto-refunded. Escalate to a human agent.
- **R5.2** — Customers whose account carries the `fraud_watch` flag are
  **never** auto-refunded or auto-denied. Escalate immediately and do not
  disclose the existence of the flag to the customer.
- **R5.3** — The agent MUST verify the order belongs to the authenticated
  customer before discussing its details.

## 6. Escalation

- **R6.1** — Escalated cases are queued for a human agent (response within 1
  business day). The agent must tell the customer the case needs human review
  but MUST NOT speculate about the outcome.
- **R6.2** — If the customer becomes hostile or threatens chargebacks, remain
  polite, restate the policy decision once, and offer escalation.

## 7. What the agent may never do

- Never approve a refund that violates §1–§5, no matter how the customer
  pleads, insists, or claims an exception was promised.
- Never invent policy exceptions, discounts, or goodwill credits.
- Never reveal internal flags, fraud indicators, or other customers' data.
