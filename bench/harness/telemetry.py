"""Turn a run's raw transcript into event-level telemetry.

One event per model invocation (= one provider API response, identified by message.id).
Token counts are copied verbatim from the provider-reported `usage` object in the transcript
(measurement_confidence = "actual"). Cost is computed from those counts with bench/config/pricing.json
(cost_source = "provider_usage_x_pricing_config"). Usage that the harness reports in its aggregate
result but which does not appear in any per-message usage (e.g. WebFetch summarisation calls,
permission-classifier calls) is emitted as a separate reconciliation event per model, marked
"actual_aggregate_unattributed". Nothing is estimated from LOC.

Attribution: each invocation is attributed to the action it *emits* (its tool call(s)); the action
whose result it *consumed* is recorded too (`consumed_action_types`) so analyses can use either view.
"""
import json
import os
import re
from collections import OrderedDict, defaultdict
from datetime import datetime

from . import pricing

URL_RE = re.compile(r"https?://[^\s'\"<>)\]]+")
TEST_RE = re.compile(r"node\s+(--test|[^|;&]*\.test\.[mc]?js)|npm\s+(run\s+)?test|\bnode --test\b")
SEARCH_CMDS = {"gh-search": "github_search", "gh-code-search": "github_search", "so-search": "web_search", "npm-search": "web_search"}
RETRIEVAL_ACTIONS = {"web_search", "github_search", "repository_inspection", "repository_clone", "snippet_retrieval", "file_copy",
                     "computer_use", "screenshot"}


def _ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def load_transcript(path):
    """Return (invocations in order, tool_results by tool_use_id, user-turn order)."""
    inv = OrderedDict()
    results = {}
    seq = []  # ordered list of ("inv", id) / ("results", [ids])
    for line in open(path):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = d.get("type")
        msg = d.get("message") if isinstance(d.get("message"), dict) else None
        if t == "assistant" and msg and msg.get("id"):
            mid = msg["id"]
            if mid not in inv:
                inv[mid] = {"id": mid, "model": msg.get("model"), "blocks": [], "usage": None, "ts": _ts(d.get("timestamp")),
                            "ts_last": None, "sidechain": d.get("isSidechain", False)}
                seq.append(("inv", mid))
            e = inv[mid]
            e["blocks"].extend(msg.get("content") or [])
            if msg.get("usage"):
                e["usage"] = msg["usage"]  # later lines carry the final usage for the message
            e["ts_last"] = _ts(d.get("timestamp"))
        elif t == "user" and msg:
            content = msg.get("content")
            ids = []
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        text = b.get("content")
                        if isinstance(text, list):
                            text = "\n".join(x.get("text", "") if isinstance(x, dict) and x.get("type") == "text" else
                                             ("[image]" if isinstance(x, dict) and x.get("type") == "image" else "") for x in text)
                        results[b["tool_use_id"]] = {"text": text or "", "is_error": bool(b.get("is_error")),
                                                     "ts": _ts(d.get("timestamp")),
                                                     "has_image": isinstance(b.get("content"), list) and any(
                                                         isinstance(x, dict) and x.get("type") == "image" for x in b["content"])}
                        ids.append(b["tool_use_id"])
            if ids:
                seq.append(("results", ids))
    return list(inv.values()), results, seq


