@AGENTS.md

# Northwind Outfitters — AI Refunds Agent

## Architecture

Next.js app with two surfaces over one in-memory event stream: a customer chat
(`app/page.tsx`) and an admin reasoning console (`app/admin/page.tsx`, light
"alpine morning" theme). `lib/agent.ts` runs a raw Anthropic tool-calling loop
(`claude-opus-4-8`, streaming, own retry loop so attempts are visible in the
trace). All refund decisions come from `lib/policy.ts`, a deterministic engine;
`process_refund` re-runs it server-side, so the model cannot approve outside
policy. `lib/store.ts` holds events/ledger on `globalThis` (survives HMR,
resets on restart). See README for the full file map and demo scenarios.

## Conventions to preserve

- Policy enforcement lives in code, not prompts — never let the LLM be the
  source of truth for eligibility. Rule IDs cited in results must exist in
  `data/refund-policy.md` (§1 window/category denials all anchor to R1.1 on purpose).
- Both UI themes share tokenized CSS in `app/globals.css`; the admin console
  stays bright/light. Re-cut colors for contrast on white rather than reusing
  dark-theme pastels; keep contrast ≥4.5:1 at trace font sizes.
- SDK auto-retry stays disabled (`maxRetries: 0`) — the loop's own retries feed
  the trace's `retry` events.

## Things that bite

- `bin/dev up` serves in Docker on port 3000. Running `npm run dev` on the host
  at the same time lands on 3001 with a *separate* in-memory ledger/trace —
  easy to stare at the wrong server's empty admin console.
- `.env.local` is optional in docker-compose (`required: false`), so the
  container starts fine without an API key and only fails when the agent is
  invoked. Recreate (not just restart) the container after changing env.
- The model is too well-grounded to trigger `tool_error` naturally (it refuses
  foreign order ids conversationally before any guard throws). To demo failure
  handling, use the ⚡ simulate CRM outage button in the admin console
  (`app/api/chaos` arms a one-shot fake tool timeout).
- Mock data is dated around 2026-07; date-window scenarios drift stale as the
  real date moves past mid-July 2026.

## Status

Feature-complete and verified end-to-end with a live key (approve / deny /
escalate / hold-the-line / chaos-retry all pass). Published at
https://github.com/scrappergus/northwind-refunds-agent. In-memory state resets
on server restart — restart right before demos for a clean ledger.
