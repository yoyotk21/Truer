"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type StageId = "fast" | "reasoned" | "deep";
type Version = StageId;
type StageVerdict = "verified" | "revised" | "appended";

type StageModel = { key: string; model: string; effort: string };
type Stage = { id: StageId; label: string; description: string; models: StageModel[] };

type StageProgress = "pending" | "running" | "done";
type ChipStatus = "pending" | "done" | "error";

type Cost = {
  perProvider: { openai: number; anthropic: number; google: number; xai: number };
  total: number;
};

type ModelResponse = {
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

type CitationModel = { model_key: string; snippet: string };
type Citation = { id: string; models: CitationModel[] };

type UserMessage = { role: "user"; content: string };

type AssistantMessage = {
  role: "assistant";
  streamBuffer: string;
  isStreaming: boolean;
  errorMessage?: string;
  versions: { fast?: string; reasoned?: string; deep?: string };
  verdicts: { reasoned?: StageVerdict; deep?: StageVerdict };
  addenda: { reasoned?: string; deep?: string };
  citations: { reasoned?: Citation[]; deep?: Citation[] };
  chips: Record<string, ChipStatus>;
  stageProgress: Record<StageId, StageProgress>;
  responses: Record<string, ModelResponse>;
  cost?: Cost;
};

type Message = UserMessage | AssistantMessage;

type RewriteAnim = {
  stage: Exclude<StageId, "fast">;
  newTokens: string[];
  cursor: number;
  prefix?: string;
};

type SessionRow = {
  id: string;
  title: string;
  total_cost: number;
  created_at: number;
  updated_at: number;
};

const DEFAULT_STAGES: Stage[] = [
  { id: "fast", label: "Instant", description: "Streamed immediately", models: [] },
  { id: "reasoned", label: "Reasoned", description: "Medium reasoning", models: [] },
  { id: "deep", label: "Deep", description: "High reasoning", models: [] },
];

function newAssistant(): AssistantMessage {
  return {
    role: "assistant",
    streamBuffer: "",
    isStreaming: true,
    versions: {},
    verdicts: {},
    addenda: {},
    citations: {},
    chips: {},
    stageProgress: { fast: "running", reasoned: "running", deep: "running" },
    responses: {},
  };
}

function hydrateAssistant(stored: {
  versions?: AssistantMessage["versions"];
  verdicts?: AssistantMessage["verdicts"];
  addenda?: AssistantMessage["addenda"];
  citations?: AssistantMessage["citations"];
  responses?: Record<string, ModelResponse>;
  cost?: Cost;
}): AssistantMessage {
  const responses = stored.responses ?? {};
  const chips: Record<string, ChipStatus> = {};
  for (const k of Object.keys(responses)) {
    chips[k] = responses[k].error ? "error" : "done";
  }
  return {
    role: "assistant",
    streamBuffer: "",
    isStreaming: false,
    versions: stored.versions ?? {},
    verdicts: stored.verdicts ?? {},
    addenda: stored.addenda ?? {},
    citations: stored.citations ?? {},
    chips,
    stageProgress: { fast: "done", reasoned: "done", deep: "done" },
    responses,
    cost: stored.cost,
  };
}

function latestVersion(versions: AssistantMessage["versions"]): Version {
  if (versions.deep !== undefined) return "deep";
  if (versions.reasoned !== undefined) return "reasoned";
  return "fast";
}

function effectiveVersion(
  m: AssistantMessage,
  pick: Version | null,
): Version {
  if (pick && m.versions[pick] !== undefined) return pick;
  return latestVersion(m.versions);
}

function displayContent(
  m: AssistantMessage,
  pick: Version | null,
  animFor?: RewriteAnim | null,
): string {
  if (m.isStreaming) return m.streamBuffer;
  if (animFor) return currentAnimText(animFor);
  const v = effectiveVersion(m, pick);
  return m.versions[v] ?? m.streamBuffer;
}

function stripCitationMarkers(s: string): string {
  return s.replace(/\s?\[\[\d+\]\]/g, "");
}

function canonicalAssistantText(
  m: AssistantMessage,
  pick: Version | null,
): string {
  const v = effectiveVersion(m, pick);
  const text =
    m.versions[v] ??
    m.versions.deep ??
    m.versions.reasoned ??
    m.versions.fast ??
    m.streamBuffer;
  return stripCitationMarkers(text);
}

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

function currentAnimText(a: RewriteAnim): string {
  return (a.prefix ?? "") + a.newTokens.slice(0, a.cursor).join("");
}

function supersedes(newStage: Exclude<StageId, "fast">, pick: Version): boolean {
  if (pick === newStage) return true;
  if (newStage === "deep") return pick === "fast" || pick === "reasoned";
  if (newStage === "reasoned") return pick === "fast";
  return false;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function splitOnMarkers(s: string): (string | { marker: string })[] {
  const re = /\[\[(\d+)\]\]/g;
  const out: (string | { marker: string })[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) != null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ marker: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function walkSplitMarkers(node: HastNode): void {
  if (!node.children) return;
  const out: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitOnMarkers(child.value);
      if (parts.length === 1 && typeof parts[0] === "string") {
        out.push(child);
      } else {
        for (const p of parts) {
          if (typeof p === "string") {
            if (p.length > 0) out.push({ type: "text", value: p });
          } else {
            out.push({
              type: "element",
              tagName: "sup",
              properties: { dataCiteId: p.marker },
              children: [{ type: "text", value: p.marker }],
            });
          }
        }
      }
    } else {
      const tag = child.tagName;
      if (tag !== "code" && tag !== "pre") walkSplitMarkers(child);
      out.push(child);
    }
  }
  node.children = out;
}

function rehypeCiteMarkers() {
  return (tree: HastNode) => walkSplitMarkers(tree);
}

function freshSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [stages, setStages] = useState<Stage[]>(DEFAULT_STAGES);
  const [pickedVersion, setPickedVersion] = useState<Record<number, Version>>({});
  const [sessionCost, setSessionCost] = useState(0);
  const [selected, setSelected] = useState<{ messageIdx: number; key: string } | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => freshSessionId());
  const [deactivatedKeys, setDeactivatedKeys] = useState<Set<string>>(() => new Set());
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionRow[] | null>(null);
  const searchReqIdRef = useRef(0);
  const [anim, setAnim] = useState<Record<number, RewriteAnim | null>>({});
  const [openCitation, setOpenCitation] = useState<{
    messageIdx: number;
    version: Exclude<Version, "fast">;
    citationId: string;
    anchor: { top: number; left: number; width: number; height: number };
  } | null>(null);
  const inFlightRef = useRef<Map<number, AbortController>>(new Map());
  const animRafRef = useRef<Record<number, number>>({});
  const pickedVersionRef = useRef<Record<number, Version>>({});
  const [recording, setRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveBaseRef = useRef<string>("");
  const committedRef = useRef<string>("");
  const pendingRef = useRef<string>("");

  useEffect(() => {
    pickedVersionRef.current = pickedVersion;
  }, [pickedVersion]);

  function cancelRewriteAnim(idx: number) {
    const id = animRafRef.current[idx];
    if (id !== undefined) {
      cancelAnimationFrame(id);
      delete animRafRef.current[idx];
    }
    setAnim((s) => {
      if (s[idx] == null) return s;
      const next = { ...s };
      next[idx] = null;
      return next;
    });
  }

  function startRewriteAnim(
    idx: number,
    newText: string,
    stage: Exclude<StageId, "fast">,
    prefix?: string,
  ) {
    const prev = animRafRef.current[idx];
    if (prev !== undefined) cancelAnimationFrame(prev);

    const newTokens = tokenize(newText);
    if (newTokens.length === 0) {
      cancelRewriteAnim(idx);
      return;
    }

    const dur = Math.min(4000, Math.max(1200, 150 + newTokens.length * 25));
    const start = performance.now();

    setAnim((s) => ({
      ...s,
      [idx]: { stage, newTokens, cursor: 0, prefix },
    }));

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const nextCursor = Math.round(newTokens.length * t);
      setAnim((s) => {
        const cur = s[idx];
        if (!cur) return s;
        return { ...s, [idx]: { ...cur, cursor: nextCursor } };
      });
      if (t >= 1) {
        delete animRafRef.current[idx];
        setAnim((s) => {
          if (s[idx] == null) return s;
          const next = { ...s };
          next[idx] = null;
          return next;
        });
        return;
      }
      animRafRef.current[idx] = requestAnimationFrame(tick);
    };
    animRafRef.current[idx] = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      for (const id of Object.values(animRafRef.current)) {
        if (typeof id === "number") cancelAnimationFrame(id);
      }
      animRafRef.current = {};
    };
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, []);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length === 0) {
      searchReqIdRef.current += 1;
      setSearchResults(null);
      return;
    }
    const reqId = ++searchReqIdRef.current;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { sessions: SessionRow[] };
        if (reqId !== searchReqIdRef.current) return;
        setSearchResults(data.sessions);
      } catch {
        // ignore
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  useEffect(() => {
    if (!selected && !openCitation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openCitation) setOpenCitation(null);
      else if (selected) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, openCitation]);

  function patchAssistant(
    idx: number,
    fn: (m: AssistantMessage) => AssistantMessage,
  ) {
    setMessages((curr) => {
      const target = curr[idx];
      if (!target || target.role !== "assistant") return curr;
      const copy = curr.slice();
      copy[idx] = fn(target);
      return copy;
    });
  }

  async function refreshSessions() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionRow[] };
      setSessions(data.sessions);
    } catch {
      // ignore
    }
  }

  function resetConversationState() {
    for (const c of inFlightRef.current.values()) c.abort();
    inFlightRef.current.clear();
    for (const id of Object.values(animRafRef.current)) {
      if (typeof id === "number") cancelAnimationFrame(id);
    }
    animRafRef.current = {};
    setAnim({});
    setMessages([]);
    setPickedVersion({});
    setSessionCost(0);
    setSelected(null);
    setOpenCitation(null);
    setDeactivatedKeys(new Set());
  }

  function toggleDeactivate(key: string) {
    setDeactivatedKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  function newChat() {
    resetConversationState();
    setSessionId(freshSessionId());
    setSearchQuery("");
  }

  async function loadSession(id: string) {
    if (id === sessionId && messages.length > 0) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        id: string;
        title: string;
        total_cost: number;
        messages: { role: "user" | "assistant"; content: unknown }[];
      };
      resetConversationState();
      setSessionId(data.id);
      setSessionCost(data.total_cost);
      const hydrated: Message[] = data.messages.map((row) => {
        if (row.role === "user") {
          const c = row.content as { content?: string };
          return { role: "user", content: c?.content ?? "" };
        }
        return hydrateAssistant(row.content as Parameters<typeof hydrateAssistant>[0]);
      });
      setMessages(hydrated);
    } catch {
      // ignore
    }
  }

  async function deleteSessionRow(id: string) {
    if (!confirm("Delete this session?")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    if (id === sessionId) newChat();
    void refreshSessions();
  }

  function joinText(...parts: string[]): string {
    return parts.map((p) => p.trim()).filter(Boolean).join(" ");
  }

  function repaintInput() {
    setInput(joinText(liveBaseRef.current, committedRef.current, pendingRef.current));
  }

  function teardownRealtime() {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
  }

  async function toggleRecord() {
    if (recording) {
      committedRef.current = joinText(committedRef.current, pendingRef.current);
      pendingRef.current = "";
      repaintInput();
      teardownRealtime();
      setRecording(false);
      return;
    }

    setVoiceError(null);
    liveBaseRef.current = input;
    committedRef.current = "";
    pendingRef.current = "";

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "microphone permission denied");
      return;
    }
    streamRef.current = stream;

    let clientSecret: string;
    try {
      const tokenRes = await fetch("/api/realtime-token", { method: "POST" });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData?.clientSecret) {
        throw new Error(tokenData?.error || `token request failed (${tokenRes.status})`);
      }
      clientSecret = tokenData.clientSecret;
    } catch (err) {
      teardownRealtime();
      setVoiceError(err instanceof Error ? err.message : "could not get session token");
      return;
    }

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    pc.addTrack(stream.getAudioTracks()[0], stream);

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.onmessage = (e) => {
      try {
        handleRealtimeEvent(JSON.parse(e.data));
      } catch {}
    };
    dc.onopen = () => {
      try {
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  turn_detection: { type: "server_vad" },
                  transcription: { model: "gpt-4o-transcribe" },
                },
              },
            },
          }),
        );
      } catch {}
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        if (recording) {
          setVoiceError(`connection ${s}`);
          teardownRealtime();
          setRecording(false);
        }
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!sdpRes.ok) {
        const errText = await sdpRes.text();
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${errText.slice(0, 200)}`);
      }
      const answer = { type: "answer" as const, sdp: await sdpRes.text() };
      await pc.setRemoteDescription(answer);
    } catch (err) {
      teardownRealtime();
      setVoiceError(err instanceof Error ? err.message : "connection failed");
      return;
    }

    setRecording(true);
  }

  function handleRealtimeEvent(ev: { type?: string; delta?: string; transcript?: string; error?: { message?: string } }) {
    if (!ev?.type) return;
    if (ev.type === "conversation.item.input_audio_transcription.delta" && typeof ev.delta === "string") {
      pendingRef.current += ev.delta;
      repaintInput();
    } else if (ev.type === "conversation.item.input_audio_transcription.completed" && typeof ev.transcript === "string") {
      committedRef.current = joinText(committedRef.current, ev.transcript);
      pendingRef.current = "";
      repaintInput();
    } else if (ev.type === "error") {
      setVoiceError(ev.error?.message || "realtime error");
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    const latest = messages[messages.length - 1];
    if (latest?.role === "assistant" && latest.isStreaming) return;
    setInput("");

    const apiMessages = [
      ...messages.map((m, i) =>
        m.role === "user"
          ? { role: "user" as const, content: m.content }
          : {
              role: "assistant" as const,
              content: canonicalAssistantText(
                m,
                pickedVersionRef.current[i] ?? null,
              ),
            },
      ),
      { role: "user" as const, content: text },
    ];

    const myIdx = messages.length + 1;

    setMessages((curr) => [
      ...curr,
      { role: "user", content: text },
      newAssistant(),
    ]);

    const controller = new AbortController();
    inFlightRef.current.set(myIdx, controller);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          sessionId,
          deactivatedKeys: Array.from(deactivatedKeys),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`request failed: ${res.status} ${errText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: { type: string } & Record<string, unknown>;
          try {
            evt = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (evt.type === "stages") {
            const ss = evt.stages as Stage[];
            setStages(ss);
            const initialChips: Record<string, ChipStatus> = {};
            for (const s of ss) for (const m of s.models) initialChips[m.key] = "pending";
            patchAssistant(myIdx, (m) => ({ ...m, chips: initialChips }));
          } else if (evt.type === "chunk") {
            const data = evt.data as string;
            patchAssistant(myIdx, (m) => ({ ...m, streamBuffer: m.streamBuffer + data }));
          } else if (evt.type === "instant_done") {
            patchAssistant(myIdx, (m) => ({
              ...m,
              isStreaming: false,
              versions: { ...m.versions, fast: m.streamBuffer },
              stageProgress: { ...m.stageProgress, fast: "done" },
            }));
          } else if (evt.type === "stage_started") {
            const stage = evt.stage as StageId;
            patchAssistant(myIdx, (m) => ({
              ...m,
              stageProgress: { ...m.stageProgress, [stage]: "running" },
            }));
          } else if (evt.type === "stage_done") {
            const stage = evt.stage as StageId;
            patchAssistant(myIdx, (m) => ({
              ...m,
              stageProgress: { ...m.stageProgress, [stage]: "done" },
            }));
          } else if (evt.type === "verifier") {
            const key = evt.key as string;
            const status = evt.status as Exclude<ChipStatus, "pending">;
            patchAssistant(myIdx, (m) => ({
              ...m,
              chips: { ...m.chips, [key]: status },
            }));
          } else if (evt.type === "model_response") {
            const r: ModelResponse = {
              key: evt.key as string,
              stage: evt.stage as StageId,
              model: evt.model as string,
              effort: evt.effort as string,
              text: evt.text as string,
              inputTokens: evt.inputTokens as number,
              outputTokens: evt.outputTokens as number,
              cost: evt.cost as number,
              error: evt.error as string | undefined,
            };
            patchAssistant(myIdx, (m) => ({
              ...m,
              responses: { ...m.responses, [r.key]: r },
            }));
          } else if (evt.type === "stage_verdict") {
            const stage = evt.stage as Exclude<StageId, "fast">;
            const verdict = evt.verdict as StageVerdict;
            const content = evt.content as string | undefined;
            const addendum = evt.addendum as string | undefined;
            const citations = (evt.citations as Citation[] | undefined) ?? [];
            patchAssistant(myIdx, (m) => {
              if (content) {
                const pick = pickedVersionRef.current[myIdx] ?? null;
                const oldText = displayContent(m, pick);
                const willAutoSwitch = !pick || supersedes(stage, pick);
                const oldStripped = stripCitationMarkers(oldText);
                const newStripped = stripCitationMarkers(content);
                if (willAutoSwitch && oldStripped !== newStripped) {
                  if (verdict === "appended" && addendum && content.endsWith(addendum)) {
                    const prefix = content.slice(0, content.length - addendum.length);
                    queueMicrotask(() => startRewriteAnim(myIdx, addendum, stage, prefix));
                  } else {
                    queueMicrotask(() => startRewriteAnim(myIdx, content, stage));
                  }
                }
              }
              const versions = { ...m.versions };
              if (content) versions[stage] = content;
              const addenda = { ...m.addenda };
              if (verdict === "appended" && addendum) {
                addenda[stage] = addendum;
              } else {
                delete addenda[stage];
              }
              const nextCitations = { ...m.citations, [stage]: citations };
              return {
                ...m,
                verdicts: { ...m.verdicts, [stage]: verdict },
                versions,
                addenda,
                citations: nextCitations,
              };
            });
          } else if (evt.type === "cost") {
            const cost: Cost = {
              perProvider: evt.perProvider as Cost["perProvider"],
              total: evt.total as number,
            };
            patchAssistant(myIdx, (m) => ({ ...m, cost }));
            setSessionCost((s) => s + cost.total);
          } else if (evt.type === "error") {
            const message = (evt.message as string) ?? "unknown error";
            patchAssistant(myIdx, (m) => ({ ...m, errorMessage: message, isStreaming: false }));
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        patchAssistant(myIdx, (m) => ({ ...m, errorMessage: "stopped", isStreaming: false }));
      } else {
        const message = err instanceof Error ? err.message : "unknown error";
        patchAssistant(myIdx, (m) => ({ ...m, errorMessage: message, isStreaming: false }));
      }
    } finally {
      inFlightRef.current.delete(myIdx);
      void refreshSessions();
      // The LLM-generated title arrives shortly after `done`; refetch once more.
      setTimeout(() => {
        void refreshSessions();
      }, 4000);
    }
  }

  const selectedResponse = (() => {
    if (!selected) return null;
    const m = messages[selected.messageIdx];
    if (!m || m.role !== "assistant") return null;
    return m.responses[selected.key] ?? null;
  })();

  const latestMessage = messages[messages.length - 1];
  const fastInFlight =
    latestMessage?.role === "assistant" && latestMessage.isStreaming;

  return (
    <div className="flex h-screen">
      <SessionSidebar
        sessions={searchResults ?? sessions}
        activeId={sessionId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onNew={newChat}
        onSelect={loadSession}
        onDelete={deleteSessionRow}
      />
      <div className="flex-1 min-w-0 flex flex-col h-screen">
        <header className="border-b border-zinc-800">
          <div className="max-w-5xl w-full mx-auto px-4 py-4 flex items-center justify-between">
            <h1 className="text-lg font-semibold tracking-tight">Truer</h1>
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span
                className="cursor-default"
                title={stages
                  .map((s) => `${s.label}: ${s.models.map((m) => m.model).join(", ") || "—"}`)
                  .join(" · ")}
              >
                {stages.flatMap((s) => s.models).length} models · 3 stages ⓘ
              </span>
              {sessionCost > 0 && (
                <span>session {formatUsd(sessionCost, sessionCost >= 0.01 ? 2 : 4)}</span>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 min-h-0 flex flex-col max-w-5xl w-full mx-auto px-4">
          <div className="flex-1 overflow-y-auto py-6 space-y-6">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-zinc-600">Ask anything.</p>
              </div>
            ) : (
              messages.map((m, i) =>
                m.role === "user" ? (
                  <UserBubble key={i} message={m} />
                ) : (
                  <AssistantBubble
                    key={i}
                    message={m}
                    stages={stages}
                    pick={pickedVersion[i] ?? null}
                    anim={anim[i] ?? null}
                    onPick={(v) => {
                      cancelRewriteAnim(i);
                      setPickedVersion((s) => ({ ...s, [i]: v }));
                    }}
                    onSelectModel={(key) => {
                      setOpenCitation(null);
                      setSelected({ messageIdx: i, key });
                    }}
                    selectedKey={
                      selected && selected.messageIdx === i ? selected.key : null
                    }
                    deactivatedKeys={deactivatedKeys}
                    onOpenCitation={(version, citationId, anchor) =>
                      setOpenCitation((cur) => {
                        if (
                          cur &&
                          cur.messageIdx === i &&
                          cur.version === version &&
                          cur.citationId === citationId
                        ) {
                          return null;
                        }
                        return { messageIdx: i, version, citationId, anchor };
                      })
                    }
                    activeCitationId={
                      openCitation && openCitation.messageIdx === i
                        ? openCitation.citationId
                        : null
                    }
                  />
                ),
              )
            )}
          </div>

          <footer className="py-4 border-t border-zinc-800">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask anything"
                disabled={fastInFlight}
                rows={1}
                className="flex-1 resize-none rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm focus:outline-none focus:border-zinc-600 disabled:opacity-60 max-h-40 overflow-y-auto"
              />
              <button
                type="button"
                onClick={() => void toggleRecord()}
                disabled={fastInFlight}
                aria-label={recording ? "Stop recording" : "Start voice input"}
                title={recording ? "Stop recording" : "Voice input"}
                className={`h-9 w-9 shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${
                  recording
                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    : "bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {recording ? <RecordingDot /> : <MicIcon />}
              </button>
              {fastInFlight ? (
                <button
                  type="button"
                  onClick={() =>
                    inFlightRef.current.get(messages.length - 1)?.abort()
                  }
                  className="h-9 shrink-0 rounded-lg bg-zinc-700 text-zinc-200 px-4 text-sm font-medium hover:bg-zinc-600 transition-colors"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="h-9 shrink-0 rounded-lg bg-zinc-100 text-zinc-900 px-4 text-sm font-medium disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </form>
            <div className="flex items-center justify-between mt-1.5">
              {voiceError ? (
                <p className="text-[11px] text-red-400">{voiceError}</p>
              ) : (
                <span />
              )}
              <p className="text-[11px] text-zinc-700">⏎ send · ⇧⏎ newline</p>
            </div>
          </footer>
        </div>
      </div>

      <ModelSidebar
        response={selectedResponse}
        selectedKey={selected?.key ?? null}
        selectedModelLabel={
          selected
            ? selectedResponse?.model ??
              stages
                .flatMap((s) => s.models)
                .find((m) => m.key === selected.key)?.model ??
              null
            : null
        }
        selectedStage={
          selected
            ? selectedResponse?.stage ??
              stages.find((s) => s.models.some((m) => m.key === selected.key))?.id ??
              null
            : null
        }
        isDeactivated={selected ? deactivatedKeys.has(selected.key) : false}
        onToggleDeactivate={() => selected && toggleDeactivate(selected.key)}
        onClose={() => setSelected(null)}
      />
      {openCitation && (() => {
        const m = messages[openCitation.messageIdx];
        if (!m || m.role !== "assistant") return null;
        const citations = m.citations[openCitation.version] ?? [];
        const citation = citations.find((c) => c.id === openCitation.citationId);
        if (!citation) return null;
        return (
          <CitationPopover
            anchor={openCitation.anchor}
            citation={citation}
            stages={stages}
            onPickModel={(key) => {
              setOpenCitation(null);
              setSelected({ messageIdx: openCitation.messageIdx, key });
            }}
            onClose={() => setOpenCitation(null)}
          />
        );
      })()}
    </div>
  );
}

function SessionSidebar({
  sessions,
  activeId,
  searchQuery,
  onSearchChange,
  onNew,
  onSelect,
  onDelete,
}: {
  sessions: SessionRow[];
  activeId: string;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const isSearching = searchQuery.trim().length > 0;
  return (
    <aside className="w-64 shrink-0 h-screen border-r border-zinc-800 bg-zinc-950 flex flex-col">
      <div className="px-3 py-3.5 border-b border-zinc-800 space-y-2">
        <button
          type="button"
          onClick={onNew}
          className="w-full rounded-md bg-zinc-100 text-zinc-900 px-3 py-1.5 text-sm font-medium hover:bg-zinc-200 transition-colors"
        >
          + New chat
        </button>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search chats…"
          className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-2 space-y-0.5">
        {sessions.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-zinc-600">
            {isSearching ? "No matches." : "No sessions yet."}
          </p>
        ) : (
          sessions.map((s) => (
            <SessionRowItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => onSelect(s.id)}
              onDelete={() => onDelete(s.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SessionRowItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: SessionRow;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group relative flex items-center rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      }`}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <div className="truncate">{session.title || "Untitled"}</div>
        <div className="text-[11px] text-zinc-500 mt-0.5">
          {formatCostShort(session.total_cost)}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete session"
        className="ml-2 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function formatCostShort(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="flex justify-end">
      <div className="text-zinc-100 max-w-[80%] whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  stages,
  pick,
  anim,
  onPick,
  onSelectModel,
  selectedKey,
  deactivatedKeys,
  onOpenCitation,
  activeCitationId,
}: {
  message: AssistantMessage;
  stages: Stage[];
  pick: Version | null;
  anim: RewriteAnim | null;
  onPick: (v: Version) => void;
  onSelectModel: (key: string) => void;
  selectedKey: string | null;
  deactivatedKeys: Set<string>;
  onOpenCitation: (
    version: Exclude<Version, "fast">,
    citationId: string,
    anchor: { top: number; left: number; width: number; height: number },
  ) => void;
  activeCitationId: string | null;
}) {
  const content = displayContent(message, pick, anim);
  const activeVersion = effectiveVersion(message, pick);
  const isAnimating = !!anim;

  const addendumForActive =
    !message.isStreaming && activeVersion !== "fast"
      ? message.addenda[activeVersion]
      : undefined;
  const split =
    addendumForActive && content.endsWith(addendumForActive)
      ? {
          body: content.slice(0, content.length - addendumForActive.length).replace(/\n+$/, ""),
          addendum: addendumForActive,
        }
      : null;

  const citationVersion: Exclude<Version, "fast"> | null =
    activeVersion === "fast" ? null : activeVersion;
  const citations = citationVersion ? message.citations[citationVersion] ?? [] : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sup = (props: any) => {
    const id =
      props?.["data-cite-id"] ??
      props?.dataCiteId ??
      props?.citeId;
    if (id == null || !citationVersion) {
      // strip the children (which would be the marker number) when this isn't a citation pill
      // eslint-disable-next-line jsx-a11y/heading-has-content, @typescript-eslint/no-unused-vars
      const { node, ...rest } = props ?? {};
      return <sup {...rest} />;
    }
    const citation = citations.find((c) => c.id === String(id));
    if (!citation) return null;
    return (
      <CitationPill
        id={String(id)}
        active={activeCitationId === String(id)}
        onClick={(rect) => onOpenCitation(citationVersion, String(id), rect)}
      />
    );
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: any = { sup };

  return (
    <div className="space-y-3 border-l-2 border-zinc-800 pl-4">
      {!message.isStreaming && !message.errorMessage && (
        <>
          <VersionToggle message={message} active={activeVersion} onPick={onPick} />
          <div className="space-y-1.5">
            {stages.map((s) => (
              <StageRow
                key={s.id}
                stage={s}
                chips={message.chips}
                progress={message.stageProgress[s.id]}
                verdict={s.id === "fast" ? null : message.verdicts[s.id] ?? null}
                responses={message.responses}
                onSelectModel={onSelectModel}
                selectedKey={selectedKey}
                deactivatedKeys={deactivatedKeys}
              />
            ))}
          </div>
        </>
      )}

      <div className="max-w-[72ch] prose prose-invert prose-p:text-zinc-100 prose-headings:text-zinc-100 prose-code:text-zinc-200 prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-blue-400 max-w-none leading-relaxed">
        {split ? (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeCiteMarkers]}
              components={components}
            >
              {split.body}
            </ReactMarkdown>
            <div className="mt-3 border-l-2 border-sky-500/60 pl-3 text-sky-300 prose-invert prose-p:text-sky-300 prose-headings:text-sky-200 prose-strong:text-sky-200 prose-code:text-sky-200">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeCiteMarkers]}
                components={components}
              >
                {split.addendum}
              </ReactMarkdown>
            </div>
          </>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeCiteMarkers]}
            components={components}
          >
            {content}
          </ReactMarkdown>
        )}
        {(message.isStreaming || isAnimating) && (
          <span className="animate-pulse text-zinc-400 text-sm">▌</span>
        )}
      </div>

      {message.errorMessage && (
        <span className="text-xs text-red-400">error: {message.errorMessage}</span>
      )}

      {message.cost && <CostLine cost={message.cost} />}
    </div>
  );
}

