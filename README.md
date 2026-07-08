# Northwind Outfitters — AI Refunds Agent

A fully functional AI customer-support agent that approves, denies, or escalates
e-commerce refund requests. Every decision is grounded in a strict written policy,
enforced by a deterministic policy engine the LLM cannot override, and streamed
live to an admin console as a reasoning trace.

**Two surfaces, one event stream:**

| Surface | URL | What it shows |
|---|---|---|
| Customer chat | `http://localhost:3000` | Pick one of 15 demo customers and request a refund — typed, or spoken via the mic button |
| Agent console | `http://localhost:3000/admin` | Live reasoning trace (thinking, tool calls, retries, failures) + decision ledger |

## Quick start

Requires Docker. Copy the env template and add an Anthropic API key:

```sh
cp .env.local.example .env.local   # then paste your ANTHROPIC_API_KEY
bin/dev up                         # build + start the dev container
bin/browse chat                    # open the customer chat (or: bin/browse admin)
```

`bin/dev` with no arguments opens an fzf picker (`up`, `down`, `sh`, `logs`, …).

Without Docker: `npm install && npm run dev` (Node 20+; Next.js reads
`.env.local` directly).

## Architecture

```
app/page.tsx        Customer chat (streams the reply token by token; voice mode)
app/admin/page.tsx  Agent console (SSE feed of every reasoning/tool event)
app/api/chat        POST — runs one agent turn, streams SSE frames
app/api/logs        GET  — live SSE feed for the admin trace
app/api/state       GET  — decision ledger + customer roster
app/api/chaos       POST — arm a one-shot simulated CRM outage (failure demo)
app/api/speech      POST — text → spoken mp3 (ElevenLabs TTS; voice mode)
app/api/transcribe  POST — recorded audio → text (ElevenLabs Scribe)

lib/agent.ts        The agent loop (raw tool calling on the Anthropic API)
lib/tools.ts        Tool definitions + executors (6 tools)
lib/policy.ts       Deterministic refund-policy engine — the source of truth
lib/store.ts        In-memory event log, decision ledger, SSE pub/sub
lib/speech.ts       Client voice plumbing: ordered playback queue + mic recorder

data/customers.json    Mock CRM: 15 customers, each mapping to a policy scenario
data/refund-policy.md  The strict policy document (rule ids R1.1–R6.2)
```

### The agent loop (`lib/agent.ts`)

Raw function calling — no framework. Each user turn:

1. Claude (`claude-opus-4-8`, adaptive thinking, streaming) receives the policy
   document as a cached system prompt plus the conversation history.
2. When it emits `tool_use` blocks, the server executes them and feeds
   `tool_result` blocks back, looping until the model stops calling tools
   (with a hard `MAX_LOOPS` stop).
3. Every step — thinking summaries, tool inputs/outputs, tool errors, API
   retries with backoff, final decisions — is published to an in-memory event
   store that both the chat stream and the admin console subscribe to.

SDK auto-retry is disabled on purpose: the loop does its own retries so each
attempt is visible in the trace (`retry` events with backoff timing).

### Policy enforcement is code, not vibes

The LLM never decides eligibility by itself:

- `check_refund_eligibility` runs `lib/policy.ts`, a pure function that returns
  `approve | deny | escalate` plus the rule ids applied and the refundable amount.
- `process_refund` **re-runs the same engine** and rejects the call if the claim
  isn't approvable — so even a jailbroken or hallucinating model cannot move
  money against policy. The rejection surfaces as a `tool_error` in the trace
  and the agent recovers by denying or escalating.

### Tools

| Tool | Purpose |
|---|---|
| `lookup_customer` | Verify the customer by email (identity gate, R5.3) |
| `get_order` | Fetch order items, dates, categories, payment method |
| `check_refund_eligibility` | Run the deterministic policy engine over a claim |
| `process_refund` | Execute an approved refund (re-validates; can refuse) |
| `deny_refund` | Record a denial with the rule ids that justify it |
| `escalate_to_human` | Open a human-review ticket (fraud flags, >$400, repeat refunders) |

### Voice mode

The mic button in the chat composer starts a spoken interaction. With an
`ELEVENLABS_API_KEY` set, it works in any modern browser and sounds like a
person: the browser records with `MediaRecorder`, `/api/transcribe` runs the
audio through ElevenLabs Scribe, and the agent's reply segments are synthesized
by `/api/speech` (ElevenLabs Flash) and played in order as each one completes —
so "Let me pull up your order…" plays while the tools run. Tap the mic, talk,
then click Done (or tap the mic again) to send — or just pause: a level meter
on the stream detects end-of-turn and auto-sends. Typed messages stay silent.

