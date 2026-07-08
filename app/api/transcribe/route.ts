import { accessDenied, checkRateLimit, hasValidAccessJwt } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/transcribe — recorded audio in (multipart "audio" field), text
// out, via ElevenLabs Scribe. Replaces the Chrome-only SpeechRecognition
// path: the browser records with MediaRecorder (universal) and we do the
// recognition server-side. Same env gate as /api/speech.

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // ~1 min of opus is well under 1 MB

export async function POST(req: Request): Promise<Response> {
  if (!(await hasValidAccessJwt(req))) return accessDenied();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Voice is not configured." }, { status: 503 });
  }

  const limit = checkRateLimit(req, "voice");
  if (!limit.ok) {
    return Response.json(
      { error: "Rate limit reached — please wait before more voice requests." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  let audio: File | null = null;
  try {
    const form = await req.formData();
    const field = form.get("audio");
    if (field instanceof File) audio = field;
  } catch {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  if (!audio || audio.size === 0) {
    return Response.json({ error: "audio file is required." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Recording too large." }, { status: 413 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append("model_id", "scribe_v1");
  upstreamForm.append("file", audio, audio.name || "recording.webm");
  const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: upstreamForm,
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error(`[transcribe] ElevenLabs STT failed (${upstream.status}): ${detail.slice(0, 300)}`);
    return Response.json({ error: "Transcription failed." }, { status: 502 });
  }

  const result = (await upstream.json()) as { text?: string };
  return Response.json({ text: (result.text ?? "").trim() });
}
