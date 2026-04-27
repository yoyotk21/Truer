# Answer

A chat UI that answers every question with **three concurrent stages** — an instant streamed reply, a medium-reasoning panel, and a high-reasoning panel — and lets later stages revise earlier ones. Each non-instant stage runs four frontier models from different vendors in parallel and synthesizes them into a single answer with inline citations back to the supporting models.

All four chat-model vendors (OpenAI, Anthropic, Google, xAI) are reached through a single [OpenRouter](https://openrouter.ai) API key. There are no per-vendor SDKs and no local price table — OpenRouter reports the USD cost of every call.

## How it works

| Stage | Effort | Models | Behavior |
|---|---|---|---|
| **Instant** | minimal | 1 model, streamed | Sub-second headline answer |
| **Reasoned** | medium | 4 models, parallel | ~1 minute, can revise the instant answer |
| **Deep** | high | 4 models, parallel | Slowest, can revise either prior answer |

Stages 2 and 3 fire in parallel with stage 1's stream. As each non-instant stage's models finish, a judge model synthesizes their outputs against the prior baseline and returns one of:

- **verified** — experts add nothing substantive; keep the prior answer.
- **appended** — experts agree but add 1–3 small details, examples, or caveats; graft them onto the prior answer.
- **revised** — prior answer was wrong or incomplete; replace it.

The user can see up to three distinct versions of an answer (`fast`, `reasoned`, `deep`) and toggle between them. Inline `[[N]]` markers attribute each claim to the supporting expert models, with verbatim snippets that are pruned automatically if they don't substring-match the source.

## Features

- **Multi-vendor parallel answers.** Every non-instant stage queries OpenAI, Anthropic, Google, and xAI top models simultaneously.
- **Streaming-first UX.** The instant stage starts streaming tokens immediately; reasoned and deep stages backfill as they complete, with a token-level rewrite animation when a verdict revises the visible answer.
- **Inline citations.** Claims in the synthesized answer link to verbatim snippets from the supporting models. Snippets that aren't substring-matched against the source are pruned automatically.
- **Voice input.** A mic button streams audio directly from the browser to OpenAI's Realtime API over WebRTC for live transcription (`gpt-4o-transcribe`). Requires a separate `OPENAI_API_KEY` because OpenRouter does not proxy audio; the key never leaves the server — `/api/realtime-token` mints an ephemeral `client_secret` per session.
- **Per-model mute.** Click any model chip to deactivate it for the next turn; the route honors a `deactivatedKeys` list and skips those models entirely.
- **Per-model sidebar.** Click a chip to open a fixed sidebar showing that call's full markdown response, model id, reasoning effort, tokens, and cost.
- **Per-provider cost accounting.** Every response's `usage.cost` is summed and grouped by vendor (OpenAI / Anthropic / Google / xAI) at the end of each turn.
- **Persistent sessions.** Conversations and per-session totals are stored in a local SQLite database (`data/sessions.db`) and listed in a sidebar with full-text search. Titles are auto-generated on the first turn.

## Setup

### 1. Prerequisites

- **Node.js 20+** (Next.js 15 requires ≥ 18.18, and `better-sqlite3` ships prebuilds for current LTS).
- **npm** (ships with Node).
- A C/C++ toolchain available on your `PATH` in case `better-sqlite3` has to build from source: Xcode Command Line Tools on macOS (`xcode-select --install`), `build-essential` on Debian/Ubuntu, or the "Desktop development with C++" workload on Windows.
- An [OpenRouter](https://openrouter.ai) account and API key. You'll add credit there once and it covers every chat-model call (OpenAI, Anthropic, Google, xAI).
- *Optional, voice input only:* an OpenAI account and API key with access to the Realtime API and `gpt-4o-transcribe`. OpenRouter does not proxy audio, so this is a separate key.

### 2. Clone and install

```bash
git clone <repo-url> answer
cd answer
npm install
```

`npm install` will compile the native `better-sqlite3` binding the first time. If it fails, install the toolchain above and re-run.

### 3. Configure environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in at minimum:

```env
# Required — get one at https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-...

# Optional — only needed if you want to use the mic button.
# OPENAI_API_KEY=sk-...

# Optional — sent as HTTP-Referer to OpenRouter for app attribution.
# OPENROUTER_REFERER=http://localhost:3000

# Optional — override the synthesis/judge model.
# MODEL_JUDGE=openai/gpt-5.4-mini
```

Full reference:

| Var | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | Single key for all chat-model calls |
| `OPENAI_API_KEY` | only for voice | Server-only key used by `/api/realtime-token` to mint ephemeral session tokens for browser-side WebRTC transcription |
| `OPENROUTER_REFERER` | no | `HTTP-Referer` header for OpenRouter app attribution |
| `MODEL_JUDGE` | no | Override the synthesis/judge model (default `openai/gpt-5.4-mini`) |

### 4. Run the dev server

```bash
npm run dev
```

Open http://localhost:3000. The first request creates `data/sessions.db` automatically — no migrations to run. Sessions, messages, and per-session cost totals persist across restarts; the `data/` directory is gitignored.

### 5. Production build (optional)

```bash
npm run build
npm run start
```

`next start` serves the production bundle on port 3000 by default; override with `PORT=4000 npm run start`. The same `.env.local` is loaded.

### Troubleshooting

- **`OPENROUTER_API_KEY not set`** at the first request — `.env.local` is missing, in the wrong directory, or the dev server was started before the file existed. Restart `npm run dev`.
- **`better-sqlite3` build errors** — install the C/C++ toolchain listed above, then `rm -rf node_modules && npm install`.
- **Mic button shows an error / silent transcription** — `OPENAI_API_KEY` is missing or the account lacks Realtime API access. Chat still works without it.
- **No models respond** — check the OpenRouter dashboard for credit balance and model availability. Individual model failures surface as `model_response` events with an `error` field; the rest of the flow continues.

## Configuring models

The lineup of models per stage lives in [`lib/providers.ts`](lib/providers.ts) as the `STAGES` array. That is the single source of truth — frontend chip rows, sidebar metadata, and per-provider cost grouping are all derived from it. To add, remove, or swap a model, edit that array.

## Scripts

```bash
npm run dev            # Next.js dev server
npm run build          # Production build
npm run start          # Run the built app
npm run lint           # next lint
npx tsc --noEmit       # Typecheck (primary correctness gate)
```

## Smoke test

There is no test suite. After non-trivial changes to the route or provider layer, run a curl against the streaming endpoint:

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke-1","messages":[{"role":"user","content":"hi"}]}' --max-time 240
```

Expect (in order): one `stages` event, instant-stage `chunk`s, `instant_done`, then per-model `verifier` + `model_response` events for every active non-instant model, two `stage_verdict` events (one for `reasoned`, one for `deep`), a `cost` event, and `done`. Errors from individual models surface as `model_response` events with an `error` field — the flow keeps going.

## Architecture

```
app/
  page.tsx                 Single-page UI: composer, message list, chip rows,
                           version toggle, mic button, citation popovers,
                           model sidebar, sessions sidebar
  api/
    chat/route.ts          NDJSON streaming endpoint; orchestrates the 3 stages
    realtime-token/route.ts Mints ephemeral OpenAI Realtime client_secret for voice
    sessions/route.ts      List sessions
    sessions/search/route.ts  Full-text search across titles and messages
    sessions/[id]/route.ts Load / delete a session
lib/
  providers.ts             STAGES config, OpenRouter client, streamFast, callModel
  verify.ts                Judge prompts, verdict logic, citation pruning
  pricing.ts               Usage type + provider bucketing by slug prefix
  db.ts                    SQLite (better-sqlite3) session/message storage
  title.ts                 Auto-generates session titles
data/sessions.db           Local SQLite database (gitignored)
```

The server speaks NDJSON over a `ReadableStream`. Each line is one JSON event; the full vocabulary is the `Event` union in `app/api/chat/route.ts`, parsed by `send()` in `app/page.tsx`. Adding an event requires changes in three places: emit in the route, parse in the page, and update the `Event` union.

The reasoned stage is internally staged: as soon as the first two of its four models return, the judge produces a first-pass synthesis (no overwrite of `fast` permitted) so the deep stage has a baseline to compare against. When the remaining reasoned models land, a second internal synthesis can upgrade that baseline before deep's verdict runs.

## Tech stack

- **Next.js 15** (App Router) + **React 19**
- **TypeScript**
- **Tailwind CSS v4** with `@tailwindcss/typography`
- **react-markdown** + **remark-gfm** for rendering
- **better-sqlite3** for session storage
- **OpenRouter** as the single chat-model gateway
- **OpenAI Realtime API** over WebRTC for voice transcription (optional)

## License

MIT.
