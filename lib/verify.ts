import { openrouter, toUsage } from "./providers";
import type { Usage } from "./pricing";

const JUDGE = process.env.MODEL_JUDGE || "openai/gpt-5.4-mini";

export type CitationModel = { model_key: string; snippet: string };
export type Citation = { id: string; models: CitationModel[] };

export type Verdict =
  | { verdict: "verified"; content: string; citations: Citation[] }
  | { verdict: "revised"; content: string; citations: Citation[] }
  | { verdict: "appended"; addendum: string; content: string; citations: Citation[] };

export type SynthesizeResult = { verdict: Verdict; usage: Usage[] };

export type Expert = { key: string; name: string; text: string };

type SynthArgs = {
  question: string;
  baseline: string;
  baselineLabel?: string;
  experts: Expert[];
  skipCompare?: boolean;
  noRevise?: boolean;
};

const CITATION_RULES = [
  "CITATIONS:",
  "- Insert inline markers of the form [[N]] (double-bracketed integer) right after each substantive claim, fact, or recommendation. Numbers start at 1 and increment per distinct citation; reuse the same N if the same claim appears again.",
  "- Do NOT place markers inside fenced code blocks (``` ... ```) or inline code spans (`...`). Place them at the end of the surrounding sentence instead.",
  "- For every marker [[N]] you insert, produce a citations entry with `id: \"N\"` and one or more supporting models in `models`.",
  "- Each `models[i].model_key` MUST be one of the EXPERT keys listed above (e.g. \"reasoned-openai\"). Do not invent keys, do not use model slugs.",
  "- Each `models[i].snippet` MUST be a short verbatim excerpt (5–25 words) copied from that expert's text supporting the claim. Do not paraphrase. Snippets that are not substrings of the cited expert's text will be discarded.",
  "- Cite as many supporting experts as genuinely apply to a claim. Prefer broader corroboration over a single citation when multiple experts agree.",
].join("\n");

function expertBlocks(experts: Expert[]): string {
  const present = experts.filter((e) => e.text.trim());
  return present
    .map(
      (e, i) =>
        `EXPERT ${String.fromCharCode(65 + i)} (key: ${e.key}, model: ${e.name}):\n${e.text}`,
    )
    .join("\n\n");
}

function buildSynthCitationsPrompt(question: string, experts: Expert[]): string {
  const present = experts.filter((e) => e.text.trim());
  const disagreementHint =
    present.length >= 2
      ? `- Explicitly flag any meaningful disagreements in the form "${present[0].name} says X, but ${present[1].name} says Y." Name the models when noting disagreements.`
      : "- If the experts agree, present a unified answer.";

  return [
    "You are synthesizing the single best chat response from multiple expert AI answers to a user question, AND citing which experts support each claim.",
    "",
    "USER QUESTION:",
    question,
    "",
    expertBlocks(experts),
    "",
    "Produce a unified answer that:",
    "- Uses the consensus where the experts agree.",
    disagreementHint,
    "- Reads as a single chat response, not a report.",
    "",
    CITATION_RULES,
    "",
    "Output JSON only, matching the schema { text: string, citations: [{ id, models: [{ model_key, snippet }] }] }.",
  ].join("\n");
}

