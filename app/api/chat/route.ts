import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent";
import { accessDenied, checkRateLimit, hasValidAccessJwt } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Abuse caps: each accepted request can fan out into many model calls, so
// bound everything the client controls before it reaches the API.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_ENTRIES = 60;
const MAX_ID_CHARS = 64;

interface ChatRequest {
  conversationId: string;
  // Opaque prior history (includes tool_use/tool_result/thinking blocks).
  messages: Anthropic.MessageParam[];
  userMessage: string;
  // Email of the demo persona "signed in" to the chat; injected once so the
  // agent can verify identity via lookup_customer (R5.3).
  customerEmail?: string;
}

// POST /api/chat — runs one agent turn, streaming SSE frames:
//   {type:"delta", text}          assistant prose, token by token
//   {type:"trace", event, data}   live copy of the reasoning-log events
//   {type:"done", messages}       full updated history to send back next turn
//   {type:"error", message}
export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Request body too large." }, { status: 413 });
  }
  let body: ChatRequest;
  try {
    body = JSON.parse(raw) as ChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (
    typeof body.conversationId !== "string" ||
    !body.conversationId ||
    body.conversationId.length > MAX_ID_CHARS ||
    typeof body.userMessage !== "string" ||
    !body.userMessage.trim() ||
    body.userMessage.length > MAX_MESSAGE_CHARS
  ) {
    return Response.json(
      { error: "conversationId and userMessage are required (and size-limited)." },
      { status: 400 },
    );
  }
  const prior = body.messages ?? [];
  if (
    !Array.isArray(prior) ||
    prior.length > MAX_HISTORY_ENTRIES ||
    prior.some((m) => !m || (m.role !== "user" && m.role !== "assistant"))
  ) {
    return Response.json({ error: "messages must be a bounded chat history." }, { status: 400 });
  }

  const limit = checkRateLimit(req);
  if (!limit.ok) {
    return Response.json(
      { error: "Rate limit reached — please wait before sending more messages." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));

      try {
        const isFirstTurn = (body.messages ?? []).length === 0;
        const content =
          isFirstTurn && body.customerEmail
            ? `[Session authenticated for ${body.customerEmail}]\n\n${body.userMessage}`
            : body.userMessage;
        const history: Anthropic.MessageParam[] = [
          ...(body.messages ?? []),
          { role: "user", content },
        ];
        const updated = await runAgentTurn(body.conversationId, history, {
          onTextDelta: (text) => send({ type: "delta", text }),
          onTrace: (event, data) => send({ type: "trace", event, data }),
        });
        send({ type: "done", messages: updated });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
