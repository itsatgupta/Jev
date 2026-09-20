import { Flow, Race, donut, fmtMs, fmtPct, fmtUsd } from "/flow.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kpi = (cls, label, value, tiny = "") => `<div class="kpi ${cls}"><small>${label}</small><div class="big">${value}</div><div class="tiny">${tiny}</div></div>`;
const simTag = (s) => (s ? ' <span class="badge sim" title="This provider is unavailable, so this value is a placeholder">simulated</span>' : "");
const CAT_COLORS = { brand_deal: "var(--k3)", invoice: "var(--k1)", newsletter: "var(--k2)", cold_pitch: "var(--k6)", customer: "var(--k5)", scam: "var(--k4)", other: "var(--k7)" };
const KIND_COLORS = { breaking: "var(--k1)", golden_nugget: "var(--k3)", hot_take: "var(--k6)", promo: "var(--k5)", ai_slop: "var(--k4)", noise: "var(--k7)" };
const TIER_COLOR = { light: "var(--k2)", standard: "var(--k1)", frontier: "var(--k5)" };
const TIERS = ["light", "standard", "frontier"];

let STATUS, SAMPLES, MODELS, PROVIDER = "claude";
const P = () => STATUS.providers[PROVIDER];
const label = (k) => MODELS[k]?.label ?? k;
const prices = (k) => `$${MODELS[k].inPerM} / $${MODELS[k].outPerM}`;
const small = () => P().small, big = () => P().big;
const live = () => P().state === "live";

/* ─────────── plumbing ─────────── */
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: PROVIDER, ...body }) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
async function busy(btns, out, fn) {
  [].concat(btns).forEach((b) => (b.disabled = true));
  try { await fn(); } catch (e) { (out ?? document.querySelector(".view:not([hidden])")).insertAdjacentHTML("afterbegin", `<div class="card err">${esc(e.message)}</div>`); console.error(e); }
  finally { [].concat(btns).forEach((b) => (b.disabled = false)); refreshStatus(); }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
function chips(sel, items, target) {
  $(sel).innerHTML = items.map((s, i) => `<button class="chip" data-i="${i}">${esc(s.label)}</button>`).join("");
  $(sel).addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) $(target).value = items[b.dataset.i].text; });
}
const bars = (probs, colorOf) => Object.entries(probs).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" data-w="${v * 100}" style="background:${colorOf(k)}"></div></div><b>${fmtPct(v)}</b></div>`).join("");
const grow = (root) => requestAnimationFrame(() => requestAnimationFrame(() => root.querySelectorAll(".fill[data-w]").forEach((f) => (f.style.width = f.dataset.w + "%"))));

/* ─────────── header: provider switch, status, budget ─────────── */
const STATE_TEXT = { live: "live", simulated: "no key", unavailable: "unavailable", budget: "budget reached" };
function renderControls() {
  const p = P(), b = STATUS.budget, pct = Math.min(100, (b.spentUsd / b.capUsd) * 100);
  $("#controls").innerHTML = `
    <span class="seg" role="group" aria-label="LLM provider">${Object.entries(STATUS.providers).map(([k, v]) => `<button data-provider="${k}" aria-pressed="${k === PROVIDER}">${esc(v.label)}</button>`).join("")}</span>
    <button class="pill" id="pill-provider" title="${esc(p.note || "Provider is healthy")}${p.state !== "live" ? " (click to re-check)" : ""}"><i class="dot ${p.state === "live" ? "live" : "sim"}"></i>${esc(p.label)} <b>${STATE_TEXT[p.state]}</b></button>
    <span class="pill" title="Jev (TypeSafe)"><i class="dot ${STATUS.jev === "live" ? "live" : "sim"}"></i>Jev <b>${STATUS.jev === "live" ? "live" : "no key"}</b></span>
    <span class="pill" title="Real API spend this server session. Paid LLM calls stop when the cap is reached."><span class="lbl">Budget</span><b>${fmtUsd(b.spentUsd)}</b> / ${fmtUsd(b.capUsd)}<span class="meter"><i style="width:${pct}%"></i></span><button class="chip" id="budget-up" title="Raise the cap by $0.50">+$0.50</button></span>`;
}
async function refreshStatus() {
  try { STATUS = await api("/api/status"); renderControls(); } catch { /* server restarting */ }
}
document.addEventListener("click", async (e) => {
  const sw = e.target.closest("[data-provider]");
  if (sw) return setProvider(sw.dataset.provider);
  if (e.target.closest("#budget-up")) { STATUS = await api("/api/budget", { capUsd: STATUS.budget.capUsd + 0.5 }); renderControls(); }
  if (e.target.closest("#pill-provider") && P().state !== "live") { await api("/api/providers/reset", {}); refreshStatus(); }
});
function setProvider(k) {
  PROVIDER = k;
  try { localStorage.setItem("jev-provider", k); } catch { /* private mode */ }
  renderControls(); rebuildProviderUi();
}
function rebuildProviderUi() {
  document.querySelectorAll(".js-small").forEach((n) => (n.textContent = label(small())));
  document.querySelectorAll(".js-big").forEach((n) => (n.textContent = label(big())));
  if (started.has("router")) buildRouter();
  if (started.has("triage")) buildTriage();
  if (started.has("inbox")) buildInbox();
  if (started.has("titles")) buildTitles();
  if (started.has("cost")) drawCost();
}

