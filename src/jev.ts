import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { budget, hasJevKey, jevCostUsd } from "./config.ts";

export interface Timed<T> {
  value: T;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  /** True when no TYPESAFE_API_KEY is set and the offline heuristic answered instead. */
  simulated: boolean;
}

let client: TypeSafeClient | undefined;

/**
 * One Jev call: typed questions in, a normalised plain value out, with latency and cost attached.
 * `mock` is the offline stand-in used only when no key is configured.
 */
export async function jevCall<const Q extends Questions, T>(
  state: EntryType,
  questions: Q,
  normalize: (answers: SystemOneResult<Q>["answers"]) => T,
  mock: () => T,
): Promise<Timed<T>> {
  const started = performance.now();
  if (!hasJevKey()) {
    const text = typeof state === "string" ? state : JSON.stringify(state);
    const inputTokens = Math.ceil(text.length / 4) + 60 * Object.keys(questions).length;
    await new Promise((r) => setTimeout(r, 70 + Math.random() * 130));
    return { value: mock(), latencyMs: Math.round(performance.now() - started), inputTokens, costUsd: jevCostUsd(inputTokens), simulated: true };
  }
  client ??= new TypeSafeClient();
  const { answers, usage } = await client.systemOne({ state, questions });
  budget.charge(jevCostUsd(usage.input_tokens));
  return {
    value: normalize(answers),
    latencyMs: Math.round(performance.now() - started),
    inputTokens: usage.input_tokens,
    costUsd: jevCostUsd(usage.input_tokens),
    simulated: false,
  };
}