Without a key, the chat falls back to the browser Web Speech API
(Chrome/Edge only, OS-grade voice) so local dev needs no extra account. Both
new routes sit behind the same guards as `/api/chat` (Cloudflare Access JWT
check plus a per-IP rate bucket), and the audio path stays outside the agent
loop — the tools and policy engine are unchanged.

## Demo scenarios

Each customer exercises a different corner of `data/refund-policy.md`:

| Customer | Scenario | Expected outcome |
|---|---|---|
| Sarah Chen | Standard return, well inside 30-day window | **Refunded** |
| Marcus Webb | Standard return, ~49 days after delivery | **Denied** (R1.1) |
| Priya Patel | Same age as Marcus, but gold tier → 60-day window | **Refunded** (R1.2) |
| Tom Alvarez | Electronics, day ~22 of a 14-day window | **Denied** (R1.1) |
| Dana Kim | Final-sale clearance tent | **Denied** — try pleading; the agent holds the line |
| Liam O'Connor | Order still in transit | **Denied** (R1.3) |
| Grace Okafor | Account has an internal `fraud_watch` flag | **Escalated** — flag never disclosed |
| Ethan Ross | 3 refunds in the last 12 months | **Escalated** (R5.1) |
| Mia Torres | $649 kayak, over the $400 auto-approve limit | **Escalated** (R3.3) |
| Noah Fischer | Fuel canisters damaged on arrival, reported same day | **Refunded** incl. shipping (R4.2) |
| Ava Lindqvist | Perishables, damage reported ~3 weeks late | **Denied** (R4.1 → R1.1) |
| Jack Murphy | Wants refund sent to a *different* card | **Denied** (R3.1), store credit offered |
| Sofia Ramirez | Two orders: one in window, one long past | Mixed — partial handling |
| Ben Carter | Boots already worn on a muddy trail | **Denied** (R2.1) once condition is disclosed |
| Zoe Nakamura | Small clean return | **Refunded** |

A good "holding the line" demo: Dana Kim (final sale) or Ben Carter — push back,
claim an exception was promised, threaten a chargeback. The agent restates the
decision once and offers escalation (R6.2), and `process_refund` would reject the
claim anyway.

To show failure handling in the trace: click **⚡ simulate CRM outage** in the
admin console. The next tool call throws a (clearly labeled) transient timeout —
the trace shows `tool_call → tool_error → retry of the same call → success`,
and the conversation completes normally.

Two more guards exist server-side but rarely fire live, because the model
refuses first: order ownership (`get_order` throws on another customer's order
id — R5.3) and the `process_refund` policy re-check. They're defense in depth
against a hallucinating or jailbroken model, not just prompt rules.

## Deploying a public demo

A production image is provided (standalone Next build, non-root):

```sh
docker build -f dockerfiles/prod.dockerfile -t northwind-refunds-agent .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DEMO_ADMIN_TOKEN=some-long-secret northwind-refunds-agent
```

Hardening built in for public exposure (all inert in local dev):

- **Per-IP rate limiting** on `/api/chat` (default 20 turns / 5 min;
  `CHAT_RATE_LIMIT` / `CHAT_RATE_WINDOW_SEC`), plus size caps on message
  length, history length, and body size — one agent turn can fan out into
  many model calls, so the expensive endpoint is the guarded one.
- **`DEMO_ADMIN_TOKEN`** (optional): gates the reasoning trace (`/api/logs`),
  the decision ledger, and the failure injector (`/api/chaos`). The console
  shows an unlock form that exchanges the token for an HttpOnly cookie, so it
  never appears in URLs; `x-admin-token` / `?token=` also work for scripting.
  Unset, everything stays open for local use.
- The API key never reaches the browser; `.dockerignore` keeps `.env*` out of
  images. Set a spend cap on the key in the Anthropic console regardless.

## Notes & tradeoffs

- **State is in-memory** (ledger, event log) — restarts reset it. Right-sized
  for a demo; the store module is the seam where Postgres/Redis would go.
- **Prompt caching**: the policy + tool definitions are cached
  (`cache_control: ephemeral`), so multi-turn conversations pay ~10% of the
  input cost after the first turn.
- **Auth is simulated** by the persona picker; the identity gate (R5.3) is
  enforced agent-side via `lookup_customer` + order-ownership checks.
- Mock data is dated around 2026-07; the date-window scenarios assume "today"
  is within a couple of weeks of that.
