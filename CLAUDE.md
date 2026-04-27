# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Next.js dev server (http://localhost:3000)
npm run build          # Production build
npm run start          # Run the built app
npm run lint           # next lint (deprecated, may prompt to migrate)
npx tsc --noEmit       # Typecheck — use this as the primary correctness gate
```

There is no test suite. Use `npx tsc --noEmit` plus an end-to-end curl smoke test against `/api/chat` (see "Smoke test" below) to validate changes.

## Required environment

Primary key: `OPENROUTER_API_KEY` in `.env.local`. All four chat-model vendors (OpenAI, Anthropic, Google, xAI) are reached through OpenRouter — there are no per-vendor SDK clients for chat.

Voice input is the one exception: OpenRouter does not proxy audio. The mic button streams live to OpenAI via WebRTC. `/api/realtime-token` mints an ephemeral `client_secret` from `/v1/realtime/client_secrets` (model: `gpt-4o-transcribe`); the browser opens a peer connection directly to OpenAI and consumes `conversation.item.input_audio_transcription.delta` events. Set `OPENAI_API_KEY` only if you want voice input. The standard key never leaves the server.

Optional: `OPENROUTER_REFERER`, `MODEL_JUDGE`. See `.env.local.example`.

## Architecture

The whole product is a single Next.js App Router page (`app/page.tsx`) backed by one streaming endpoint (`app/api/chat/route.ts`). Everything else is supporting library code.

### The 3-stage answer flow

The core idea: every user question is answered by **three stages running concurrently**, each producing a candidate answer, with later stages able to revise earlier ones.

| Stage | Effort | Models | Purpose |
|---|---|---|---|
| `fast` | minimal | 1 model, streamed | Sub-second feel |
| `reasoned` | medium | top-tier multi-vendor | ~1 minute, can revise |
| `deep` | high | top-tier multi-vendor | Slowest, can revise |

The lineup is defined in **`lib/providers.ts:STAGES`** — that is the single source of truth for which models run at which effort. Adding/removing models means editing this array. Frontend chip rows, sidebar metadata, and per-provider cost grouping are all derived from it.

Stages 2 and 3 fire in parallel with stage 1's stream. As each non-fast stage's models all finish, `lib/verify.ts:synthesize()` runs **independently per stage** with that stage's outputs vs. the instant answer, producing `verified` (no change worth showing) or `revised` (new content). This means the user can see up to three distinct versions of an answer (`fast`, `reasoned`, `deep`) and toggle between them.

### Server → client event protocol

`/api/chat` returns NDJSON (one JSON event per line) over a `ReadableStream`. The full event vocabulary lives in `app/api/chat/route.ts` as the `Event` union — keep it in sync with the parser switch in `app/page.tsx`'s `send()` function. Key events:

- `stages` — stage config (sent first; drives the chip layout)
- `chunk` / `instant_done` — fast stream
- `stage_started` / `stage_done` — per-stage progress (drives stage-row spinners)
- `verifier` / `model_response` — per-model status and full response payload (text + usage + cost)
- `stage_verdict` — `{ stage, verdict, content? }` from per-stage synthesis (drives the version toggle)
- `cost` / `done`

Adding a new event requires changes in three places: emit in `route.ts`, parse in `page.tsx`, and update the `Event` union.

### Versioned content (frontend)

`AssistantMessage.versions: { fast?, reasoned?, deep? }` holds at most three text snapshots. A version key is set when:
- `fast` — on `instant_done`, from the accumulated stream buffer
- `reasoned` / `deep` — only when that stage's `stage_verdict` is `"revised"` (verified stages don't add a version)

The toggle bar renders one button per *available* version. Default display = latest available (`deep > reasoned > fast`); explicit clicks pin a choice in `pickedVersion`. `canonicalAssistantText()` defines what gets sent back to the API for follow-up turns (also `deep > reasoned > fast`).

### Cost accounting

OpenRouter returns `usage.cost` (USD) on every response — there is **no local price table**. `lib/pricing.ts` only contains the `Usage` type and a `providerFromModel()` helper that buckets costs by slug prefix (`openai/`, `anthropic/`, `google/`, `x-ai/`). The route aggregates per-provider totals into a `cost` event at the end of the flow.

### Model sidebar

Clicking any chip opens a fixed-position sidebar (`ModelSidebar` in `page.tsx`) showing that call's full markdown response and metadata (model id, stage, reasoning effort, tokens, cost). The data source is `AssistantMessage.responses[key]`, populated from `model_response` events.

## Smoke test

After non-trivial changes to the route or provider layer:

```bash
curl -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}' --max-time 240
```

Expect (in order): one `stages` event, fast-stage `chunk`s, `instant_done`, then per-model `verifier` + `model_response` events for every non-fast model (currently 8), two `stage_verdict` events, a `cost` event, and `done`. Errors from individual models surface as `model_response` events with an `error` field — the flow keeps going.
