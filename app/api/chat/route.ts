import { NextRequest } from "next/server";
import {
  streamFast,
  callModel,
  STAGES,
  type Msg,
  type Stage,
  type StageId,
  type StageModel,
} from "@/lib/providers";
import { synthesize, type Expert, type Citation } from "@/lib/verify";
import { providerFromModel, type Usage } from "@/lib/pricing";
import {
  ensureSession,
  appendMessage,
  addCost,
  setTitle,
  nextIdx,
} from "@/lib/db";
import { generateTitle, fallbackTitle } from "@/lib/title";

export const runtime = "nodejs";
export const maxDuration = 300;

type PerProvider = { openai: number; anthropic: number; google: number; xai: number };

type StoredModelResponse = {
  key: string;
  stage: StageId;
  model: string;
  effort: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error?: string;
};

type StoredAssistant = {
  role: "assistant";
  versions: { fast?: string; reasoned?: string; deep?: string };
  verdicts: {
    reasoned?: "verified" | "revised" | "appended";
    deep?: "verified" | "revised" | "appended";
  };
  addenda: { reasoned?: string; deep?: string };
  citations: { reasoned?: Citation[]; deep?: Citation[] };
  responses: Record<string, StoredModelResponse>;
  cost: { perProvider: PerProvider; total: number };
};

type ModelResponseEvent = StoredModelResponse & { type: "model_response" };

type Event =
  | { type: "stages"; stages: Stage[] }
  | { type: "chunk"; data: string }
  | { type: "instant_done" }
  | { type: "stage_started"; stage: StageId }
  | { type: "stage_done"; stage: StageId }
  | { type: "verifier"; key: string; status: "done" | "error" }
  | {
      type: "stage_verdict";
      stage: StageId;
      verdict: "verified" | "revised" | "appended";
      content?: string;
      addendum?: string;
      citations?: Citation[];
    }
  | { type: "cost"; perProvider: PerProvider; total: number }
  | ModelResponseEvent
  | { type: "error"; message: string }
  | { type: "done" };

