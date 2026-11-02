# lazy-agent-experiment: size-dependent retrieval economics

A controlled benchmark for one question: **at what implementation size does reuse-first software development (search, clone, copy, adapt) become cheaper for an LLM coding agent than generating the code?**

Every model invocation the agent makes is recorded with **provider-reported token usage**. Each invocation is attributed to the action that triggered it (search, clone, snippet retrieval, code generation, integration, debugging, GUI interaction, and so on). Every deliverable is graded by the same hidden test suite.

- Results: [`results/report.md`](results/report.md) (generated) and the CSVs and plots in [`results/`](results/)
- Methods, definitions and caveats: [`docs/METHODS.md`](docs/METHODS.md)

## Layout

```
bench/
  config/experiment.json    frozen agent config (model, effort, tools per strategy, budgets)
  config/pricing.json       per-model prices (from the live Anthropic pricing page)
  prompts/                  common rules + one prompt per strategy (A generate, B reuse, C hybrid, D GUI reuse)
  tasks/<task>/             task.json, template/ (SPEC.md, public smoke tests), hidden/ (evaluation suite)
  tools/rtool               logged retrieval CLI (GitHub/StackOverflow/npm search, clone, fetch)
  tools/gui, gui_daemon.js  screenshot-driven Chromium browser for the GUI condition (logged)
  harness/run_trial.py      one isolated trial -> raw stream, transcript, tool logs
  harness/telemetry.py      transcript -> per-invocation events (actual usage), reconciliation
  harness/provenance.py     retrieved-vs-generated line attribution
  harness/evaluate.py       hidden tests, security/deps/licence/maintainability, run metrics
  harness/analyze.py        CSVs + plots;  harness/report.py -> results/report.md
  run_experiment.py         randomized, resumable, parallel orchestration
results/
  events.jsonl runs.csv summary.csv cost_by_action.csv retrieval_efficiency.csv crossover_analysis.csv
  plots/*.png  report.md  runs/<run_id>/ (raw, sanitized logs)  artifacts/<run_id>/ (deliverables)
```

## Tasks

| tier | target LOC | task | family | executed in pilot |
|---|---|---|---|---|
| S1 | 100–300 | `calc-s1` arithmetic evaluator + CLI | calculator | yes |
| S1 | 100–300 | `todo-s1` todo library + CLI | todo | yes |
| S2 | 500–1,000 | `calc-s2` scientific calculator, variables, user functions, REPL | calculator | yes |
| S2 | 500–1,000 | `markdown-s2` safe CommonMark+GFM renderer, TOC/slugs, CLI | markdown | yes |
| S3 | 2,000–5,000 | `kanban-s3` multi-user Kanban REST service + SPA | kanban | yes |
| S4 | 10,000–20,000 | `pm-s4` Jira-like project manager (workflows, sprints, search DSL, webhooks, CSV) | kanban | see report |
| S5 | 30,000–50,000 | `diagram-s5` collaborative diagram editor (routing, layout, CRDT, draw.io import) | diagram | specified only |

## Reproduce

```bash
cd bench
python3 run_experiment.py --tasks calc-s1,todo-s1,calc-s2,markdown-s2,kanban-s3 --trials 3 --parallel 6
python3 -m harness.analyze
python3 -m harness.report
```

Requirements: Claude Code CLI (`claude`) authenticated, Node.js 22, Python 3.11+ with pandas and matplotlib, `gh` (GitHub search), and Playwright with Chromium (GUI condition). Each run starts from a fresh copy of `tasks/<task>/template`; nothing is shared between trials.
