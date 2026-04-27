import { NextRequest } from "next/server";

export const runtime = "nodejs";

const MODEL = "gpt-4o-transcribe";

export async function POST(_req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  const body = {
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: { type: "server_vad" },
          transcription: { model: MODEL },
        },
      },
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    return Response.json({ error: `failed to reach OpenAI: ${message}` }, { status: 502 });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return Response.json(
      { error: `OpenAI ${upstream.status}: ${text}` },
      { status: 502 },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON from OpenAI" }, { status: 502 });
  }

  const value = extractClientSecret(data);
  if (!value) {
    return Response.json(
      { error: "no client_secret in OpenAI response" },
      { status: 502 },
    );
  }

  return Response.json({ clientSecret: value, model: MODEL });
}

function extractClientSecret(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const direct = obj["client_secret"];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const v = (direct as Record<string, unknown>)["value"];
    if (typeof v === "string") return v;
  }
  if (typeof obj["value"] === "string") return obj["value"] as string;
  return null;
}
