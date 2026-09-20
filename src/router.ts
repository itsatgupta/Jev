import { choice, noul, score } from "@typesafe-ai/sdk";
import { PROVIDERS, type ModelKey, type ProviderKey, type Tier } from "./config.ts";
import { jevCall } from "./jev.ts";

const TIERS: Tier[] = ["light", "standard", "frontier"];

/** Below this Jev confidence we escalate one tier: a wrong downgrade costs more than a wasted upgrade. */
export const MIN_CONFIDENCE = 0.6;

// The routing "policy" lives here, as typed questions. Control flow stays in ordinary code.
const routingQuestions = {
  tier: choice("What is the minimum model tier that can answer this request well?", {
    light: "Simple: greeting, factual lookup, short rewrite, formatting, extraction or classification of short text",
    standard: "Moderate: typical coding task, summarising long text, multi-step analysis, constrained writing",
    frontier: "Hard: novel algorithm or system design, deep multi-step reasoning, proofs, subtle debugging, high-stakes analysis",
  }),
  complexity: score("How complex is the request?", [
    "Trivial, one obvious step",
    "Simple, a few obvious steps",
    "Moderate, needs planning or domain knowledge",
    "Hard, needs deep reasoning or expert judgement",
  ]),
  needsReasoning: noul("Does answering correctly require extended multi-step reasoning?"),
};

interface Raw {
  jevTier: Tier;
  probabilities: Record<Tier, number>;
  confidence: number;
  complexity: number;
  needsReasoning: number;
}

export interface RouteDecision extends Raw {
  tier: Tier;
  /** True when the confidence guard moved the request up one tier. */
  escalated: boolean;
  provider: ProviderKey;
  model: ModelKey;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  simulated: boolean;
}

/** Offline stand-in for Jev so the demo runs without a key. Deliberately crude, always flagged simulated. */
function heuristic(prompt: string): Raw {
  const p = prompt.toLowerCase();
  let hard = 0;
  if (/prove|proof|distributed|consensus|architect|race condition|deadlock|optimi[sz]e|trade-?offs?|migration plan|threat model/.test(p)) hard += 2;
  if (/step by step|derive|why does|root cause|design a|from scratch/.test(p)) hard += 1;
  if (prompt.length > 900) hard += 1;
  let std = 0;
  if (/refactor|function|code|bug|sql|summari[sz]e|analy[sz]e|compare|write an? (email|essay|report)/.test(p)) std += 1;
  if (prompt.length > 300) std += 1;
  const tier: Tier = hard >= 2 ? "frontier" : hard + std >= 1 ? "standard" : "light";
  const top = tier === "light" ? 0.9 : tier === "standard" ? 0.78 : 0.86;
  const rest = (1 - top) / 2;
  return {
    jevTier: tier,
    probabilities: Object.fromEntries(TIERS.map((t) => [t, t === tier ? top : rest])) as Record<Tier, number>,
    confidence: top,
    complexity: { light: 0.4, standard: 1.7, frontier: 2.7 }[tier],
    needsReasoning: { light: 0.05, standard: 0.4, frontier: 0.9 }[tier],
  };
}

export async function decide(prompt: string, provider: ProviderKey): Promise<RouteDecision> {
  const r = await jevCall(
    prompt.slice(0, 60_000),
    routingQuestions,
    (a): Raw => ({
      jevTier: a.tier.choice as Tier,
      probabilities: a.tier.probabilities as Record<Tier, number>,
      confidence: a.tier.confidence,
      complexity: a.complexity.score,
      needsReasoning: a.needsReasoning.noul,
    }),
    () => heuristic(prompt),
  );
  const idx = TIERS.indexOf(r.value.jevTier);
  const escalated = r.value.confidence < MIN_CONFIDENCE && idx < TIERS.length - 1;
  const tier = escalated ? TIERS[idx + 1]! : r.value.jevTier;
  return { ...r.value, tier, escalated, provider, model: PROVIDERS[provider].tiers[tier], latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costUsd, simulated: r.simulated };
}