def _bash_kind(cmd, state):
    c = cmd.strip()
    m = re.search(r"\brtool\s+([a-z-]+)", c)
    if m:
        sub = m.group(1)
        if sub in SEARCH_CMDS:
            return SEARCH_CMDS[sub]
        if sub == "clone":
            return "repository_clone"
        if sub in ("so-answers", "fetch"):
            return "snippet_retrieval"
        if sub == "npm-fetch":
            return "repository_clone"
    m = re.search(r"(?:^|[\s;&|/])gui\s+([a-z]+)", c)
    if m:
        return "screenshot" if m.group(1) == "screenshot" else "computer_use"
    # code written through the shell (checked before network rules: heredoc bodies may mention curl/git) (heredocs / tee / printf redirection) counts as code writing, not testing
    if re.search(r"(cat|tee)\s+(-a\s+)?>{0,2}\s*['\"]?[\w./-]+\.(m?js|cjs|ts|json|html|css|md)['\"]?\s*<<|<<-?\s*['\"]?\w+['\"]?\s*>{1,2}\s*[\w./-]+\.(m?js|ts|html|css)", c):
        return "debugging" if state["failing"] else "code_generation"
    if re.search(r"\b(sed|perl)\s+-[a-z]*i", c):
        return "debugging" if state["failing"] else "code_edit"
    if re.search(r"\bgit\s+clone\b", c):
        return "repository_clone"
    if re.search(r"\bgh\s+(api\s+[^|]*search|search)\b", c):
        return "github_search"
    if re.search(r"\b(curl|wget)\b", c) and re.search(r"(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?", c) and not re.search(r"https?://(?!localhost|127\.|0\.0)", c):
        return "test_execution"  # exercising the agent's own server, not retrieval
    if re.search(r"\b(curl|wget)\b", c):
        if "stackexchange" in c or "stackoverflow" in c or "raw.githubusercontent" in c or "/blob/" in c:
            return "snippet_retrieval"
        if "api.github.com/search" in c or "registry.npmjs.org/-/v1/search" in c:
            return "github_search" if "github" in c else "web_search"
        return "snippet_retrieval"
    if re.search(r"\b(npm|pnpm|yarn)\s+(i|install|add|ci)\b|\bpip\s+install\b", c):
        return "dependency_installation"
    if re.search(r"\b(cp|mv|rsync)\b[^\n]*\.retrieval", c):
        return "file_copy"
    if state["step"] <= 2 and re.search(r"\bcat\s+SPEC\.md|\bls\b", c) and not TEST_RE.search(c):
        return "planning"
    if TEST_RE.search(c):
        return "test_execution"
    if ".retrieval" in c:
        return "repository_inspection"
    return "other"


def _file_kind(name, inp, state):
    path = inp.get("file_path") or inp.get("path") or inp.get("pattern") or ""
    if ".retrieval" in path:
        return "repository_inspection"
    if name == "Read":
        if path.endswith(".png") and ".gui" in path:
            return "screenshot"
        if path.endswith("SPEC.md") or state["step"] <= 3:
            return "planning"
        return "debugging" if state["failing"] else "other"
    if name in ("Glob", "Grep"):
        return "debugging" if state["failing"] else "other"
    rel = path.split("/ws/", 1)[-1]
    is_test = rel.startswith("tests/") or ".test." in rel
    if name == "Write":
        if state["failing"] and not is_test:
            return "debugging"
        if rel in state["copied_files"]:
            return "integration"
        return "code_generation"
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        if state["failing"]:
            return "debugging"
        if rel in state["copied_files"]:
            return "integration"
        return "code_edit"
    return "other"


def classify_tool(name, inp, state):
    if name == "Bash":
        return _bash_kind(inp.get("command", ""), state)
    if name == "WebSearch":
        return "web_search"
    if name == "WebFetch":
        url = inp.get("url", "")
        if re.search(r"github\.com/[^/]+/[^/]+/?$|github\.com/[^/]+/[^/]+/tree/", url):
            return "repository_inspection"
        return "snippet_retrieval"
    if name in ("TodoWrite", "TaskCreate", "TaskUpdate"):
        return "planning"
    return _file_kind(name, inp, state)


def _desc(name, inp):
    if name == "Bash":
        s = inp.get("command", "")
    elif name in ("WebSearch",):
        s = inp.get("query", "")
    elif name == "WebFetch":
        s = inp.get("url", "")
    else:
        s = inp.get("file_path") or inp.get("pattern") or json.dumps(inp)[:120]
    s = " ".join(str(s).split())
    return f"{name}: {s[:200]}"


def _test_failed(text, is_error):
    if is_error:
        return True
    m = re.search(r"#\s*fail\s+(\d+)", text)
    if m:
        return int(m.group(1)) > 0
    return bool(re.search(r"^not ok\b", text, re.M))