function CitationPill({
  id,
  active,
  onClick,
}: {
  id: string;
  active: boolean;
  onClick: (rect: { top: number; left: number; width: number; height: number }) => void;
}) {
  return (
    <button
      type="button"
      data-cite-pill="true"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onClick({ top: r.top, left: r.left, width: r.width, height: r.height });
      }}
      className={`align-super inline-flex items-center justify-center mx-0.5 px-1 min-w-[1.1rem] h-[1.1rem] text-[10px] leading-none rounded border transition-colors ${
        active
          ? "border-sky-400 bg-sky-500/20 text-sky-200"
          : "border-zinc-700 text-zinc-400 hover:border-sky-500 hover:text-sky-300"
      }`}
      title={`Citation ${id}`}
    >
      {id}
    </button>
  );
}

function CitationPopover({
  anchor,
  citation,
  stages,
  onPickModel,
  onClose,
}: {
  anchor: { top: number; left: number; width: number; height: number };
  citation: Citation;
  stages: Stage[];
  onPickModel: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      const target = e.target as Element | null;
      if (target && target.closest('[data-cite-pill="true"]')) return;
      if (!ref.current.contains(target as Node)) onClose();
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const popWidth = 360;
  const margin = 8;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 768;
  let left = anchor.left + anchor.width / 2 - popWidth / 2;
  left = Math.max(margin, Math.min(left, viewportW - popWidth - margin));
  let top = anchor.top + anchor.height + 6;
  const estHeight = 44 + citation.models.length * 84;
  if (top + estHeight > viewportH - margin) {
    top = Math.max(margin, anchor.top - estHeight - 6);
  }

  const stageById = (key: string) => {
    for (const s of stages) {
      const m = s.models.find((mm) => mm.key === key);
      if (m) return { stage: s, model: m };
    }
    return null;
  };

  return (
    <div
      ref={ref}
      role="dialog"
      style={{ top, left, width: popWidth }}
      className="fixed z-[60] rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500">
        Cited by {citation.models.length} model{citation.models.length === 1 ? "" : "s"}
      </div>
      <ul className="max-h-[60vh] overflow-y-auto">
        {citation.models.map((m) => {
          const sm = stageById(m.model_key);
          const label = sm ? shortLabel(sm.model.model) : m.model_key;
          const stageName = sm ? stageLabel(sm.stage.id) : "";
          return (
            <li key={m.model_key}>
              <button
                type="button"
                onClick={() => onPickModel(m.model_key)}
                className="w-full text-left px-3 py-2 hover:bg-zinc-900 transition-colors border-b border-zinc-900 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-zinc-200 truncate">{label}</span>
                  {stageName && (
                    <span className="text-[10px] text-zinc-500 shrink-0">{stageName}</span>
                  )}
                </div>
                <blockquote className="mt-1 text-[12px] text-zinc-400 italic border-l-2 border-zinc-700 pl-2 leading-snug line-clamp-3">
                  &ldquo;{m.snippet}&rdquo;
                </blockquote>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VersionToggle({
  message,
  active,
  onPick,
}: {
  message: AssistantMessage;
  active: Version;
  onPick: (v: Version) => void;
}) {
  const available: { id: Version; label: string; verdict?: StageVerdict }[] = [];
  if (message.versions.fast !== undefined) {
    available.push({ id: "fast", label: "Instant" });
  }
  if (message.versions.reasoned !== undefined) {
    available.push({ id: "reasoned", label: "Reasoned", verdict: message.verdicts.reasoned });
  }
  if (message.versions.deep !== undefined) {
    available.push({ id: "deep", label: "Deep", verdict: message.verdicts.deep });
  }

  if (available.length <= 1) return null;

  return (
    <div className="inline-flex rounded border border-zinc-700 text-[11px] overflow-hidden">
      {available.map((v) => (
        <button
          key={v.id}
          onClick={() => onPick(v.id)}
          className={`px-2.5 py-1 transition-colors ${
            active === v.id
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function StageRow({
  stage,
  chips,
  progress,
  verdict,
  responses,
  onSelectModel,
  selectedKey,
  deactivatedKeys,
}: {
  stage: Stage;
  chips: Record<string, ChipStatus>;
  progress: StageProgress;
  verdict: StageVerdict | null;
  responses: Record<string, ModelResponse>;
  onSelectModel: (key: string) => void;
  selectedKey: string | null;
  deactivatedKeys: Set<string>;
}) {
  const isRunning = progress === "running";
  const isDone = progress === "done";
  const labelColor = isDone ? "text-zinc-400" : isRunning ? "text-zinc-500" : "text-zinc-600";

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className={`inline-flex items-center gap-1.5 ${labelColor} min-w-[5.5rem]`}>
        {isRunning ? (
          <Spinner />
        ) : isDone ? (
          <DotIcon className="text-emerald-500" />
        ) : (
          <DotIcon className="text-zinc-700" />
        )}
        <span className="font-medium">{stage.label}</span>
      </span>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {stage.models.map((m) => (
          <VerifierChip
            key={m.key}
            label={shortLabel(m.model)}
            status={chips[m.key] ?? "pending"}
            available={!!responses[m.key] && !responses[m.key]?.error}
            active={selectedKey === m.key}
            deactivated={deactivatedKeys.has(m.key)}
            onClick={() => onSelectModel(m.key)}
          />
        ))}
      </span>
      {verdict && <VerdictBadge verdict={verdict} />}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: StageVerdict }) {
  if (verdict === "verified") {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400">
        <CheckIcon /> verified
      </span>
    );
  }
  if (verdict === "appended") {
    return (
      <span className="inline-flex items-center gap-1 text-sky-400">
        <PlusIcon /> appended
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-400">
      <RevisedIcon /> revised
    </span>
  );
}

function CostLine({ cost }: { cost: Cost }) {
  const detail = `openai ${formatUsd(cost.perProvider.openai, 4)} · anthropic ${formatUsd(cost.perProvider.anthropic, 4)} · google ${formatUsd(cost.perProvider.google, 4)} · xai ${formatUsd(cost.perProvider.xai, 4)}`;
  return (
    <span className="text-[11px] text-zinc-600 cursor-default" title={detail}>
      {formatUsd(cost.total, 4)}
    </span>
  );
}

function formatUsd(n: number, digits: number): string {
  return `$${n.toFixed(digits)}`;
}

function shortLabel(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

function VerifierChip({
  label,
  status,
  available,
  active,
  deactivated,
  onClick,
}: {
  label: string;
  status: ChipStatus;
  available: boolean;
  active: boolean;
  deactivated: boolean;
  onClick: () => void;
}) {
  const color = deactivated
    ? "text-zinc-600"
    : status === "done"
    ? "text-emerald-400"
    : status === "error"
    ? "text-red-400"
    : "text-zinc-500";
  const mark = deactivated
    ? "—"
    : status === "done"
    ? "✓"
    : status === "error"
    ? "×"
    : "·";
  const interactive = deactivated || available;
  const baseBorder = active
    ? "border-zinc-500 bg-zinc-800"
    : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900";
  const opacity = deactivated ? "opacity-50" : "";
  const titleText = deactivated
    ? `${label} (deactivated — click to reactivate)`
    : interactive
    ? `View ${label} response`
    : undefined;
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      title={titleText}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${color} ${opacity} ${
        interactive ? `cursor-pointer ${baseBorder}` : "border-transparent cursor-default"
      } transition-colors`}
    >
      <span>{mark}</span>
      <span>{label}</span>
    </button>
  );
}

function ModelSidebar({
  response,
  selectedKey,
  selectedModelLabel,
  selectedStage,
  isDeactivated,
  onToggleDeactivate,
  onClose,
}: {
  response: ModelResponse | null;
  selectedKey: string | null;
  selectedModelLabel: string | null;
  selectedStage: StageId | null;
  isDeactivated: boolean;
  onToggleDeactivate: () => void;
  onClose: () => void;
}) {
  const open = !!selectedKey;
  const headerStage = response?.stage ?? selectedStage;
  const headerModel = response?.model ?? selectedModelLabel;
  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-black/40 transition-opacity z-40 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden
      />
      <aside
        className={`fixed top-0 right-0 h-screen w-full sm:w-[28rem] md:w-[32rem] bg-zinc-950 border-l border-zinc-800 shadow-2xl z-50 flex flex-col transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        {open && (
          <>
            <div className="flex items-start justify-between px-5 py-4 border-b border-zinc-800">
              <div className="min-w-0">
                <div className="text-xs text-zinc-500 capitalize">
                  {headerStage ? `${stageLabel(headerStage)} stage` : ""}
                  {isDeactivated && (
                    <span className="ml-2 text-amber-400">deactivated</span>
                  )}
                </div>
                <h2 className="text-base font-semibold tracking-tight truncate">
                  {headerModel ?? ""}
                </h2>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-200 -mr-1 p-1"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="px-5 py-3 border-b border-zinc-800">
              {response ? <MetadataTable response={response} /> : null}
              <button
                type="button"
                onClick={onToggleDeactivate}
                className={`mt-3 text-xs rounded border px-2 py-1 transition-colors ${
                  isDeactivated
                    ? "border-emerald-700 text-emerald-400 hover:bg-emerald-950"
                    : "border-zinc-700 text-zinc-300 hover:bg-zinc-900"
                }`}
              >
                {isDeactivated ? "Activate model" : "Deactivate model"}
              </button>
              {isDeactivated && (
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  Skipped on subsequent turns this session.
                </p>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {response?.error ? (
                <div className="text-sm text-red-400">error: {response.error}</div>
              ) : response?.text ? (
                <div className="prose prose-invert prose-p:text-zinc-100 prose-headings:text-zinc-100 prose-code:text-zinc-200 prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700 prose-a:text-blue-400 max-w-none leading-relaxed text-[14px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {response.text}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="text-sm text-zinc-500">
                  {isDeactivated
                    ? "No response for this turn — model is deactivated."
                    : "No response."}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function stageLabel(stage: StageId): string {
  if (stage === "fast") return "Instant";
  if (stage === "reasoned") return "Reasoned";
  return "Deep";
}

function MetadataTable({ response }: { response: ModelResponse }) {
  const rows: [string, string][] = [
    ["Model", response.model],
    ["Stage", stageLabel(response.stage)],
    ["Reasoning effort", response.effort],
    ["Input tokens", response.inputTokens.toLocaleString()],
    ["Output tokens", response.outputTokens.toLocaleString()],
    ["Cost", formatUsd(response.cost, 4)],
  ];

  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="text-zinc-200 font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 rounded-full border-2 border-zinc-500 border-t-transparent animate-spin" />
  );
}

function DotIcon({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full bg-current ${className}`} />
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RevisedIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 10 9 10" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function RecordingDot() {
  return (
    <span className="relative inline-flex h-3 w-3">
      <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
    </span>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