/* ─────────── tabs ─────────── */
const TABS = [
  ["overview", "How Jev works"], ["router", "LLM router"], ["triage", "Ticket triage"], ["inbox", "Inbox at scale"],
  ["feed", "Slop filter"], ["titles", "Title scorer"], ["cost", "Cost at scale"],
];
const inits = { overview: initOverview, router: initRouter, triage: initTriage, inbox: initInbox, feed: initFeed, titles: initTitles, cost: initCost };
const started = new Set();
function showTab(id) {
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === id));
  for (const [k] of TABS) $("#view-" + k).hidden = k !== id;
  if (!started.has(id)) { started.add(id); inits[id](); }
  history.replaceState(null, "", "#" + id);
}
(async function boot() {
  [STATUS, SAMPLES] = await Promise.all([api("/api/status"), api("/api/samples")]);
  MODELS = STATUS.models;
  let saved = null; try { saved = localStorage.getItem("jev-provider"); } catch { /* ignore */ }
  PROVIDER = STATUS.providers[saved] ? saved : Object.keys(STATUS.providers).find((k) => STATUS.providers[k].state === "live") ?? "claude";
  renderControls();
  document.querySelectorAll(".js-small").forEach((n) => (n.textContent = label(small())));
  document.querySelectorAll(".js-big").forEach((n) => (n.textContent = label(big())));
  setInterval(refreshStatus, 5000);
  $("#tabs").innerHTML = TABS.map(([id, name]) => `<button class="tab" data-tab="${id}">${name}</button>`).join("");
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) showTab(b.dataset.tab); });
  showTab(TABS.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : "overview");
})();

/* ═══════════════════ Overview ═══════════════════ */
function initOverview() {
  const TEXT = "Based on the line items and the vendor history passed in the context, this invoice appears to be legitimate. The amounts match prior purchase orders and the vendor has 14 clean payments on record, although the unusual net-90 terms may warrant a quick manual review before approval.";
  const VERDICT = `{\n  "verdict": {\n    "choice": "clean",\n    "probabilities": {\n      "clean": 0.88,\n      "review": 0.10,\n      "fraud": 0.02\n    },\n    "confidence": 0.88\n  }\n}`;
  $("#o-run").addEventListener("click", () => busy($("#o-run"), null, async () => {
    $("#o-llm-out").className = "caret"; $("#o-llm-out").textContent = ""; $("#o-jev-out").textContent = "…";
    const t0 = performance.now(), LLM_MS = 8500, JEV_MS = 400;
    let jevDone = false;
    await new Promise((res) => {
      const iv = setInterval(() => {
        const ms = performance.now() - t0;
        if (!jevDone) $("#o-jev-t").textContent = (Math.min(ms, JEV_MS) / 1000).toFixed(2) + " s";
        if (!jevDone && ms >= JEV_MS) { jevDone = true; $("#o-jev-out").textContent = VERDICT; }
        $("#o-llm-t").textContent = (Math.min(ms, LLM_MS) / 1000).toFixed(1) + " s";
        $("#o-llm-out").textContent = TEXT.slice(0, Math.floor((Math.min(ms, LLM_MS) / LLM_MS) * TEXT.length));
        if (ms >= LLM_MS) { $("#o-llm-out").className = ""; clearInterval(iv); res(); }
      }, 40);
    });
  }));
  const TYPES = {
    choice: { h: "Choice: pick one", p: "Route or categorise. Up to 255 options, each with a probability.", j: { department: { type: "choice", choice: "technical", confidence: 0.91, probabilities: { billing: 0.08, technical: 0.91, account: 0.01 } } } },
    score: { h: "Score: place on a scale", p: "You define the rubric (2 to 10 levels). Scores can fall between levels.", j: { severity: { type: "score", score: 2.86, confidence: 0.88, probabilities: { 0: 0, 1: 0.02, 2: 0.1, 3: 0.88 } } } },
    noul: { h: "Noul: yes/no probability", p: "How likely is this true? Ideal for thresholds in plain if-statements.", j: { requestsRefund: { type: "noul", noul: 0.97 } } },
  };
  $("#o-types").innerHTML = Object.entries(TYPES).map(([k, t]) => `<div class="type" data-k="${k}"><h3>${t.h}</h3><p>${t.p}</p></div>`).join("");
  const pick = (k) => { document.querySelectorAll(".type").forEach((x) => x.classList.toggle("sel", x.dataset.k === k)); $("#o-json").textContent = JSON.stringify(TYPES[k].j, null, 2); };
  $("#o-types").addEventListener("click", (e) => { const t = e.target.closest(".type"); if (t) pick(t.dataset.k); });
  pick("choice");
}

/* ═══════════════════ 1 · Router ═══════════════════ */
const R = {};
function initRouter() {
  chips("#r-samples", SAMPLES.routerPrompts, "#r-prompt");
  buildRouter();
  $("#r-go").addEventListener("click", () => busy($("#r-go"), $("#r-out"), async () => {
    $("#r-out").innerHTML = ""; $("#r-bench-out").innerHTML = "";
    const r = await routeOnce($("#r-prompt").value, $("#r-baseline").checked, true);
    $("#r-out").innerHTML = renderRoute(r); grow($("#r-out"));
  }));
  $("#r-bench").addEventListener("click", () => busy($("#r-bench"), $("#r-bench-out"), () => routeBench()));
}
function buildRouter() {
  const t = P().tiers, pos = { light: 45, standard: 125, frontier: 205 };
  R.flow = new Flow($("#r-flow"), {
    w: 920, h: 250,
    nodes: [
      { id: "prompt", x: 85, y: 125, label: "Prompt", color: "io", w: 120 },
      { id: "jev", x: 300, y: 125, label: "Jev", sub: "picks a tier", color: "jev" },
      ...TIERS.map((k) => ({ id: k, x: 570, y: pos[k], label: label(t[k]), sub: `${k} · ${prices(t[k])}`, color: k, w: 190 })),
      { id: "answer", x: 835, y: 125, label: "Answer", color: "good", w: 110 },
    ],
    edges: [{ from: "prompt", to: "jev" }, ...TIERS.flatMap((k) => [{ from: "jev", to: k }, { from: k, to: "answer" }])],
  });
  R.race = new Race($("#r-race"), [{ id: "routed", label: "Jev-routed", color: "jev" }, { id: "base", label: `Always ${label(big())}`, color: "llm" }], 7000);
}

