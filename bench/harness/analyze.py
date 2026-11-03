"""Aggregate all processed runs into the results/ deliverables, statistics and plots.

Usage: python3 -m harness.analyze

Outputs (results/): events.jsonl, runs.csv, summary.csv, cost_by_action.csv, retrieval_efficiency.csv,
crossover_analysis.csv, cell_tests.csv, regression.csv, plots/*.png
All tables carry a `model` column; every analysis is done per model (and pooled where stated).
"""
import glob
import json
import math
import os
import random
import warnings
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RES = os.path.join(REPO, "results")
PLOTS = os.path.join(RES, "plots")
EXP = json.load(open(os.path.join(REPO, "bench", "config", "experiment.json")))
STRATS = ["generate_first", "reuse_first", "hybrid", "gui_reuse_first"]
REUSE = STRATS[1:]
MODELS = EXP.get("models", [EXP["model"]])
MTAG = EXP.get("model_tag", {})
LABEL = {"generate_first": "A generate-first", "reuse_first": "B reuse-first (API/shell)", "hybrid": "C hybrid", "gui_reuse_first": "D reuse-first (GUI)"}
COLOR = {"generate_first": "#2a78d6", "reuse_first": "#eb6834", "hybrid": "#1baf7a", "gui_reuse_first": "#eda100"}  # validated palette
MARK = {"generate_first": "o", "reuse_first": "s", "hybrid": "^", "gui_reuse_first": "D"}
TIER_ORDER = ["S1", "S2", "S3", "S4", "S5"]
METRICS = {"tokens": "total_tokens_incl_cache", "tokens_uncached": "total_tokens", "inference_usd": "inference_cost_usd",
           "inference_nocache_usd": "inference_cost_nocache_usd", "execution_usd": "total_execution_cost_usd", "wall_clock_s": "elapsed_s"}
RETR_ACTIONS = {"web_search", "github_search", "repository_inspection", "repository_clone", "snippet_retrieval", "file_copy", "computer_use", "screenshot"}
INK, MUTED, GRID = "#1f1f1e", "#6b6a63", "#e4e3dd"
N_BOOT = 1000


def style():
    plt.rcParams.update({"figure.dpi": 130, "axes.edgecolor": MUTED, "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED,
                         "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False, "axes.spines.right": False,
                         "font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold", "legend.frameon": False,
                         "figure.facecolor": "#fcfcfb", "axes.facecolor": "#fcfcfb", "lines.linewidth": 2})


def load():
    runs, events = [], []
    for rj in sorted(glob.glob(os.path.join(RES, "runs", "*", "run.json"))):
        r = json.load(open(rj))
        if r.get("excluded"):
            continue
        runs.append(r)
        ev = os.path.join(os.path.dirname(rj), "events.jsonl")
        if os.path.exists(ev):
            events += [json.loads(l) for l in open(ev)]
    return runs, events


def flatten(r):
    out = {k: v for k, v in r.items() if not isinstance(v, (dict, list))}
    for k, v in (r.get("retrieval") or {}).items():
        out[f"retr_{k}"] = v
    for k, v in (r.get("gui") or {}).items():
        out[f"gui_{k}"] = v
    q = r.get("quality") or {}
    out["security_findings"] = len(q.get("security_findings") or [])
    out["runtime_dependencies"] = len((q.get("dependencies") or {}).get("runtime_dependencies") or [])
    out["dependency_vulnerabilities"] = ((q.get("dependencies") or {}).get("audit") or {}).get("vulnerabilities")
    out["license_compliant"] = (q.get("license") or {}).get("compliant")
    out["license_issues"] = "; ".join((q.get("license") or {}).get("issues") or [])
    out["syntax_errors"] = len(q.get("syntax_errors") or [])
    out["contamination_flags"] = len(q.get("contamination") or [])
    out["human_interventions"] = q.get("human_interventions", 0)
    out["permission_denials"] = len(q.get("permission_denials") or [])
    out["permission_denials_code_from_external"] = sum(1 for d in (q.get("permission_denials") or []) if "External" in d.get("reason", ""))
    for k, v in (q.get("maintainability") or {}).items():
        out[f"maint_{k}"] = v
    for k, v in (r.get("protocol") or {}).items():
        out[f"protocol_{k}"] = v
    return out