type ModelOutcome = { model: StageModel; result: { text: string; usage: Usage } | null };

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    messages?: Msg[];
    sessionId?: string;
    deactivatedKeys?: string[];
  };
  const messages = body.messages ?? [];
  const sessionId = body.sessionId;
  const dead = new Set<string>(body.deactivatedKeys ?? []);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "messages must end with a user turn" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return new Response(JSON.stringify({ error: "sessionId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const lastUserContent = messages[messages.length - 1].content;
  const now = Date.now();
  ensureSession(sessionId, now);
  const isFirstTurn = nextIdx(sessionId) === 0;
  if (isFirstTurn) setTitle(sessionId, fallbackTitle(lastUserContent));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: Event) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));

      const stored: StoredAssistant = {
        role: "assistant",
        versions: {},
        verdicts: {},
        addenda: {},
        citations: {},
        responses: {},
        cost: { perProvider: { openai: 0, anthropic: 0, google: 0, xai: 0 }, total: 0 },
      };

      try {
        send({ type: "stages", stages: STAGES });

        const usages: Usage[] = [];

        const recordModelResponse = (r: StoredModelResponse) => {
          stored.responses[r.key] = r;
        };

        const sendModelResponse = (
          stage: StageId,
          m: StageModel,
          result: { text: string; usage: Usage } | { error: string },
        ) => {
          const r: StoredModelResponse =
            "error" in result
              ? {
                  key: m.key,
                  stage,
                  model: m.model,
                  text: "",
                  effort: m.effort,
                  inputTokens: 0,
                  outputTokens: 0,
                  cost: 0,
                  error: result.error,
                }
              : {
                  key: m.key,
                  stage,
                  model: m.model,
                  text: result.text,
                  effort: m.effort,
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  cost: result.usage.cost,
                };
          recordModelResponse(r);
          send({ type: "model_response", ...r });
        };

        const launchStageModels = (stage: Stage): Promise<ModelOutcome>[] => {
          send({ type: "stage_started", stage: stage.id });
          const active = stage.models.filter((m) => !dead.has(m.key));
          return active.map(async (m): Promise<ModelOutcome> => {
            try {
              const r = await callModel(m, messages);
              send({ type: "verifier", key: m.key, status: "done" });
              sendModelResponse(stage.id, m, r);
              usages.push(r.usage);
              return { model: m, result: r };
            } catch (e) {
              send({ type: "verifier", key: m.key, status: "error" });
              sendModelResponse(stage.id, m, {
                error: e instanceof Error ? e.message : "error",
              });
              return { model: m, result: null };
            }
          });
        };

        const runStageModels = async (stage: Stage): Promise<ModelOutcome[]> => {
          const settled = await Promise.all(launchStageModels(stage));
          send({ type: "stage_done", stage: stage.id });
          return settled;
        };

        type StagedOutcomes = {
          firstN: Promise<ModelOutcome[]>;
          all: Promise<ModelOutcome[]>;
        };

        const startStagedModels = (stage: Stage, n: number): StagedOutcomes => {
          const promises = launchStageModels(stage);
          const all = Promise.all(promises).then((outs) => {
            send({ type: "stage_done", stage: stage.id });
            return outs;
          });
          const target = Math.min(n, promises.length);
          const firstN = new Promise<ModelOutcome[]>((resolve) => {
            if (target === 0) {
              resolve([]);
              return;
            }
            const done: ModelOutcome[] = [];
            for (const p of promises) {
              p.then((o) => {
                done.push(o);
                if (done.length === target) resolve(done.slice());
              });
            }
          });
          return { firstN, all };
        };

        const reasonedStage = STAGES.find((s) => s.id === "reasoned")!;
        const deepStage = STAGES.find((s) => s.id === "deep")!;
        const fastStage = STAGES.find((s) => s.id === "fast")!;
        const fastModel = fastStage.models[0];

        const reasonedStaged = startStagedModels(reasonedStage, 2);
        const deepOutcomesP = runStageModels(deepStage);

        send({ type: "stage_started", stage: "fast" });
        let instant = "";
        let fastUsage: Usage | null = null;
        if (!dead.has(fastModel.key)) {
          for await (const ev of streamFast(messages)) {
            if (ev.kind === "chunk") {
              instant += ev.text;
              send({ type: "chunk", data: ev.text });
            } else {
              usages.push(ev.usage);
              fastUsage = ev.usage;
            }
          }
          send({ type: "instant_done" });
          stored.versions.fast = instant;
          if (fastUsage) {
            sendModelResponse("fast", fastModel, { text: instant, usage: fastUsage });
          }
          send({ type: "verifier", key: fastModel.key, status: "done" });
        } else {
          send({ type: "instant_done" });
        }
        send({ type: "stage_done", stage: "fast" });

        if (isFirstTurn) {
          void generateTitle(sessionId, lastUserContent, instant);
        }

        const synthesizeStage = async (
          stageId: Exclude<StageId, "fast">,
          outcomes: ModelOutcome[],
          baseline: string,
          baselineLabel: string,
          skipCompare = false,
          noRevise = false,
        ): Promise<string> => {
          const experts: Expert[] = outcomes
            .filter((o) => o.result)
            .map((o) => ({ key: o.model.key, name: o.model.model, text: o.result!.text }));
          if (experts.length === 0) {
            stored.verdicts[stageId] = "verified";
            send({ type: "stage_verdict", stage: stageId, verdict: "verified" });
            return baseline;
          }
          const { verdict, usage: judgeUsage } = await synthesize({
            question: lastUserContent,
            baseline,
            baselineLabel,
            experts,
            skipCompare,
            noRevise,
          });
          usages.push(...judgeUsage);
          if (verdict.verdict === "verified") {
            stored.verdicts[stageId] = "verified";
            stored.versions[stageId] = verdict.content;
            stored.citations[stageId] = verdict.citations;
            delete stored.addenda[stageId];
            send({
              type: "stage_verdict",
              stage: stageId,
              verdict: "verified",
              content: verdict.content,
              citations: verdict.citations,
            });
            return verdict.content;
          }
          if (verdict.verdict === "appended") {
            stored.verdicts[stageId] = "appended";
            stored.versions[stageId] = verdict.content;
            stored.addenda[stageId] = verdict.addendum;
            stored.citations[stageId] = verdict.citations;
            send({
              type: "stage_verdict",
              stage: stageId,
              verdict: "appended",
              content: verdict.content,
              addendum: verdict.addendum,
              citations: verdict.citations,
            });
            return verdict.content;
          }
          stored.verdicts[stageId] = "revised";
          stored.versions[stageId] = verdict.content;
          stored.citations[stageId] = verdict.citations;
          delete stored.addenda[stageId];
          send({
            type: "stage_verdict",
            stage: stageId,
            verdict: "revised",
            content: verdict.content,
            citations: verdict.citations,
          });
          return verdict.content;
        };

        const reasonedFirstSynthP: Promise<string> = reasonedStaged.firstN.then((o) =>
          synthesizeStage("reasoned", o, instant, "INITIAL FAST ANSWER", true),
        );

        const reasonedBaselineForDeepP: Promise<string> = (async () => {
          const allOuts = await reasonedStaged.all;
          const firstAnswer = await reasonedFirstSynthP;
          const experts: Expert[] = allOuts
            .filter((o) => o.result)
            .map((o) => ({ key: o.model.key, name: o.model.model, text: o.result!.text }));
          if (experts.length === 0) return firstAnswer;
          const { verdict, usage: judgeUsage } = await synthesize({
            question: lastUserContent,
            baseline: instant,
            baselineLabel: "INITIAL FAST ANSWER",
            experts,
            skipCompare: true,
          });
          usages.push(...judgeUsage);
          if (verdict.verdict === "revised") return verdict.content;
          return firstAnswer;
        })();

        const deepSynthP = (async () => {
          const [deepOutcomes] = await Promise.all([deepOutcomesP, reasonedFirstSynthP]);
          let reasonedBaseline = await reasonedFirstSynthP;
          const allReasonedReady = await Promise.race([
            reasonedStaged.all.then(() => true),
            Promise.resolve(false),
          ]);
          if (allReasonedReady) reasonedBaseline = await reasonedBaselineForDeepP;
          await synthesizeStage("deep", deepOutcomes, reasonedBaseline, "REASONED ANSWER");
        })();

        await Promise.all([reasonedFirstSynthP, reasonedBaselineForDeepP, deepSynthP]);

        const perProvider: PerProvider = { openai: 0, anthropic: 0, google: 0, xai: 0 };
        let other = 0;
        for (const u of usages) {
          const p = providerFromModel(u.model);
          if (p === "other") other += u.cost;
          else perProvider[p] += u.cost;
        }
        const total =
          perProvider.openai +
          perProvider.anthropic +
          perProvider.google +
          perProvider.xai +
          other;
        stored.cost = { perProvider, total };
        send({ type: "cost", perProvider, total });

        const persistNow = Date.now();
        appendMessage(sessionId, "user", { role: "user", content: lastUserContent }, persistNow);
        appendMessage(sessionId, "assistant", stored, persistNow);
        addCost(sessionId, total);

        send({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
