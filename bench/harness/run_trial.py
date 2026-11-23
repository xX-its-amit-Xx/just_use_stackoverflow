"""Run one (task, strategy, trial) in a clean workspace and preserve all raw telemetry.

Usage: python3 -m harness.run_trial <task_id> <strategy> <trial> [--runs-root DIR]

Outputs (results/runs/<run_id>/):
  meta.json           frozen configuration + timings + harness result summary
  stream.jsonl        raw `claude -p --output-format stream-json` output
  transcript.jsonl    the agent's session transcript (per-API-message provider usage lives here)
  retrieval.jsonl     rtool log (if any), gui.jsonl  GUI action log (if any)
  stderr.txt
"""
import json
import re
import os
import shutil
import subprocess
import sys
import time
import uuid
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
REPO = os.path.dirname(BENCH)
EXP = json.load(open(os.path.join(BENCH, "config", "experiment.json")))
LEAKY_ENV = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
             "CLAUDE_ADDITIONAL_DIRECTORIES", "CLAUDE_AFTER_LAST_COMPACT", "CLAUDE_EFFORT"]


def default_runs_root():
    return os.environ.get("BENCH_WORK_ROOT", os.path.join("/tmp", "lazy-agent-work"))


def build_workspace(task_id, strategy, ws):
    tdir = os.path.join(BENCH, "tasks", task_id)
    shutil.copytree(os.path.join(tdir, "template"), ws)
    with open(os.path.join(ws, "PROVENANCE.json"), "w") as f:
        f.write("[]\n")
    bindir = os.path.join(os.path.dirname(ws), "bin")
    os.makedirs(bindir, exist_ok=True)
    for tool in EXP["strategies"][strategy]["env_tools"]:
        os.symlink(os.path.join(BENCH, "tools", tool), os.path.join(bindir, tool))
    return bindir


def system_prompt(strategy):
    common = open(os.path.join(BENCH, "prompts", "common.md")).read()
    strat = open(os.path.join(BENCH, "prompts", f"{strategy}.md")).read()
    return common + "\n" + strat


def protocol_sha(task_id, strategy):
    import hashlib
    h = hashlib.sha256()
    for root in (os.path.join(BENCH, "prompts"), os.path.join(BENCH, "tasks", task_id), os.path.join(BENCH, "tools"), os.path.join(BENCH, "config")):
        for d, _, fs in sorted(os.walk(root)):
            for f in sorted(fs):
                h.update(f.encode()); h.update(open(os.path.join(d, f), "rb").read())
    return h.hexdigest()[:16]


LIMIT_RE = re.compile(r"hit your [^\"]{0,40}limit|usage limit|rate limit|overloaded", re.I)


def wait_for_capacity(env):
    """Poll with a 1-token call until the provider accepts requests again."""
    while True:
        p = subprocess.run(["claude", "-p", "Reply with OK", "--model", "claude-haiku-5-5", "--output-format", "json", "--tools", "",
                            "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", ""],
                           capture_output=True, text=True, env=env, timeout=300, cwd="/tmp")
        try:
            if not json.loads(p.stdout).get("is_error"):
                return
        except Exception:
            pass
        time.sleep(600)