async function routeOnce(...args) {
  try { return await routeOnceInner(...args); } catch (e) { R.race?.stopAll(); R.flow?.stopTimers(); throw e; }
}
async function routeOnceInner(prompt, baseline, anim) {
  const f = anim ? R.flow : null, race = anim ? R.race : null;
  if (!prompt.trim()) throw new Error("Type or pick a prompt first");
  f?.reset(); race?.reset();
  f?.state("prompt", "done", `${prompt.length} chars`);
  race?.start("routed", 6000);
  let baseP = null;
  if (baseline) {
    race?.start("base", 6000);
    baseP = api("/api/route/answer", { prompt, tier: "frontier" }).then((r) => { race?.finish("base", 0, fmtMs(r.latencyMs)); return r; });
  } else race?.skip("base", "not run");
  const stopJev = f?.timer("jev"), sent = f?.send("prompt", "jev", { ms: 350 });
  const decision = await api("/api/route/decide", { prompt });
  await sent; stopJev?.(fmtMs(decision.latencyMs));
  const t = decision.tier;
  if (f) for (const o of TIERS) if (o !== t) { f.dim(o); f.edge("jev", o, "dim"); }
  await f?.send("jev", t, { color: t, ms: 300 });
  const stop = f?.timer(t);
  const answer = await api("/api/route/answer", { prompt, tier: t });
  stop?.(fmtMs(answer.latencyMs));
  race?.finish("routed", 0, fmtMs(decision.latencyMs + answer.latencyMs)); // measured API time, not animation time
  await f?.send(t, "answer", { color: t, ms: 300 });
  f?.state("answer", "done", fmtUsd(decision.costUsd + answer.costUsd));
  const base = baseP ? await baseP : null;
  const top = MODELS[big()];
  const baseCost = base ? base.costUsd : (answer.inputTokens * top.inPerM + answer.outputTokens * top.outPerM) / 1e6;
  const total = decision.costUsd + answer.costUsd;
  return { decision, answer, base, baseCost, total, saved: baseCost - total };
}

function renderRoute(r) {
  const d = r.decision, a = r.answer, pctSaved = r.baseCost ? (r.saved / r.baseCost) * 100 : 0, topName = label(big());
  const isTop = d.tier === "frontier";
  return `
  <div class="kpis" style="margin-bottom:16px">
    ${kpi("", "Jev decided in", fmtMs(d.latencyMs), `${d.inputTokens} tokens · ${fmtUsd(d.costUsd)}${d.simulated ? " · simulated" : ""}`)}
    ${kpi("jev", "Routed cost (Jev + answer)", fmtUsd(r.total), `${label(a.model)} answered in ${fmtMs(a.latencyMs)}`)}
    ${kpi("", `Always ${topName} ${r.base ? (r.base.simulated ? "(simulated)" : "(measured)") : "(est.)"}`, fmtUsd(r.baseCost), r.base ? `${fmtMs(r.base.latencyMs)} end to end` : "same tokens at its list price")}
    ${isTop ? kpi("", "Saved", "0%", "Hard prompt: the top tier is the right call. Jev adds only its decision cost")
      : kpi("gold", "Saved", `${Math.max(0, pctSaved).toFixed(0)}%`, `${fmtUsd(Math.max(0, r.saved))} on this request`)}
  </div>
  <div class="grid">
    <div class="card"><h2>Jev's decision${simTag(d.simulated)}</h2>
      ${bars(d.probabilities, (k) => TIER_COLOR[k])}
      <div class="stat"><span>Routed to</span><span><span class="badge ${d.tier}">${d.tier}</span> <span class="badge ${d.model}">${esc(label(d.model))}</span></span></div>
      <div class="stat"><span>${d.escalated ? "Confidence guard" : "Confidence"}</span><b class="${d.escalated ? "bad" : ""}">${d.escalated ? `${fmtPct(d.confidence)} &lt; 60%: escalated ${d.jevTier} → ${d.tier}` : fmtPct(d.confidence)}</b></div>
      <div class="stat"><span>Complexity</span><b>${d.complexity.toFixed(1)} / 3</b></div>
      <div class="stat"><span>Needs deep reasoning</span><b>${fmtPct(d.needsReasoning)}</b></div>
    </div>
    <div class="card"><h2><span class="badge ${a.model}">${esc(label(a.model))}</span> answer${simTag(a.simulated)}</h2>
      <div class="stat"><span>Latency</span><b>${fmtMs(a.latencyMs)}</b></div>
      <div class="stat"><span>Tokens in / out</span><b>${a.inputTokens} / ${a.outputTokens}</b></div>
      <div class="stat"><span>Cost</span><b>${fmtUsd(a.costUsd)}</b></div>
      <div class="answer">${esc(a.text)}</div></div>
  </div>`;
}

