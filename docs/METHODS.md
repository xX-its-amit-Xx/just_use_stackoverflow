# Methods

## 1. Agent and configuration (frozen)

- **Harness:** Claude Code CLI in headless mode (`claude -p --output-format stream-json --verbose`), one fresh session per trial (`--session-id <uuid>`).
- **Models (v2):** `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, all at `--effort medium`, crossed with every task and strategy. Execution order is randomized across models and strategies. Per-run budgets scale by model (`max_budget_usd_by_model`). The v1 pilot used Sonnet only; its Sonnet trials 0–2 on unchanged tasks count as trials of the v2 design, because the agent-visible inputs are identical. The harness refuses to price unknown models.
- **Isolation:**
  - `--setting-sources ""`, `--strict-mcp-config` and `--disable-slash-commands` remove user settings, MCP servers and skills.
  - Subagents (`Task`) are disabled, so every model call appears in one transcript.
  - Environment variables that would tie the child to the parent session are removed.
  - Each trial runs in a fresh copy of the task template.
- **Permissions:** `--permission-mode auto`. Actions are screened by the harness's safety classifier rather than bypassed.
- **Budgets:** per-run `--max-budget-usd` and a wall-clock limit per tier.
- **Tools per strategy:**

| strategy | built-in tools | extra CLI on PATH |
|---|---|---|
| A generate-first | Bash Read Write Edit Glob Grep | – |
| B reuse-first | + WebSearch WebFetch | `rtool` |
| C hybrid | + WebSearch WebFetch | `rtool` |
| D GUI reuse-first | Bash Read Write Edit Glob Grep | `gui` (browser) |

- **Prompts:** `bench/prompts/common.md` plus the strategy file, appended to the system prompt. Strategies B and D carry a *mandatory* protocol: search and acquire before writing to `src/`. In the protocol-v0 trial the prompts were advisory; with advisory prompts, agents skipped retrieval entirely at S1 (kept in `results/runs_protocol_v0/` as evidence). Each run records a `protocol_sha` hash of the prompts, task, tools and config.

## 2. Token telemetry

**Source of truth.** Claude Code writes the session transcript to `~/.claude/projects/*/<session>.jsonl`. Each assistant API response appears with its provider `message.id` and the final provider `usage` object: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` with a 5m/1h split, `output_tokens_details.thinking_tokens`, and `server_tool_use`. One response can span several transcript lines, one per content block. Lines are grouped by `message.id` and the final usage is taken.

**One event per model invocation** goes to `events.jsonl`:
- `measurement_confidence = "actual"`.
- Cost is computed from those counts and `pricing.json`, with `cost_source = provider_usage_x_pricing_config`.

**Reconciliation.**
- The per-message sums are compared with the harness's aggregate `modelUsage` from the `result` record.
- Any positive difference (for example, the WebFetch summarizer model, or permission-classifier calls if the harness bills them) becomes a separate event: `measurement_confidence = "actual_aggregate_unattributed"`, `cost_source = harness_modelUsage_minus_transcript`.
- Computed cost is also compared with the harness's own `total_cost_usd`.
- During verification this check found a stale price in our reference table (Sonnet 5.5 cache reads cost $0.10/M, not $0.20/M). It was corrected from the live pricing page.

**Attribution.**
- Each invocation is attributed to the action it **emitted**: its tool call, classified into the requested action types.
- The action whose output it **consumed** is also recorded (`consumed_action_types`).
- `cost_by_action.csv` reports both views.
- Parallel tool calls in one invocation are listed in `sub_actions`. Their tokens are not split, because splitting would be an estimate.

**Action classification** (`harness/telemetry.py`) is rule-based on tool name and arguments:
- rtool subcommands, `git clone`, `gh … search` and curl targets map to the retrieval types.
- Writes and edits after a failing test run map to `debugging` until the next passing run.
- Edits to files that were copied or pasted from retrieved material map to `integration`.
- `gui screenshot` maps to `screenshot`; other `gui` commands map to `computer_use`.
- Heredoc writes through Bash map to `code_generation`.

**Never estimated.** Token counts. The only estimated quantities are explicitly named:
- `screenshot_tokens_estimate`: Anthropic's image formula, w·h/750. The actual image tokens are inside `input_tokens`.
- `compute_cost_usd_estimate`.
- `irrelevant_reading_cost_usd_est`.

## 3. Retrieval and provenance metrics

- `rtool` and `gui` write structured logs (`retrieval.jsonl`, `gui.jsonl`): queries, result counts, bytes and lines acquired, durations, success.
- **Provenance** (`harness/provenance.py`):
  - The corpus is all of `.retrieval/` (clones, npm tarballs, fetched files, Stack Overflow answers), the GUI clipboard history, and the text of retrieval tool results (WebFetch, curl, WebSearch).
  - Each non-trivial final source line is classified as *exact* (normalized line in the corpus, counted as incorporated), *modified* (identifiers and literals abstracted; token skeleton of 8 or more tokens matches the corpus), or *generated*.
  - Trivial lines (under 12 chars, punctuation only, comments) are excluded from the denominator.
  - Search-to-use conversion = corpus sources contributing at least one line / corpus sources.
  - Retrieved LOC = lines in the corpus. Discarded = retrieved − incorporated − modified.
- **Limitation:** code the model reproduces from training memory cannot be told apart from generated code, so it counts as generated.

## 4. Size

- **`functional_loc`:** non-blank, non-comment lines in source files outside tests, `node_modules`, retrieval caches, minified files and build output.
- **`normalized_loc`:** non-whitespace characters on functional lines / 30. Agents write dense code (lines up to 180 characters), so this formatting-independent measure is reported alongside LOC.
- Tier labels are the *targets* in the spec. All analyses use the *measured* size of the generate-first implementation of the same task.

## 5. Costs

| metric | definition |
|---|---|
| total tokens | `input + output` (uncached); also `input + output + cache_read + cache_write` ("incl. cache"), the volume the model actually processed |
| weighted inference cost | Σ uncached·p_in + cache_read·p_cr + cache_write_5m·p_cw5 + cache_write_1h·p_cw1h + output·p_out, per model; Haiku long-context tier applied per request |
| total execution cost | inference + web-search charges ($10/1k) + compute estimate (elapsed hours × $0.08/h, the published Managed Agents runtime rate, used as a proxy because the container price is not exposed) + dependency acquisition ($0; registries are free) |
| wall-clock | elapsed = task assignment → agent exit + evaluation; active = API time + tool execution time |

## 6. Quality

- **Hidden suite** (`tasks/<task>/hidden`): run against the preserved artifact, never visible to the agent.
- **Pass rate** = passed / tests in the suite. The suite size is the maximum observed for the task, so a crashed suite counts as all-fail.
- **Success** means a pass rate of at least 90%. A strict 100% flag is also reported.
- **Quality-adjusted cost** = cost / pass rate.
- **Other checks:** the agent's own tests, `node --check` syntax, pattern-based security scan, declared runtime dependencies (`npm audit` if any), maintainability proxies (file sizes, LOC per function, duplicate-line ratio), license compliance (provenance entries, copyleft, missing notices, undeclared reuse), protocol compliance, and contamination (any tool input referencing the benchmark repo or hidden tests).
- **Validation:** the markdown suite was checked against markdown-it 14 used as an oracle: 54/56 pass, and the two remaining differences are deliberate spec choices.

## 7. Crossover and statistics

- **Per-cell ratio:** `mean(reuse) / mean(generate)` for each model × task × strategy × metric, with a bootstrap 95% CI. Each cell also gets a Welch t-test on log cost, Holm-corrected across all cells of a metric (`cell_tests.csv`).
- **Regression** (`regression.csv`): per model and pooled, `log(cost) ~ C(task) + Σ_s [is_s + is_s·(log size − mean)]` with HC3 standard errors. Task fixed effects absorb size and family main effects. `β_s` is the strategy's log-ratio at the mean task size; `γ_s` is how that ratio changes with size. Crossover = `exp(mean − β/γ)`. CIs come from 200 bootstrap resamples of runs within task × strategy cells.
- **Family/size confound:** reuse potential is a property of a family, so each fit is repeated for all families, markdown only (sizes S1–S3 within one family) and excluding markdown.
- **Metrics:** weighted cost, cache-independent cost (all input priced uncached, to remove cross-run cache luck), total tokens and wall-clock. They are reported separately.
- **Success:** Wilson 95% intervals for success rates. Quality-adjusted ratios divide cost by pass rate.

## 8. Known limitations (and what v2 did about each)

- **One model family, one harness.** Results describe Claude Sonnet 5.5 inside Claude Code, not agents in general.
- **The GUI condition is a Playwright-driven headless Chromium.** The agent sees screenshots and acts by coordinates, keys and clipboard. This is genuine GUI interaction, but it is not the native Anthropic computer-use tool, which this harness does not expose. Stack Overflow serves a Cloudflare challenge (HTTP 403) to the headless browser, so GUI discovery is effectively GitHub-only. Every failed navigation is logged.
- **Prompt-cache interference.** Concurrent trials share the provider prompt cache for the common system prompt, so a later trial can get cheaper cache reads. Randomized order spreads this across strategies.
- **Prompt compliance.** Strategy conditions are enforced by prompt and audited afterwards (`protocol_*` columns), not by sandboxing. Generate-first could technically still reach the network.
- **Small n.** The pilot uses ≤3 trials per cell, and the CIs are wide.
- **Provenance blind spots.** Matching misses code that was retrieved and then heavily rewritten, and code downloaded directly into `src/` by a raw `curl -o`, which bypasses the corpus.

## 9. Evaluation-suite changes during the pilot (applied retroactively to all runs)

- `kanban-s3` "web UI served": the check originally required the literal `/api/auth/login` in the served JS. Three correct UIs built paths through a prefixing helper (`api('POST','/auth/login')`) and failed. The check now matches `auth/login`, `/boards` and `move`. Every stored artifact was re-evaluated.
- `pm-s4` (spec v1, used by all executed S4 runs) said auth and error conventions were "identical to kanban-s3", but agents never see that spec. It also did not define `GET /api/projects/:id`, and the webhook delivery `status` field was ambiguous. Three tests failed in ≥9/12 runs for those reasons alone. The tests now accept every reasonable reading (`/me` returning `{user}` or the bare user; 403 or 404 for a guest; delivery status as HTTP code or a success word). The spec was clarified for future runs (v2, which changes `protocol_sha`). All S4 artifacts were re-evaluated.
- Minified files (`*.min.*`) are excluded from functional LOC as generated/vendored artifacts. One markdown reuse run vendored a 120 KB minified markdown-it build, plus 65 LOC of glue. Its provenance and external-code share still count the vendored file (see `provenance.json`).

## 10. Protocol v2 changes

- **New tasks:** `markdown-s1` (CommonMark subset) and `markdown-s3` (Markdown wiki: renderer + versioned pages, LCS diff, search, backlinks, SPA). The markdown family now spans S1–S3. The `markdown-s1` hidden suite was validated against markdown-it 14 (26/26). `markdown-s3` was validated against a reference implementation written for this purpose (31/31). The reference is kept outside the public repository.
- **Self-contained specs:** the `pm-s4` and `diagram-s5` specs no longer refer to other tasks' specs. Op shapes, exports, `pendingOps` semantics and auth conventions are written out. Old `pm-s4` Sonnet runs (spec v1) moved to `results/runs_superseded_pm_s4_spec_v1/`.
- **Contamination guard:** the benchmark repository is public. `rtool` refuses to return, clone or fetch it. The contamination check scans tool inputs, tool outputs and GUI URLs for it.
- **Cost:** a cache-independent cost metric was added.
