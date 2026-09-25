# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Jev demos" — six live side-by-side demos of TypeSafe's Jev (a "System One" typed decision model) racing LLMs (Claude and Kimi). Single Node 22.6+ process, no database, no build step (Node native TS), served as static files + one request handler. Deployable to Vercel as a serverless function or anywhere Node runs.

## Dev / build / run

| Command | Does |
|---|---|
| `npm start` | Run server at `http://localhost:3000` |
| `npm run dev` | Same, restart on file changes (`node --watch`) |
| `npm run typecheck` | `tsc --noEmit` |

Node 22.6+ required (check with `node -v`). No API keys needed to explore the UI — missing keys fall back to clearly badged simulated output.

## Architecture

**Server (`src/`)** — one HTTP endpoint per pipeline stage so the UI can animate each hop live:
- `server.ts` — request handler (also exported for Vercel `api/[...path].ts`), static file serving, per-IP rate limiter, API key reading via AsyncLocalStorage
- `jev.ts` — typed Jev call wrapper (`jevCall`) with latency/cost/budget tracking, offline heuristic fallback, per-key cooldown
- `llm.ts` — Claude (Anthropic SDK) + Kimi (OpenAI chat-compat wire format) behind `complete()` / `parseWith()`; structured output via Zod; simulated fallback when provider down
- `config.ts` — model IDs/prices, provider tiers, per-key spend budgets, provider availability
- `keys.ts` — bring-your-own-key support: keys arrive as request headers, live only for the request via `AsyncLocalStorage`, never logged or echoed back
- `router.ts` — router demo Jev questions + tier-selection + confidence guard (escalates below 60%)
- `triage.ts` — ticket triage: one Jev call answers six questions, business rules in plain `decideAction()`
- `usecases.ts` — inbox classifier, feed labeler, title scorer (LLM writes, Jev ranks)
- `samples.ts` — sample prompts, tickets, feed posts, deterministic inbox generator

**Frontend (`public/`)** — vanilla JS modules, no framework:
- `index.html` — app shell: hero banner, six tabs, narrator bar, keys dialog
- `app.js` — per-demo UI logic, provider switching, key management, status polling
- `demo.js` — demo-mode narration/pacing/callouts
- `keys.js` — browser-side key storage (sessionStorage / opt-in localStorage)
- `flow.js` — animation toolkit: pipeline diagrams, race lanes, donut chart
- `style.css` — light/dark theme, single accent color

## Key conventions

- Jev makes the decision; an LLM writes the words; control flow stays in ordinary code.
- Failed LLM baselines are never shown as results — lane says "unavailable" instead.
- Latencies in race lanes are measured API times, not animation time.
- Every demo call runs at the cheapest effort setting (thinking disabled on K2.6, low reasoning on K3/Claude) except frontier tier and always-top-model baseline.
- Per-key spend budget (`DEMO_BUDGET_USD`, default $0.50) is a hard cap on real API spend; Jev itself is ~free and never blocked.
- `HOSTED=1` ignores server keys — public deployments must use bring-your-own-keys.
- `parseWith()` is the structured-output baseline; `complete()` is the free-text baseline.
- `jevCall()` signature: `(state, questions, normalize, mock) => Timed<T>` — normalize shapes the raw Jev result; mock is the offline stand-in.

## Provider model map

- Claude: haiku (light) / sonnet (standard) / opus (frontier); small=haiku, mid=sonnet, big=opus
- Kimi: kimiK26 (light/standard) / kimiK3 (frontier, standard, big); K2.6 has thinking disabled