function buildCombinedJudgePrompt(
  question: string,
  baseline: string,
  baselineLabel: string,
  experts: Expert[],
  noRevise = false,
): string {
  const lc = baselineLabel.toLowerCase();
  const verdictChoices = noRevise
    ? [
        `- "verified" — the experts add nothing substantive vs. the ${lc}; only stylistic/wording differences, OR no clean addendum applies.`,
        `- "appended" — the experts agree with the ${lc} but contain 1–3 small new factual details, examples, or caveats worth surfacing. Do NOT use this if the new content contradicts or restructures the ${lc}.`,
      ]
    : [
        `- "verified" — the experts add nothing substantive vs. the ${lc}; only stylistic/wording differences. The user is equally well-served by the prior answer.`,
        `- "appended" — the experts offer new content (details, examples, caveats, nuance, or a follow-up paragraph) that does NOT contradict the ${lc}. The new material can stand alongside the prior text without rewriting it. Prefer this whenever an overwrite is not strictly required.`,
        `- "revised" — only when the ${lc} is factually wrong, directly contradicted by the experts, or so structurally broken/missing that no addendum can salvage it. Do NOT pick this just because the experts restructure or expand — if the prior answer can stand with new content grafted on, choose "appended" instead.`,
      ];
  const emptyBaselineRule = noRevise
    ? `- If the ${lc} is empty or near-empty, choose "verified" (the prior answer stays as-is; no overwrite is permitted in this call).`
    : `- If the ${lc} is empty or near-empty, do NOT choose "appended" — choose "revised" instead.`;

  return [
    `You are deciding how a panel of expert AI answers should update what a user sees compared to a prior answer (${baselineLabel}). You will also produce inline citations attributing each claim in the displayed text to the supporting experts.`,
    "",
    "USER QUESTION:",
    question,
    "",
    `${baselineLabel}:`,
    baseline,
    "",
    expertBlocks(experts),
    "",
    "Choose exactly one verdict:",
    ...verdictChoices,
    ...(noRevise
      ? []
      : [
          "",
          `- Default to "appended" when the new content can stand alongside the ${lc} without contradicting it. Reserve "revised" for cases where leaving the ${lc} in place would mislead the user.`,
        ]),
    "",
    "Output contract (every verdict must produce a `text` field — the full text the user will see — with [[N]] markers inserted, and a `citations` array):",
    `- "verified" → \`text\` = the ${lc} re-emitted verbatim with [[N]] markers inserted citing experts that corroborate each claim. \`addendum\` = "".`,
    "- \"revised\" → `text` = a new unified answer (synthesizing the experts) with [[N]] markers inserted. `addendum` = \"\".",
    `- "appended" → \`addendum\` = ONLY the new details to graft on (no preamble, no restating the ${lc}; reads naturally as a continuation). \`text\` = the ${lc} verbatim, then a blank line, then the addendum, with [[N]] markers throughout. The text must end with the addendum exactly.`,
    emptyBaselineRule,
    "",
    CITATION_RULES,
    "",
    "Output JSON only.",
  ].join("\n");
}

const CITATION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            model_key: { type: "string" },
            snippet: { type: "string" },
          },
          required: ["model_key", "snippet"],
          additionalProperties: false,
        },
      },
    },
    required: ["id", "models"],
    additionalProperties: false,
  },
} as const;

const SYNTH_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    citations: CITATION_SCHEMA,
  },
  required: ["text", "citations"],
  additionalProperties: false,
} as const;

const COMBINED_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["verified", "revised", "appended"] },
    text: { type: "string" },
    addendum: { type: "string" },
    citations: CITATION_SCHEMA,
  },
  required: ["verdict", "text", "addendum", "citations"],
  additionalProperties: false,
} as const;

