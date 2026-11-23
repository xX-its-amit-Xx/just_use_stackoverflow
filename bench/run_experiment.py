"""Orchestrate a randomized set of trials.

Usage:
  python3 run_experiment.py --tasks calc-s1,todo-s1 --strategies all --trials 3 [--parallel 4] [--seed 1] [--dry-run]

Each (task, strategy, trial) runs in its own fresh workspace (no shared artifacts). Execution order is
shuffled with a recorded seed. Trials already present in results/runs/ (same task/strategy/trial with a
run.json) are skipped, so the script is resumable. Each finished run is evaluated immediately.
"""
import argparse
import glob
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

REPO = os.path.dirname(HERE)
STRATS = ["generate_first", "reuse_first", "hybrid", "gui_reuse_first"]


def done(task, strat, trial, model):
    for rj in glob.glob(os.path.join(REPO, "results", "runs", f"{task}__{strat}__*", "run.json")):
        r = json.load(open(rj))
        if r.get("model") == model and int(r.get("trial")) == trial and not r.get("excluded"):
            return True
    return False


import re
import shutil
import subprocess
import threading

LIMIT_RE = re.compile(r"hit your [^\"]{0,40}limit|usage limit|rate limit|overloaded|API Error", re.I)
_gate = threading.Lock()


def infra_failure(out):
    """A run that still ended on a provider interruption (after run_trial's own resume attempts) is not a trial outcome."""
    try:
        meta = json.load(open(os.path.join(out, "meta.json")))
    except Exception:
        return "no meta"
    hr = meta.get("harness_result") or {}
    if meta.get("final_limit_hit"):
        return "usage limit (unresolved after resumes)"
    if not hr:
        return None if meta.get("timed_out") else "no result record"
    if hr.get("is_error") and not (hr.get("total_cost_usd") or 0):
        return "error before any model call"
    return None


def wait_for_capacity():
    """Block (one prober at a time) until a 1-token probe call succeeds."""
    with _gate:
        while True:
            env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_EFFORT")}
            p = subprocess.run(["claude", "-p", "Reply with OK", "--model", "claude-haiku-5-5", "--output-format", "json", "--tools", "",
                                "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", ""], capture_output=True, text=True, env=env, timeout=300,
                               cwd="/tmp")
            try:
                ok = not json.loads(p.stdout).get("is_error")
            except Exception:
                ok = False
            if ok:
                return
            print(json.dumps({"event": "waiting_for_capacity", "ts": time.time(), "detail": p.stdout[-200:]}), flush=True)
            time.sleep(600)


def one(task, strat, trial, model):
    """Run the trial and its evaluation in separate processes. Provider-side interruptions are retried, never scored."""
    t0 = time.time()
    attempt = 0
    while True:
        attempt += 1
        p = subprocess.run([sys.executable, "-m", "harness.run_trial", task, strat, str(trial), model], cwd=HERE, capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(p.stderr[-800:])
        info = json.loads(p.stdout.strip().splitlines()[-1])
        rid, out = info["run_id"], info["out"]
        why = infra_failure(out)
        if not why:
            break
        shutil.rmtree(out, ignore_errors=True)
        with open(os.path.join(REPO, "results", "execution_log.jsonl"), "a") as f:
            f.write(json.dumps({"ts": time.time(), "event": "infra_retry", "run_id": rid, "reason": why, "attempt": attempt}) + "\n")
        if attempt >= 200:
            raise RuntimeError(f"gave up after {attempt} provider interruptions: {why}")
        wait_for_capacity()
    e = subprocess.run([sys.executable, "-m", "harness.evaluate", out], cwd=HERE, capture_output=True, text=True, timeout=3600)
    if e.returncode:
        raise RuntimeError(f"evaluate failed for {rid}: {e.stderr[-800:]}")
    r = json.load(open(os.path.join(out, "run.json")))
    final = os.path.join(REPO, "results", "runs", rid)
    if os.path.abspath(out) != final:
        shutil.move(out, final)
        sa = os.path.join(REPO, "results", ".inprogress_artifacts", rid)
        if os.path.isdir(sa):
            shutil.move(sa, os.path.join(REPO, "results", "artifacts", rid))
    return {"run_id": rid, "minutes": round((time.time() - t0) / 60, 1), "pass": f"{r['hidden_pass']}/{r['hidden_tests']}",
            "loc": r["functional_loc"], "usd": r["inference_cost_usd"], "attempts": attempt}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--strategies", default="all")
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--first-trial", type=int, default=0)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--seed", type=int, default=20261102)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--models", default="claude-sonnet-5-5")
    a = ap.parse_args()
    strats = STRATS if a.strategies == "all" else a.strategies.split(",")
    plan = [(t, s, k, m) for m in a.models.split(",") for t in a.tasks.split(",") for s in strats
            for k in range(a.first_trial, a.first_trial + a.trials)]
    plan = [p for p in plan if not done(*p)]
    # Randomized complete blocks: all cells of trial k (shuffled) before trial k+1, so the data set is
    # balanced across models/strategies/tasks at whatever point execution stops.
    rnd = random.Random(a.seed)
    rnd.shuffle(plan)
    plan.sort(key=lambda p: p[2])
    log = os.path.join(REPO, "results", "execution_log.jsonl")
    with open(log, "a") as f:
        f.write(json.dumps({"ts": time.time(), "event": "plan", "seed": a.seed, "order": plan}) + "\n")
    print(f"{len(plan)} trials, seed {a.seed}:", *plan, sep="\n  ")
    if a.dry_run:
        return
    with ThreadPoolExecutor(a.parallel) as ex:
        futs = {ex.submit(one, *p): p for p in plan}
        for fu in as_completed(futs):
            p = futs[fu]
            try:
                res = fu.result()
            except Exception as e:  # keep going; failures are recorded
                res = {"error": repr(e)[:500]}
            res.update(task=p[0], strategy=p[1], trial=p[2], model=p[3], ts=time.time())
            print(json.dumps(res), flush=True)
            with open(log, "a") as f:
                f.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
