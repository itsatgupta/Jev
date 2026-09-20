import { choice, noul, score } from "@typesafe-ai/sdk";
import { z } from "zod";
import { PROVIDERS, usable, type ProviderKey } from "./config.ts";
import { jevCall } from "./jev.ts";
import { complete, parseWith, type Completion } from "./llm.ts";

const DEPARTMENTS = {
  billing: "Charges, refunds, invoices, payment failures",
  technical: "Bugs, outages, errors, integration problems",
  account: "Login, access, profile, plan or seat changes",
  sales: "Pricing, upgrades, demos, procurement",
  other: "Anything else",
} as const;
type Department = keyof typeof DEPARTMENTS;

// One Jev call answers all six questions in a single parallel pass.
const triageQuestions = {
  department: choice("Which team should handle this ticket?", DEPARTMENTS),
  urgency: score("How urgent is this ticket?", [
    "No time pressure",
    "Would like a reply this week",
    "Blocking their work, needs a reply today",
    "Production is down or money is at risk right now",
  ]),
  frustration: score("How frustrated is the customer?", [
    "Calm, factual",
    "Mildly annoyed but civil",
    "Clearly angry",
    "Furious, threatening or abusive",
  ]),
  refundRequested: noul("Does the customer explicitly ask for money back?"),
  churnRisk: noul("Is the customer signalling they may cancel or leave?"),
  spam: noul("Is this spam, a solicitation, or not a real support request?"),
};

export interface Triage {
  department: Department;
  departmentConfidence: number;
  urgency: number;
  frustration: number;
  refundRequested: number;
  churnRisk: number;
  spam: number;
}

export interface TimedTriage {
  triage: Triage;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
  simulated: boolean;
}

export type Action = "discard" | "escalate" | "auto-reply";

/** Business rules stay in plain code; Jev only supplies the calibrated signals they branch on. */
export function decideAction(t: Triage): { action: Action; reasons: string[] } {
  if (t.spam > 0.7) return { action: "discard", reasons: [`spam ${pct(t.spam)}`] };
  const reasons: string[] = [];
  if (t.churnRisk > 0.6) reasons.push(`churn risk ${pct(t.churnRisk)}`);
  if (t.urgency >= 2.2) reasons.push(`urgency ${t.urgency.toFixed(1)}/3`);
  if (t.frustration >= 2.2) reasons.push(`frustration ${t.frustration.toFixed(1)}/3`);
  if (t.refundRequested > 0.7 && t.department === "billing") reasons.push("refund request");
  return reasons.length
    ? { action: "escalate", reasons }
    : { action: "auto-reply", reasons: ["low urgency, low churn risk"] };
}
const pct = (n: number) => `${Math.round(n * 100)}%`;

export const triageWithJev = async (ticket: string): Promise<TimedTriage> => {
  const r = await jevCall(
    ticket,
    triageQuestions,
    (a): Triage => ({
      department: a.department.choice,
      departmentConfidence: a.department.confidence,
      urgency: a.urgency.score,
      frustration: a.frustration.score,
      refundRequested: a.refundRequested.noul,
      churnRisk: a.churnRisk.noul,
      spam: a.spam.noul,
    }),
    () => heuristic(ticket),
  );
  return { triage: r.value, latencyMs: r.latencyMs, costUsd: r.costUsd, inputTokens: r.inputTokens, simulated: r.simulated };
};

const LlmTriageSchema = z.object({
  department: z.enum(["billing", "technical", "account", "sales", "other"]),
  urgency: z.number().describe("0 no pressure, 1 this week, 2 needs reply today, 3 production down or money at risk"),
  frustration: z.number().describe("0 calm, 1 mildly annoyed, 2 angry, 3 furious"),
  refundRequested: z.number().describe("Probability 0-1 that the customer explicitly asks for a refund"),
  churnRisk: z.number().describe("Probability 0-1 that the customer may cancel"),
  spam: z.number().describe("Probability 0-1 that this is spam or not a support request"),
});

/** Baseline: the same six judgements made by the provider's small LLM (the cheap, fast option). */
export async function triageWithLlm(ticket: string, provider: ProviderKey): Promise<TimedTriage | null> {
  if (!usable(provider)) return null;
  let r;
  try {
    r = await parseWith(PROVIDERS[provider].small, LlmTriageSchema, ticket, "You triage customer-support tickets. Return the requested fields for the ticket.");
  } catch {
    return null; // baseline unavailable (spend cap or rate limit): the UI shows the lane as n/a
  }
  return {
    triage: { ...r.value, departmentConfidence: NaN },
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    simulated: false,
  };
}

/** Offline stand-in for Jev; flagged simulated everywhere it surfaces. */
function heuristic(ticket: string): Triage {
  const t = ticket.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  const department: Department = has(/charged|refund|invoice|payment|billing|card/)
    ? "billing"
    : has(/error|bug|crash|down|outage|api|500|not working|broken/)
      ? "technical"
      : has(/password|login|log in|access|seat|account/)
        ? "account"
        : has(/pricing|quote|demo|enterprise|upgrade/)
          ? "sales"
          : "other";
  const spam = has(/seo|backlinks|crypto|winner|click here|guaranteed/) ? 0.95 : 0.03;
  const relaxed = has(/nothing urgent|not urgent|no rush|whenever you/);
  const urgency = relaxed ? 0.5 : has(/production|down|outage|asap|urgent|immediately|losing/) ? 2.8 : has(/today|blocked|can't/) ? 2.1 : 0.7;
  const frustration = has(/unacceptable|furious|worst|scam|ridiculous|!!/) ? 2.7 : has(/again|still|third time|frustrat/) ? 1.8 : 0.4;
  return {
    department,
    departmentConfidence: 0.9,
    urgency,
    frustration,
    refundRequested: has(/refund|money back/) ? 0.94 : 0.04,
    churnRisk: has(/cancel|switch to|leaving|competitor/) ? 0.88 : 0.05,
    spam,
  };
}

/** Drafts the first reply; escalated tickets get the bigger model. */
export async function draftReply(ticket: string, department: string, action: Action, provider: ProviderKey): Promise<Completion | null> {
  if (action === "discard") return null;
  const p = PROVIDERS[provider];
  return complete(action === "escalate" ? p.mid : p.small, ticket, {
    system:
      `You are a support agent for a SaaS company. The ticket was routed to ${department}. ` +
      (action === "escalate"
        ? "It is high priority: acknowledge the impact, apologise once, and state the next concrete step. "
        : "Write a short, friendly first reply. ") +
      "Under 90 words. Never promise refunds or timelines you cannot verify.",
    maxTokens: 250,
  });
}
