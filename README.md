# ClearView

A friendly spreadsheet review app for hackathon challenge 9. Choose CSV, Excel, or JSON, or try the café example, review clear before-and-after suggestions, and download an updated copy. Every change needs your approval and can be undone.

## Share the browser demo

**Website:** https://biruk-desta.github.io/cleanroom-detective/

This public GitHub Pages version needs no account or installation. CSV parsing, rule checks, evidence, review, undo and exports run in the visitor's browser. The optional Ask the assistant panel calls Llama 3.3 70B through a separate Cloudflare Worker on the Ghost account’s Free plan. It sends messages, column names, numeric summaries and finding metadata; selected finding evidence is opt-in. Full files remain in the browser. No AI response can directly edit data. Export before closing the tab.

Run `npm run build:pages` to build the standalone site and `npm run preview:pages` to preview it under `/cleanroom-detective/`. Pushes to `main` run tests, type checking, and the Pages build before publishing through GitHub Actions. The original server-backed app and optional local AI remain available below.

## Run locally

Requires Node 22.13+ and npm. Install with `npm ci`. Copy `.env.example` to `.env` for a new checkout.

For the live local investigator, sign in with `codex login`, then run `npm run ai:local` in one terminal and `npm run dev` in another. Open http://localhost:3000. `CODEX_BIN` can point to the Codex executable. The bridge also detects this machine's installed Codex extension. It listens only on 127.0.0.1:8788.

The local bridge reuses Codex's saved ChatGPT sign-in; it never reads or copies credentials. It runs ephemeral, read-only Codex processes with shell, apps, delegation, hooks, web search and image tools disabled. This is not represented as a universally verified tool-free sandbox. Only reconstructed, bounded numeric statistics, opaque column IDs, fixed check names, and finding counts enter its prompt. Raw CSV cells, headers, filenames and reviewer notes do not.

## Public assistant deployment

`assistant-worker/wrangler.jsonc` targets the Ghost account. Verify the intended account before deploying: the machine’s default Wrangler login may be a different account. Deploy with `wrangler deploy --config assistant-worker/wrangler.jsonc` using the Ghost login. No API key is embedded in the website. The Worker accepts only the site and local-preview browser origins, bounds request sizes and model output, and limits each IP to six requests per minute. Free-plan daily quotas stop inference when exhausted. No R2, file uploads, database, paid upgrade, or persistent chat storage is provisioned. Application request logging is disabled to avoid logging conversation content.

## Hosted mode

The private hosted app supports the full deterministic audit, review, undo and exports without a model connection. A cloud Worker cannot use this computer's signed-in CLI. For hosted AI, configure `OPENAI_API_KEY` as a server-side Sites secret and optionally `OPENAI_MODEL` (default `gpt-5-mini`), then redeploy. Do not deploy `LOCAL_PLANNER_URL`. Never put API credentials in client code. The OpenAI Developers plugin provides the supported key-provisioning workflow.

The AI chooses the order of all enabled checks, adapting to each check's measured result. Deterministic code supplies findings and patches. The model does not invent repairs or decide whether a reviewer should accept them. The separate rules comparison runs all checks with no LLM. Provider failures are reported; there is no silent fallback labeled as AI.

## Demo walkthrough

1. Choose **Try the example** on the welcome screen. The café dataset has confirmed example rules; **Adjust checks** lets you inspect them.
2. Select **Check my file** to run an AI-assisted check (when connected locally) or standard checks in the shared website. Expect four supported repairs: an exact duplicate, missing quantity, category spacing/case, and an explicit grams-to-kilograms conversion.
3. Review one suggestion at a time. Choose **Apply this fix** or **Keep as is**; the next pending item appears automatically. Expand the evidence when you want the details, or open **Your data** to inspect the working table. Quantity is derived using exact decimal arithmetic, without rounding.
4. The impossible February date requires source evidence. The large order is only a review request, not a proven defect. Keep it as is, optionally adding a note.
5. Undo the most recent decision from **Changes**. Choose **Download results** for the updated CSV, list of changes, printable HTML report, and untouched original.
6. For a genuine evaluation, have a human prepare an independent answer key, keep it hidden until investigation completes, then reveal it. Columns: `row,check,truth`; `truth` is `defect` or `valid`. Row numbers refer to parsed records, excluding the header. The app compares against the first completed investigation and locks subsequent investigations after reveal. No blind evaluation or real dataset benchmark is claimed by the included sample.

