export type Provider = "openai" | "anthropic" | "google" | "xai" | "other";

export type Usage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};

export function providerFromModel(model: string): Provider {
  const prefix = model.split("/")[0];
  if (prefix === "openai") return "openai";
  if (prefix === "anthropic") return "anthropic";
  if (prefix === "google") return "google";
  if (prefix === "x-ai") return "xai";
  return "other";
}
