# Answer

A chat UI that answers every question with **three concurrent stages** — an instant streamed reply, a medium-reasoning panel, and a high-reasoning panel — and lets later stages revise earlier ones. Each non-instant stage runs four frontier models from different vendors in parallel and synthesizes them into a single answer with inline citations back to the supporting models.

All four vendors (OpenAI, Anthropic, Google, xAI) are reached through a single [OpenRouter](https://openrouter.ai) API key. There are no per-vendor SDKs and no local price table — OpenRouter reports the USD cost of every call.

## How it works

| Stage | Effort | Models | Behavior |
|---|---|---|---|
| **Instant** | minimal | 1 model, streamed | Sub-second headline answer |
| **Reasoned** | medium | 4 models, parallel | ~1 minute, can revise the instant answer |
| **Deep** | high | 4 models, parallel | Slowest, can revise either prior answer |

Stages 2 and 3 fire in parallel with stage 1's stream. As each non-instant stage's models finish, a judge model synthesizes their outputs against the prior baseline and returns one of:

- **verified** — experts add nothing substantive; keep the prior answer.
- **appended** — experts agree but add 1–3 details; graft them onto the prior answer.
- **revised** — prior answer was wrong or incomplete; replace it.

The user can see up to three distinct versions of an answer (`fast`, `reasoned`, `deep`) and toggle between them. Inline `[[N]]` markers attribute each claim to the supporting expert models, with verbatim snippets.

## Features

- **Multi-vendor parallel answers.** Every non-instant stage queries OpenAI, Anthropic, Google, and xAI top models simultaneously.
- **Streaming-first UX.** The instant stage starts streaming tokens immediately; reasoned and deep stages backfill as they complete.
- **Inline citations.** Claims in the synthesized answer link to verbatim snippets from the supporting models. Snippets that aren't substring-matched against the source are pruned automatically.
- **Per-model sidebar.** Click any model chip to see that call's full markdown response, model id, reasoning effort, tokens, and cost.
- **Per-provider cost accounting.** Every response's `usage.cost` is summed and grouped by vendor at the end of each turn.
- **Persistent sessions.** Conversations and per-session totals are stored in a local SQLite database (`data/sessions.db`) and listed in a sidebar with full-text search.

## Quick start

```bash
git clone <repo-url> answer
cd answer
npm install
cp .env.local.example .env.local        # then add your OPENROUTER_API_KEY
npm run dev
```

Open http://localhost:3000.

## Environment

| Var | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | Single key for all model calls |
| `OPENROUTER_REFERER` | no | `HTTP-Referer` header for OpenRouter app attribution |
| `MODEL_JUDGE` | no | Override the synthesis/judge model (default `openai/gpt-5.4-mini`) |

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
  -d '{"messages":[{"role":"user","content":"hi"}]}' --max-time 240
```

Expect (in order): one `stages` event, instant-stage `chunk`s, `instant_done`, then per-model `verifier` + `model_response` events for every non-instant model, two `stage_verdict` events, a `cost` event, and `done`. Errors from individual models surface as `model_response` events with an `error` field — the flow keeps going.

## Architecture

```
app/
  page.tsx               Single-page UI: composer, message list, chip rows,
                         version toggle, model sidebar, sessions sidebar
  api/
    chat/route.ts        NDJSON streaming endpoint; orchestrates the 3 stages
    sessions/...         List, load, search, delete persisted sessions
lib/
  providers.ts           STAGES config, OpenRouter client, streamFast, callModel
  verify.ts              Judge prompts, verdict logic, citation pruning
  pricing.ts             Usage type + provider bucketing by slug prefix
  db.ts                  SQLite (better-sqlite3) session/message storage
  title.ts               Auto-generates session titles
data/sessions.db         Local SQLite database (gitignored)
```

The server speaks NDJSON over a `ReadableStream`. Each line is one JSON event; the full vocabulary is the `Event` union in `app/api/chat/route.ts`, parsed by `send()` in `app/page.tsx`. Adding an event requires changes in three places: emit in the route, parse in the page, and update the `Event` union.

## Tech stack

- **Next.js 15** (App Router) + **React 19**
- **TypeScript**
- **Tailwind CSS v4** with `@tailwindcss/typography`
- **react-markdown** + **remark-gfm** for rendering
- **better-sqlite3** for session storage
- **OpenRouter** as the single model gateway

## License

MIT.
