"""Evaluate a finished run and compute its run-level metrics.

Usage: python3 -m harness.evaluate <results/runs/run_id> [--no-copy]

Writes results/runs/<run_id>/{events.jsonl, run.json} and copies the deliverable to
results/artifacts/<run_id>/ (excluding retrieval caches, node_modules, browser state).
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict

from . import loc, pricing, provenance, telemetry

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
REPO = os.path.dirname(BENCH)
PERMISSIVE = re.compile(r"\b(MIT|ISC|BSD|Apache|Unlicense|CC0|0BSD|WTFPL|Zlib|Python-2|CC[- ]BY(?![- ]SA)|Public Domain)", re.I)
COPYLEFT = re.compile(r"\b(GPL|AGPL|LGPL|OSL|EUPL|MPL|CC[- ]BY[- ]SA|SSPL)", re.I)
SECURITY_PATTERNS = {
    "eval_or_function_ctor": r"\beval\s*\(|new\s+Function\s*\(",
    "child_process_exec": r"\bexec(Sync)?\s*\(\s*[`'\"].*\$\{|child_process[\s\S]{0,40}exec\(",
    "innerHTML_with_variable": r"\.innerHTML\s*[+]?=\s*(?![`'\"][^`'\"$]*[`'\"]\s*;)",
    "weak_hash_for_password": r"createHash\(\s*['\"](md5|sha1)['\"]",
    "math_random_token": r"(token|session|secret)[^\n]{0,60}Math\.random|Math\.random[^\n]{0,60}(token|session|secret)",
    "hardcoded_secret": r"(api[_-]?key|secret|password)\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}['\"]",
    "path_traversal_risk": r"(readFile|createReadStream)\([^)]*(req\.url|pathname)",
}


def copy_artifact(ws, dst):
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(ws, dst, ignore=shutil.ignore_patterns(".retrieval", "node_modules", ".gui", ".telemetry", ".git", "*.png", "data.json", "todos.json"))


def retrieval_manifest(ws):
    out = []
    base = os.path.join(ws, ".retrieval")
    if not os.path.isdir(base):
        return out
    for top in sorted(glob.glob(os.path.join(base, "*", "*"))):
        size = 0
        files = 0
        for d, dirs, fs in os.walk(top):
            dirs[:] = [x for x in dirs if x != ".git"]
            for f in fs:
                files += 1
                try:
                    size += os.path.getsize(os.path.join(d, f))
                except OSError:
                    pass
        out.append({"path": os.path.relpath(top, ws), "files": files, "bytes": size})
    return out


def run_tests(app_dir, test_files, timeout=600):
    if not test_files:
        return {"tests": 0, "pass": 0, "fail": 0, "duration_s": 0, "output_tail": "no test files"}
    t0 = time.time()
    try:
        p = subprocess.run(["node", "--test", "--test-reporter=tap", "--test-concurrency=1", *test_files],
                           cwd=app_dir, env={**os.environ, "APP_DIR": app_dir}, capture_output=True, text=True, timeout=timeout)
        out = p.stdout + p.stderr
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        out += "\n# TIMEOUT"
    g = lambda k: int(m.group(1)) if (m := re.search(rf"^# {k} (\d+)", out, re.M)) else 0
    failed = re.findall(r"^\s*not ok \d+ - (.*)$", out, re.M)
    return {"tests": g("tests"), "pass": g("pass"), "fail": g("fail"), "duration_s": round(time.time() - t0, 2),
            "failed_names": failed[:60], "output_tail": out[-3000:]}


def security_scan(app_dir):
    findings = []
    for d, dirs, files in os.walk(os.path.join(app_dir, "src")):
        for fn in files:
            if not fn.endswith((".js", ".mjs", ".cjs", ".html")):
                continue
            p = os.path.join(d, fn)
            text = open(p, encoding="utf-8", errors="replace").read()
            for name, pat in SECURITY_PATTERNS.items():
                for m in re.finditer(pat, text, re.I):
                    line = text.count("\n", 0, m.start()) + 1
                    findings.append({"rule": name, "file": os.path.relpath(p, app_dir), "line": line})
    return findings


def dependency_check(app_dir):
    pj = os.path.join(app_dir, "package.json")
    try:
        pkg = json.load(open(pj))
    except Exception:
        return {"runtime_dependencies": [], "dev_dependencies": [], "audit": "package.json unreadable"}
    deps = list((pkg.get("dependencies") or {}).keys())
    dev = list((pkg.get("devDependencies") or {}).keys())
    audit = {"vulnerabilities": 0, "note": "no dependencies declared"}
    if deps or dev:
        tmp = app_dir + "__audit"
        shutil.copytree(app_dir, tmp, dirs_exist_ok=True)
        try:
            subprocess.run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--silent"], cwd=tmp, capture_output=True, timeout=300)
            p = subprocess.run(["npm", "audit", "--json"], cwd=tmp, capture_output=True, text=True, timeout=300)
            j = json.loads(p.stdout or "{}")
            v = (j.get("metadata") or {}).get("vulnerabilities") or {}
            audit = {"vulnerabilities": sum(v.values()) if v else 0, "by_severity": v}
        except Exception as e:
            audit = {"vulnerabilities": None, "note": f"audit failed: {e}"}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return {"runtime_dependencies": deps, "dev_dependencies": dev, "audit": audit}


def maintainability(app_dir, loc_info):
    per = loc_info["per_file"]
    lines = Counter()
    fn_count = 0
    for rel in per:
        text = open(os.path.join(app_dir, rel), encoding="utf-8", errors="replace").read()
        fn_count += len(re.findall(r"\bfunction\b|=>\s*[{(]|^\s*(async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{", text, re.M))
        for l in text.splitlines():
            s = provenance.norm(l)
            if s and not provenance.is_trivial(s):
                lines[s] += 1
    nontriv = sum(lines.values()) or 1
    dup = sum(c - 1 for c in lines.values() if c > 1)
    vals = list(per.values()) or [0]
    return {"src_files": len(per), "max_file_loc": max(vals), "mean_file_loc": round(sum(vals) / len(vals), 1),
            "functions": fn_count, "loc_per_function": round(loc_info["functional_loc"] / max(fn_count, 1), 1),
            "duplicate_line_ratio": round(dup / nontriv, 4)}


def license_check(app_dir, prov):
    try:
        entries = json.load(open(os.path.join(app_dir, "PROVENANCE.json")))
        if not isinstance(entries, list):
            entries = []
    except Exception:
        entries = None
    issues = []
    if entries is None:
        issues.append("PROVENANCE.json missing or invalid")
        entries = []
    # entries that only document "nothing reused" are not third-party sources
    entries = [e for e in entries if isinstance(e, dict) and str(e.get("source_url") or "").strip().lower() not in ("", "n/a", "none", "null", "-")]
    for e in entries:
        lic = str((e or {}).get("license") or "")
        if not lic or lic.lower() in ("unknown", "none", "n/a"):
            issues.append(f"no license recorded for {e.get('source_url')}")
        elif COPYLEFT.search(lic) and not re.search(r"CC[- ]BY[- ]SA", lic, re.I):
            issues.append(f"copyleft license {lic} for {e.get('source_url')}")
    ext = prov["external_fraction"]
    notices = any(os.path.exists(os.path.join(app_dir, p)) for p in ("src/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md", "NOTICE"))
    undeclared = ext > 0.05 and not entries
    if undeclared:
        issues.append(f"{ext:.0%} of non-trivial lines match retrieved material but PROVENANCE.json is empty")
    if entries and not notices and any(not re.search(r"CC0|Unlicense|Public Domain", str(e.get("license", "")), re.I) for e in entries):
        issues.append("third-party code used but no THIRD_PARTY_NOTICES.md / NOTICE file")
    return {"provenance_entries": len(entries), "notices_file": notices, "issues": issues, "compliant": not issues}


def contamination_check(tool_index, run_dir=None):
    """Flag any contact with benchmark-private material: the local repo path, or the public benchmark
    repository appearing in a tool input, a tool result (search hits, fetched pages) or a GUI URL."""
    hits = []
    for tid, t in tool_index.items():
        blob = json.dumps(t["input"])
        if "/bench/tasks/" in blob or ("hidden/" in blob and "tasks" in blob) or "just_use_stackoverflow" in blob.lower():
            hits.append({"where": "tool_input", "input": t["input"]})
        elif "just_use_stackoverflow" in (t["result"].get("text") or "").lower():
            hits.append({"where": "tool_result", "input": t["input"]})
    gp = os.path.join(run_dir, "gui.jsonl") if run_dir else None
    if gp and os.path.exists(gp):
        for l in open(gp):
            if "just_use_stackoverflow" in l.lower():
                hits.append({"where": "gui", "line": l[:200]})
    return hits


def permission_denials(tool_index):
    """Tool calls refused by the harness permission classifier (auto mode), with the stated reason."""
    out = []
    for t in tool_index.values():
        txt = t["result"].get("text", "") or ""
        if "denied by the Claude Code auto mode classifier" in txt or "Permission for this action was denied" in txt:
            m = re.search(r"Reason: \[([^\]]+)\]", txt)
            out.append({"action_type": t["kind"], "reason": m.group(1) if m else "unknown", "step": t["step"]})
    return out


def node_check(app_dir):
    bad = []
    for d, dirs, files in os.walk(os.path.join(app_dir, "src")):
        for fn in files:
            if fn.endswith((".js", ".mjs")):
                p = subprocess.run(["node", "--check", os.path.join(d, fn)], capture_output=True, text=True)
                if p.returncode:
                    bad.append(os.path.relpath(os.path.join(d, fn), app_dir))
    return bad


def retrieval_metrics(events, tool_index, ws, run_dir, prov):
    retr = [json.loads(l) for l in open(os.path.join(run_dir, "retrieval.jsonl"))] if os.path.exists(os.path.join(run_dir, "retrieval.jsonl")) else []
    gui = [json.loads(l) for l in open(os.path.join(run_dir, "gui.jsonl"))] if os.path.exists(os.path.join(run_dir, "gui.jsonl")) else []
    kinds = defaultdict(list)
    for t in tool_index.values():
        kinds[t["kind"]].append(t)
    # searches: tool calls classified as searches (+ multiple rtool searches inside one Bash call)
    n_search = 0
    for t in kinds["web_search"] + kinds["github_search"]:
        n_search += max(1, len(re.findall(r"\brtool\s+(gh-search|gh-code-search|so-search|npm-search)", t["input"].get("command", "")))) if t["name"] == "Bash" else 1
    gui_searches = [g for g in gui if g["command"] == "open" and re.search(r"/search\?|[?&]q=", str(g.get("args")))]
    n_search += len(gui_searches)
    results_examined = sum(r.get("n_results", 0) for r in retr if r.get("command") in ("gh-search", "gh-code-search", "so-search", "npm-search"))
    for t in kinds["web_search"]:
        if t["name"] == "WebSearch":
            results_examined += len(re.findall(r'"url":|https?://', t["result"].get("text", "")[:20000]))
    repos = set()
    for r in retr:
        if r.get("command") == "clone" and r.get("ok"):
            repos.add(r["source_urls"][0])
    for t in kinds["repository_inspection"] + kinds["snippet_retrieval"]:
        for u in telemetry.URL_RE.findall(json.dumps(t["input"])):
            m = re.match(r"https?://(?:raw\.githubusercontent\.com|github\.com)/([^/\s]+)/([^/\s#?]+)", u)
            if m:
                repos.add(f"https://github.com/{m.group(1)}/{m.group(2).removesuffix('.git')}")
    for g in gui:
        u = g.get("url") or ""
        m = re.match(r"https?://(?:raw\.githubusercontent\.com|github\.com)/([^/\s]+)/([^/\s#?]+)", u)
        if m and m.group(1) not in ("search", "topics", "orgs", "settings", "login", "features", "marketplace"):
            repos.add(f"https://github.com/{m.group(1)}/{m.group(2)}")
    files_inspected = {t["input"].get("file_path") for t in kinds["repository_inspection"] if t["name"] == "Read"}
    files_inspected |= {r.get("local_path") for r in retr if r.get("command") == "fetch" and r.get("ok")}
    files_inspected |= {g.get("url") for g in gui if g["command"] == "open" and g.get("ok") and "/blob/" in str(g.get("url")) or "raw.githubusercontent" in str(g.get("url"))}
    files_inspected.discard(None)
    files_copied = sum(len(re.findall(r"\b(cp|rsync)\b", t["input"].get("command", ""))) for t in kinds["file_copy"] if t["name"] == "Bash")
    files_copied += sum(1 for g in gui if g["command"] == "paste" and g.get("ok"))
    snippets = len([r for r in retr if r.get("command") in ("so-answers", "fetch") and r.get("ok")]) + \
        len([t for t in kinds["snippet_retrieval"] if t["name"] == "WebFetch"]) + len([g for g in gui if g["command"] == "copy" and g.get("ok")])
    clones = [r for r in retr if r.get("command") in ("clone", "npm-fetch")]
    retrieval_calls = [t for k in ("web_search", "github_search", "repository_clone", "snippet_retrieval") for t in kinds[k]]
    failed = [t for t in retrieval_calls if t["result"].get("is_error") or re.search(r"rtool \S+ failed|\"n_results\": 0|total_count\": 0|^\[\]$", t["result"].get("text", "")[:2000], re.M)]
    failed_gui = [g for g in gui if g["command"] == "open" and not g.get("ok")]
    lc = prov["line_classes"]
    final_loc = prov.get("final_functional_loc", 0)
    nt = lc["nontrivial"] or 1
    inc = round(final_loc * lc["exact"] / nt)
    mod = round(final_loc * lc["modified"] / nt)
    retrieved_loc = prov["corpus_lines"]
    return {
        "search_queries": n_search,
        "search_results_examined": results_examined,
        "repositories_inspected": len(repos),
        "repositories_cloned": len([r for r in clones if r.get("ok")]) + len([t for t in kinds["repository_clone"] if "git clone" in t["input"].get("command", "")]),
        "clone_attempts_failed": len([r for r in clones if not r.get("ok")]),
        "files_inspected": len(files_inspected),
        "files_copied": files_copied,
        "snippets_retrieved": snippets,
        "retrieved_loc": retrieved_loc,
        "cloned_repo_lines": sum(r.get("lines", 0) for r in clones if r.get("ok")),
        "retrieved_loc_incorporated": inc,
        "retrieved_loc_modified": mod,
        "retrieved_loc_discarded": max(0, retrieved_loc - inc - mod),
        "generated_loc": max(0, final_loc - inc - mod),
        "modified_loc": mod,
        "integration_modifications": len(kinds["integration"]),
        "external_fraction": round(prov["external_fraction"], 4),
        "search_to_use_conversion": round(prov["corpus_sources_contributing"] / prov["corpus_sources"], 4) if prov["corpus_sources"] else None,
        "repository_acquisition_s": round(sum(t.get("dur", 0) for t in kinds["repository_clone"]), 2),
        "retrieval_actions": len(retrieval_calls) + len([g for g in gui if g["command"] == "open"]),
        "retrieval_failures": len(failed) + len(failed_gui),
        "retrieval_failure_rate": round((len(failed) + len(failed_gui)) / max(1, len(retrieval_calls) + len([g for g in gui if g["command"] == "open"])), 4),
    }


def protocol_compliance(strategy, events):
    """Did the agent follow its condition? Order of first retrieval vs first source write (by step)."""
    retr = {"web_search", "github_search", "repository_inspection", "repository_clone", "snippet_retrieval", "computer_use", "screenshot"}
    first_retr = next((e["step_number"] for e in events if set(e["sub_actions"]) & retr), None)
    def writes_src(e):
        return any(a in ("code_generation", "code_edit", "integration", "file_copy", "debugging") for a in e["sub_actions"]) and \
            ("src/" in e["action_description"] or any(p.startswith("src/") for p in e["artifact_paths"]))
    first_write = next((e["step_number"] for e in events if writes_src(e)), None)
    n_retr = sum(1 for e in events if set(e["sub_actions"]) & retr)
    if strategy == "generate_first":
        ok = n_retr == 0
    elif strategy in ("reuse_first", "gui_reuse_first"):
        ok = first_retr is not None and (first_write is None or first_retr < first_write)
    else:
        ok = True
    acquired = any(set(e["sub_actions"]) & {"repository_clone", "snippet_retrieval", "file_copy"} for e in events) or \
        any("gui copy" in e["action_description"] for e in events)
    return {"first_retrieval_step": first_retr, "first_src_write_step": first_write, "retrieval_invocations": n_retr,
            "acquired_any": acquired, "compliant": ok, "compliant_strict": ok and (acquired or strategy in ("generate_first", "hybrid"))}


def gui_metrics(events, run_dir):
    p = os.path.join(run_dir, "gui.jsonl")
    if not os.path.exists(p):
        return None
    g = [json.loads(l) for l in open(p)]
    c = Counter(x["command"] for x in g)
    shots = [x for x in g if x["command"] == "screenshot" and x.get("ok")]
    # Image token ESTIMATE (Anthropic vision formula w*h/750 after scaling to <=1568px long edge); actual cost is inside input tokens.
    def img_tokens(w, h):
        s = min(1.0, 1568 / max(w, h))
        return int((w * s) * (h * s) / 750)
    vis_calls = [e for e in events if e.get("consumed_image")]
    ts = [x["ts"] for x in g]
    return {
        "browser_navigations": c["open"] + c["back"] + c["forward"],
        "screenshots": len(shots),
        "screenshot_tokens_estimate": sum(img_tokens(x.get("width", 1280), x.get("height", 800)) for x in shots),
        "screenshot_tokens_viewed_estimate": len(vis_calls) * img_tokens(1280, 800),
        "clicks": c["click"],
        "text_selections": c["select"] + sum(1 for x in g if x["command"] == "key" and "a" in str(x.get("args")).lower() and "control" in str(x.get("args")).lower()),
        "copy_operations": c["copy"],
        "paste_operations": c["paste"],
        "failed_navigations": sum(1 for x in g if x["command"] == "open" and not x.get("ok")),
        "gui_action_time_s": round(sum(x.get("duration_s", 0) for x in g), 2),
        "browser_session_span_s": round(max(ts) - min(ts), 2) if ts else 0,
        "visual_reasoning_calls": len(vis_calls),
        "visual_reasoning_cost_usd": round(sum(e["estimated_cost_usd"] for e in vis_calls), 6),
    }


def process(run_dir, copy=True):
    meta = json.load(open(os.path.join(run_dir, "meta.json")))
    ws = meta["workspace"]
    task_dir = os.path.join(BENCH, "tasks", meta["task_id"])
    art = os.path.join(REPO, "results", "artifacts", meta["run_id"])
    if copy or not os.path.exists(art):
        copy_artifact(ws, art)
    json.dump(retrieval_manifest(ws), open(os.path.join(run_dir, "retrieval_manifest.json"), "w"), indent=1)
    events, tool_index, recon = telemetry.build_events(run_dir, meta) if meta.get("transcript_found") else ([], {}, {})
    with open(os.path.join(run_dir, "events.jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")

    # evaluation (on the preserved artifact copy)
    t0 = time.time()
    hidden = sorted(glob.glob(os.path.join(task_dir, "hidden", "*.test.js")))
    hid = run_tests(art, hidden)
    own = run_tests(art, sorted(glob.glob(os.path.join(art, "tests", "**", "*.test.js"), recursive=True)))
    eval_s = time.time() - t0
    loc_info = loc.count_tree(art)
    prov = provenance.analyse(ws, tool_index)
    prov["final_functional_loc"] = loc_info["functional_loc"]
    prov_small = {k: v for k, v in prov.items() if k != "per_file"}
    json.dump(prov, open(os.path.join(run_dir, "provenance.json"), "w"), indent=1)

    # costs
    tok = Counter()
    for e in events:
        for k in ("input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_tokens", "web_search_requests", "web_fetch_requests"):
            tok[k] += e[k] or 0
        tok["reasoning_tokens"] += e["reasoning_tokens"] or 0
    inference = sum(e["estimated_cost_usd"] for e in events)
    # Sensitivity metric independent of prompt-cache hits: every input token priced as uncached input.
    nocache = 0.0
    for e in events:
        prompt = e["input_tokens"] + e["cached_input_tokens"] + e["cache_creation_tokens"]
        rt = pricing.rates(e["model"], prompt)
        nocache += (prompt * rt["input"] + e["output_tokens"] * rt["output"]) / 1e6
    attributed = sum(e["estimated_cost_usd"] for e in events if e["measurement_confidence"] == "actual")
    pc = pricing.config()
    search_cost = tok["web_search_requests"] * pc["server_tools"]["web_search_per_request"]
    hr = meta.get("harness_result") or {}
    active_s = (hr.get("duration_api_ms") or 0) / 1000 + sum(e["tool_wall_s"] for e in events)
    # Agent elapsed time = the CLI's own session duration (task assignment -> final result). The orchestrator's
    # observed process wall time is kept separately: it can be inflated if the orchestrator is slow to reap the process.
    elapsed_agent = (hr.get("duration_ms") or 0) / 1000 or meta["agent_elapsed_s"]
    compute_cost = (elapsed_agent + eval_s) / 3600 * pc["compute"]["usd_per_container_hour"]
    q_tests = hid["tests"]
    run = {k: meta[k] for k in ("run_id", "task_id", "strategy", "trial", "tier", "family", "model", "effort")}
    run.update({
        "exit_code": meta["exit_code"], "timed_out": meta["timed_out"], "harness_subtype": hr.get("subtype"), "num_turns": hr.get("num_turns"),
        "model_invocations": sum(1 for e in events if e["measurement_confidence"] != "actual_aggregate_unattributed"),
        "input_tokens": tok["input_tokens"], "output_tokens": tok["output_tokens"], "cached_input_tokens": tok["cached_input_tokens"],
        "cache_creation_tokens": tok["cache_creation_tokens"], "reasoning_tokens": tok["reasoning_tokens"],
        "total_tokens": tok["input_tokens"] + tok["output_tokens"],
        "total_tokens_incl_cache": tok["input_tokens"] + tok["output_tokens"] + tok["cached_input_tokens"] + tok["cache_creation_tokens"],
        "web_search_requests": tok["web_search_requests"],
        "inference_cost_usd": round(inference, 6), "inference_cost_nocache_usd": round(nocache, 6), "inference_cost_attributed_usd": round(attributed, 6),
        "harness_reported_cost_usd": hr.get("total_cost_usd"),
        "search_api_cost_usd": round(search_cost, 6), "compute_cost_usd_estimate": round(compute_cost, 6),
        "total_execution_cost_usd": round(inference + search_cost + compute_cost, 6),
        "elapsed_s": round(elapsed_agent + eval_s, 2), "agent_elapsed_s": round(elapsed_agent, 2), "orchestrator_observed_s": round(meta["agent_elapsed_s"], 2), "eval_s": round(eval_s, 2),
        "active_s": round(active_s, 2), "api_s": round((hr.get("duration_api_ms") or 0) / 1000, 2),
        "hidden_tests": q_tests, "hidden_pass": hid["pass"], "hidden_fail": hid["fail"],
        "own_tests": own["tests"], "own_pass": own["pass"],
        "functional_loc": loc_info["functional_loc"], "functional_chars": loc_info["functional_chars"],
        "normalized_loc": round(loc_info["functional_chars"] / 30),
        "minified_vendor_bytes": loc_info["minified_vendor_bytes"], "test_loc": loc_info["test_loc"], "comment_lines": loc_info["comment_lines"],
        "blank_lines": loc_info["blank_lines"],
    })
    run["retrieval"] = retrieval_metrics(events, tool_index, ws, run_dir, prov)
    run["gui"] = gui_metrics(events, run_dir)
    run["protocol"] = protocol_compliance(meta["strategy"], events)
    run["protocol"]["protocol_sha"] = meta.get("protocol_sha")
    run["quality"] = {
        "security_findings": security_scan(art), "dependencies": dependency_check(art), "maintainability": maintainability(art, loc_info),
        "license": license_check(art, prov), "syntax_errors": node_check(art), "human_interventions": 0,
        "contamination": contamination_check(tool_index, run_dir), "permission_denials": permission_denials(tool_index), "hidden_failed_names": hid.get("failed_names", []),
    }
    run["provenance"] = prov_small
    run["reconciliation"] = recon
    run["action_counts"] = dict(Counter(e["action_type"] for e in events))
    json.dump(run, open(os.path.join(run_dir, "run.json"), "w"), indent=1)
    return run


if __name__ == "__main__":
    r = process(sys.argv[1], copy="--no-copy" not in sys.argv)
    print(json.dumps({k: r[k] for k in ("run_id", "hidden_tests", "hidden_pass", "functional_loc", "inference_cost_usd",
                                         "harness_reported_cost_usd", "total_tokens_incl_cache")}, indent=1))
