---
name: verify
description: Build/launch/drive recipe for verifying changes to this app at runtime.
---

# Verifying this app

The canonical dev server is the Docker one: `bin/dev up` → http://localhost:3000
(bind-mounts the repo, HMR picks up edits — no rebuild needed to test changes).

**Never run `npm run dev` or `npm run build` on the host while the container is
up.** The bind mount shares `.next`; host writes corrupt it (page loops on
`[Fast Refresh] rebuilding`, routes 404). Recover: `rm -rf .next && bin/dev restart`.
If you need a second server with different env (e.g. a fake `ELEVENLABS_API_KEY`),
take the container down first (`bin/dev down`) or accept curl-only testing
against the container.

Drive it:
- Chat surface: pick a persona card, click a suggestion chip, watch the
  streamed reply (needs `ANTHROPIC_API_KEY` in `.env.local` — the container
  has it). One turn ≈ 15–25s.
- Admin surface: http://localhost:3000/admin — live SSE trace + ledger.
- API-level: `curl localhost:3000/api/state`; POST `/api/chat` with
  `{conversationId, messages: [], userMessage}` streams SSE frames.
- Voice routes: `/api/speech` `{text}` → mp3 (503 keyless), `/api/transcribe`
  multipart `audio` field → `{text}` (503 keyless). Fake key → 502 after a
  real upstream 401, logged as `[speech]`/`[transcribe]` in `bin/dev logs`.
- Restarting the container resets the in-memory ledger/trace — expected.
