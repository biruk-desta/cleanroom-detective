# Cleanroom Detective

A CSV investigation workspace for hackathon challenge 9. Upload one table, declare its data rules, inspect measured findings, approve reversible repairs, and export the cleaned data with an evidence ledger.

## Run locally

Requires Node 22.13+ and npm. Install with `npm ci`. Copy `.env.example` to `.env` for a new checkout.

For the live local investigator, sign in with `codex login`, then run `npm run ai:local` in one terminal and `npm run dev` in another. Open http://localhost:3000. `CODEX_BIN` can point to the Codex executable. The bridge also detects this machine's installed Codex extension. It listens only on 127.0.0.1:8788.

The local bridge reuses Codex's saved ChatGPT sign-in; it never reads or copies credentials. It runs ephemeral, read-only Codex processes with shell, apps, delegation, hooks, web search and image tools disabled. This is not represented as a universally verified tool-free sandbox. Only reconstructed, bounded numeric statistics, opaque column IDs, fixed check names, and finding counts enter its prompt. Raw CSV cells, headers, filenames and reviewer notes do not.

## Hosted mode

The private hosted app supports the full deterministic audit, review, undo and exports without a model connection. A cloud Worker cannot use this computer's signed-in CLI. For hosted AI, configure `OPENAI_API_KEY` as a server-side Sites secret and optionally `OPENAI_MODEL` (default `gpt-5-mini`), then redeploy. Do not deploy `LOCAL_PLANNER_URL`. Never put API credentials in client code. The OpenAI Developers plugin provides the supported key-provisioning workflow.

The AI chooses the order of all enabled checks, adapting to each check's measured result. Deterministic code supplies findings and patches. The model does not invent repairs or decide whether a reviewer should accept them. The separate rules comparison runs all checks with no LLM. Provider failures are reported; there is no silent fallback labeled as AI.

## Demo walkthrough

1. Start with the clearly labeled synthetic café case and inspect its confirmed rules.
2. Run an AI investigation (local) or rules audit. Expect four supported repairs: an exact duplicate, missing quantity, category spacing/case, and an explicit grams-to-kilograms conversion.
3. Inspect and approve each proposal. Observe before/after values and the working table. Quantity is derived using exact decimal arithmetic, without rounding.
4. The impossible February date requires source evidence. The large order is only a review request, not a proven defect. Keep it with a note.
5. Undo the most recent decision from the ledger. Export the cleaned CSV, change ledger, printable HTML report, and untouched original.
6. For a genuine evaluation, have a human prepare an independent answer key, keep it hidden until investigation completes, then reveal it. Columns: `row,check,truth`; `truth` is `defect` or `valid`. Row numbers refer to parsed records, excluding the header. The app compares against the first completed investigation and locks subsequent investigations after reveal. No blind evaluation or real dataset benchmark is claimed by the included sample.

The visual explanation and LaTeX source are available from **How it works** and in `public/`.

## Data and limits

1 MB per file, 5,000 records, 40 columns, 4,000 characters per cell. Comma-separated CSV with strict quoting, multiline values and unique headers. Explicit empty records are preserved. Empty physical lines are ignored. IDs remain strings; rows have separate stable numeric identities. Business rules must be confirmed for uploaded data. The date check expects YYYY-MM-DD. Unit conversion covers only explicit g/kg. The arithmetic check recovers missing positive integer quantities from trusted total/price, not general accounting reconciliation.

Changes affect a working copy. Patches verify their before values and arithmetic/duplicate dependencies. Undo replays the remaining approved decisions from the original. All configured checks rerun after a decision. Keeping a value records review; it does not remove it from remaining findings in the report.

There is no database or durable session storage. Refresh/closing the tab loses the case; export first. Rules-only audits stay in the browser. AI investigations send the CSV to this app's server for deterministic computation; only numerical aggregates go to the model. The app does not persist CSV payloads. Exported CSVs preserve source values and are not a spreadsheet formula sanitizer.

## Validation

- `npm test`: 15 tests covering CSV parsing, exact arithmetic, dates, categories, units, conflicting IDs, stale evidence, undo, missing sentinels, key scoring and planner constraints.
- `npx tsc --noEmit`: project type check.
- `npm run lint:app`: authored application, audit engine, bridge and tests. The scaffold's full `npm run lint` currently reports pre-existing issues in unused UI primitives and hooks.
- `npm run build`: production Worker and client build.
- A live six-step Codex investigation on the sample returned the expected six findings (four repairs, two source/review items).
- The page-scoped `get_case_profile` WebMCP tool is feature-detected. No supported WebMCP validation context was available in this session, so its browser registration contract is not claimed as verified. Broad browser UI testing was not performed.

Dependency note: React/React DOM/RSC were patched together to 19.2.8 to address the RSC advisory reported by npm. The retained Sites scaffold still reports transitive/tooling advisories (including image parsers and Windows development-server behavior); it was not broadly upgraded with `npm audit fix --force`. Review those before expanding this prototype beyond its owner-private deployment.
