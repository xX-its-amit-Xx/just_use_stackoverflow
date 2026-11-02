"""Aggregate all processed runs into the results/ deliverables and plots.

Usage: python3 -m harness.analyze
"""
import glob
import json
import math
import os
import random
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RES = os.path.join(REPO, "results")
PLOTS = os.path.join(RES, "plots")
EXP = json.load(open(os.path.join(REPO, "bench", "config", "experiment.json")))
STRATS = ["generate_first", "reuse_first", "hybrid", "gui_reuse_first"]
LABEL = {"generate_first": "A generate-first", "reuse_first": "B reuse-first (API/shell)", "hybrid": "C hybrid", "gui_reuse_first": "D reuse-first (GUI)"}
COLOR = {"generate_first": "#2a78d6", "reuse_first": "#eb6834", "hybrid": "#1baf7a", "gui_reuse_first": "#eda100"}  # validated palette
MARK = {"generate_first": "o", "reuse_first": "s", "hybrid": "^", "gui_reuse_first": "D"}
TIER_ORDER = ["S1", "S2", "S3", "S4", "S5"]
METRICS = {"tokens": "total_tokens_incl_cache", "tokens_uncached": "total_tokens", "inference_usd": "inference_cost_usd",
           "execution_usd": "total_execution_cost_usd", "wall_clock_s": "elapsed_s"}
INK, MUTED, GRID = "#1f1f1e", "#6b6a63", "#e4e3dd"


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
    for k, v in (r.get("protocol") or {}).items():
        out[f"protocol_{k}"] = v
    for k, v in (q.get("maintainability") or {}).items():
        out[f"maint_{k}"] = v
    return out


def ci95(xs, n_boot=2000, seed=7):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and math.isnan(x))]
    if len(xs) < 2:
        return (None, None)
    rnd = random.Random(seed)
    means = sorted(sum(rnd.choice(xs) for _ in xs) / len(xs) for _ in range(n_boot))
    return (means[int(0.025 * n_boot)], means[int(0.975 * n_boot) - 1])


