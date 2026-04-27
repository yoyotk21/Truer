import OpenAI from "openai";
import type { Usage } from "./pricing";

export type Msg = { role: "user" | "assistant"; content: string };

const SYSTEM =
  "You are a helpful assistant. Answer the user directly and concisely. If the question is ambiguous, state your assumption and answer.";

const FAST_SYSTEM = [
  "You are the fast first-pass answer in a multi-stage system. A more thorough answer will follow within seconds, so your job is a headline, not a full response.",
  "",
  "Rules:",
  "- Answer in 1–3 sentences. Use up to 5 short bullets only if the question is inherently a list.",
  "- No preamble, no restating the question, no closing offers (\"let me know if…\").",
  "- Lead with the direct answer; skip hedging and caveats unless they change the answer.",
  "- If the question is ambiguous, state one assumption in a short clause and answer.",
].join("\n");

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type StageId = "fast" | "reasoned" | "deep";

export type StageModel = {
  key: string;
  model: string;
  effort: ReasoningEffort;
};

export type Stage = {
  id: StageId;
  label: string;
  description: string;
  models: StageModel[];
};

export const STAGES: Stage[] = [
  {
    id: "fast",
    label: "Instant",
    description: "Streamed immediately",
    models: [
      { key: "fast", model: "openai/gpt-5.4-mini", effort: "minimal" },
    ],
  },
  {
    id: "reasoned",
    label: "Reasoned",
    description: "Top models, medium reasoning",
    models: [
      { key: "reasoned-openai", model: "openai/gpt-5.5", effort: "medium" },
      { key: "reasoned-anthropic", model: "anthropic/claude-opus-4.7", effort: "medium" },
      { key: "reasoned-google", model: "google/gemini-3.1-pro-preview", effort: "medium" },
      { key: "reasoned-grok", model: "x-ai/grok-4.20", effort: "medium" },
    ],
  },
  {
    id: "deep",
    label: "Deep",
    description: "Top models, high reasoning",
    models: [
      { key: "deep-openai", model: "openai/gpt-5.5", effort: "high" },
      { key: "deep-anthropic", model: "anthropic/claude-opus-4.7", effort: "high" },
      { key: "deep-google", model: "google/gemini-3.1-pro-preview", effort: "high" },
      { key: "deep-grok", model: "x-ai/grok-4.20", effort: "high" },
    ],
  },
];

export function findStageModel(key: string): { stage: Stage; model: StageModel } | null {
  for (const s of STAGES) {
    const m = s.models.find((m) => m.key === key);
    if (m) return { stage: s, model: m };
  }
  return null;
}

const FAST = STAGES[0].models[0];

let _client: OpenAI | null = null;
export function openrouter(): OpenAI {
  if (!_client) {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
    _client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "http://localhost",
        "X-Title": "Answer",
      },
    });
  }
  return _client;
}

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
} | null | undefined;

export function toUsage(model: string, u: RawUsage): Usage {
  const inputTokens = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const reasoning = u?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    model,
    inputTokens,
    outputTokens: completion + reasoning,
    cost: u?.cost ?? 0,
  };
}

export type CallResult = { text: string; usage: Usage };
export type StreamYield =
  | { kind: "chunk"; text: string }
  | { kind: "usage"; usage: Usage };

export async function* streamFast(messages: Msg[]): AsyncGenerator<StreamYield> {
  const stream = (await openrouter().chat.completions.create({
    model: FAST.model,
    messages: [{ role: "system", content: FAST_SYSTEM }, ...messages],
    reasoning: { effort: FAST.effort },
    stream: true,
    stream_options: { include_usage: true },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as unknown as AsyncIterable<{
    choices: { delta?: { content?: string } }[];
    usage?: RawUsage;
  }>;

  let finalUsage: RawUsage = null;

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield { kind: "chunk", text };
    if (chunk.usage) finalUsage = chunk.usage;
  }

  yield { kind: "usage", usage: toUsage(FAST.model, finalUsage) };
}

export async function callModel(m: StageModel, messages: Msg[]): Promise<CallResult> {
  const resp = await openrouter().chat.completions.create({
    model: m.model,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    reasoning: { effort: m.effort },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const text = resp.choices[0]?.message?.content ?? "";
  return { text, usage: toUsage(m.model, resp.usage as RawUsage) };
}
