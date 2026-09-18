# Team feedback implementation

Source: team feature-review document, 13-tab snapshot reviewed on September 18, 2026.

The features tab separates an initial version from later enhancements. Preserve the current layout and approval-first behavior.

1. Import and preparation: add bounded Excel/JSON conversion, sheet selection, conversion warnings, original-file download, and column/type preview. Storage work was paused at the owner's request. The shared site retains its 1 MB / 5,000-row CSV limit; the browser-storage route is not enabled.
2. Audit setup: add a plain-language goal, explicit domain, sensitivity, required fields, numeric limits, email structure checks, and reusable local profiles. Suggest a plan using transparent local matching; require confirmation and never claim this is an LLM.
3. Review: surface severity and evidence strength, prioritize actionable issues, allow manual overrides of proposed fixes, and preview a bounded batch of matching suggestions before approval. Preserve undo and per-record decisions.
4. Exports: add a printable report with Save as PDF, unresolved-issues CSV, and readable summaries. Keep the original dataset and complete change ledger.
5. Validation: preserve existing regression tests; add conversion, custom-rule, bulk rollback and SQLite-WASM parity coverage; test the shared browser build before publishing.

Affected code: `audit.ts` and the portable SQLite engine (rules and decisions); `check-settings.tsx` (setup); Home and LargeWorkspace (review/import/export); browser worker RPC (bounded batches and exports). Existing SQLite tables can hold the added rule and finding metadata in their JSON payloads; no destructive data migration is needed. The private Node service retains the same rule semantics.

Later enhancements remain separate: learned preferences, multiple time-series correction strategies, expert assignment/collaboration, scientific image classification, and external contact verification. Email structure is not proof an address exists. Never contact people automatically.

Presentation corrections: GitHub Pages runs React and TypeScript rules locally. The paused, unpublished large-file route uses SQLite WASM in a web worker and private browser storage. The repository also has an optional model planner and private Node service; do not describe those as active on GitHub Pages. There is no implemented Hermes/Claude 3.5 stack, MCP execution sandbox, or generated Python repair loop. Evaluation numbers must come from the actual answer-key comparison, not the draft's example numbers. The bundled café case is synthetic and is not a blind human-planted benchmark.


## Interactive assistant follow-up

Added an optional conversational assistant using Llama 3.3 70B on the verified Cloudflare Workers Free plan, while keeping the GitHub Pages URL and 1 MB CSV limit. The assistant explains findings, requests clarification, recommends review items, and proposes a bounded subset of rules. Those proposals open in the existing settings for confirmation. It cannot author dataset patches, contact anyone, execute code, or claim unsupported domain checks. Only bounded summaries and explicitly selected evidence enter the prompt. Messages remain in browser memory; the Worker stores none.

Fixed missed initial requirements: manual overrides now work for suggested cell repairs, with atomic verified measurement/unit edits and arithmetic consistency checks. Current summaries update after apply, keep, bulk decisions, and undo. Reports label reviewer notes accurately; no authenticated reviewer identity is claimed. Branding is now ClearView, including the four-page proposed-design visual explainer.

Still outstanding from the broader document catalog: excessive Other/category discovery; near-duplicate entities; finance amount parsing/accounting reconciliation/merchant matching; sensor intervals, gaps, drift, stuck readings and cross-field conflicts; preference learning; method comparisons; expert assignment; privacy masking throughout tables/exports; scientific images; and external contact verification. Existing date checks flag non-ISO or invalid calendar values but do not interpret ambiguous dates or infer time zones. The new Financial data prompt requests synthetic transactions/balance-sheet CSVs plus a planted-defect key; those fixtures and their domain-specific checks are not yet delivered. The Google Doc itself has not been edited. Do not describe the complete wish list as finished.