def ratio_ci(num, den, n_boot=2000, seed=11):
    if len(num) < 2 or len(den) < 2:
        return (None, None)
    rnd = random.Random(seed)
    rs = []
    for _ in range(n_boot):
        a = sum(rnd.choice(num) for _ in num) / len(num)
        b = sum(rnd.choice(den) for _ in den) / len(den)
        if b > 0:
            rs.append(a / b)
    rs.sort()
    return (rs[int(0.025 * len(rs))], rs[int(0.975 * len(rs)) - 1]) if rs else (None, None)


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
    # expected hidden test count per task = max observed (a crashed suite reports fewer)
    exp_tests = df.groupby("task_id")["hidden_tests"].transform("max")
    df["pass_rate"] = (df["hidden_pass"] / exp_tests.replace(0, np.nan)).fillna(0).clip(0, 1)
    thr = EXP["success_threshold"]
    df["success"] = df["pass_rate"] >= thr
    df["success_strict"] = df["pass_rate"] >= 1.0
    for m, col in METRICS.items():
        df[f"{m}_per_pass"] = df[col] / df["pass_rate"].replace(0, np.nan)  # quality-adjusted (inf/NaN when nothing passes)
    df.to_csv(os.path.join(RES, "runs.csv"), index=False)

    # ---------- summary ----------
    rows = []
    for (task, strat), g in df.groupby(["task_id", "strategy"]):
        row = {"task_id": task, "strategy": strat, "tier": g["tier"].iloc[0], "family": g["family"].iloc[0], "n_trials": len(g),
               "success_rate": g["success"].mean(), "strict_success_rate": g["success_strict"].mean(), "mean_pass_rate": g["pass_rate"].mean(),
               "mean_functional_loc": g["functional_loc"].mean()}
        for col in ["total_tokens", "total_tokens_incl_cache", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_tokens",
                    "inference_cost_usd", "harness_reported_cost_usd", "total_execution_cost_usd", "elapsed_s", "active_s", "model_invocations",
                    "retr_external_fraction", "security_findings"]:
            if col in g:
                vals = g[col].astype(float).tolist()
                row[f"mean_{col}"] = float(np.mean(vals))
                row[f"sd_{col}"] = float(np.std(vals, ddof=1)) if len(vals) > 1 else None
                lo, hi = ci95(vals)
                row[f"ci95_lo_{col}"], row[f"ci95_hi_{col}"] = lo, hi
        rows.append(row)
    summ = pd.DataFrame(rows)
    summ["tier_rank"] = summ["tier"].map(TIER_ORDER.index)
    summ = summ.sort_values(["tier_rank", "task_id", "strategy"]).drop(columns="tier_rank")
    summ.to_csv(os.path.join(RES, "summary.csv"), index=False)

    # ---------- cost by action ----------
    ev = pd.DataFrame(events)
    ev = ev.merge(df[["run_id", "tier", "family"]], on="run_id", how="left")
    ev["total_tokens_incl_cache"] = ev["input_tokens"] + ev["output_tokens"] + ev["cached_input_tokens"] + ev["cache_creation_tokens"]
    agg_cols = {"event_id": "count", "input_tokens": "sum", "output_tokens": "sum", "cached_input_tokens": "sum", "cache_creation_tokens": "sum",
                "total_tokens_incl_cache": "sum", "estimated_cost_usd": "sum"}
    emit = ev.groupby(["strategy", "tier", "action_type"]).agg(agg_cols).rename(columns={"event_id": "invocations"}).reset_index()
    emit["attribution"] = "emitted_action"
    # consume view: split each invocation's tokens equally over the result types it consumed (first invocation -> 'task_prompt')
    crow = []
    for _, e in ev.iterrows():
        kinds = e["consumed_action_types"] or (["task_prompt"] if e["step_number"] == 1 else ["no_tool_result"])
        if e["measurement_confidence"] == "actual_aggregate_unattributed":
            kinds = ["other"]
        w = 1 / len(kinds)
        for k in kinds:
            crow.append({"strategy": e["strategy"], "tier": e["tier"], "action_type": k, "invocations": w,
                         **{c: e[c] * w for c in ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_tokens", "total_tokens_incl_cache", "estimated_cost_usd"]}})
    cons = pd.DataFrame(crow).groupby(["strategy", "tier", "action_type"]).sum(numeric_only=True).reset_index()
    cons["attribution"] = "consumed_result"
    cba = pd.concat([emit, cons])
    tot = cba.groupby(["attribution", "strategy", "tier"])["estimated_cost_usd"].transform("sum")
    cba["cost_share"] = cba["estimated_cost_usd"] / tot
    cba.to_csv(os.path.join(RES, "cost_by_action.csv"), index=False)

    # ---------- retrieval efficiency ----------
    rcols = ["run_id", "task_id", "family", "tier", "strategy", "trial", "functional_loc", "pass_rate", "inference_cost_usd"] + \
        [c for c in df.columns if c.startswith("retr_") or c.startswith("gui_")]
    reff = df[rcols].copy()
    retr_actions = {"web_search", "github_search", "repository_inspection", "repository_clone", "snippet_retrieval", "file_copy", "computer_use", "screenshot"}
    rc = ev[ev["action_type"].isin(retr_actions)].groupby("run_id")["estimated_cost_usd"].sum()
    ic = ev[ev["action_type"].isin({"integration", "file_copy"})].groupby("run_id")["estimated_cost_usd"].sum()
    dbg = ev[ev["action_type"] == "debugging"].groupby("run_id")["estimated_cost_usd"].sum()
    reff["retrieval_cost_usd"] = reff["run_id"].map(rc).fillna(0)
    reff["integration_cost_usd"] = reff["run_id"].map(ic).fillna(0)
    reff["debugging_cost_usd"] = reff["run_id"].map(dbg).fillna(0)
    reff["retrieval_cost_share"] = reff["retrieval_cost_usd"] / reff["inference_cost_usd"].replace(0, np.nan)
    reff["debugging_cost_share"] = reff["debugging_cost_usd"] / reff["inference_cost_usd"].replace(0, np.nan)
    # irrelevant-reading cost: consume-attributed cost of retrieval results, scaled by the share of retrieved lines discarded
    cons_run = defaultdict(float)
    for _, e in ev.iterrows():
        k = e["consumed_action_types"] or []
        if k:
            cons_run[e["run_id"]] += e["estimated_cost_usd"] * sum(1 for x in k if x in retr_actions) / len(k)
    reff["retrieval_reading_cost_usd"] = reff["run_id"].map(cons_run).fillna(0)
    disc_share = (reff["retr_retrieved_loc_discarded"] / reff["retr_retrieved_loc"].replace(0, np.nan)).fillna(0)
    reff["irrelevant_reading_cost_usd_est"] = reff["retrieval_reading_cost_usd"] * disc_share
    reff.to_csv(os.path.join(RES, "retrieval_efficiency.csv"), index=False)

    # ---------- crossover ----------
    cx = []
    for (fam, tier, task), g in df.groupby(["family", "tier", "task_id"]):
        base = g[g["strategy"] == "generate_first"]
        if base.empty:
            continue
        for strat in STRATS[1:]:
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
                    cx.append({"family": fam, "tier": tier, "task_id": task, "strategy": strat, "metric": m, "quality_adjusted": qadj,
                               "reuse_mean": np.mean(num) if num else None, "generate_mean": np.mean(den) if den else None,
                               "ratio": r, "ratio_ci95_lo": lo, "ratio_ci95_hi": hi, "n_reuse": len(num), "n_generate": len(den),
                               "reuse_cheaper": (r < 1) if r is not None else None,
                               "functional_loc_generate": base["functional_loc"].mean(), "functional_loc_reuse": s["functional_loc"].mean()})
    cxd = pd.DataFrame(cx)
    # crossover size: log-linear fit of ratio vs generate-first functional LOC, pooled across families, per strategy & metric
    fits = []
    if not cxd.empty:
        for (strat, m, q), g in cxd.dropna(subset=["ratio"]).groupby(["strategy", "metric", "quality_adjusted"]):
            g = g[g["ratio"] > 0]
            if g["functional_loc_generate"].nunique() >= 2:
                x, y = np.log10(g["functional_loc_generate"]), np.log10(g["ratio"])
                b, a = np.polyfit(x, y, 1)
                cross = 10 ** (-a / b) if b != 0 else None
                lo, hi = g["functional_loc_generate"].min(), g["functional_loc_generate"].max()
                fits.append({"family": "ALL (log-log fit)", "tier": "fit", "task_id": "", "strategy": strat, "metric": m, "quality_adjusted": q,
                             "ratio": None, "fit_slope": b, "fit_intercept": a, "n_points": len(g),
                             "crossover_loc_estimate": cross,
                             "crossover_within_observed_range": bool(cross and lo <= cross <= hi),
                             "interpretation": ("reuse gets relatively cheaper as size grows" if b < 0 else "reuse gets relatively more expensive as size grows")})
    cxd = pd.concat([cxd, pd.DataFrame(fits)], ignore_index=True)
    cxd.to_csv(os.path.join(RES, "crossover_analysis.csv"), index=False)

    plots(df, ev, reff)
    print(f"runs={len(df)} events={len(ev)} -> results/")


def _scatter(ax, df, xcol, ycol, logy=True):
    for s in STRATS:
        g = df[df["strategy"] == s]
        if g.empty:
            continue
        ax.scatter(g[xcol], g[ycol], s=36, marker=MARK[s], color=COLOR[s], edgecolor="#fcfcfb", linewidth=1.2, label=LABEL[s], zorder=3)
        m = g.groupby("tier").agg(x=(xcol, "mean"), y=(ycol, "mean")).reset_index()
        m["r"] = m["tier"].map(TIER_ORDER.index)
        m = m.sort_values("r")
        ax.plot(m["x"], m["y"], color=COLOR[s], alpha=0.8, zorder=2)
    ax.set_xscale("log")
    if logy:
        ax.set_yscale("log")
    ax.legend(loc="best", fontsize=8)


def plots(df, ev, reff):
    ok = df[df["functional_loc"] > 0]
    # 1 weighted cost vs size
    fig, axs = plt.subplots(1, 2, figsize=(10, 4))
    _scatter(axs[0], ok, "functional_loc", "inference_cost_usd")
    axs[0].set(title="Weighted inference cost vs implementation size", xlabel="functional LOC of final implementation (log)", ylabel="inference cost, USD (log)")
    _scatter(axs[1], ok, "functional_loc", "total_tokens_incl_cache")
    axs[1].set(title="Total tokens processed vs size", xlabel="functional LOC (log)", ylabel="input+cache+output tokens (log)")
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "token_cost_vs_size.png")); plt.close(fig)
    # 2 output tokens
    fig, ax = plt.subplots(figsize=(6, 4))
    _scatter(ax, ok, "functional_loc", "output_tokens")
    ax.set(title="Output tokens vs implementation size", xlabel="functional LOC (log)", ylabel="output tokens (log)")
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "output_tokens_vs_size.png")); plt.close(fig)
    # 3 input tokens: uncached+cache-write vs cache-read, two panels (one axis each)
    d = ok.assign(fresh_input=ok["input_tokens"] + ok["cache_creation_tokens"])
    fig, axs = plt.subplots(1, 2, figsize=(10, 4))
    _scatter(axs[0], d, "functional_loc", "fresh_input")
    axs[0].set(title="Uncached + cache-write input tokens", xlabel="functional LOC (log)", ylabel="tokens (log)")
    _scatter(axs[1], d, "functional_loc", "cached_input_tokens")
    axs[1].set(title="Cache-read input tokens", xlabel="functional LOC (log)", ylabel="tokens (log)")
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "input_tokens_vs_size.png")); plt.close(fig)
    # 4 integration cost vs retrieved LOC
    fig, ax = plt.subplots(figsize=(6, 4))
    r = reff[reff["strategy"] != "generate_first"]
    for s in STRATS[1:]:
        g = r[r["strategy"] == s]
        if not g.empty:
            ax.scatter(g["retr_retrieved_loc"].clip(lower=1), g["integration_cost_usd"].clip(lower=1e-4), s=36, marker=MARK[s], color=COLOR[s],
                       edgecolor="#fcfcfb", linewidth=1.2, label=LABEL[s], zorder=3)
    ax.set_xscale("log"); ax.set_yscale("log")
    ax.set(title="Integration + copy cost vs retrieved LOC", xlabel="lines of retrieved material (log)", ylabel="integration/copy inference cost, USD (log)")
    ax.legend(fontsize=8)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "integration_cost_vs_size.png")); plt.close(fig)
    # 5 computer use vs shell: per task, mean retrieval cost and total cost, B vs D (grouped bars)
    fig, axs = plt.subplots(1, 2, figsize=(10, 4))
    tasks = sorted(df["task_id"].unique(), key=lambda t: (TIER_ORDER.index(df[df.task_id == t].tier.iloc[0]), t))
    x = np.arange(len(tasks))
    for i, (col, title) in enumerate([("retrieval_cost_usd", "Retrieval-phase inference cost"), ("inference_cost_usd", "Total inference cost")]):
        ax = axs[i]
        for j, s in enumerate(["reuse_first", "gui_reuse_first"]):
            vals = [reff[(reff.task_id == t) & (reff.strategy == s)][col].mean() for t in tasks]
            ax.bar(x + (j - 0.5) * 0.38, np.nan_to_num(vals), width=0.36, color=COLOR[s], label=LABEL[s], edgecolor="#fcfcfb", linewidth=2)
        ax.set_xticks(x, tasks, rotation=20); ax.set(title=f"{title}: GUI vs API/shell", ylabel="USD (mean of trials)")
        ax.legend(fontsize=8); ax.grid(axis="x", visible=False)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "computer_use_vs_shell.png")); plt.close(fig)
    # 6 success vs size
    fig, ax = plt.subplots(figsize=(6, 4))
    tiers = [t for t in TIER_ORDER if t in set(df["tier"])]
    x = np.arange(len(tiers))
    w = 0.8 / len(STRATS)
    for j, s in enumerate(STRATS):
        vals = [df[(df.tier == t) & (df.strategy == s)]["pass_rate"].mean() for t in tiers]
        ax.bar(x + (j - 1.5) * w, np.nan_to_num(vals), width=w * 0.92, color=COLOR[s], label=LABEL[s], edgecolor="#fcfcfb", linewidth=1)
    ax.axhline(EXP["success_threshold"], color=MUTED, linewidth=1, linestyle="--")
    ax.text(len(tiers) - 0.5, EXP["success_threshold"] + 0.01, f"success threshold {EXP['success_threshold']:.0%}", color=MUTED, ha="right", fontsize=8)
    ax.set_xticks(x, tiers); ax.set(title="Hidden-suite pass rate by size tier", ylabel="mean pass rate", ylim=(0, 1.08)); ax.grid(axis="x", visible=False)
    ax.legend(fontsize=7, loc="lower left")
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "success_vs_size.png")); plt.close(fig)
    # 7 output-token savings vs input-token overhead (relative to generate-first, per task)
    fig, ax = plt.subplots(figsize=(6, 4))
    for s in STRATS[1:]:
        pts = []
        for t in tasks:
            a = df[(df.task_id == t) & (df.strategy == "generate_first")]
            b = df[(df.task_id == t) & (df.strategy == s)]
            if a.empty or b.empty:
                continue
            pts.append(((b["input_tokens"] + b["cache_creation_tokens"] + b["cached_input_tokens"]).mean() - (a["input_tokens"] + a["cache_creation_tokens"] + a["cached_input_tokens"]).mean(),
                        a["output_tokens"].mean() - b["output_tokens"].mean(), t))
        if pts:
            ax.scatter([p[0] for p in pts], [p[1] for p in pts], s=40, marker=MARK[s], color=COLOR[s], edgecolor="#fcfcfb", linewidth=1.2, label=LABEL[s], zorder=3)
            for p in pts:
                ax.annotate(p[2], (p[0], p[1]), fontsize=6.5, color=MUTED, xytext=(4, 3), textcoords="offset points")
    ax.axhline(0, color=MUTED, linewidth=1); ax.axvline(0, color=MUTED, linewidth=1)
    ax.set(title="Output-token savings vs input-token overhead\n(relative to generate-first, same task)", xlabel="extra input tokens incl. cache (reuse − generate)",
           ylabel="output tokens saved (generate − reuse)")
    ax.legend(fontsize=7)
    fig.tight_layout(); fig.savefig(os.path.join(PLOTS, "output_savings_vs_input_overhead.png")); plt.close(fig)


if __name__ == "__main__":
    main()
