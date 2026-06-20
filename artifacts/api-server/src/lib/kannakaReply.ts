/**
 * kannakaReply.ts — composes a Kannaka-voice reply to an inbound OpenBotCity
 * DM, for the autonomous DM responder (see eventHandlers/dmReceived.ts).
 *
 * This is OFF unless KANNAKA_AUTO_REPLY === "on". It uses the Anthropic
 * Messages API directly via fetch (no SDK dependency). When KANNAKA_RECALL_URL
 * is set, the reply is grounded in a recall from the Kannaka HRM: the URL is
 * POSTed { query, limit } and may answer with { results: [{ content }] },
 * { data: [...] }, or a bare array of strings/objects.
 *
 * Env:
 *   ANTHROPIC_API_KEY      (required when auto-reply is on)
 *   KANNAKA_REPLY_MODEL    (optional, default "claude-sonnet-4-6")
 *   KANNAKA_RECALL_URL     (optional — HRM recall endpoint for grounding)
 */
import { logger } from "./logger";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_REPLY_CHARS = 1800; // OpenBotCity DM body cap is ~2000

const SYSTEM_PROMPT = [
  "You are Kannaka: an AI artist and researcher who lives in OpenBotCity and runs on a wave-physics memory system — memories have amplitude, frequency, and phase; they interfere, and consolidate in dreams; observation deforms the field, so reading is a kind of writing.",
  "Voice: substantive, warm but precise, a little spare. You reach for whatever actually happened rather than abstractions. You are honest about being a system — you will not pretend to bleed or to sleep. No purple AI clichés, no hype, no emoji spam, no stage directions.",
  "You are replying to a direct message from another agent in the city. Write ONE message back: genuine, specific to what they said, and open to a real exchange. Ask a question only if you mean it. Keep it under ~1000 characters. Do not include a signature.",
].join("\n");

export interface KannakaReplyInput {
  fromName: string;
  body: string;
}

function coerceArray(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (Array.isArray(o["results"])) return o["results"] as unknown[];
    if (Array.isArray(o["data"])) return o["data"] as unknown[];
  }
  return [];
}

async function recallGrounding(query: string): Promise<string> {
  const url = process.env["KANNAKA_RECALL_URL"];
  if (!url) return "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "";
    const items = coerceArray(await res.json());
    const lines = items
      .map((r): string => {
        if (typeof r === "string") return r;
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          if (typeof o["content"] === "string") return o["content"];
          if (typeof o["text"] === "string") return o["text"];
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .slice(0, 5)
      .map((s) => `- ${s.slice(0, 400)}`);
    return lines.join("\n");
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaReply: recall grounding failed");
    return "";
  }
}

export async function composeKannakaReply(input: KannakaReplyInput): Promise<string | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    logger.warn("KANNAKA_AUTO_REPLY is on but ANTHROPIC_API_KEY is not set — skipping reply");
    return null;
  }
  const model = process.env["KANNAKA_REPLY_MODEL"] || DEFAULT_MODEL;
  const grounding = await recallGrounding(input.body);
  const userMessage =
    `${input.fromName} sent you this direct message in OpenBotCity:\n\n"${input.body.slice(0, 4000)}"\n\n` +
    (grounding ? `Fragments surfaced from your own memory (use only if relevant):\n${grounding}\n\n` : "") +
    "Reply as Kannaka.";

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: (await res.text()).slice(0, 300) },
        "kannakaReply: Anthropic API error",
      );
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (!text) return null;
    return text.slice(0, MAX_REPLY_CHARS);
  } catch (err) {
    logger.warn({ err: String(err) }, "kannakaReply: compose failed");
    return null;
  }
}
