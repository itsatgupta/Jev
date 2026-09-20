import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODELS, accountError, budget, costUsd, markDown, usable, type ModelKey } from "./config.ts";

let claude: Anthropic | undefined;
const anthropic = () => (claude ??= new Anthropic());
const KIMI_BASE = process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";

export type Effort = "low" | "medium" | "high";

export interface Completion {
  model: ModelKey;
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  simulated: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => Math.round(base * (0.85 + Math.random() * 0.3));

// Rough offline stand-ins used only when a provider is unavailable. Always flagged `simulated`.
const SIM: Record<ModelKey, { latency: number; outTok: number }> = {
  haiku: { latency: 800, outTok: 140 }, sonnet: { latency: 2200, outTok: 380 }, opus: { latency: 3800, outTok: 520 },
  kimiK26: { latency: 900, outTok: 160 }, kimiK3: { latency: 4500, outTok: 420 },
};

interface KimiResult { text: string; inputTokens: number; outputTokens: number }

/** Kimi speaks the OpenAI chat-completions wire format. K2.6 needs thinking switched off to answer directly. */
async function kimiChat(model: ModelKey, system: string | undefined, prompt: string, o: { maxTokens: number; json?: boolean; effort?: Effort }): Promise<KimiResult> {
  const info = MODELS[model];
  const body: Record<string, unknown> = {
    model: info.id,
    max_tokens: o.maxTokens,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    ...(model === "kimiK26" ? { thinking: { type: "disabled" } } : { reasoning_effort: o.effort === "high" ? "high" : "low" }),
    ...(o.json ? { response_format: { type: "json_object" } } : {}),
  };
  const res = await fetch(`${KIMI_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MOONSHOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? res.statusText), { status: res.status });
  return {
    text: (data.choices?.[0]?.message?.content ?? "").trim(),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

export async function complete(
  model: ModelKey,
  prompt: string,
  opts: { system?: string; maxTokens?: number; effort?: Effort } = {},
): Promise<Completion> {
  const info = MODELS[model];
  const started = performance.now();
  const effort = opts.effort ?? "low";
  const maxTokens = opts.maxTokens ?? (info.provider === "kimi" && model === "kimiK3" ? 1000 : 500);

  const simulate = async (): Promise<Completion> => {
    const sim = SIM[model];
    const inputTokens = Math.ceil(prompt.length / 4) + 20;
    await sleep(jitter(sim.latency));
    return {
      model, text: `[Simulated ${info.label} response: this provider is unavailable, so this is a placeholder.]`,
      inputTokens, outputTokens: sim.outTok, latencyMs: Math.round(performance.now() - started),
      costUsd: costUsd(info, inputTokens, sim.outTok), simulated: true,
    };
  };
  if (!usable(info.provider)) return simulate();

  let text: string, inputTokens: number, outputTokens: number;
  try {
    if (info.provider === "kimi") {
      ({ text, inputTokens, outputTokens } = await kimiChat(model, opts.system, prompt, { maxTokens, effort }));
      if (!text) text = "[The model spent its token budget on reasoning before answering. Raise max tokens or lower the effort.]";
    } else {
      const r = await anthropic().messages.create({
        model: info.id, max_tokens: maxTokens, system: opts.system,
        ...(model === "haiku" ? {} : { output_config: { effort } }),
        messages: [{ role: "user", content: prompt }],
      });
      text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      inputTokens = r.usage.input_tokens; outputTokens = r.usage.output_tokens;
    }
  } catch (err) {
    const reason = accountError(err);
    if (!reason) throw err;
    markDown(info.provider, reason);
    return simulate();
  }
  const cost = costUsd(info, inputTokens, outputTokens);
  budget.charge(cost);
  return { model, text, inputTokens, outputTokens, latencyMs: Math.round(performance.now() - started), costUsd: cost, simulated: false };
}

export interface Parsed<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

/** Structured-output call: the "LLM does the classification" baseline. Throws if the provider can't answer. */
export async function parseWith<S extends z.ZodType>(model: ModelKey, schema: S, prompt: string, system: string): Promise<Parsed<z.infer<S>>> {
  const info = MODELS[model];
  if (!usable(info.provider)) throw new Error(`${info.label} is unavailable`);
  const started = performance.now();
  let value: z.infer<S>, inputTokens: number, outputTokens: number;
  try {
    if (info.provider === "kimi") {
      const sys = `${system}\nRespond with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(z.toJSONSchema(schema))}`;
      const r = await kimiChat(model, sys, prompt, { maxTokens: 400, json: true });
      value = schema.parse(JSON.parse(r.text));
      ({ inputTokens, outputTokens } = r);
    } else {
      const r = await anthropic().messages.parse({
        model: info.id, max_tokens: 500, system,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      });
      if (!r.parsed_output) throw new Error("Claude returned output that did not match the schema");
      value = r.parsed_output; inputTokens = r.usage.input_tokens; outputTokens = r.usage.output_tokens;
    }
  } catch (err) {
    const reason = accountError(err);
    if (reason) markDown(info.provider, reason);
    throw err;
  }
  const cost = costUsd(info, inputTokens, outputTokens);
  budget.charge(cost);
  return { value, inputTokens, outputTokens, latencyMs: Math.round(performance.now() - started), costUsd: cost };
}