async function routeBench() {
  const items = SAMPLES.routerPrompts, baseline = $("#r-baseline").checked, out = $("#r-bench-out"), topName = label(big());
  $("#r-out").innerHTML = ""; let done = 0;
  out.innerHTML = `<div class="card spinner">Routing ${items.length} prompts… <span id="r-prog">0</span>/${items.length}</div>`;
  const results = await pool(items, 3, async (s) => { const r = await routeOnce(s.text, baseline, false); $("#r-prog").textContent = ++done; return r; });
  const sum = (f) => results.reduce((a, r) => a + f(r), 0), mix = {};
  results.forEach((r) => (mix[r.answer.model] = (mix[r.answer.model] ?? 0) + 1));
  const cost = sum((r) => r.total), base = sum((r) => r.baseCost), anySim = results.some((r) => r.decision.simulated || r.answer.simulated);
  out.innerHTML = `<div class="card"><h2>Benchmark · ${items.length} prompts${simTag(anySim)}</h2>
    <div class="kpis">
      ${kpi("jev", "Routed total", fmtUsd(cost), `avg ${fmtUsd(cost / items.length)} per prompt`)}
      ${kpi("", `Always ${topName} ${baseline ? "(measured)" : "(est.)"}`, fmtUsd(base), `avg ${fmtUsd(base / items.length)} per prompt`)}
      ${kpi("gold", "Saved", `${(((base - cost) / base) * 100).toFixed(0)}%`, `${fmtUsd(base - cost)} across the set`)}
      ${kpi("", "Avg Jev decision", fmtMs(sum((r) => r.decision.latencyMs) / items.length), `Jev spend ${fmtUsd(sum((r) => r.decision.costUsd))} total`)}
      <div class="kpi"><small>Model mix</small><div style="margin-top:9px;display:flex;gap:6px;flex-wrap:wrap">${Object.entries(mix).map(([k, v]) => `<span class="badge ${k}">${esc(label(k))} ${v}</span>`).join("")}</div></div>
    </div>
    <table style="margin-top:14px"><thead><tr><th>Prompt</th><th>Routed to</th><th class="num">Confidence</th><th class="num">Jev</th><th class="num">Routed cost</th><th class="num">${esc(topName)} cost</th></tr></thead><tbody>
    ${results.map((r, i) => `<tr><td>${esc(items[i].label)}</td><td><span class="badge ${r.answer.model}">${esc(label(r.answer.model))}</span> <span class="muted">${r.decision.tier}</span></td><td class="num">${fmtPct(r.decision.confidence)}</td><td class="num">${fmtMs(r.decision.latencyMs)}</td><td class="num">${fmtUsd(r.total)}</td><td class="num">${fmtUsd(r.baseCost)}</td></tr>`).join("")}
    </tbody></table>
    <p class="note">${topName} figures are ${baseline ? "real always-top-model runs" : "the routed answer's tokens priced at the top model's list price"}. Quality is not scored here: read the answers to the hard prompts before claiming parity.</p></div>`;
}

/* ═══════════════════ 2 · Ticket triage ═══════════════════ */
const T = {};
function initTriage() {
  chips("#t-samples", SAMPLES.tickets, "#t-ticket");
  buildTriage();
  $("#t-go").addEventListener("click", () => busy($("#t-go"), $("#t-out"), async () => {
    $("#t-out").innerHTML = ""; $("#t-bench-out").innerHTML = "";
    const r = await triageOnce($("#t-ticket").value, $("#t-compare").checked && live(), $("#t-draft").checked, true);
    $("#t-out").innerHTML = renderTriage(r);
  }));
  $("#t-bench").addEventListener("click", () => busy($("#t-bench"), $("#t-bench-out"), () => triageBench()));
}
function buildTriage() {
  const p = P();
  T.flow = new Flow($("#t-flow"), {
    w: 920, h: 270,
    nodes: [
      { id: "ticket", x: 80, y: 105, label: "Ticket", color: "io", w: 110 },
      { id: "jev", x: 270, y: 75, label: "Jev", sub: "6 questions, 1 call", color: "jev", w: 160 },
      { id: "llm", x: 270, y: 200, label: `${label(p.small)} classifier`, sub: "baseline", color: "llm", w: 190 },
      { id: "rules", x: 490, y: 75, label: "Your code", sub: "if / else on scores", color: "code", w: 150 },
      { id: "discard", x: 750, y: 30, label: "Discard", sub: "spam", color: "io", w: 150 },
      { id: "human", x: 750, y: 105, label: "Human queue", sub: `${label(p.mid)} drafts`, color: "frontier", w: 170 },
      { id: "auto", x: 750, y: 180, label: "Auto-reply", sub: `${label(p.small)} drafts`, color: "light", w: 170 },
    ],
    edges: [{ from: "ticket", to: "jev" }, { from: "ticket", to: "llm", dashed: true }, { from: "jev", to: "rules" }, { from: "rules", to: "discard" }, { from: "rules", to: "human" }, { from: "rules", to: "auto" }],
  });
  T.race = new Race($("#t-race"), [{ id: "jev", label: "Jev", color: "jev" }, { id: "llm", label: label(p.small), color: "llm" }], 2200);
}

async function triageOnce(...args) {
  try { return await triageOnceInner(...args); } catch (e) { T.race?.stopAll(); T.flow?.stopTimers(); throw e; }
}
async function triageOnceInner(ticket, compare, draft, anim) {
  if (!ticket.trim()) throw new Error("Type or pick a ticket first");
  const f = anim ? T.flow : null, race = anim ? T.race : null;
  f?.reset(); race?.reset();
  f?.state("ticket", "done", `${ticket.length} chars`);
  race?.start("jev", 1800);
  compare ? race?.start("llm", 2600) : race?.skip("llm", "off");
  const stopJ = f?.timer("jev"), stopL = compare ? f?.timer("llm") : null;
  f?.send("ticket", "jev", { ms: 350 }); if (compare) f?.send("ticket", "llm", { ms: 350 });
  const jevP = api("/api/triage/jev", { ticket }).then((r) => { race?.finish("jev", 0, fmtMs(r.jev.latencyMs)); stopJ?.(fmtMs(r.jev.latencyMs)); return r; });
  const llmP = compare ? api("/api/triage/llm", { ticket }).then((r) => { race?.finish("llm", 0, r ? fmtMs(r.latencyMs) : "n/a"); stopL?.(r ? fmtMs(r.latencyMs) : "n/a"); return r; }) : Promise.resolve(null);
  const jevR = await jevP, { action, reasons } = jevR;
  await f?.send("jev", "rules", { ms: 350 });
  f?.state("rules", "done", action);
  const target = { discard: "discard", escalate: "human", "auto-reply": "auto" }[action], tone = action === "escalate" ? "frontier" : action === "auto-reply" ? "light" : "io";
  if (f) for (const o of ["discard", "human", "auto"]) if (o !== target) { f.dim(o); f.edge("rules", o, "dim"); }
  await f?.send("rules", target, { color: tone, ms: 400 });
  let reply = null;
  if (draft && action !== "discard") {
    const stop = f?.timer(target);
    reply = await api("/api/triage/reply", { ticket, department: jevR.jev.triage.department, action });
    stop?.(fmtMs(reply.latencyMs));
  } else f?.state(target, "done");
  return { jev: jevR.jev, llm: await llmP, action, reasons, reply };
}

