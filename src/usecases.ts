import { choice, noul, score } from "@typesafe-ai/sdk";
import { z } from "zod";
import { PROVIDERS, usable, type ProviderKey } from "./config.ts";
import { jevCall, type Timed } from "./jev.ts";
import { parseWith } from "./llm.ts";

const has = (text: string, re: RegExp) => re.test(text.toLowerCase());

/* ───────────── Use case 3: inbox triage at scale ───────────── */

export const EMAIL_CATEGORIES = ["brand_deal", "invoice", "newsletter", "cold_pitch", "customer", "scam", "other"] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

const inboxQuestions = {
  category: choice("What kind of email is this?", {
    brand_deal: "A brand or sponsor offering a paid collaboration",
    invoice: "Receipt, invoice, payment confirmation or billing notice",
    newsletter: "Bulk newsletter or product update",
    cold_pitch: "Unsolicited sales or service pitch",
    customer: "A customer or member asking for help or giving feedback",
    scam: "Phishing, fraud or something untrustworthy",
    other: "Anything else",
  }),
  urgency: score("How important is it that the owner personally sees this email?", [
    "Ignore",
    "Low",
    "High, reply today",
    "Critical, needs a reply within 30 minutes",
  ]),
  scam: noul("Does this email look like a scam or something untrustworthy?"),
  needsReply: noul("Does this email need a personal reply?"),
};

export interface InboxLabel {
  category: EmailCategory;
  categoryConfidence: number;
  urgency: number;
  scam: number;
  needsReply: number;
}

