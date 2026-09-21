import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_IN_PER_M, MODELS, PROVIDERS, accountError, budget, hasJevKey, markDown, providerState, resetDown, usable, type ProviderKey, type Tier } from "./config.ts";
import { noul } from "@typesafe-ai/sdk";
import { jevCall, jevState, markJevDown, probeJev, resetJevDown } from "./jev.ts";
import { HEADER, hosted, keySource, redact, validKey, withKeys, currentUserKeys, type KeyName, type UserKeys } from "./keys.ts";
import { complete, probeLlm, type Effort } from "./llm.ts";
import { decide } from "./router.ts";
import { feedPosts, makeEmails, routerPrompts, tickets } from "./samples.ts";
import { decideAction, draftReply, triageWithJev, triageWithLlm, type Action } from "./triage.ts";
import { classifyEmailWithJev, classifyEmailWithLlm, generateTitles, labelPost, scoreTitle } from "./usecases.ts";

const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
// Everything is served from this origin; inline styles are used by the charts. Keys never leave the browser except to this server.
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const MAX_BODY = 200_000;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS });
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
    budget.setCap(num(Number(b.capUsd) * 100, 50, 10, 5000) / 100, provider(b));
    return status();
  },
  "/api/keys/check": async () => checkKeys(),
  "/api/jev/reset": async () => {
    resetJevDown();
    await probeJevKey();
    return status();
  },
};

const KEY_NAMES: KeyName[] = ["jev", "claude", "kimi"];

/** Maps a provider failure to something a visitor can act on, without ever echoing a key back. */
function friendlyKeyError(err: unknown): string {
  const e = err as { status?: number; message?: string; code?: string; cause?: { code?: string } };
  if (e?.status === 401 || e?.status === 403) return "The provider rejected this key. Check it is copied in full and still active.";
  const account = accountError(err);
  if (account) return redact(account).slice(0, 200);
  const code = e?.code ?? e?.cause?.code;
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || /timeout|fetch failed/i.test(e?.message ?? "")) return "Could not reach the provider. Try again in a moment.";
  return redact(e?.message ?? "Key check failed").slice(0, 200);
}

/** Validates only the keys the visitor supplied (never the server's own) with a one-token call each. */
async function checkKeys() {
  const mine = currentUserKeys();
  const results: Partial<Record<KeyName, { ok: boolean; note: string }>> = {};
  await Promise.all(KEY_NAMES.filter((n) => mine[n]).map(async (n) => {
    try {
      if (n === "jev") { resetJevDown(); await probeJev(); } else { resetDown(n); await probeLlm(n); }
      results[n] = { ok: true, note: "Key works" };
    } catch (err) {
      const note = friendlyKeyError(err);
      results[n] = { ok: false, note };
      // A rejected key should show as unavailable straight away, not "live" until the first demo click fails.
      if (accountError(err)) { if (n === "jev") markJevDown(note); else markDown(n, note); }
    }
  }));
  return { results };
}

/** One-token call that lets a bad key or spend cap surface immediately instead of on the first demo click. */
async function probe(p: ProviderKey) {
  if (!usable(p)) return;
  try { await complete(PROVIDERS[p].small, "hi", { maxTokens: 1 }); } catch { /* transient errors are fine here */ }
}

/** Same idea for Jev: a rejected key is discovered at startup and shown as unavailable, not "live". */
async function probeJevKey() {
  if (jevState().state !== "live") return;
  try { await jevCall("ping", { ok: noul("Is this a greeting?") }, () => 0, () => 0); } catch { /* transient */ }
}

const status = () => ({
  jev: jevState().state,
  jevNote: jevState().note,
  jevSource: keySource("jev"),
  jevInPerM: JEV_IN_PER_M,
  hosted: hosted(),
  models: MODELS,
  providers: Object.fromEntries(
    (Object.keys(PROVIDERS) as ProviderKey[]).map((k) => [k, {
      ...PROVIDERS[k], ...providerState(k), keySource: keySource(k),
      budget: { spentUsd: budget.spent(k), capUsd: budget.cap(k) },
    }]),
  ),
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
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store", ...SECURITY_HEADERS });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

/** Keys arrive as headers, are format-checked, and live only for this request. */
function readKeys(req: IncomingMessage): UserKeys {
  const keys: UserKeys = {};
  for (const n of KEY_NAMES) {
    const v = req.headers[HEADER[n]];
    if (v === undefined || v === "") continue;
    if (!validKey(v)) throw new HttpError(400, `The ${n} key has an invalid format`);
    keys[n] = v;
  }
  return keys;
}

// Simple per-IP limiter for public hosting (RATE_LIMIT_PER_MIN, default 600 when HOSTED=1, off locally).
const RATE = Number(process.env.RATE_LIMIT_PER_MIN ?? (hosted() ? 600 : 0));
const hits = new Map<string, { n: number; reset: number }>();
function limited(req: IncomingMessage): boolean {
  if (!RATE) return false;
  const fwd = process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
  const ip = fwd || req.socket.remoteAddress || "unknown", now = Date.now();
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); return false; }
  return ++h.n > RATE;
}

/** The whole app as one request handler: used by the local server below and by the Vercel function in api/. */
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  let keys: UserKeys = {};
  try {
    if (path.startsWith("/api/")) {
      if (limited(req)) throw new HttpError(429, "Too many requests. Please slow down for a minute.");
      keys = readKeys(req);
      return await withKeys(keys, () => handleApi(req, res, path));
    }
    await serveStatic(res, path);
  } catch (err) {
    const code = err instanceof HttpError ? err.status : 500;
    const raw = (err as { error?: { error?: { message?: string } } }).error?.error?.message ?? (err instanceof Error ? err.message : "Internal error");
    const message = withKeys(keys, () => redact(raw));
    if (code === 500) console.error(message);
    json(res, code, { error: message });
  }
}

// Only listen when run directly (npm start). On Vercel this module is imported and `handle` is used instead.
const runDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) createServer(handle).listen(Number(process.env.PORT ?? 3000), () => {
  const port = process.env.PORT ?? 3000;
  console.log(`Jev demos on http://localhost:${port}`);
  console.log(`  Jev (TypeSafe): ${hasJevKey() ? "key set" : "SIMULATED (set TYPESAFE_API_KEY)"}`);
  for (const k of Object.keys(PROVIDERS) as ProviderKey[]) console.log(`  ${PROVIDERS[k].label.padEnd(14)}: ${providerState(k).state}`);
  void Promise.all([...(Object.keys(PROVIDERS) as ProviderKey[]).map(probe), probeJevKey()]).then(() =>
    console.log("  Probe:          " + [`jev=${jevState().state}`, ...(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => `${k}=${providerState(k).state}`)].join(" ")),
  );
  console.log(`  Budget:         $${Number(process.env.DEMO_BUDGET_USD ?? 0.5).toFixed(2)} per key (set DEMO_BUDGET_USD)`);
  if (hosted()) console.log("  HOSTED mode:    server keys are ignored; visitors must bring their own");
});