def find_transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def run(task_id, strategy, trial, runs_root=None, model=None):
    task = json.load(open(os.path.join(BENCH, "tasks", task_id, "task.json")))
    tier = task["tier"]
    model = model or EXP["model"]
    tag = EXP.get("model_tag", {}).get(model, model)
    run_id = f"{task_id}__{strategy}__{tag}__t{trial}__{time.strftime('%Y%m%dT%H%M%S')}"
    budget = EXP.get("max_budget_usd_by_model", {}).get(model, EXP["max_budget_usd"])[tier]
    work = os.path.join(runs_root or default_runs_root(), run_id)
    ws = os.path.join(work, "ws")
    os.makedirs(work)
    bindir = build_workspace(task_id, strategy, ws)
    # in-progress runs live in a gitignored staging area; the orchestrator moves them to results/runs after evaluation
    out = os.path.join(REPO, "results", ".inprogress", run_id)
    os.makedirs(out)
    session_id = str(uuid.uuid4())
    tel = os.path.join(ws, ".telemetry")

    env = {k: v for k, v in os.environ.items() if k not in LEAKY_ENV}
    env["PATH"] = bindir + os.pathsep + env["PATH"]
    env["BENCH_TELEMETRY_DIR"] = tel
    env["GUI_WORKSPACE"] = ws
    if strategy == "gui_reuse_first":
        npm_root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
        env["NODE_PATH"] = npm_root

    cmd = ["claude", "-p", "Implement the application specified in SPEC.md, following the benchmark rules in your instructions.",
           "--output-format", "stream-json", "--verbose",
           "--model", model, "--effort", EXP["effort"],
           "--session-id", session_id,
           "--tools", ",".join(EXP["strategies"][strategy]["tools"]),
           "--append-system-prompt", system_prompt(strategy),
           "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "",
           "--permission-mode", EXP["permission_mode"],
           "--max-budget-usd", str(budget)]
    meta = {"run_id": run_id, "task_id": task_id, "strategy": strategy, "trial": trial, "tier": tier,
            "family": task["family"], "model": model, "effort": EXP["effort"], "session_id": session_id,
            "workspace": ws, "cmd": [c if len(c) < 300 else c[:80] + "...<system prompt>" for c in cmd],
            "claude_code_version": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
            "max_budget_usd": budget, "max_wall_clock_s": EXP["max_wall_clock_s"][tier],
            "protocol_sha": protocol_sha(task_id, strategy)}
    t_assign = time.time()
    meta["t_assigned"] = t_assign
    # A provider usage limit can interrupt a run. Instead of discarding the work, wait for capacity and resume the
    # same session (same transcript, so per-message telemetry stays complete). Waiting time is excluded from the
    # run's elapsed time; resumed runs are flagged (`segments` > 1) for sensitivity analysis.
    limit_s = EXP["max_wall_clock_s"][tier]
    segments, active, timed_out = [], 0.0, False
    stream_path = os.path.join(out, "stream.jsonl")
    open(stream_path, "w").close()
    seg_cmd = cmd
    while True:
        t0 = time.time()
        with open(stream_path, "a") as so, open(os.path.join(out, "stderr.txt"), "a") as se:
            p = subprocess.Popen(seg_cmd, cwd=ws, env=env, stdout=so, stderr=se, stdin=subprocess.DEVNULL)
            try:
                p.wait(timeout=max(60, limit_s - active))
            except subprocess.TimeoutExpired:
                timed_out = True
                p.kill()
                p.wait()
        dt = time.time() - t0
        active += dt
        result = None
        for line in open(stream_path):
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") == "result":
                result = d
        limited = bool(result) and LIMIT_RE.search(json.dumps(result.get("result") or "")) is not None
        segments.append({"started": t0, "seconds": round(dt, 2), "exit_code": p.returncode, "limit_hit": limited,
                         "duration_ms": (result or {}).get("duration_ms")})
        if timed_out or not limited or len(segments) >= 30:
            break
        wait_for_capacity(env)
        seg_cmd = [c for c in cmd if True]
        i = seg_cmd.index("--session-id")
        seg_cmd[i:i + 2] = ["--resume", session_id]
        seg_cmd[2] = ("The session was interrupted by an external usage limit and has now been resumed. "
                      "Continue the task from where you left off, following the same rules.")
    t_end = time.time()
    meta.update(t_agent_end=t_end, agent_elapsed_s=active, wall_span_s=t_end - t_assign, exit_code=p.returncode,
                timed_out=timed_out, segments=segments, resumed_after_limit=len(segments) > 1,
                final_limit_hit=segments[-1]["limit_hit"])
    if strategy == "gui_reuse_first":
        subprocess.run([os.path.join(bindir, "gui"), "shutdown"], cwd=ws, env=env, capture_output=True, timeout=30)

    # harness-reported result summary: usage/cost are cumulative across resumed segments (last result);
    # durations are per segment, so they are summed.
    if result:
        meta["harness_result"] = {k: result.get(k) for k in ("subtype", "is_error", "duration_ms", "duration_api_ms", "num_turns",
                                                             "total_cost_usd", "usage", "modelUsage", "stop_reason")}
        if len(segments) > 1:
            durs, apis = [], []
            for line in open(stream_path):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") == "result":
                    durs.append(d.get("duration_ms") or 0)
                    apis.append(d.get("duration_api_ms") or 0)
            meta["harness_result"]["duration_ms"] = sum(durs)
            meta["harness_result"]["duration_api_ms"] = sum(apis)
    tr = find_transcript(session_id)
    meta["transcript_found"] = bool(tr)
    if tr:
        shutil.copy(tr, os.path.join(out, "transcript.jsonl"))
        from .sanitize import sanitize_file
        sanitize_file(os.path.join(out, "transcript.jsonl"))
        sanitize_file(os.path.join(out, "stream.jsonl"))
    for fn in ("retrieval.jsonl", "gui.jsonl"):
        if os.path.exists(os.path.join(tel, fn)):
            shutil.copy(os.path.join(tel, fn), os.path.join(out, fn))
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    return run_id, out, ws


if __name__ == "__main__":
    a = sys.argv[1:]
    rid, out, ws = run(a[0], a[1], int(a[2]), model=a[3] if len(a) > 3 else None)
    print(json.dumps({"run_id": rid, "out": out, "workspace": ws}))
