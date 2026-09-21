import { noul, TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { accountError, budget, jevCostUsd } from "./config.ts";
import { bucket, keyFor } from "./keys.ts";

export interface Timed<T> {
  value: T;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  /** True when no usable Jev key is available and the offline heuristic answered instead. */
  simulated: boolean;
}

const clients = new Map<string, TypeSafeClient>();
/** One client per key (never shared across visitors); bounded so a public host can't grow it forever. */
function clientFor(apiKey: string) {
  let c = clients.get(apiKey);
  if (!c) {
    if (clients.size >= 50) clients.clear();
    c = new TypeSafeClient({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

/** Cheapest possible real call, used to validate a key. Throws with the provider's error if it fails. */
export async function probeJev() {
  const key = keyFor("jev");
  if (!key) throw new Error("No Jev key");
  await clientFor(key).systemOne({ state: "ping", questions: { ok: noul("Is this a greeting?") } });
}

/* Availability: a rejected key marks Jev down for a cool-down (per key), and the offline heuristic answers instead. */
const jevDown = new Map<string, { until: number; reason: string }>();
const COOL_DOWN_MS = 10 * 60_000;
export function jevState(): { state: "live" | "simulated" | "unavailable"; note: string } {
  if (!keyFor("jev")) return { state: "simulated", note: "No API key set" };
  const d = jevDown.get(bucket("jev"));
  return d && Date.now() < d.until ? { state: "unavailable", note: d.reason } : { state: "live", note: "" };
}
export const resetJevDown = () => jevDown.delete(bucket("jev"));
export const markJevDown = (reason: string) => { jevDown.set(bucket("jev"), { until: Date.now() + COOL_DOWN_MS, reason }); };

/**
 * One Jev call: typed questions in, a normalised plain value out, with latency and cost attached.
 * `mock` is the offline stand-in used when there is no key, or the key is rejected.
 */
export async function jevCall<const Q extends Questions, T>(
  state: EntryType,
  questions: Q,
  normalize: (answers: SystemOneResult<Q>["answers"]) => T,
  mock: () => T,
): Promise<Timed<T>> {
  const started = performance.now();
  const simulate = async (): Promise<Timed<T>> => {
    const text = typeof state === "string" ? state : JSON.stringify(state);
    const inputTokens = Math.ceil(text.length / 4) + 60 * Object.keys(questions).length;
    await new Promise((r) => setTimeout(r, 70 + Math.random() * 130));
    return { value: mock(), latencyMs: Math.round(performance.now() - started), inputTokens, costUsd: jevCostUsd(inputTokens), simulated: true };
  };
  const apiKey = keyFor("jev");
  if (!apiKey || jevState().state !== "live") return simulate();
  let result;
  try {
    result = await clientFor(apiKey).systemOne({ state, questions });
  } catch (err) {
    const reason = accountError(err);
    if (!reason) throw err;
    jevDown.set(bucket("jev"), { until: Date.now() + COOL_DOWN_MS, reason });
    return simulate();
  }
  const { answers, usage } = result;
  budget.charge(jevCostUsd(usage.input_tokens), "jev");
  return {
    value: normalize(answers),
    latencyMs: Math.round(performance.now() - started),
    inputTokens: usage.input_tokens,
    costUsd: jevCostUsd(usage.input_tokens),
    simulated: false,
  };
}
