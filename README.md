# Jev demos

![Node](https://img.shields.io/badge/node-%3E%3D22.6-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Six live, side-by-side demos of [TypeSafe's Jev](https://www.langchain.com/blog/building-a-harness-with-jev) — a "System One" model that returns **typed, probabilistic decisions** (70–500 ms, $0.042 per 1M input tokens, output free) instead of generated text.

**Jev makes the decision. An LLM writes the words. Your code owns the control flow.** Switch the LLM side between **Claude** (Haiku 4.5 / Sonnet 5 / Opus 5) and **Kimi** (K2.6 / K3) from the header — every tab, price and pipeline label follows the switch.

Reference: [YouTube video](https://www.youtube.com/watch?v=d9lCIVc5AyU)

![Screenshot of the Jev demos app](docs/screenshot.png)

---

## Quickstart

```bash
git clone git@github.com:mayank953/Jev.git
cd Jev
npm install
cp .env.example .env    # optional — see "API keys" below
npm start
```

Open **http://localhost:3000**. That's it — no build step, no keys required to try it.

- **Node 22.6 or newer** is required (the app runs TypeScript directly via Node's native support — no compile step, no `ts-node`). Check with `node -v`.
- **No API keys needed to explore the UI.** Any demo whose key is missing runs in **simulated mode**: output is clearly badged `simulated` and a status pill in the header shows why. Add keys any time and reload — no restart needed for most changes, though the server does need a restart to pick up a newly added key.

---

## API keys (all optional)

| Key | Powers | Get one at |
|---|---|---|
| `TYPESAFE_API_KEY` | Jev, the decision model — used in every demo | [typesafe.ai](https://typesafe.ai) |
| `ANTHROPIC_API_KEY` | Claude (Haiku 4.5 / Sonnet 5 / Opus 5) | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `MOONSHOT_API_KEY` | Kimi (K2.6 / K3), the second LLM provider | [platform.kimi.ai](https://platform.kimi.ai) |

Put them in `.env` (copied from `.env.example`, already git-ignored — **never commit real keys**). You only need `TYPESAFE_API_KEY` plus **one** of the two LLM keys for a fully live demo; the app auto-selects whichever LLM provider is actually usable.

---

## The demos

| Tab | What it shows |
|---|---|
| **How Jev works** | Animated LLM-vs-Jev duel (illustrative timings) and the three answer types: choice, score, noul |
| **LLM router** | Jev reads a prompt and picks a model tier. Live pipeline diagram, race lanes vs. always using the top model, a confidence guard that escalates uncertain calls, and a 10-prompt benchmark |
| **Ticket triage** | One Jev call answers six questions about a support ticket; plain code routes it (discard / escalate / auto-reply). Optional real race against the small LLM as a classifier |
| **Inbox at scale** | Up to 500 emails classified in parallel — live donut chart, importance histogram, scam count, and cost per 1M emails. The LLM-classifier race is capped at 50 emails to keep it cheap; Jev still classifies the full set |
| **Slop filter** | Posts stream in and are labelled live (breaking / golden nugget / promo / hot take / noise / AI slop); a "hide slop" toggle cleans the feed in real time |
| **Title scorer** | The small LLM writes candidate video titles, Jev scores every one in parallel (click appeal, clarity, hype, specificity), and the leaderboard re-ranks live |
| **Cost at scale** | A slider showing monthly cost of Jev vs. every configured model at your volume |

---

## Keeping it cheap to run

- **Session budget.** `DEMO_BUDGET_USD` (default **$0.50**) is a hard cap on real LLM spend for the life of the server process. Once reached, paid LLM calls fall back to clearly badged simulated output — the header shows a live meter and a "+$0.50" button to raise it on the fly. Jev itself costs about $0.02–0.04 per 1,000 decisions and is never blocked by this cap.
- **Low effort/thinking everywhere.** Every demo call runs at the cheapest setting that still answers directly (thinking disabled on Kimi K2.6, low reasoning effort on K3, low effort on Claude), except the router's "frontier" tier and the always-top-model baseline, which need real capability to be a fair comparison.
- **Inbox race is capped at 50 emails** even if you pick 500 in the dropdown — only the head-to-head comparison is capped; Jev alone still classifies everything you asked for.
- **Simulated fallback.** If a key is missing, or a provider rejects the account (spend cap, no credit, bad key), that provider's output becomes clearly badged placeholder text and the header explains why. The other provider and Jev are unaffected. A capped provider automatically retries after 10 minutes, or immediately if you click its status pill in the header.

## Honest numbers

- **Failed baselines are never shown as results.** If an LLM comparison can't run, its lane simply says "unavailable" — nothing is faked or compared against it.
- Latencies in the race lanes are **measured API times**, not animation time. The "How Jev works" duel is the one illustrative exception (its timings come from TypeSafe's own launch material, not a live call).
- The router benchmark measures speed and cost, **not answer quality**. Read the actual answers on the harder prompts before concluding a cheaper tier matched a frontier model.
- Prices in [`src/config.ts`](src/config.ts) are first-party list prices as of September 2026 for [Anthropic](https://www.anthropic.com/pricing) and [Moonshot/Kimi](https://platform.kimi.ai/docs/pricing/chat) — re-check before quoting them anywhere else, list prices change.

---

## Project structure

```
src/
  config.ts     model IDs, prices, provider tiers, the spend budget, provider availability
  llm.ts        Claude (Anthropic SDK) + Kimi (raw HTTP) behind one complete()/parseWith() API
  jev.ts        one typed Jev call, with latency, cost and budget tracking
  router.ts     the router demo's Jev questions + tier-selection logic
  triage.ts     the ticket-triage demo's Jev questions + routing rules
  usecases.ts   inbox classifier, slop filter, and title-scoring Jev questions
  samples.ts    sample prompts, tickets, feed posts, and the deterministic inbox generator
  server.ts     one HTTP endpoint per pipeline stage, so the UI can animate each hop live
public/
  index.html    the six-tab app shell
  app.js        per-demo UI logic
  flow.js       small animation toolkit: pipeline diagrams, race lanes, donut chart
  style.css     light/dark theme, single accent colour
docs/
  screenshot.png
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | Run the server at `http://localhost:3000` |
| `npm run dev` | Same, but restarts on file changes (`node --watch`) |
| `npm run typecheck` | Type-check the whole project with `tsc --noEmit` |

## Troubleshooting

- **"Port 3000 already in use"** — set a different port: `PORT=3001 npm start`, or stop whatever else is using 3000.
- **A provider pill says "unavailable"** — the key is set but the account rejected the call (spend cap, no credit, wrong key). Click the pill to re-check immediately, or wait 10 minutes for the automatic retry.
- **A provider pill says "no key"** — that `.env` variable is empty or missing. Add it and restart the server.
- **`npm start` fails immediately** — check `node -v` is 22.6 or newer; older Node can't run `.ts` files directly.
- **Everything is badged "simulated"** — no keys are set at all. The app still fully works for exploring the UI and flow; add at least `TYPESAFE_API_KEY` and one LLM key for live numbers.

## Contributing

This is a demo/reference project. Issues and pull requests are welcome — keep changes scoped and consistent with the existing style (plain TypeScript, no framework, no build step).

## License

[MIT](LICENSE) © 2026 Mayank Aggarwal