const COMBINED_SCHEMA_NO_REVISE = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["verified", "appended"] },
    text: { type: "string" },
    addendum: { type: "string" },
    citations: CITATION_SCHEMA,
  },
  required: ["verdict", "text", "addendum", "citations"],
  additionalProperties: false,
} as const;

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function snippetIsValid(snippet: string, fullText: string): boolean {
  const a = normalizeForMatch(snippet);
  const b = normalizeForMatch(fullText);
  if (a.length < 3) return false;
  return b.includes(a);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifyAndPrune(
  text: string,
  citations: Citation[],
  experts: Expert[],
): { text: string; citations: Citation[] } {
  const expertByKey = new Map(experts.map((e) => [e.key, e.text]));
  const kept: Citation[] = [];
  const droppedIds: string[] = [];
  for (const c of citations) {
    const validModels: CitationModel[] = [];
    const seen = new Set<string>();
    for (const m of c.models) {
      if (seen.has(m.model_key)) continue;
      const expertText = expertByKey.get(m.model_key);
      if (expertText && snippetIsValid(m.snippet, expertText)) {
        validModels.push(m);
        seen.add(m.model_key);
      }
    }
    if (validModels.length > 0) {
      kept.push({ id: c.id, models: validModels });
    } else {
      droppedIds.push(c.id);
    }
  }

  let outText = text;
  for (const id of droppedIds) {
    const re = new RegExp(`\\s*\\[\\[${escapeRegex(id)}\\]\\]`, "g");
    outText = outText.replace(re, "");
  }
  return { text: outText, citations: kept };
}

type ParsedSynth = { text: string; citations: Citation[] };
type ParsedCombined = {
  verdict: "verified" | "revised" | "appended";
  text: string;
  addendum: string;
  citations: Citation[];
};

function parseSynth(raw: string): ParsedSynth | null {
  try {
    const obj = JSON.parse(raw) as ParsedSynth;
    if (typeof obj.text !== "string") return null;
    if (!Array.isArray(obj.citations)) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCombined(raw: string): ParsedCombined | null {
  try {
    const obj = JSON.parse(raw) as ParsedCombined;
    if (typeof obj.text !== "string") return null;
    if (typeof obj.addendum !== "string") return null;
    if (!Array.isArray(obj.citations)) return null;
    if (
      obj.verdict !== "verified" &&
      obj.verdict !== "revised" &&
      obj.verdict !== "appended"
    ) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

export async function synthesize(a: SynthArgs): Promise<SynthesizeResult> {
  const usage: Usage[] = [];
  const baselineLabel = a.baselineLabel ?? "INITIAL FAST ANSWER";
  const presentExperts = a.experts.filter((e) => e.text.trim());

  if (presentExperts.length === 0) {
    return {
      verdict: { verdict: "verified", content: a.baseline, citations: [] },
      usage,
    };
  }

  if (a.skipCompare) {
    const resp = await openrouter().chat.completions.create({
      model: JUDGE,
      messages: [
        {
          role: "user",
          content: buildSynthCitationsPrompt(a.question, presentExperts),
        },
      ],
      reasoning: { effort: "minimal" },
      response_format: {
        type: "json_schema",
        json_schema: { name: "synth", schema: SYNTH_SCHEMA, strict: true },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usage.push(toUsage(JUDGE, resp.usage as any));

    const raw = resp.choices[0]?.message?.content?.trim() ?? "";
    const parsed = parseSynth(raw);
    if (!parsed || !parsed.text.trim()) {
      return {
        verdict: { verdict: "verified", content: a.baseline, citations: [] },
        usage,
      };
    }
    const { text, citations } = verifyAndPrune(
      parsed.text,
      parsed.citations,
      presentExperts,
    );
    return {
      verdict: { verdict: "revised", content: text, citations },
      usage,
    };
  }

  const resp = await openrouter().chat.completions.create({
    model: JUDGE,
    messages: [
      {
        role: "user",
        content: buildCombinedJudgePrompt(
          a.question,
          a.baseline,
          baselineLabel,
          presentExperts,
          a.noRevise,
        ),
      },
    ],
    reasoning: { effort: "minimal" },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "judge",
        schema: a.noRevise ? COMBINED_SCHEMA_NO_REVISE : COMBINED_SCHEMA,
        strict: true,
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usage.push(toUsage(JUDGE, resp.usage as any));

  const raw = resp.choices[0]?.message?.content ?? "{}";
  const parsed = parseCombined(raw);
  if (!parsed) {
    return {
      verdict: { verdict: "verified", content: a.baseline, citations: [] },
      usage,
    };
  }

  const { text: cleanedText, citations: cleanedCites } = verifyAndPrune(
    parsed.text,
    parsed.citations,
    presentExperts,
  );

  if (parsed.verdict === "verified") {
    return {
      verdict: { verdict: "verified", content: cleanedText, citations: cleanedCites },
      usage,
    };
  }

  if (parsed.verdict === "appended") {
    const addendum = parsed.addendum.trim();
    if (addendum && a.baseline.trim() && cleanedText.trim()) {
      return {
        verdict: {
          verdict: "appended",
          addendum,
          content: cleanedText,
          citations: cleanedCites,
        },
        usage,
      };
    }
    if (a.noRevise) {
      return {
        verdict: { verdict: "verified", content: a.baseline, citations: [] },
        usage,
      };
    }
    return {
      verdict: { verdict: "revised", content: cleanedText, citations: cleanedCites },
      usage,
    };
  }

  // revised
  if (a.noRevise) {
    return {
      verdict: { verdict: "verified", content: a.baseline, citations: [] },
      usage,
    };
  }
  return {
    verdict: { verdict: "revised", content: cleanedText, citations: cleanedCites },
    usage,
  };
}