def boot_mean_ci(xs, seed=7):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and math.isnan(x))]
    if len(xs) < 2:
        return (None, None)
    rnd = random.Random(seed)
    means = sorted(sum(rnd.choice(xs) for _ in xs) / len(xs) for _ in range(N_BOOT))
    return (means[int(0.025 * N_BOOT)], means[int(0.975 * N_BOOT) - 1])


def ratio_ci(num, den, seed=11):
    if len(num) < 2 or len(den) < 2:
        return (None, None)
    rnd = random.Random(seed)
    rs = []
    for _ in range(N_BOOT):
        a = sum(rnd.choice(num) for _ in num) / len(num)
        b = sum(rnd.choice(den) for _ in den) / len(den)
        if b > 0:
            rs.append(a / b)
    rs.sort()
    return (rs[int(0.025 * len(rs))], rs[int(0.975 * len(rs)) - 1]) if rs else (None, None)


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def holm(pvals):
    idx = sorted(range(len(pvals)), key=lambda i: pvals[i])
    adj = [None] * len(pvals)
    m = len(pvals)
    running = 0.0
    for rank, i in enumerate(idx):
        running = max(running, min(1.0, (m - rank) * pvals[i]))
        adj[i] = running
    return adj


# ---------------------------------------------------------------- regression
def fit_crossover(d, metric_col):
    """log(metric) ~ task FE + strategy + strategy:log(size). Returns per-strategy (beta, gamma, crossover)."""
    import statsmodels.formula.api as smf
    d = d[d[metric_col] > 0].copy()
    d["y"] = np.log(d[metric_col])
    d["ls"] = np.log(d["task_size_loc"])
    if d["task_id"].nunique() < 2 or d["strategy"].nunique() < 2:
        return None
    d["strategy"] = pd.Categorical(d["strategy"], categories=[s for s in STRATS if s in set(d["strategy"])])
    for s in REUSE:
        d[f"is_{s}"] = (d["strategy"] == s).astype(float)
        d[f"ls_{s}"] = d[f"is_{s}"] * (d["ls"] - d["ls"].mean())
    terms = [f"is_{s} + ls_{s}" for s in REUSE if d[f"is_{s}"].sum() > 0]
    m = smf.ols("y ~ C(task_id) + " + " + ".join(terms), data=d).fit(cov_type="HC3")
    out = {}
    for s in REUSE:
        if f"is_{s}" not in m.params:
            continue
        b, g = m.params[f"is_{s}"], m.params[f"ls_{s}"]
        cross = float(np.exp(d["ls"].mean() - b / g)) if g != 0 else None
        out[s] = {"beta_at_mean_size": b, "beta_se": m.bse[f"is_{s}"], "beta_p": m.pvalues[f"is_{s}"], "gamma_slope": g,
                  "gamma_se": m.bse[f"ls_{s}"], "gamma_p": m.pvalues[f"ls_{s}"], "crossover_loc": cross,
                  "ratio_at_mean_size": float(np.exp(b)), "mean_log_size": d["ls"].mean(), "n": int(m.nobs), "r2": m.rsquared}
    return out


def bootstrap_crossover(d, metric_col, seed=3, reps=200):
    rnd = np.random.default_rng(seed)
    cells = [g for _, g in d.groupby(["task_id", "strategy"])]
    res = defaultdict(list)
    for _ in range(reps):
        bd = pd.concat([g.iloc[rnd.integers(0, len(g), len(g))] for g in cells])
        f = fit_crossover(bd, metric_col)
        if not f:
            continue
        for s, v in f.items():
            res[s].append((v["crossover_loc"], v["gamma_slope"], v["ratio_at_mean_size"]))
    out = {}
    for s, vals in res.items():
        a = np.array([v for v in vals if v[0] is not None and np.isfinite(v[0])])
        if len(a) == 0:
            continue
        out[s] = {"crossover_ci_lo": float(np.percentile(a[:, 0], 2.5)), "crossover_ci_hi": float(np.percentile(a[:, 0], 97.5)),
                  "slope_ci_lo": float(np.percentile(a[:, 1], 2.5)), "slope_ci_hi": float(np.percentile(a[:, 1], 97.5)),
                  "share_boot_slope_negative": float((a[:, 1] < 0).mean()), "boot_reps": len(a)}
    return out


