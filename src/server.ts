import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_IN_PER_M, MODELS, PROVIDERS, budget, hasJevKey, providerState, resetDown, usable, type ProviderKey, type Tier } from "./config.ts";
import { complete, type Effort } from "./llm.ts";
import { decide } from "./router.ts";
import { feedPosts, makeEmails, routerPrompts, tickets } from "./samples.ts";
import { decideAction, draftReply, triageWithJev, triageWithLlm, type Action } from "./triage.ts";
import { classifyEmailWithJev, classifyEmailWithLlm, generateTitles, labelPost, scoreTitle } from "./usecases.ts";

const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const MAX_BODY = 200_000;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const text = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${field}" must be a non-empty string`);
  return v;
};

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

const provider = (b: Record<string, unknown>): ProviderKey => {
  if (b.provider === undefined) return "claude";
  if (b.provider === "claude" || b.provider === "kimi") return b.provider;
  throw new HttpError(400, `"provider" must be "claude" or "kimi"`);
};
const TIERS: Tier[] = ["light", "standard", "frontier"];
const tier = (v: unknown): Tier => {
  const t = TIERS.find((x) => x === v);
  if (!t) throw new HttpError(400, `"tier" must be one of ${TIERS.join(", ")}`);
  return t;
};
/** Thinking effort per tier, kept low on purpose: the demo should be cheap to run. */
const effortFor = (p: ProviderKey, t: Tier): Effort => (t === "frontier" ? (p === "kimi" ? "high" : "medium") : "low");

/** POST handlers: one endpoint per pipeline stage so the UI can animate each hop as it really happens. */
const post: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/api/route/decide": async (b) => decide(text(b.prompt, "prompt"), provider(b)),
  "/api/route/answer": async (b) => {
    const p = provider(b), t = tier(b.tier);
    return complete(PROVIDERS[p].tiers[t], text(b.prompt, "prompt"), { effort: effortFor(p, t) });
  },
  "/api/triage/jev": async (b) => {
    const jev = await triageWithJev(text(b.ticket, "ticket"));
    return { jev, ...decideAction(jev.triage) };
  },
  "/api/triage/llm": async (b) => triageWithLlm(text(b.ticket, "ticket"), provider(b)),
  "/api/triage/reply": async (b) => draftReply(text(b.ticket, "ticket"), text(b.department, "department"), text(b.action, "action") as Action, provider(b)),
  "/api/inbox/jev": async (b) => classifyEmailWithJev(text(b.email, "email")),
  "/api/inbox/llm": async (b) => classifyEmailWithLlm(text(b.email, "email"), provider(b)),
  "/api/feed/label": async (b) => labelPost(text(b.post, "post")),
  "/api/titles/generate": async (b) => generateTitles(text(b.topic, "topic"), num(b.n, 8, 3, 16), provider(b)),
  "/api/titles/score": async (b) => scoreTitle(text(b.title, "title"), text(b.topic, "topic")),
  "/api/providers/reset": async (b) => {
    resetDown(provider(b));
    await probe(provider(b));
    return status();
  },
  "/api/budget": async (b) => {
    budget.setCap(num(Number(b.capUsd) * 100, 50, 10, 5000) / 100);
    return status();
  },
};

/** One-token call that lets a bad key or spend cap surface immediately instead of on the first demo click. */
async function probe(p: ProviderKey) {
  if (!usable(p)) return;
  try { await complete(PROVIDERS[p].small, "hi", { maxTokens: 1 }); } catch { /* transient errors are fine here */ }
}

const status = () => ({
  jev: hasJevKey() ? "live" : "simulated",
  jevInPerM: JEV_IN_PER_M,
  models: MODELS,
  providers: Object.fromEntries(
    (Object.keys(PROVIDERS) as ProviderKey[]).map((k) => [k, { ...PROVIDERS[k], ...providerState(k) }]),
  ),
  budget: { spentUsd: budget.spent(), capUsd: budget.cap() },
});

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === "GET" && path === "/api/status") return json(res, 200, status());
  if (req.method === "GET" && path === "/api/samples") return json(res, 200, { routerPrompts, tickets, feedPosts });
  if (req.method === "GET" && path === "/api/inbox/sample") {
    const n = num(Number(new URL(req.url ?? "", "http://x").searchParams.get("n")), 60, 5, 500);
    return json(res, 200, makeEmails(n));
  }
  const handler = req.method === "POST" ? post[path] : undefined;
  if (handler) return json(res, 200, await handler(await readJson(req)));
  throw new HttpError(404, "Not found");
}

async function serveStatic(res: ServerResponse, path: string) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
  if (rel.startsWith("..")) return json(res, 403, { error: "Forbidden" });
  try {
    const file = await readFile(join(publicDir, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (path.startsWith("/api/")) return await handleApi(req, res, path);
    await serveStatic(res, path);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const upstream = (err as { error?: { error?: { message?: string } } }).error?.error?.message;
    json(res, status, { error: upstream ?? (err instanceof Error ? err.message : "Internal error") });
  }
}).listen(Number(process.env.PORT ?? 3000), () => {
  const port = process.env.PORT ?? 3000;
  console.log(`Jev demos on http://localhost:${port}`);
  console.log(`  Jev (TypeSafe): ${hasJevKey() ? "live" : "SIMULATED (set TYPESAFE_API_KEY)"}`);
  for (const k of Object.keys(PROVIDERS) as ProviderKey[]) console.log(`  ${PROVIDERS[k].label.padEnd(14)}: ${providerState(k).state}`);
  void Promise.all((Object.keys(PROVIDERS) as ProviderKey[]).map(probe)).then(() =>
    console.log("  Probe:          " + (Object.keys(PROVIDERS) as ProviderKey[]).map((k) => `${k}=${providerState(k).state}`).join(" ")),
  );
  console.log(`  Budget:         $${budget.cap().toFixed(2)} (set DEMO_BUDGET_USD)`);
});
