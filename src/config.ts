import { bucket, keyFor, type KeyName } from "./keys.ts";

export type ProviderKey = "claude" | "kimi";
export type ModelKey = "haiku" | "sonnet" | "opus" | "kimiK26" | "kimiK3";
export type Tier = "light" | "standard" | "frontier";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderKey;
  /** USD per 1M tokens (first-party list price). */
  inPerM: number;
  outPerM: number;
}

// Prices are first-party list prices as of Sep 2026. Re-check before quoting numbers externally.
export const MODELS: Record<ModelKey, ModelInfo> = {
  haiku: { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "claude", inPerM: 1, outPerM: 5 },
  sonnet: { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude", inPerM: 2, outPerM: 10 },
  opus: { id: "claude-opus-5", label: "Opus 5", provider: "claude", inPerM: 5, outPerM: 25 },
  kimiK26: { id: "kimi-k2.6", label: "Kimi K2.6", provider: "kimi", inPerM: 0.95, outPerM: 4 },
  kimiK3: { id: "kimi-k3", label: "Kimi K3", provider: "kimi", inPerM: 3, outPerM: 15 },
};

export interface Provider {
  label: string;
  /** Which model answers each router tier. */
  tiers: Record<Tier, ModelKey>;
  /** Cheap model: classifier baseline, title writer, auto-replies. */
  small: ModelKey;
  /** Bigger model for escalated replies. */
  mid: ModelKey;
  /** Top model: the "always use the best" baseline. */
  big: ModelKey;
}

export const PROVIDERS: Record<ProviderKey, Provider> = {
  claude: { label: "Claude", tiers: { light: "haiku", standard: "sonnet", frontier: "opus" }, small: "haiku", mid: "sonnet", big: "opus" },
  kimi: { label: "Kimi", tiers: { light: "kimiK26", standard: "kimiK3", frontier: "kimiK3" }, small: "kimiK26", mid: "kimiK3", big: "kimiK3" },
};

// Jev: $0.042 per 1M input tokens, output free.
export const JEV_IN_PER_M = 0.042;

export const hasJevKey = () => keyFor("jev") !== undefined;
export const hasKey = (p: ProviderKey) => keyFor(p) !== undefined;

export const costUsd = (m: ModelInfo, inTok: number, outTok: number) => (inTok * m.inPerM + outTok * m.outPerM) / 1e6;
export const jevCostUsd = (inTok: number) => (inTok * JEV_IN_PER_M) / 1e6;

/* ───────────── Spend budget ─────────────
 * A hard cap on real API spend. Once reached, paid LLM calls fall back to clearly badged simulated output
 * until the cap is raised. Every key gets its own bucket: all traffic on the server's keys shares one, and each
 * visitor-supplied key has its own, so nobody can spend anybody else's budget. Jev is ~free, so it is counted
 * but never blocked. */
const defaultCap = () => Number(process.env.DEMO_BUDGET_USD ?? 0.5);
const budgets = new Map<string, { spent: number; cap: number }>();
const slot = (name: KeyName) => {
  const id = bucket(name);
  let b = budgets.get(id);
  if (!b) {
    if (budgets.size >= 2000) budgets.delete(budgets.keys().next().value!); // bound memory on a public host
    b = { spent: 0, cap: defaultCap() };
    budgets.set(id, b);
  }
  return b;
};
export const budget = {
  spent: (name: KeyName) => slot(name).spent,
  cap: (name: KeyName) => slot(name).cap,
  charge: (usd: number, name: KeyName) => { slot(name).spent += usd; },
  setCap: (usd: number, name: KeyName) => { slot(name).cap = usd; },
  exhausted: (name: KeyName) => slot(name).spent >= slot(name).cap,
};

/* ───────────── Provider availability ─────────────
 * Account-level failures (spend cap, bad key, no credit) mark that key down for a cool-down window. */
const down = new Map<string, { until: number; reason: string }>();
const COOL_DOWN_MS = 10 * 60_000; // account-level problems (spend cap, credit) do not clear in seconds
const downId = (p: ProviderKey) => `${p}:${bucket(p)}`;

export type ProviderState = "live" | "simulated" | "unavailable" | "budget";
export function providerState(p: ProviderKey): { state: ProviderState; note: string } {
  if (!hasKey(p)) return { state: "simulated", note: "No API key set" };
  if (budget.exhausted(p)) return { state: "budget", note: `Demo budget of $${budget.cap(p).toFixed(2)} reached` };
  const d = down.get(downId(p));
  if (d && Date.now() < d.until) return { state: "unavailable", note: d.reason };
  return { state: "live", note: "" };
}
export const usable = (p: ProviderKey) => providerState(p).state === "live";

/** Returns a human reason when `err` is an account-level failure (not a transient one), otherwise null. */
export function accountError(err: unknown): string | null {
  const e = err as { status?: number; error?: { error?: { message?: string } }; message?: string };
  const message = e?.error?.error?.message ?? e?.message ?? "";
  if (e?.status === 401 || e?.status === 402 || e?.status === 403) return message || "The provider rejected the key";
  if ((e?.status === 400 || e?.status === 429) && /usage limit|credit balance|billing|spend|insufficient|quota|balance|suspended/i.test(message)) return message;
  return null;
}
export function markDown(p: ProviderKey, reason: string) {
  if (down.size >= 2000) down.delete(down.keys().next().value!);
  down.set(downId(p), { until: Date.now() + COOL_DOWN_MS, reason });
}
export function resetDown(p: ProviderKey) {
  down.delete(downId(p));
}
