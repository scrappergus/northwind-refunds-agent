import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const body = (await req.json()) as ChatRequest;
  if (!body.conversationId || typeof body.userMessage !== "string") {
    return Response.json({ error: "conversationId and userMessage are required" }, { status: 400 });
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
