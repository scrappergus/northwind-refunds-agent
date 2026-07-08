import { accessDenied, checkRateLimit, hasValidAccessJwt } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/speech — text in, spoken audio (mp3) out, via ElevenLabs. The
// browser plays the returned bytes with a plain <audio> element, which works
// everywhere — unlike window.speechSynthesis, which the client only uses as
// a fallback when this route reports voice is unconfigured (503).
//
// Env: ELEVENLABS_API_KEY enables the route; ELEVENLABS_VOICE_ID overrides
// the default voice. Absent key → 503, and the UI falls back to Web Speech.

const MAX_TEXT_CHARS = 4_000; // agent reply segments are well under this
// "Sarah" — warm, conversational, and a *premade* voice: library voices
// (e.g. Rachel) 402 on free-tier API keys with paid_plan_required.
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Voice is not configured." }, { status: 503 });
  }

  let text: unknown;
  try {
    ({ text } = (await req.json()) as { text?: unknown });
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS) {
    return Response.json({ error: "text is required (and size-limited)." }, { status: 400 });
  }

  const limit = checkRateLimit(req, "voice");
  if (!limit.ok) {
    return Response.json(
      { error: "Rate limit reached — please wait before more voice requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  // Voice ids are alphanumeric; strip paste artifacts (a trailing ")" here
  // once turned every synthesis into a silent 400 → 502).
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID?.replace(/[^A-Za-z0-9]/g, "") || DEFAULT_VOICE_ID;
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.trim(),
        // Turbo is the artifact/latency sweet spot (same credit cost as
        // Flash). Override with ELEVENLABS_MODEL_ID, e.g. eleven_flash_v2_5
        // for ~75ms synthesis or eleven_multilingual_v2 for top quality at
        // double the credits.
        model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5",
      }),
    },
  );
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error(`[speech] ElevenLabs TTS failed (${upstream.status}): ${detail.slice(0, 300)}`);
    return Response.json({ error: "Speech synthesis failed." }, { status: 502 });
  }

  // Stream the audio through so playback can start before synthesis finishes.
  return new Response(upstream.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
