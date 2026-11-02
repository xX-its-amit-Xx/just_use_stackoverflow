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


def find_transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def run(task_id, strategy, trial, runs_root=None, model=None):
    task = json.load(open(os.path.join(BENCH, "tasks", task_id, "task.json")))
    tier = task["tier"]
    model = model or EXP["model"]
    run_id = f"{task_id}__{strategy}__t{trial}__{time.strftime('%Y%m%dT%H%M%S')}"
    work = os.path.join(runs_root or default_runs_root(), run_id)
    ws = os.path.join(work, "ws")
    os.makedirs(work)
    bindir = build_workspace(task_id, strategy, ws)
    out = os.path.join(REPO, "results", "runs", run_id)
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
           "--max-budget-usd", str(EXP["max_budget_usd"][tier])]
    meta = {"run_id": run_id, "task_id": task_id, "strategy": strategy, "trial": trial, "tier": tier,
            "family": task["family"], "model": model, "effort": EXP["effort"], "session_id": session_id,
            "workspace": ws, "cmd": [c if len(c) < 300 else c[:80] + "...<system prompt>" for c in cmd],
            "claude_code_version": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
            "max_budget_usd": EXP["max_budget_usd"][tier], "max_wall_clock_s": EXP["max_wall_clock_s"][tier],
            "protocol_sha": protocol_sha(task_id, strategy)}
    t_assign = time.time()
    meta["t_assigned"] = t_assign
    timed_out = False
    with open(os.path.join(out, "stream.jsonl"), "w") as so, open(os.path.join(out, "stderr.txt"), "w") as se:
        p = subprocess.Popen(cmd, cwd=ws, env=env, stdout=so, stderr=se, stdin=subprocess.DEVNULL)
        try:
            p.wait(timeout=EXP["max_wall_clock_s"][tier])
        except subprocess.TimeoutExpired:
            timed_out = True
            p.kill()
            p.wait()
    t_end = time.time()
    meta.update(t_agent_end=t_end, agent_elapsed_s=t_end - t_assign, exit_code=p.returncode, timed_out=timed_out)
    if strategy == "gui_reuse_first":
        subprocess.run([os.path.join(bindir, "gui"), "shutdown"], cwd=ws, env=env, capture_output=True, timeout=30)

    # harness-reported result summary (aggregate usage, cost, durations)
    result = None
    for line in open(os.path.join(out, "stream.jsonl")):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") == "result":
            result = d
    if result:
        meta["harness_result"] = {k: result.get(k) for k in ("subtype", "is_error", "duration_ms", "duration_api_ms", "num_turns",
                                                             "total_cost_usd", "usage", "modelUsage", "stop_reason")}
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
    rid, out, ws = run(a[0], a[1], int(a[2]))
    print(json.dumps({"run_id": rid, "out": out, "workspace": ws}))
