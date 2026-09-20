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

export const hasJevKey = () => Boolean(process.env.TYPESAFE_API_KEY?.trim());
export const hasKey = (p: ProviderKey) => Boolean((p === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.MOONSHOT_API_KEY)?.trim());

export const costUsd = (m: ModelInfo, inTok: number, outTok: number) => (inTok * m.inPerM + outTok * m.outPerM) / 1e6;
export const jevCostUsd = (inTok: number) => (inTok * JEV_IN_PER_M) / 1e6;

/* ───────────── Spend budget ─────────────
 * A hard cap on real API spend for the demo session. Once reached, paid LLM calls fall back to clearly
 * badged simulated output until the cap is raised. Jev is ~free, so it is counted but never blocked. */
let spentUsd = 0;
let capUsd = Number(process.env.DEMO_BUDGET_USD ?? 0.5);
export const budget = {
  spent: () => spentUsd,
  cap: () => capUsd,
  charge: (usd: number) => { spentUsd += usd; },
  setCap: (usd: number) => { capUsd = usd; },
  exhausted: () => spentUsd >= capUsd,
};

/* ───────────── Provider availability ─────────────
 * Account-level failures (spend cap, bad key, no credit) mark a provider down for a cool-down window. */
const down: Record<ProviderKey, { until: number; reason: string }> = { claude: { until: 0, reason: "" }, kimi: { until: 0, reason: "" } };
const COOL_DOWN_MS = 10 * 60_000; // account-level problems (spend cap, credit) do not clear in seconds

export type ProviderState = "live" | "simulated" | "unavailable" | "budget";
export function providerState(p: ProviderKey): { state: ProviderState; note: string } {
  if (!hasKey(p)) return { state: "simulated", note: "No API key set" };
  if (budget.exhausted()) return { state: "budget", note: `Demo budget of $${capUsd.toFixed(2)} reached` };
  if (Date.now() < down[p].until) return { state: "unavailable", note: down[p].reason };
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
  down[p] = { until: Date.now() + COOL_DOWN_MS, reason };
}
export function resetDown(p: ProviderKey) {
  down[p] = { until: 0, reason: "" };
}