const field = (name, v, fmt) => `<div class="stat"><span>${name}</span><b>${fmt(v)}</b></div>`;
function triageCol(title, t, tone) {
  if (!t) return `<div class="card"><h2>${title}</h2><p class="muted">Baseline not run: switched off, or ${esc(P().label)} is unavailable right now.</p></div>`;
  const x = t.triage;
  return `<div class="card"><h2>${title}${simTag(t.simulated)}</h2>
    <div class="kpis" style="grid-template-columns:1fr 1fr">${kpi(tone === "jev" ? "jev" : "", "Latency", fmtMs(t.latencyMs))}${kpi(tone === "jev" ? "jev" : "", "Cost", fmtUsd(t.costUsd), `${t.inputTokens} tokens in`)}</div>
    <div style="margin-top:10px">
    ${field("Department", x.department, (v) => `<span class="badge ${tone}">${esc(v)}</span>`)}
    ${field("Urgency", x.urgency, (v) => v.toFixed(1) + " / 3")}${field("Frustration", x.frustration, (v) => v.toFixed(1) + " / 3")}
    ${field("Refund requested", x.refundRequested, fmtPct)}${field("Churn risk", x.churnRisk, fmtPct)}${field("Spam", x.spam, fmtPct)}</div></div>`;
}
function renderTriage(r) {
  const same = r.llm && r.jev.triage.department === r.llm.triage.department;
  return `
  ${r.llm ? `<div class="kpis" style="margin-bottom:16px">
    ${kpi("gold", "Jev speed-up", (r.llm.latencyMs / r.jev.latencyMs).toFixed(1) + "×", `${fmtMs(r.jev.latencyMs)} vs ${fmtMs(r.llm.latencyMs)}`)}
    ${kpi("gold", "Jev cost advantage", (r.llm.costUsd / r.jev.costUsd).toFixed(0) + "×", `${fmtUsd(r.jev.costUsd)} vs ${fmtUsd(r.llm.costUsd)}`)}
    ${kpi(same ? "" : "bad", "Same department?", same ? "Yes" : "No", same ? "both agree" : "they disagree: read the ticket")}</div>` : ""}
  <div class="grid">${triageCol("Jev · one call, six answers", r.jev, "jev")}${triageCol(`${esc(label(small()))} as classifier`, r.llm, "llm")}</div>
  <div class="card" style="margin-top:16px"><h2>What the code does with it</h2>
    <div class="stat"><span>Action</span><span><span class="badge ${r.action}">${esc(r.action)}</span> <span class="muted">${esc(r.reasons.join(", "))}</span></span></div>
    ${r.reply ? `<div class="stat"><span>Reply drafted by</span><span><span class="badge ${r.reply.model}">${esc(label(r.reply.model))}</span> ${fmtMs(r.reply.latencyMs)} · ${fmtUsd(r.reply.costUsd)}${simTag(r.reply.simulated)}</span></div><div class="answer">${esc(r.reply.text)}</div>` : ""}
    <p class="note">Only tickets that need words reach an LLM, and the risky ones get the bigger model. Spam never does.</p></div>`;
}

