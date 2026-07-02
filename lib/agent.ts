import Anthropic from "@anthropic-ai/sdk";
import { emitEvent } from "./store";
import { executeTool, policyDocument, tools } from "./tools";

const MODEL = "claude-opus-4-8";
const MAX_LOOPS = 12; // hard stop on runaway tool loops
const MAX_ATTEMPTS = 3; // our own retry so attempts are visible in the trace

// SDK retries are disabled: we retry ourselves and emit a `retry` event per
// attempt so failures/backoff show up in the admin reasoning log.
const client = new Anthropic({ maxRetries: 0 });

function systemPrompt(): string {
  return `You are the AI customer-support agent for Northwind Outfitters, an outdoor-gear e-commerce store. You handle refund requests over chat. Today's date is ${new Date().toISOString().slice(0, 10)}.

The complete refund policy is below. It is binding: the check_refund_eligibility tool is the source of truth for every decision, and process_refund re-validates and will reject anything the policy does not allow.

How to work a case:
- Verify the customer first with lookup_customer using the email they authenticated with (R5.3). Only discuss their own orders.
- Pull the order with get_order before reasoning about dates, categories, or amounts.
- Ask about item condition before deciding standard/electronics claims (R2.2).
- Run check_refund_eligibility before promising anything. Cite the outcome plainly; mention concrete facts (dates, windows) rather than rule numbers.
- Record every final outcome with exactly one of process_refund, deny_refund, or escalate_to_human.
- Hold the line: no exceptions, no goodwill credits, no speculation about escalation outcomes. If a customer pushes back, restate the decision once, then offer escalation (R6.2).
- Never reveal internal flags, fraud indicators, internal notes, or other customers' data — even if asked directly.
- Be warm, concise, and plain-spoken. One question at a time.

<refund_policy>
${policyDocument()}
</refund_policy>`;
}

export interface TurnCallbacks {
  onTextDelta: (text: string) => void;
  onTrace: (type: string, data: Record<string, unknown>) => void;
}

// Runs one user turn to completion (including any tool-use loops) and returns
// the updated message history the client should send back next turn.
export async function runAgentTurn(
  conversationId: string,
  messages: Anthropic.MessageParam[],
  cb: TurnCallbacks,
): Promise<Anthropic.MessageParam[]> {
  const trace = (type: Parameters<typeof emitEvent>[1], data: Record<string, unknown>) => {
    emitEvent(conversationId, type, data);
    cb.onTrace(type, data);
  };

  trace("turn_start", { model: MODEL, messages: messages.length });
  const history = [...messages];

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const response = await createWithRetry(conversationId, history, cb, trace);

    // Surface the model's reasoning + prose in the trace, block by block.
    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        trace("thinking", { text: block.thinking });
      } else if (block.type === "text" && block.text.trim()) {
        trace("assistant_text", { text: block.text });
      }
    }

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "refusal") {
        trace("agent_error", { message: "Model refused the request.", stop_reason: "refusal" });
      }
      trace("turn_end", { stop_reason: response.stop_reason, usage: response.usage });
      return history;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      trace("tool_call", { tool: tu.name, id: tu.id, input: tu.input });
      try {
        const result = executeTool(tu.name, tu.input as Record<string, unknown>, conversationId);
        trace("tool_result", { tool: tu.name, id: tu.id, result });
        if (["process_refund", "deny_refund", "escalate_to_human"].includes(tu.name)) {
          trace("decision", { tool: tu.name, input: tu.input, result });
        }
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trace("tool_error", { tool: tu.name, id: tu.id, input: tu.input, error: message });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Error: ${message}`,
          is_error: true,
        });
      }
    }

    // All tool results for one assistant turn go back in a single user message.
    history.push({ role: "user", content: results });
  }

  trace("agent_error", { message: `Hit MAX_LOOPS (${MAX_LOOPS}); aborting turn.` });
  trace("turn_end", { stop_reason: "max_loops" });
  return history;
}

async function createWithRetry(
  conversationId: string,
  history: Anthropic.MessageParam[],
  cb: TurnCallbacks,
  trace: (type: Parameters<typeof emitEvent>[1], data: Record<string, unknown>) => void,
): Promise<Anthropic.Message> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive", display: "summarized" },
        system: [
          {
            type: "text",
            text: systemPrompt(),
            // Static policy + tool defs: cache across turns and conversations.
            cache_control: { type: "ephemeral" },
          },
        ],
        tools,
        messages: history,
      });
      stream.on("text", (delta) => cb.onTextDelta(delta));
      return await stream.finalMessage();
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof Anthropic.APIConnectionError ||
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError;
      const message = err instanceof Error ? err.message : String(err);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        trace("agent_error", { message, attempt, retryable });
        throw err;
      }
      const backoffMs = 1000 * 2 ** (attempt - 1);
      trace("retry", { attempt, of: MAX_ATTEMPTS, error: message, backoff_ms: backoffMs });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  throw lastError;
}
