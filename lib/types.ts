export type ItemCategory = "standard" | "electronics" | "perishable";

export interface OrderItem {
  sku: string;
  name: string;
  category: ItemCategory;
  price: number;
  qty: number;
  final_sale: boolean;
}

export interface Order {
  id: string;
  placed_at: string;
  delivered_at: string | null;
  status: "processing" | "in_transit" | "delivered";
  payment_method: string;
  shipping_fee: number;
  items: OrderItem[];
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  joined: string;
  loyalty_tier: "none" | "silver" | "gold";
  flags: string[];
  refunds_last_12mo: number;
  orders: Order[];
}

export type Decision = "approve" | "deny" | "escalate";

export interface EligibilityResult {
  decision: Decision;
  rules_applied: string[];
  refundable_amount: number;
  notes: string[];
}

export interface RefundRecord {
  id: string;
  conversationId: string;
  customerId: string;
  customerName: string;
  orderId: string;
  outcome: "refunded" | "denied" | "escalated";
  amount: number | null;
  rules: string[];
  reason: string;
  at: string;
}

export type AgentEventType =
  | "turn_start"
  | "thinking"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "retry"
  | "decision"
  | "turn_end"
  | "agent_error";

export interface AgentEvent {
  id: number;
  conversationId: string;
  ts: string;
  type: AgentEventType;
  data: Record<string, unknown>;
}
