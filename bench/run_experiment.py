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


def done(task, strat, trial):
    for rj in glob.glob(os.path.join(REPO, "results", "runs", f"{task}__{strat}__t{trial}__*", "run.json")):
        if not json.load(open(rj)).get("excluded"):
            return True
    return False


def one(task, strat, trial):
    """Run the trial and its evaluation in separate processes (no GIL coupling between concurrent trials)."""
    import subprocess
    t0 = time.time()
    p = subprocess.run([sys.executable, "-m", "harness.run_trial", task, strat, str(trial)], cwd=HERE, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr[-800:])
    info = json.loads(p.stdout.strip().splitlines()[-1])
    rid, out = info["run_id"], info["out"]
    e = subprocess.run([sys.executable, "-m", "harness.evaluate", out], cwd=HERE, capture_output=True, text=True, timeout=3600)
    if e.returncode:
        raise RuntimeError(f"evaluate failed for {rid}: {e.stderr[-800:]}")
    r = json.load(open(os.path.join(out, "run.json")))
    return {"run_id": rid, "minutes": round((time.time() - t0) / 60, 1), "pass": f"{r['hidden_pass']}/{r['hidden_tests']}",
            "loc": r["functional_loc"], "usd": r["inference_cost_usd"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--strategies", default="all")
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--first-trial", type=int, default=0)
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--seed", type=int, default=20261102)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    strats = STRATS if a.strategies == "all" else a.strategies.split(",")
    plan = [(t, s, k) for t in a.tasks.split(",") for s in strats for k in range(a.first_trial, a.first_trial + a.trials)]
    plan = [p for p in plan if not done(*p)]
    random.Random(a.seed).shuffle(plan)
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
            res.update(task=p[0], strategy=p[1], trial=p[2], ts=time.time())
            print(json.dumps(res), flush=True)
            with open(log, "a") as f:
                f.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
