import { db, subscribe } from "@/lib/store";
import { accessDenied, hasValidAccessJwt, isAdmin, unauthorized } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/logs — SSE feed for the admin dashboard. Sends recent history on
// connect, then every new agent event as it happens.
export async function GET(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  if (!isAdmin(req)) return unauthorized();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      send({ type: "history", events: db.events.slice(-500) });
      unsubscribe = subscribe((event) => send({ type: "event", event }));
      // Keep intermediaries from closing the idle connection.
      heartbeat = setInterval(
        () => controller.enqueue(encoder.encode(": ping\n\n")),
        15000,
      );
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
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