async function triageBench() {
  const items = SAMPLES.tickets, compare = $("#t-compare").checked && live(), draft = $("#t-draft").checked, out = $("#t-bench-out");
  $("#t-out").innerHTML = ""; let done = 0;
  out.innerHTML = `<div class="card spinner">Triaging ${items.length} tickets… <span id="t-prog">0</span>/${items.length}</div>`;
  const results = await pool(items, 3, async (s) => { const r = await triageOnce(s.text, compare, draft, false); $("#t-prog").textContent = ++done; return r; });
  const sum = (f) => results.reduce((a, r) => a + f(r), 0), wl = results.filter((r) => r.llm);
  const agree = wl.filter((r) => r.jev.triage.department === r.llm.triage.department).length, n = items.length;
  const count = (a) => results.filter((r) => r.action === a).length, sl = esc(label(small()));
  out.innerHTML = `<div class="card"><h2>Batch · ${n} tickets${simTag(results.some((r) => r.jev.simulated))}</h2><div class="kpis">
    ${kpi("jev", "Avg Jev triage", fmtMs(sum((r) => r.jev.latencyMs) / n), `${fmtUsd(sum((r) => r.jev.costUsd))} total`)}
    ${wl.length ? kpi("", `Avg ${sl} triage`, fmtMs(sum((r) => r.llm?.latencyMs ?? 0) / wl.length), `${fmtUsd(sum((r) => r.llm?.costUsd ?? 0))} total`) + kpi("gold", "Dept agreement", `${agree}/${wl.length}`, `Jev vs ${sl}`) : ""}
    ${kpi("", "Escalated / auto / discarded", `${count("escalate")} / ${count("auto-reply")} / ${count("discard")}`, "decided by plain code")}</div>
    <table style="margin-top:14px"><thead><tr><th>Ticket</th><th>Department</th><th class="num">Urgency</th><th class="num">Churn</th><th>Action</th><th class="num">Jev</th><th class="num">${sl}</th></tr></thead><tbody>
    ${results.map((r, i) => `<tr><td>${esc(items[i].label)}</td><td>${esc(r.jev.triage.department)}</td><td class="num">${r.jev.triage.urgency.toFixed(1)}</td><td class="num">${fmtPct(r.jev.triage.churnRisk)}</td><td><span class="badge ${r.action}">${esc(r.action)}</span></td><td class="num">${fmtMs(r.jev.latencyMs)}</td><td class="num">${r.llm ? fmtMs(r.llm.latencyMs) : "–"}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ═══════════════════ 3 · Inbox at scale ═══════════════════ */
const I = {};
const JEV_CONC = 12, LLM_CONC = 4, RACE_CAP = 50;
function initInbox() {
  buildInbox();
  drawInbox({ done: 0, cat: {}, urg: [0, 0, 0, 0], top: [] });
  $("#i-go").addEventListener("click", () => busy($("#i-go"), $("#i-kpis"), runInbox));
}
function buildInbox() {
  I.flow = new Flow($("#i-flow"), {
    w: 920, h: 210,
    nodes: [
      { id: "emails", x: 90, y: 90, label: "Inbox", sub: "", color: "io", w: 130 },
      { id: "jev", x: 380, y: 60, label: "Jev", sub: `×${JEV_CONC} parallel`, color: "jev", w: 170 },
      { id: "llm", x: 380, y: 155, label: label(small()), sub: `×${LLM_CONC} parallel`, color: "llm", w: 170 },
      { id: "dash", x: 760, y: 90, label: "Dashboard", sub: "categories · urgency · scams", color: "good", w: 230 },
    ],
    edges: [{ from: "emails", to: "jev" }, { from: "emails", to: "llm", dashed: true }, { from: "jev", to: "dash" }, { from: "llm", to: "dash", dashed: true }],
  });
  I.race = new Race($("#i-lanes"), [{ id: "jev", label: "Jev", color: "jev" }, { id: "llm", label: label(small()), color: "llm" }]);
}

function drawInbox(s, extra = {}) {
  const slices = Object.entries(s.cat).map(([k, v]) => ({ label: k, value: v, color: CAT_COLORS[k] }));
  donut($("#i-donut"), slices.length ? slices : [{ value: 0.0001, color: "var(--line)" }], s.done);
  $("#i-legend").innerHTML = Object.entries(CAT_COLORS).map(([k, c]) => `<div><i style="background:${c}"></i>${k.replace("_", " ")}<b>${s.cat[k] ?? 0}</b></div>`).join("");
  const mx = Math.max(1, ...s.urg), names = ["Ignore", "Low", "High", "Critical"], cols = ["var(--k7)", "var(--k1)", "var(--k6)", "var(--k4)"];
  $("#i-hist").innerHTML = s.urg.map((v, i) => `<div><div class="col" style="--c:${cols[i]};height:${(v / mx) * 100}px">${v}</div>${names[i]}</div>`).join("");
  $("#i-top").innerHTML = s.top.length ? s.top.map((t) => `<div class="stat"><span><span class="badge tone-${t.category}">${t.category.replace("_", " ")}</span> ${esc(t.subject)}</span><b>${t.urgency.toFixed(1)}</b></div>`).join("") : "Nothing yet.";
  if (extra.kpis) $("#i-kpis").innerHTML = extra.kpis;
}

async function runInbox() {
  const raceLlm = $("#i-race").checked && live(), n = raceLlm ? Math.min(+$("#i-n").value, RACE_CAP) : +$("#i-n").value;
  const emails = await api("/api/inbox/sample?n=" + n);
  const s = { done: 0, cat: {}, urg: [0, 0, 0, 0], top: [], jevCost: 0, jevTok: 0, errors: 0, llmDone: 0, llmOk: 0, llmCost: 0, scam: 0, deals: 0 };
  I.flow.reset(); I.race.reset();
  I.flow.state("emails", "done", `${n} emails`);
  I.flow.state("jev", "active"); if (raceLlm) I.flow.state("llm", "active"); else I.flow.dim("llm");
  const t0 = performance.now(); let jevEnd = null, llmEnd = null, queued = false;
  I.race.start("jev", 1, true); raceLlm ? I.race.start("llm", 1, true) : I.race.skip("llm", "off");
  const sl = label(small());
  const paint = () => {
    queued = false;
    const now = performance.now(), jt = (jevEnd ?? now) - t0, avgJev = s.done ? s.jevCost / s.done : 0;
    const avgLlm = s.llmOk ? s.llmCost / s.llmOk : avgJev ? ((s.jevTok / s.done) * MODELS[small()].inPerM + 90 * MODELS[small()].outPerM) / 1e6 : 0;
    drawInbox(s, {
      kpis: [
        kpi("", "Classified", `${s.done} / ${n}`, s.errors ? `${s.errors} errors` : "5 judgements each"),
        kpi("jev", "Jev throughput", `${(s.done / Math.max(0.05, jt / 1000)).toFixed(1)}/s`, `${fmtMs(jt)} elapsed`),
        kpi("", "Jev spend", fmtUsd(s.jevCost), `${fmtUsd(avgJev * 1000)} per 1,000 emails`),
        raceLlm && s.llmOk ? kpi("", `${sl} spend`, fmtUsd(s.llmCost), `${s.llmOk} ok of ${s.llmDone} · ${fmtMs((llmEnd ?? now) - t0)}`) : kpi("", `${sl} (est.)`, fmtUsd(avgLlm * s.done), "same tokens + 90 out"),
        kpi("gold", `Jev vs ${sl} cost`, avgJev ? (avgLlm / avgJev).toFixed(0) + "×" : "–", `per 1M emails: ${fmtUsd(avgJev * 1e6)} vs ${fmtUsd(avgLlm * 1e6)}`),
        kpi("", "Scams flagged", s.scam, `${s.deals} brand deals found`),
      ].join(""),
    });
    I.race.set("jev", s.done / n); if (raceLlm) I.race.set("llm", s.llmDone / n);
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  const jevRun = pool(emails, JEV_CONC, async (e) => {
    try {
      const r = await api("/api/inbox/jev", { email: e.text }), v = r.value;
      s.done++; s.jevCost += r.costUsd; s.jevTok += r.inputTokens;
      s.cat[v.category] = (s.cat[v.category] ?? 0) + 1;
      s.urg[Math.min(3, Math.round(v.urgency))]++;
      if (v.scam > 0.6) s.scam++; if (v.category === "brand_deal") s.deals++;
      if (v.urgency >= 1.8 && v.scam < 0.5) { s.top.push({ category: v.category, urgency: v.urgency, subject: e.text.split("\n").map((l, i) => (i ? l : l.replace("Subject: ", ""))).join(" · ").slice(0, 70), key: e.text }); s.top = [...new Map(s.top.map((t) => [t.key, t])).values()].sort((a, b) => b.urgency - a.urgency).slice(0, 5); }
      if (s.done % 6 === 1) I.flow.send("emails", "jev", { ms: 300 });
    } catch { s.errors++; s.done++; }
    schedule();
  }).then(() => { jevEnd = performance.now(); I.race.finish("jev", jevEnd - t0); I.flow.state("jev", "done", `${fmtMs(jevEnd - t0)}`); I.flow.send("jev", "dash", { ms: 400, n: 3 }); });
  const llmRun = raceLlm ? pool(emails, LLM_CONC, async (e) => {
    try { const r = await api("/api/inbox/llm", { email: e.text }); if (r) { s.llmOk++; s.llmCost += r.costUsd; } } catch { /* rate limits are expected at scale */ }
    s.llmDone++; if (s.llmDone % 4 === 1) I.flow.send("emails", "llm", { ms: 300 });
    schedule();
  }).then(() => {
    llmEnd = performance.now();
    if (s.llmOk === 0) { I.race.skip("llm", "unavailable"); I.flow.state("llm", "dim", "unavailable"); return; } // never present failed calls as a result
    I.race.finish("llm", llmEnd - t0); I.flow.state("llm", "done", fmtMs(llmEnd - t0));
  }) : Promise.resolve();
  await Promise.all([jevRun, llmRun]); paint();
}

/* ═══════════════════ 4 · Slop filter ═══════════════════ */
const F = { timer: null, idx: 0 };
function initFeed() {
  F.flow = new Flow($("#f-flow"), {
    w: 920, h: 130,
    nodes: [
      { id: "post", x: 90, y: 65, label: "New post", color: "io", w: 130 },
      { id: "jev", x: 340, y: 65, label: "Jev", sub: "kind · slop · worth", color: "jev", w: 170 },
      { id: "label", x: 590, y: 65, label: "Your rules", sub: "hide / boost / keep", color: "code", w: 150 },
      { id: "feed", x: 810, y: 65, label: "Clean feed", color: "good", w: 130 },
    ],
    edges: [["post", "jev"], ["jev", "label"], ["label", "feed"]].map(([from, to]) => ({ from, to })),
  });
  $("#f-hide").addEventListener("change", (e) => $("#f-feed").classList.toggle("hideslop", e.target.checked));
  $("#f-go").addEventListener("click", startFeed);
  $("#f-stop").addEventListener("click", () => { clearInterval(F.timer); $("#f-go").disabled = false; });
  paintFeed();
}
function startFeed() {
  clearInterval(F.timer);
  $("#f-go").disabled = true; $("#f-feed").innerHTML = "";
  Object.assign(F, { n: 0, slop: 0, ms: 0, cost: 0, tok: 0, idx: 0, done: 0 });
  paintFeed();
  const MAX = 24;
  F.timer = setInterval(async () => {
    if (F.n >= MAX) { clearInterval(F.timer); $("#f-go").disabled = false; return; }
    const p = SAMPLES.feedPosts[F.idx++ % SAMPLES.feedPosts.length]; F.n++;
    const card = document.createElement("div");
    card.className = "post"; card.innerHTML = `<div>${esc(p.text)}</div><div class="meta"><span class="pending">Jev is judging…</span></div>`;
    $("#f-feed").prepend(card);
    F.flow.send("post", "jev", { ms: 250 });
    try {
      const r = await api("/api/feed/label", { post: p.text }), v = r.value;
      card.style.setProperty("--pc", KIND_COLORS[v.kind]);
      if (v.kind === "ai_slop") { card.classList.add("slop"); F.slop++; }
      card.querySelector(".meta").innerHTML = `<span class="badge tone-${v.kind}">${v.kind.replace("_", " ")}</span><span>${fmtPct(v.kindConfidence)} sure</span><span>AI-written ${fmtPct(v.aiWritten)}</span><span>worth reading ${v.worthReading.toFixed(1)}/3</span><span style="margin-left:auto">${fmtMs(r.latencyMs)}${r.simulated ? " · simulated" : ""}</span>`;
      F.done++; F.ms += r.latencyMs; F.cost += r.costUsd; F.tok += r.inputTokens;
      F.flow.state("jev", "active", fmtMs(r.latencyMs)); F.flow.send("jev", "label", { ms: 200 }).then(() => F.flow.send("label", "feed", { ms: 200, color: v.kind === "ai_slop" ? "var(--k4)" : "good" }));
    } catch (e) { card.querySelector(".meta").innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    paintFeed();
  }, 750);
}
function paintFeed() {
  const m = MODELS[small()], avgTok = F.done ? F.tok / F.done : 0, est = F.done * ((avgTok * m.inPerM + 70 * m.outPerM) / 1e6);
  $("#f-kpis").innerHTML = [
    kpi("", "Posts judged", F.done ?? 0, `${F.n ?? 0} sent`), kpi("", "Slop flagged", F.slop ?? 0, "hidden when the toggle is on"),
    kpi("jev", "Avg Jev latency", F.done ? fmtMs(F.ms / F.done) : "–", "per post, live"),
    kpi("", "Jev spend", fmtUsd(F.cost ?? 0), `${esc(m.label)} would be ~${fmtUsd(est)} (est.)`),
  ].join("");
}

/* ═══════════════════ 5 · Title scorer ═══════════════════ */
const TI = {};
const ROW_H = 44;
function initTitles() {
  buildTitles();
  $("#ti-go").addEventListener("click", () => busy($("#ti-go"), $("#ti-kpis"), runTitles));
}
function buildTitles() {
  TI.flow = new Flow($("#ti-flow"), {
    w: 920, h: 130,
    nodes: [
      { id: "topic", x: 90, y: 65, label: "Topic", color: "io", w: 130 },
      { id: "writer", x: 330, y: 65, label: label(small()), sub: "writes candidates", color: "light", w: 170 },
      { id: "jev", x: 590, y: 65, label: "Jev ×N", sub: "scores each, parallel", color: "jev", w: 170 },
      { id: "board", x: 830, y: 65, label: "Leaderboard", color: "good", w: 130 },
    ],
    edges: [["topic", "writer"], ["writer", "jev"], ["jev", "board"]].map(([from, to]) => ({ from, to })),
  });
}
function layoutBoard(rows) {
  const sorted = [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  sorted.forEach((r, i) => { r.el.style.top = i * ROW_H + "px"; r.el.querySelector(".rk").textContent = i + 1; r.el.classList.toggle("first", i === 0 && r.score != null); });
}
async function runTitles() {
  const topic = $("#ti-topic").value.trim(), n = +$("#ti-n").value; if (!topic) throw new Error("Enter a topic");
  const board = $("#ti-board"); board.innerHTML = ""; $("#ti-kpis").innerHTML = ""; TI.flow.reset();
  TI.flow.state("topic", "done", "");
  const stopW = TI.flow.timer("writer"); TI.flow.send("topic", "writer", { ms: 300 });
  const gen = await api("/api/titles/generate", { topic, n }); stopW(fmtMs(gen.latencyMs ?? 0));
  board.style.height = gen.titles.length * ROW_H + "px";
  const rows = gen.titles.map((t) => {
    const d = document.createElement("div"); d.className = "trow";
    d.innerHTML = `<div class="rk">·</div><div class="ttl" title="${esc(t)}">${esc(t)}</div><div class="sc"><div class="track"><div class="fill" style="background:var(--accent)"></div></div><b class="muted">…</b></div>`;
    board.appendChild(d); return { title: t, el: d, score: null };
  });
  rows.forEach((r, i) => (r.el.style.top = i * ROW_H + "px"));
  await TI.flow.send("writer", "jev", { ms: 400, n: 4 });
  const t0 = performance.now(), stopJ = TI.flow.timer("jev"); let cost = 0, tok = 0, done = 0;
  await pool(rows, 8, async (r) => {
    const res = await api("/api/titles/score", { title: r.title, topic }), v = res.value;
    r.score = v.composite; cost += res.costUsd; tok += res.inputTokens; done++;
    const fill = r.el.querySelector(".fill"), b = r.el.querySelector("b");
    fill.style.width = v.composite + "%"; b.textContent = v.composite; b.className = "";
    r.el.title = `click appeal ${v.clickAppeal.toFixed(1)}/4 · clarity ${v.clarity.toFixed(1)}/3 · hype ${fmtPct(v.clickbait)} · specific ${fmtPct(v.specific)}`;
    layoutBoard(rows);
    TI.flow.send("jev", "board", { ms: 250 });
  });
  const jevMs = performance.now() - t0; stopJ(fmtMs(jevMs)); TI.flow.state("board", "done", `#1 scored ${Math.max(...rows.map((r) => r.score))}`);
  const m = MODELS[small()], est = (done * ((tok / done) * m.inPerM + 90 * m.outPerM)) / 1e6;
  $("#ti-kpis").innerHTML = [
    kpi("jev", `Jev scored ${done} titles${gen.simulated ? " · titles simulated" : ""}`, fmtMs(jevMs), "in parallel, four judgements each"),
    kpi("", "Jev cost", fmtUsd(cost), `${fmtUsd((cost / done) * 1000)} per 1,000 titles`),
    kpi("", `${esc(m.label)} as judge (est.)`, fmtUsd(est), `${(est / cost).toFixed(0)}× more, and slower`),
    kpi("gold", "Winner", `${Math.max(...rows.map((r) => r.score))}/100`, esc([...rows].sort((a, b) => b.score - a.score)[0].title.slice(0, 44))),
  ].join("");
}

/* ═══════════════════ 6 · Cost at scale ═══════════════════ */
function initCost() {
  document.querySelectorAll("#view-cost input").forEach((i) => i.addEventListener("input", drawCost));
  drawCost();
}
function drawCost() {
  const vol = Math.round(10 ** +$("#c-vol").value), tin = +$("#c-in").value, tout = +$("#c-out").value;
  $("#c-vol-l").textContent = vol.toLocaleString(); $("#c-in-l").textContent = tin.toLocaleString(); $("#c-out-l").textContent = tout;
  const rows = [
    { k: "jev", name: "Jev", color: "var(--accent)", per: (tin * STATUS.jevInPerM) / 1e6 },
    ...Object.entries(MODELS).map(([k, m]) => ({ k, name: m.label, color: "var(--k7)", per: (tin * m.inPerM + tout * m.outPerM) / 1e6 })),
  ].map((r) => ({ ...r, month: r.per * vol * 30 })).sort((a, b) => a.month - b.month);
  const mx = Math.max(...rows.map((r) => r.month));
  $("#c-bars").innerHTML = rows.map((r) => `<div class="cbar"><b style="text-align:left;${r.k === "jev" ? "color:var(--accent)" : ""}">${esc(r.name)}</b><div class="track"><div class="fill" style="width:${Math.max(0.6, (r.month / mx) * 100)}%;background:${r.color}"></div></div><b>${fmtUsd(r.month)} <span class="muted" style="font-weight:400">/ mo</span></b></div>`).join("");
  const by = Object.fromEntries(rows.map((r) => [r.k, r])), j = by.jev, sm = by[small()], bg = by[big()];
  $("#c-kpis").innerHTML = [
    kpi("jev", "Jev per month", fmtUsd(j.month), `${fmtUsd(j.per * 1000)} per 1,000 decisions`),
    kpi("", `${esc(bg.name)} per month`, fmtUsd(bg.month), `${(bg.month / j.month).toFixed(0)}× Jev`),
    kpi("gold", `Jev vs ${esc(sm.name)}`, (sm.month / j.month).toFixed(0) + "×", `saves ${fmtUsd(sm.month - j.month)} a month`),
    kpi("", `Saved vs ${esc(bg.name)} / year`, fmtUsd((bg.month - j.month) * 12), "at this volume"),
  ].join("");
}
