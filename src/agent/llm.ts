import OpenAI from "openai";
import { z } from "zod";

/**
 * LLM client for discovery. NVIDIA-hosted Nemotron via the OpenAI-compatible
 * endpoint. We ask for strict JSON in the message content (rather than native
 * tool calling) because JSON-in-content is the lowest common denominator that
 * works reliably across NVIDIA-hosted models; a Zod parse + one retry guards
 * against malformed output.
 */

// models frequently emit explicit nulls for unused fields — treat null as absent
const optStr = z.string().nullish().transform((v) => v ?? undefined);

export const DecisionSchema = z.object({
  thought: z.string().nullish().transform((v) => v ?? ""),
  action: z.object({
    verb: z.enum(["click", "type", "select", "navigate", "extract", "done", "stuck"]),
    ref: optStr,
    value: optStr,
    /** for extract: which declared output this fills */
    name: optStr,
    /** for done/stuck */
    summary: optStr,
  }),
});
export type Decision = z.infer<typeof DecisionSchema>;

export class LlmClient {
  private client: OpenAI;
  readonly model: string;

  constructor() {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) throw new Error("NVIDIA_API_KEY is not set (see .env.example). Required for discovery runs only.");
    this.client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });
    this.model = process.env.NVIDIA_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1";
  }

  async decide(messages: OpenAI.ChatCompletionMessageParam[]): Promise<{ decision: Decision; raw: string }> {
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs = lastErr
        ? [...messages, { role: "user" as const, content: `Your previous reply was not valid JSON for the required schema (${lastErr}). Reply again with ONLY the JSON object.` }]
        : messages;
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: msgs,
        temperature: 0.2,
        max_tokens: 600,
      });
      const raw = res.choices[0]?.message?.content ?? "";
      const parsed = extractJson(raw);
      if (parsed) {
        const check = DecisionSchema.safeParse(parsed);
        if (check.success) return { decision: check.data, raw };
        lastErr = check.error.issues.map((i) => i.message).join("; ");
      } else {
        lastErr = "no JSON object found";
      }
    }
    throw new Error(`Model did not produce a valid decision after retry (${lastErr})`);
  }
}

/** Pull the first JSON object out of a reply that may include prose or code fences. */
function extractJson(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  // scan for the matching close brace
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