def main():
    style()
    os.makedirs(PLOTS, exist_ok=True)
    runs, events = load()
    if not runs:
        print("no processed runs")
        return
    with open(os.path.join(RES, "events.jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    df = pd.DataFrame([flatten(r) for r in runs])
    df["model_tag"] = df["model"].map(lambda m: MTAG.get(m, m))
    exp_tests = df.groupby("task_id")["hidden_tests"].transform("max")
    df["pass_rate"] = (df["hidden_pass"] / exp_tests.replace(0, np.nan)).fillna(0).clip(0, 1)
    thr = EXP["success_threshold"]
    df["success"] = df["pass_rate"] >= thr
    df["success_strict"] = df["pass_rate"] >= 1.0
    # task size: mean functional LOC of the generate-first implementations of that task, per model and pooled
    size_pooled = df[df.strategy == "generate_first"].groupby("task_id")["functional_loc"].mean()
    df["task_size_loc"] = df["task_id"].map(size_pooled)
    size_m = df[df.strategy == "generate_first"].groupby(["model", "task_id"])["functional_loc"].mean()
    df["task_size_loc_model"] = [size_m.get((m, t), np.nan) for m, t in zip(df.model, df.task_id)]
    for m, col in METRICS.items():
        df[f"{m}_per_pass"] = df[col] / df["pass_rate"].replace(0, np.nan)
    df = df.copy()
    df.to_csv(os.path.join(RES, "runs.csv"), index=False)

    # ---------- summary (model x task x strategy) ----------
    rows = []
    for (model, task, strat), g in df.groupby(["model", "task_id", "strategy"]):
        k = int(g["success"].sum())
        lo, hi = wilson(k, len(g))
        row = {"model": model, "task_id": task, "strategy": strat, "tier": g["tier"].iloc[0], "family": g["family"].iloc[0], "n_trials": len(g),
               "success_rate": g["success"].mean(), "success_ci95_lo": lo, "success_ci95_hi": hi, "strict_success_rate": g["success_strict"].mean(),
               "mean_pass_rate": g["pass_rate"].mean(), "mean_functional_loc": g["functional_loc"].mean(), "task_size_loc": g["task_size_loc"].iloc[0]}
        for col in ["total_tokens", "total_tokens_incl_cache", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_tokens",
                    "inference_cost_usd", "inference_cost_nocache_usd", "harness_reported_cost_usd", "total_execution_cost_usd", "elapsed_s",
                    "active_s", "model_invocations", "retr_external_fraction", "security_findings"]:
            if col in g:
                vals = g[col].astype(float).tolist()
                row[f"mean_{col}"] = float(np.mean(vals))
                row[f"sd_{col}"] = float(np.std(vals, ddof=1)) if len(vals) > 1 else None
                row[f"ci95_lo_{col}"], row[f"ci95_hi_{col}"] = boot_mean_ci(vals)
        rows.append(row)
    summ = pd.DataFrame(rows)
    summ["tier_rank"] = summ["tier"].map(TIER_ORDER.index)
    summ = summ.sort_values(["model", "tier_rank", "task_id", "strategy"]).drop(columns="tier_rank")
    summ.to_csv(os.path.join(RES, "summary.csv"), index=False)

    # ---------- events / cost by action ----------
    ev = pd.DataFrame(events)
    ev = ev.merge(df[["run_id", "tier", "family", "model_tag"]], on="run_id", how="left")
    ev["run_model"] = ev["run_id"].map(dict(zip(df.run_id, df.model)))
    ev["total_tokens_incl_cache"] = ev["input_tokens"] + ev["output_tokens"] + ev["cached_input_tokens"] + ev["cache_creation_tokens"]
    tokcols = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_tokens", "total_tokens_incl_cache", "estimated_cost_usd"]
    emit = ev.groupby(["run_model", "strategy", "tier", "action_type"]).agg(invocations=("event_id", "count"), **{c: (c, "sum") for c in tokcols}).reset_index()
    emit["attribution"] = "emitted_action"
    crow = []
    for e in ev.itertuples():
        kinds = e.consumed_action_types or (["task_prompt"] if e.step_number == 1 else ["no_tool_result"])
        if e.measurement_confidence == "actual_aggregate_unattributed":
            kinds = ["other"]
        w = 1 / len(kinds)
        for k in kinds:
            crow.append({"run_model": e.run_model, "strategy": e.strategy, "tier": e.tier, "action_type": k, "invocations": w,
                         **{c: getattr(e, c) * w for c in tokcols}})
    cons = pd.DataFrame(crow).groupby(["run_model", "strategy", "tier", "action_type"]).sum(numeric_only=True).reset_index()
    cons["attribution"] = "consumed_result"
    cba = pd.concat([emit, cons]).rename(columns={"run_model": "model"})
    cba["cost_share"] = cba["estimated_cost_usd"] / cba.groupby(["attribution", "model", "strategy", "tier"])["estimated_cost_usd"].transform("sum")
    cba.to_csv(os.path.join(RES, "cost_by_action.csv"), index=False)

    # ---------- retrieval efficiency ----------
    rcols = ["run_id", "model", "task_id", "family", "tier", "strategy", "trial", "functional_loc", "task_size_loc", "pass_rate",
             "inference_cost_usd"] + [c for c in df.columns if c.startswith("retr_") or c.startswith("gui_")]
    reff = df[rcols].copy()
    by = lambda mask: ev[mask].groupby("run_id")["estimated_cost_usd"].sum()
    reff["retrieval_cost_usd"] = reff["run_id"].map(by(ev["action_type"].isin(RETR_ACTIONS))).fillna(0)
    reff["integration_cost_usd"] = reff["run_id"].map(by(ev["action_type"].isin({"integration", "file_copy"}))).fillna(0)
    reff["debugging_cost_usd"] = reff["run_id"].map(by(ev["action_type"] == "debugging")).fillna(0)
    reff["retrieval_cost_share"] = reff["retrieval_cost_usd"] / reff["inference_cost_usd"].replace(0, np.nan)
    reff["debugging_cost_share"] = reff["debugging_cost_usd"] / reff["inference_cost_usd"].replace(0, np.nan)
    cons_run = defaultdict(float)
    for e in ev.itertuples():
        k = e.consumed_action_types or []
        if k:
            cons_run[e.run_id] += e.estimated_cost_usd * sum(1 for x in k if x in RETR_ACTIONS) / len(k)
    reff["retrieval_reading_cost_usd"] = reff["run_id"].map(cons_run).fillna(0)
    disc = (reff["retr_retrieved_loc_discarded"] / reff["retr_retrieved_loc"].replace(0, np.nan)).fillna(0)
    reff["irrelevant_reading_cost_usd_est"] = reff["retrieval_reading_cost_usd"] * disc
    reff["reused"] = reff["retr_external_fraction"] > 0.2
    reff.to_csv(os.path.join(RES, "retrieval_efficiency.csv"), index=False)

    # ---------- per-cell ratios + Welch tests on log cost ----------
    from scipy import stats
    cx, tests = [], []
    for (model, fam, tier, task), g in df.groupby(["model", "family", "tier", "task_id"]):
        base = g[g["strategy"] == "generate_first"]
        if base.empty:
            continue
        for strat in REUSE:
            s = g[g["strategy"] == strat]
            if s.empty:
                continue
            for m, col in METRICS.items():
                for qadj in (False, True):
                    c = f"{m}_per_pass" if qadj else col
                    num = s[c].replace([np.inf], np.nan).dropna().tolist()
                    den = base[c].replace([np.inf], np.nan).dropna().tolist()
                    r = (np.mean(num) / np.mean(den)) if num and den and np.mean(den) > 0 else None
                    lo, hi = ratio_ci(num, den)
                    p = None
                    if len(num) >= 2 and len(den) >= 2 and min(num + den) > 0:
                        p = float(stats.ttest_ind(np.log(num), np.log(den), equal_var=False).pvalue)
                    cx.append({"model": model, "family": fam, "tier": tier, "task_id": task, "strategy": strat, "metric": m, "quality_adjusted": qadj,
                               "reuse_mean": np.mean(num) if num else None, "generate_mean": np.mean(den) if den else None, "ratio": r,
                               "ratio_ci95_lo": lo, "ratio_ci95_hi": hi, "welch_p_logscale": p, "n_reuse": len(num), "n_generate": len(den),
                               "reuse_cheaper": (r < 1) if r is not None else None, "task_size_loc": g["task_size_loc"].iloc[0]})
    cxd = pd.DataFrame(cx)
    for (qadj, m), idx in cxd.groupby(["quality_adjusted", "metric"]).groups.items():
        ps = cxd.loc[idx, "welch_p_logscale"]
        ok = ps.notna()
        if ok.any():
            cxd.loc[ps[ok].index, "holm_p"] = holm(ps[ok].tolist())
    cxd["significant_holm_05"] = cxd["holm_p"] < 0.05

    # ---------- regression crossover (per model; pooled / markdown-only / non-markdown) ----------
    reg = []
    subsets = {"all_families": lambda d: d, "markdown_only": lambda d: d[d.family == "markdown"], "excluding_markdown": lambda d: d[d.family != "markdown"]}
    for model in sorted(df.model.unique()) + ["ALL_MODELS"]:
        dm = df if model == "ALL_MODELS" else df[df.model == model]
        for sname, sf in subsets.items():
            d = sf(dm)
            for m in ("inference_usd", "inference_nocache_usd", "tokens", "wall_clock_s"):
                col = METRICS[m]
                f = fit_crossover(d, col)
                if not f:
                    continue
                b = bootstrap_crossover(d, col) if m != "wall_clock_s" else {}
                lo_s, hi_s = d["task_size_loc"].min(), d["task_size_loc"].max()
                for s, v in f.items():
                    row = {"model": model, "subset": sname, "metric": m, "strategy": s, **v, **b.get(s, {}),
                           "observed_size_min": lo_s, "observed_size_max": hi_s}
                    cl = v["crossover_loc"]
                    row["crossover_within_observed_range"] = bool(cl and lo_s <= cl <= hi_s)
                    row["reading"] = ("ratio falls with size" if v["gamma_slope"] < 0 else "ratio rises with size") + \
                        ("" if v["gamma_p"] < 0.05 else " (slope not significant)")
                    reg.append(row)
    regd = pd.DataFrame(reg)
    regd.to_csv(os.path.join(RES, "regression.csv"), index=False)
    cxd.to_csv(os.path.join(RES, "crossover_analysis.csv"), index=False)
    cxd[(~cxd.quality_adjusted) & cxd.metric.isin(["inference_usd", "tokens", "wall_clock_s", "inference_nocache_usd"])].to_csv(os.path.join(RES, "cell_tests.csv"), index=False)

    plots(df, ev, reff, cxd)
    print(f"runs={len(df)} events={len(ev)} models={sorted(df.model.unique())} -> results/")


# ---------------------------------------------------------------- plots
def _scatter(ax, df, xcol, ycol, logy=True, legend=True):
    for s in STRATS:
        g = df[df["strategy"] == s]
        if g.empty:
            continue
        ax.scatter(g[xcol], g[ycol], s=22, marker=MARK[s], color=COLOR[s], edgecolor="#fcfcfb", linewidth=0.8, label=LABEL[s], zorder=3, alpha=0.85)
        m = g.groupby("task_id").agg(x=(xcol, "mean"), y=(ycol, "mean")).reset_index().sort_values("x")
        ax.plot(m["x"], m["y"], color=COLOR[s], alpha=0.85, zorder=2)
    ax.set_xscale("log")
    if logy:
        ax.set_yscale("log")
    if legend:
        ax.legend(loc="best", fontsize=7)


def _facet(df, ycol, title, ylabel, fname):
    models = [m for m in MODELS if m in set(df.model)]
    fig, axs = plt.subplots(1, len(models), figsize=(4.2 * len(models), 3.8), sharey=True, squeeze=False)
    for i, m in enumerate(models):
        ax = axs[0][i]
        _scatter(ax, df[df.model == m], "task_size_loc", ycol, legend=(i == 0))
        ax.set(title=f"{MTAG.get(m, m)}: {title}", xlabel="task size: generate-first functional LOC (log)")
        if i == 0:
            ax.set_ylabel(ylabel)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, fname)); plt.close(fig)


