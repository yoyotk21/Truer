import { openrouter, toUsage } from "./providers";
import { addCost, setTitle } from "./db";
import { providerFromModel } from "./pricing";

const TITLE_MODEL = process.env.MODEL_TITLE || "openai/gpt-5.4-mini";

const PROMPT = [
  "Generate a 3 to 6 word title summarizing this chat. No quotes, no trailing punctuation, no surrounding markdown. Title only.",
  "",
  "USER:",
].join("\n");

export async function generateTitle(
  sessionId: string,
  firstUserMessage: string,
  firstAssistantText: string,
): Promise<void> {
  try {
    const resp = await openrouter().chat.completions.create({
      model: TITLE_MODEL,
      messages: [
        {
          role: "user",
          content: `${PROMPT}\n${firstUserMessage}\n\nASSISTANT:\n${firstAssistantText.slice(0, 1200)}`,
        },
      ],
      reasoning: { effort: "minimal" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const raw = resp.choices[0]?.message?.content?.trim() ?? "";
    const title = raw.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 80);
    if (title) setTitle(sessionId, title);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = toUsage(TITLE_MODEL, resp.usage as any);
    if (usage.cost > 0 && providerFromModel(usage.model)) {
      addCost(sessionId, usage.cost);
    }
  } catch {
    // Leave the truncation fallback in place.
  }
}

export function fallbackTitle(firstUserMessage: string): string {
  const t = firstUserMessage.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 57) + "..." : t || "New chat";
}