export const classifyEmailWithJev = (email: string): Promise<Timed<InboxLabel>> =>
  jevCall(
    email,
    inboxQuestions,
    (a) => ({
      category: a.category.choice,
      categoryConfidence: a.category.confidence,
      urgency: a.urgency.score,
      scam: a.scam.noul,
      needsReply: a.needsReply.noul,
    }),
    () => {
      const category: EmailCategory = has(email, /verify your account|password will expire|wire transfer|gift card|prince|lottery/) ? "scam"
        : has(email, /sponsor|brand deal|collab|paid partnership|ambassador/) ? "brand_deal"
        : has(email, /invoice|receipt|payment (received|failed)|payout|billing/) ? "invoice"
        : has(email, /newsletter|this week in|unsubscribe|digest/) ? "newsletter"
        : has(email, /quick call|book a demo|grow your|10x|our agency|leads/) ? "cold_pitch"
        : has(email, /help|not working|broken|refund|can't|question|thank/) ? "customer" : "other";
      const scam = category === "scam" ? 0.93 : 0.03;
      return {
        category,
        categoryConfidence: 0.88,
        urgency: has(email, /urgent|asap|immediately|today|down/) ? (category === "scam" ? 0.4 : 2.6) : category === "customer" ? 1.8 : category === "brand_deal" ? 1.9 : 0.5,
        scam,
        needsReply: category === "customer" || category === "brand_deal" ? 0.9 : 0.06,
      };
    },
  );

const InboxLlmSchema = z.object({
  category: z.enum(EMAIL_CATEGORIES),
  urgency: z.number().describe("0 ignore, 1 low, 2 reply today, 3 critical within 30 minutes"),
  scam: z.number().describe("Probability 0-1 the email is a scam"),
  needsReply: z.number().describe("Probability 0-1 the email needs a personal reply"),
});

/** Baseline: the provider's small LLM answering the same questions. Null when it can't run. */
export async function classifyEmailWithLlm(email: string, provider: ProviderKey) {
  if (!usable(provider)) return null;
  let r;
  try {
    r = await parseWith(PROVIDERS[provider].small, InboxLlmSchema, email, "You triage the inbox of a busy content creator. Return the requested fields for the email.");
  } catch {
    return null;
  }
  return { value: { ...r.value, categoryConfidence: NaN } satisfies InboxLabel, latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costUsd, simulated: false };
}

/* ───────────── Use case 4: real-time feed filter ───────────── */

export const POST_KINDS = ["breaking", "golden_nugget", "hot_take", "promo", "ai_slop", "noise"] as const;
export type PostKind = (typeof POST_KINDS)[number];

const feedQuestions = {
  kind: choice("What kind of post is this?", {
    breaking: "Genuine breaking news, or an official product launch or release announcement with concrete details",
    golden_nugget: "A specific, useful insight, technique or resource worth saving",
    hot_take: "An opinion without new information",
    promo: "Advertising: giveaways, discount codes, follow-for-a-prize, or vague self-promotion with no concrete details",
    ai_slop: "Generic, formulaic engagement bait that reads as machine-written",
    noise: "Chatter with no value",
  }),
  aiWritten: noul("Does this read as machine-written filler?"),
  worthReading: score("How worth reading is this for someone focused on AI and building products?", ["Skip", "Skim", "Read", "Must read"]),
};

export interface FeedLabel {
  kind: PostKind;
  kindConfidence: number;
  aiWritten: number;
  worthReading: number;
}

export const labelPost = (post: string): Promise<Timed<FeedLabel>> =>
  jevCall(
    post,
    feedQuestions,
    (a) => ({ kind: a.kind.choice, kindConfidence: a.kind.confidence, aiWritten: a.aiWritten.noul, worthReading: a.worthReading.score }),
    () => {
      const slop = has(post, /game[- ]?changer|unlock|here'?s the thing|let that sink in|thread 🧵|10 ways|nobody is talking about|🚀|🔥/);
      const kind: PostKind = slop ? "ai_slop"
        : has(post, /just released|announcing|now available|launch(ed|es)|breaking/) ? "breaking"
        : has(post, /giveaway|use code|link in bio|discount|dm me/) ? "promo"
        : has(post, /benchmark|tip:|how to|repo|paper|latency|we measured|open.?source/) ? "golden_nugget"
        : has(post, /unpopular opinion|overrated|hot take|dead/) ? "hot_take" : "noise";
      return {
        kind,
        kindConfidence: 0.85,
        aiWritten: slop ? 0.94 : 0.08,
        worthReading: { breaking: 2.6, golden_nugget: 2.8, hot_take: 1.2, promo: 0.4, ai_slop: 0.2, noise: 0.3 }[kind],
      };
    },
  );

/* ───────────── Use case 5: LLM writes, Jev ranks ───────────── */

const titleQuestions = {
  clickAppeal: score("How likely is a curious viewer to click this video title?", ["Very unlikely", "Unlikely", "Maybe", "Likely", "Very likely"]),
  clarity: score("How clear is what the viewer will get from this title?", ["Vague", "Somewhat clear", "Clear", "Crystal clear"]),
  clickbait: noul("Is this title misleading or hype without substance?"),
  specific: noul("Does the title name a concrete outcome, number or tool?"),
};

export interface TitleScore {
  clickAppeal: number;
  clarity: number;
  clickbait: number;
  specific: number;
  /** 0-100 composite used to rank candidates. */
  composite: number;
}

const composite = (t: Omit<TitleScore, "composite">) =>
  Math.round(Math.max(0, Math.min(100, (t.clickAppeal / 4) * 45 + (t.clarity / 3) * 25 + t.specific * 15 + (1 - t.clickbait) * 15)));

export const scoreTitle = (title: string, topic: string): Promise<Timed<TitleScore>> =>
  jevCall(
    { topic, title },
    titleQuestions,
    (a) => {
      const t = { clickAppeal: a.clickAppeal.score, clarity: a.clarity.score, clickbait: a.clickbait.noul, specific: a.specific.noul };
      return { ...t, composite: composite(t) };
    },
    () => {
      const specific = /\d|build|step|vs|tutorial|how to/i.test(title) ? 0.8 : 0.25;
      const clickbait = /insane|shocking|you won't believe|secret|!!/i.test(title) ? 0.85 : 0.1;
      const t = { clickAppeal: 1.4 + (title.length % 7) * 0.32, clarity: specific > 0.5 ? 2.4 : 1.3, clickbait, specific };
      return { ...t, composite: composite(t) };
    },
  );

const TitlesSchema = z.object({ titles: z.array(z.string()) });

export async function generateTitles(topic: string, n: number, provider: ProviderKey) {
  const simulated = async () => {
    const seeds = [
      `${topic}: the complete beginner tutorial`, `I built an AI agent with ${topic} in 20 minutes`, `${topic} is INSANE (you won't believe this)`,
      `${topic} vs the old way: real cost and speed numbers`, `The secret ${topic} trick nobody talks about`, `${topic} explained in 5 minutes`,
      `Build a support triage bot with ${topic} step by step`, `Why ${topic} changes everything`, `${topic} for beginners: 3 projects you can copy`,
      `Stop overpaying for AI: ${topic} cuts costs 90%`, `${topic}: what I learned after 7 days`, `Is ${topic} overhyped? I tested it`,
    ];
    return { titles: seeds.slice(0, n), simulated: true, latencyMs: 300, costUsd: 0 };
  };
  if (!usable(provider)) return simulated();
  let r;
  try {
    r = await parseWith(PROVIDERS[provider].small, TitlesSchema, `Topic: ${topic}\nWrite ${n} distinct YouTube video titles, varied in style (tutorial, curiosity, comparison, hype, specific outcome). Titles only.`, "You write YouTube titles for a developer audience.");
  } catch {
    return simulated();
  }
  return { titles: r.value.titles.slice(0, n), simulated: false, latencyMs: r.latencyMs, costUsd: r.costUsd };
}