def plots(df, ev, reff, cxd):
    ok = df[df["task_size_loc"] > 0]
    _facet(ok, "inference_cost_usd", "inference cost", "weighted inference cost, USD (log)", "token_cost_vs_size.png")
    _facet(ok, "total_tokens_incl_cache", "total tokens", "input+cache+output tokens (log)", "total_tokens_vs_size.png")
    _facet(ok, "output_tokens", "output tokens", "output tokens (log)", "output_tokens_vs_size.png")
    _facet(ok.assign(fresh_input=ok["input_tokens"] + ok["cache_creation_tokens"]), "fresh_input", "uncached+cache-write input", "tokens (log)", "input_tokens_vs_size.png")
    _facet(ok, "cached_input_tokens", "cache-read input", "tokens (log)", "cached_input_tokens_vs_size.png")

    # integration cost vs retrieved LOC
    fig, ax = plt.subplots(figsize=(6, 4))
    r = reff[reff["strategy"] != "generate_first"]
    for s in REUSE:
        g = r[r["strategy"] == s]
        if not g.empty:
            ax.scatter(g["retr_retrieved_loc"].clip(lower=1), g["integration_cost_usd"].clip(lower=1e-4), s=22, marker=MARK[s], color=COLOR[s],
                       edgecolor="#fcfcfb", linewidth=0.8, label=LABEL[s], zorder=3, alpha=0.85)
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set(title="Integration + copy cost vs retrieved LOC (all models)", xlabel="lines of retrieved material (log)", ylabel="integration/copy cost, USD (log)")
    ax.legend(fontsize=7)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "integration_cost_vs_size.png")); plt.close(fig)

    # GUI vs shell per model: ratio D/B of total cost per task
    models = [m for m in MODELS if m in set(df.model)]
    tasks = sorted(df["task_id"].unique(), key=lambda t: df[df.task_id == t].task_size_loc.iloc[0])
    fig, axs = plt.subplots(1, 2, figsize=(11, 4))
    w = 0.8 / max(1, len(models))
    mcol = {"claude-haiku-5-5": "#1baf7a", "claude-sonnet-5-5": "#2a78d6", "claude-opus-5-5": "#eb6834"}
    for i, (col, title) in enumerate([("retrieval_cost_usd", "Retrieval-phase cost: GUI / API-shell"), ("inference_cost_usd", "Total inference cost: GUI / API-shell")]):
        ax = axs[i]
        x = np.arange(len(tasks))
        for j, m in enumerate(models):
            vals = []
            for t in tasks:
                b = reff[(reff.task_id == t) & (reff.strategy == "reuse_first") & (reff.model == m)][col].mean()
                d = reff[(reff.task_id == t) & (reff.strategy == "gui_reuse_first") & (reff.model == m)][col].mean()
                vals.append(d / b if b and b > 0 else np.nan)
            ax.bar(x + (j - (len(models) - 1) / 2) * w, np.nan_to_num(vals), width=w * 0.9, color=mcol.get(m, MUTED), label=MTAG.get(m, m), edgecolor="#fcfcfb", linewidth=1)
        ax.axhline(1, color=MUTED, linewidth=1, linestyle="--")
        ax.set_xticks(x, tasks, rotation=25); ax.set(title=title, ylabel="ratio D / B (mean of trials)"); ax.legend(fontsize=7); ax.grid(axis="x", visible=False)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "computer_use_vs_shell.png")); plt.close(fig)

    # success vs size per model
    fig, axs = plt.subplots(1, len(models), figsize=(4.2 * len(models), 3.6), sharey=True, squeeze=False)
    for i, m in enumerate(models):
        ax = axs[0][i]
        dm = df[df.model == m]
        tiers = [t for t in TIER_ORDER if t in set(dm["tier"])]
        x = np.arange(len(tiers))
        ww = 0.8 / len(STRATS)
        for j, s in enumerate(STRATS):
            vals = [dm[(dm.tier == t) & (dm.strategy == s)]["pass_rate"].mean() for t in tiers]
            ax.bar(x + (j - 1.5) * ww, np.nan_to_num(vals), width=ww * 0.92, color=COLOR[s], label=LABEL[s], edgecolor="#fcfcfb", linewidth=1)
        ax.axhline(EXP["success_threshold"], color=MUTED, linewidth=1, linestyle="--")
        ax.set_xticks(x, tiers); ax.set(title=f"{MTAG.get(m, m)}: hidden-suite pass rate", ylim=(0, 1.08)); ax.grid(axis="x", visible=False)
        if i == 0:
            ax.set_ylabel("mean pass rate"); ax.legend(fontsize=6.5, loc="lower left")
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "success_vs_size.png")); plt.close(fig)

    # output-token savings vs input overhead, per model
    fig, axs = plt.subplots(1, len(models), figsize=(4.2 * len(models), 3.8), squeeze=False)
    for i, m in enumerate(models):
        ax = axs[0][i]
        dm = df[df.model == m]
        for s in REUSE:
            pts = []
            for t in tasks:
                a = dm[(dm.task_id == t) & (dm.strategy == "generate_first")]
                b = dm[(dm.task_id == t) & (dm.strategy == s)]
                if a.empty or b.empty:
                    continue
                inp = lambda z: (z["input_tokens"] + z["cache_creation_tokens"] + z["cached_input_tokens"]).mean()
                pts.append((inp(b) - inp(a), a["output_tokens"].mean() - b["output_tokens"].mean()))
            if pts:
                ax.scatter([p[0] for p in pts], [p[1] for p in pts], s=30, marker=MARK[s], color=COLOR[s], edgecolor="#fcfcfb", linewidth=1, label=LABEL[s], zorder=3)
        ax.axhline(0, color=MUTED, linewidth=1); ax.axvline(0, color=MUTED, linewidth=1)
        ax.set(title=f"{MTAG.get(m, m)}: output saved vs input added", xlabel="extra input tokens incl. cache (reuse − generate)")
        if i == 0:
            ax.set_ylabel("output tokens saved (generate − reuse)"); ax.legend(fontsize=6.5)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "output_savings_vs_input_overhead.png")); plt.close(fig)

    # model comparison: geometric-mean cost ratio vs generate-first per tier, per model and strategy
    c = cxd[(~cxd.quality_adjusted) & (cxd.metric == "inference_usd") & cxd.ratio.notna()]
    if not c.empty:
        fig, axs = plt.subplots(1, 3, figsize=(12, 3.8), sharey=True)
        for i, s in enumerate(REUSE):
            ax = axs[i]
            for m in models:
                g = c[(c.strategy == s) & (c.model == m)].groupby("task_id").agg(r=("ratio", "first"), x=("task_size_loc", "first")).reset_index().sort_values("x")
                if not g.empty:
                    ax.plot(g["x"], g["r"], marker="o", markersize=5, color=mcol.get(m, MUTED), label=MTAG.get(m, m))
            ax.axhline(1, color=MUTED, linewidth=1, linestyle="--")
            ax.set_xscale("log"); ax.set_yscale("log")
            ax.set(title=f"{LABEL[s]} / generate-first", xlabel="task size (log)")
            if i == 0:
                ax.set_ylabel("inference-cost ratio (log)"); ax.legend(fontsize=7)
        fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "model_comparison_ratios.png")); plt.close(fig)


if __name__ == "__main__":
    main()