def build_events(run_dir, meta):
    tpath = os.path.join(run_dir, "transcript.jsonl")
    invs, results, seq = load_transcript(tpath)
    ws = meta["workspace"]
    state = {"failing": False, "copied_files": set(), "step": 0}
    tool_index = {}  # tool_use_id -> info
    events = []
    # walk seq to know which results precede which invocation
    consumed_for = {}
    buf = []
    for k, v in seq:
        if k == "results":
            buf.extend(v)
        else:
            consumed_for[v] = buf
            buf = []
    for step, e in enumerate(invs, start=1):
        state["step"] = step
        tool_uses = [b for b in e["blocks"] if isinstance(b, dict) and b.get("type") == "tool_use"]
        actions, descs, paths, urls = [], [], [], []
        tool_dur = 0.0
        tool_err = False
        for tu in tool_uses:
            name, inp = tu.get("name"), tu.get("input") or {}
            kind = classify_tool(name, inp, state)
            res = results.get(tu["id"], {})
            # state updates after classification
            if kind == "test_execution":
                state["failing"] = _test_failed(res.get("text", ""), res.get("is_error"))
            if kind == "file_copy" and name == "Bash":
                for m in re.finditer(r"\b(?:cp|mv|rsync)\b(?:\s+-\S+)*\s+(\S+)\s+(\S+)", inp.get("command", "")):
                    dst = m.group(2).rstrip("/")
                    state["copied_files"].add(dst.removeprefix("./"))
            if name == "Bash" and re.search(r"\bgui\s+paste\s+(\S+)", inp.get("command", "")):
                state["copied_files"].add(re.search(r"\bgui\s+paste\s+(\S+)", inp["command"]).group(1).removeprefix("./"))
                kind = "file_copy"
            fp = inp.get("file_path")
            if fp:
                paths.append(fp.replace(ws + "/", ""))
            urls += URL_RE.findall(json.dumps(inp))
            if kind in RETRIEVAL_ACTIONS:
                urls += URL_RE.findall(res.get("text", ""))[:10]
            dur = max(0.0, res["ts"] - e["ts_last"]) if res.get("ts") and e.get("ts_last") else 0.0
            tool_dur = max(tool_dur, dur)  # parallel calls overlap: wall time is the max
            tool_err = tool_err or bool(res.get("is_error"))
            tool_index[tu["id"]] = {"kind": kind, "name": name, "input": inp, "result": res, "inv": e["id"], "step": step, "dur": dur}
            actions.append(kind)
            descs.append(_desc(name, inp))
        texts = [b.get("text", "") for b in e["blocks"] if isinstance(b, dict) and b.get("type") == "text"]
        if not tool_uses:
            action = "planning" if step <= 2 else "other"
            descs = ["assistant text: " + " ".join(" ".join(texts).split())[:200]] if texts else ["assistant turn without tool call"]
        else:
            # dominant action: first retrieval/code action, else first
            action = actions[0]
        u = e["usage"] or {}
        cc = u.get("cache_creation") or {}
        cw1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
        cw5m = cc.get("ephemeral_5m_input_tokens", 0) or 0
        cw_total = u.get("cache_creation_input_tokens", 0) or 0
        if cw1h + cw5m != cw_total:  # no TTL breakdown -> assume 5m (documented)
            cw5m = cw_total - cw1h
        model = e["model"] or meta["model"]
        c = pricing.cost(model, u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
                         u.get("cache_read_input_tokens", 0) or 0, cw5m, cw1h)
        consumed = [tool_index[t]["kind"] for t in consumed_for.get(e["id"], []) if t in tool_index]
        has_image = any(results.get(t, {}).get("has_image") for t in consumed_for.get(e["id"], []))
        details = u.get("output_tokens_details") or {}
        stu = u.get("server_tool_use") or {}
        ev = {
            "run_id": meta["run_id"], "task_id": meta["task_id"], "strategy": meta["strategy"],
            "timestamp": datetime.fromtimestamp(e["ts"]).isoformat() + "Z" if e["ts"] else None,
            "event_id": e["id"], "step_number": step, "action_type": action,
            "action_description": " | ".join(descs)[:500],
            "model": model,
            "input_tokens": u.get("input_tokens", 0) or 0,
            "output_tokens": u.get("output_tokens", 0) or 0,
            "cached_input_tokens": u.get("cache_read_input_tokens", 0) or 0,
            "cache_creation_tokens": cw_total,
            "cache_creation_5m_tokens": cw5m, "cache_creation_1h_tokens": cw1h,
            "reasoning_tokens": details.get("thinking_tokens"),
            "web_search_requests": stu.get("web_search_requests", 0) or 0,
            "web_fetch_requests": stu.get("web_fetch_requests", 0) or 0,
            "estimated_cost_usd": round(c["total"], 8),
            "cost_components": {k: round(v, 8) for k, v in c.items() if k != "total"},
            "cost_source": "provider_usage_x_pricing_config",
            "measurement_confidence": "actual" if e["usage"] else "missing_usage",
            "artifact_paths": paths, "source_urls": sorted(set(urls))[:25],
            "notes": "",
            "sub_actions": actions, "consumed_action_types": consumed, "consumed_image": has_image,
            "tool_error": tool_err, "tool_wall_s": round(tool_dur, 3),
            "n_tool_calls": len(tool_uses),
        }
        notes = []
        if len(tool_uses) > 1:
            notes.append(f"{len(tool_uses)} parallel tool calls in one invocation; tokens are per-invocation and not split")
        if details.get("thinking_tokens") is None:
            notes.append("reasoning_tokens not reported for this message")
        if e["sidechain"]:
            notes.append("sidechain (subagent) message")
        ev["notes"] = "; ".join(notes)
        events.append(ev)

    # reconciliation against harness aggregate usage
    hr = (meta.get("harness_result") or {}).get("modelUsage") or {}
    by_model = defaultdict(lambda: {"input": 0, "output": 0, "cr": 0, "cw": 0})
    for ev in events:
        m = by_model[ev["model"]]
        m["input"] += ev["input_tokens"]; m["output"] += ev["output_tokens"]; m["cr"] += ev["cached_input_tokens"]; m["cw"] += ev["cache_creation_tokens"]
    recon = {}
    for model, agg in hr.items():
        t = by_model.get(model, {"input": 0, "output": 0, "cr": 0, "cw": 0})
        d = {"input": agg.get("inputTokens", 0) - t["input"], "output": agg.get("outputTokens", 0) - t["output"],
             "cr": agg.get("cacheReadInputTokens", 0) - t["cr"], "cw": agg.get("cacheCreationInputTokens", 0) - t["cw"]}
        recon[model] = {"harness": agg, "transcript": dict(t), "delta": d}
        if any(v > 0 for v in d.values()):
            cw1h = max(0, (agg.get("cacheCreationEphemeral1hInputTokens") or 0) - sum(x["cache_creation_1h_tokens"] for x in events if x["model"] == model))
            cw5m = max(0, d["cw"] - cw1h)
            c = pricing.cost(model, max(0, d["input"]), max(0, d["output"]), max(0, d["cr"]), cw5m, cw1h)
            events.append({
                "run_id": meta["run_id"], "task_id": meta["task_id"], "strategy": meta["strategy"],
                "timestamp": datetime.fromtimestamp(meta["t_agent_end"]).isoformat() + "Z", "event_id": f"reconcile-{model}",
                "step_number": len(invs) + 1, "action_type": "other",
                "action_description": "harness-reported usage absent from per-message transcript usage",
                "model": model, "input_tokens": max(0, d["input"]), "output_tokens": max(0, d["output"]),
                "cached_input_tokens": max(0, d["cr"]), "cache_creation_tokens": max(0, d["cw"]),
                "cache_creation_5m_tokens": cw5m, "cache_creation_1h_tokens": cw1h, "reasoning_tokens": None,
                "web_search_requests": 0, "web_fetch_requests": 0,
                "estimated_cost_usd": round(c["total"], 8), "cost_components": {k: round(v, 8) for k, v in c.items() if k != "total"},
                "cost_source": "harness_modelUsage_minus_transcript", "measurement_confidence": "actual_aggregate_unattributed",
                "artifact_paths": [], "source_urls": [],
                "notes": "Provider-reported usage in the harness aggregate with no per-message record (e.g. WebFetch summariser or permission-classifier calls). Not attributable to a specific action.",
                "sub_actions": [], "consumed_action_types": [], "consumed_image": False, "tool_error": False, "tool_wall_s": 0, "n_tool_calls": 0})
    return events, tool_index, recon
