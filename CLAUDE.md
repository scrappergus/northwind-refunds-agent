@AGENTS.md

# Northwind Outfitters — AI Refunds Agent

## Architecture

Next.js app with two surfaces over one in-memory event stream: a customer chat
(`app/page.tsx`, typed or voice — ElevenLabs TTS/STT via `/api/speech` +
`/api/transcribe` when `ELEVENLABS_API_KEY` is set, any browser; Web Speech
fallback otherwise) and an admin reasoning console (`app/admin/page.tsx`,
light "alpine morning" theme). `lib/agent.ts` runs a raw Anthropic tool-calling loop
(`claude-opus-4-8`, streaming, own retry loop so attempts are visible in the
trace). All refund decisions come from `lib/policy.ts`, a deterministic engine;
`process_refund` re-runs it server-side, so the model cannot approve outside
policy. `lib/store.ts` holds events/ledger on `globalThis` (survives HMR,
resets on restart). `lib/guard.ts` carries the deploy hardening: per-IP rate
limiting + input caps on `/api/chat`, an admin gate (unlock form →
`POST /api/session` → HttpOnly cookie; header/query for scripting), and
optional Cloudflare Access JWT validation that seals direct-origin access.
See README for the full file map and demo scenarios.

## Conventions to preserve

- Policy enforcement lives in code, not prompts — never let the LLM be the
  source of truth for eligibility. Rule IDs cited in results must exist in
  `data/refund-policy.md` (§1 window/category denials all anchor to R1.1 on purpose).
- Both UI themes share tokenized CSS in `app/globals.css`; the admin console
  stays bright/light. Re-cut colors for contrast on white rather than reusing
  dark-theme pastels; keep contrast ≥4.5:1 at trace font sizes.
- SDK auto-retry stays disabled (`maxRetries: 0`) — the loop's own retries feed
  the trace's `retry` events.
- Auth flows never put secrets in URLs: the admin token travels via the
  unlock-form cookie or `x-admin-token` header (`?token=` exists for curl only).
- All guards are env-gated no-ops locally; never make local dev require them.

## Things that bite

- `bin/dev up` serves in Docker on port 3000. Running `npm run dev` on the host
  at the same time lands on 3001 with a *separate* in-memory ledger/trace —
  easy to stare at the wrong server's empty admin console. Worse: the repo is
  bind-mounted into the container, so a host `npm run dev` *or* `npm run build`
  clobbers the container's `.next` — the 3001 page loops on `[Fast Refresh]
  rebuilding` and 3000 starts 404ing routes. Recover with
  `rm -rf .next && bin/dev restart`.
- `.env.local` is optional in docker-compose (`required: false`), so the
  container starts fine without an API key and only fails when the agent is
  invoked. Recreate (not just restart) the container after changing env.
- The model is too well-grounded to trigger `tool_error` naturally (it refuses
  foreign order ids conversationally before any guard throws). To demo failure
  handling, use the ⚡ simulate CRM outage button in the admin console
  (`app/api/chaos` arms a one-shot fake tool timeout).
- With `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` set, every API route requires a
  valid `Cf-Access-Jwt-Assertion`. A stale/wrong AUD (e.g. after recreating
  the Access application) makes every API call 403 — update or unset both
  vars together.
- `.composer button` outranks single-class selectors inside the composer;
  scope new composer controls as `.composer .foo` or they inherit the dark
  Send-button styling.
- Mock data is dated around 2026-07; date-window scenarios drift stale as the
  real date moves past mid-July 2026.
- Don't paint viewport-sized CSS gradients: under Firefox's software
  WebRender (VMs, remote desktops, GPU-blocklisted machines) they get
  re-rasterized on the CPU every scroll frame and the page visibly janks.
  Keep gradients to fixed-size bands (see `.console`'s 260px background-size
  wash). Same family of problem: don't animate `box-shadow`, and any
  `prefers-reduced-motion` override must cap `animation-iteration-count`,
  not just duration.

## Status

Feature-complete and verified end-to-end with a live key: approve / deny /
escalate / hold-the-line / chaos-retry all pass, plus voice mode (mic button;
realistic ElevenLabs voice in any browser with a key, Web Speech fallback
without). Published at
https://github.com/scrappergus/northwind-refunds-agent and deployed to
DigitalOcean App Platform (production Dockerfile, standalone build) behind a
Cloudflare-proxied domain with a Cloudflare Access OTP gate; the app also
validates Access JWTs so the DO origin URL serves no data directly.
Deployment specifics (app id, hostname, tokens, redeploy command) live in the
gitignored `notes/deploy-digitalocean.md`. In-memory state resets on
restart/redeploy — restart right before demos for a clean ledger.