## Team feedback additions

- Ask the real AI assistant to explain a finding, calculate from shared evidence, recommend the next review, or propose required fields/email/range/date/outlier rules from a conversational goal. Plans open as drafts in existing settings and require confirmation. Clarifying questions and stale-plan protection are built in.
- Set a plain-language goal and choose a domain. The separate Suggest my plan button still uses local matching; it is not an LLM and does not enable repair assumptions automatically.
- Confirm required fields, basic email structure, numeric bounds, outlier sensitivity, and priority for custom-rule violations. Save up to five reusable profiles on this device.
- Review findings in priority order with qualitative evidence strength. Override a suggested cell correction using source evidence, or preview up to 30 similar cell fixes and approve them as an undoable batch.
- Choose an Excel worksheet or convert a flat JSON array. Original bytes remain available. JSON numbers retain their original numeric text; Excel uses formatted values and existing cached formula results without running formulas.
- Download unresolved issues, including kept values. **Save report as PDF** opens a print-ready report; choose **Save as PDF** in the browser dialog. No PDF-generation server is required.

Advanced sensor/time-series checks, accounting reconciliation, near-duplicate entity matching, image classification, learned preferences, collaboration and external contact verification remain future work. The pitch must not claim Hermes/Claude, a Python repair sandbox, or a blind benchmark. See [feedback review](docs/feedback-plan.md).

The visual explanation and LaTeX source are available from **Quick guide** and in `public/`.

## Data and limits

Shared site: CSV/JSON up to 1 MB; Excel workbooks up to 10 MB, with one selected sheet converted to at most 1 MB / 5,000 rows / 40 columns. Cells support 4,000 characters. Large-file storage work is paused at the owner’s request. Comma-separated CSV with strict quoting, multiline values and unique headers. Explicit empty records are preserved. Empty physical lines are ignored. IDs remain strings; rows have separate stable numeric identities. Business rules must be confirmed for uploaded data. The date check expects YYYY-MM-DD. Unit conversion covers only explicit g/kg. The arithmetic check recovers missing positive integer quantities from trusted total/price, not general accounting reconciliation.

Changes affect a working copy. Patches verify their before values and arithmetic/duplicate dependencies. Undo replays the remaining approved decisions from the original. All configured checks rerun after a decision. Keeping a value records review; it does not remove it from remaining findings in the report.

The shared site keeps the current dataset in memory. Saved audit profiles contain only rules and column names in local browser storage. Refresh/closing the tab loses the case; export first. Rules-only audits stay in the browser. The optional local/server investigator sends the CSV to this app's server for deterministic computation; only numerical aggregates go to that planner. The public conversational assistant uses the bounded context described above; chat history stays in memory and clears on file change or reload. The app does not persist CSV payloads. Exported CSVs preserve source values and are not a spreadsheet formula sanitizer.

## Validation

- `npm test`: 34 tests covering CSV parsing, exact arithmetic, dates, categories, units, conflicting IDs, stale evidence, undo, missing sentinels, key scoring and planner constraints.
- `npx tsc --noEmit`: project type check.
- `npm run lint:app`: authored application, audit engine, bridge and tests. The scaffold's full `npm run lint` currently reports pre-existing issues in unused UI primitives and hooks.
- `npm run build`: production Worker and client build.
- A live six-step Codex investigation on the sample returned the expected six findings (four repairs, two source/review items).
- The page-scoped `get_case_profile` WebMCP tool is feature-detected. No supported WebMCP validation context was available in this session, so its browser registration contract is not claimed as verified. The shared-site goal setup, sample review, priority display and export controls were checked in Chrome. Automated OS file selection requires the browser extension’s file-URL permission.

Dependency note: React/React DOM/RSC were patched together to 19.2.8 to address the RSC advisory reported by npm. The retained Sites scaffold still reports transitive/tooling advisories (including image parsers and Windows development-server behavior); it was not broadly upgraded with `npm audit fix --force`. Review those before expanding this prototype beyond its owner-private deployment.
