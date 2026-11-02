"""Measure how much of the final implementation originates from retrieved material.

Corpus = every text the agent acquired during the run:
  * files under ws/.retrieval (clones, npm packages, fetched snippets, Stack Overflow answers)
  * GUI clipboard history (ws/.gui/clipboard_history)
  * tool results of retrieval actions (WebFetch / curl / WebSearch outputs) from the transcript

Each final functional source line is classified:
  exact     - normalised line occurs verbatim in the corpus            -> "incorporated"
  modified  - same token skeleton (identifiers/literals abstracted)     -> "modified"
  generated - otherwise
Trivial lines (short, punctuation-only, or common keywords) are excluded from matching and
reported separately; percentages are computed over non-trivial lines.
Limitation: verbatim reproduction from the model's training memory is indistinguishable from
generation and is counted as generated.
"""
import os
import re
from collections import defaultdict

from .loc import EXCLUDE_DIRS, SRC_EXT, is_test_path

TEXT_EXT = SRC_EXT | {".md", ".txt", ".json", ""}
MAX_FILE_BYTES = 400_000
KEYWORDS = set("""break case catch class const continue debugger default delete do else export extends finally for function if import in
instanceof let new return super switch this throw try typeof var void while with yield async await of static get set true false null undefined""".split())
# Possessive quantifiers + disjoint alternatives: no catastrophic backtracking on unterminated or
# backslash-heavy string literals (the original pattern froze the evaluator on vendored libraries).
TOKEN_RE = re.compile(r"[A-Za-z_$][\w$]*+|\d++(?:\.\d+)?(?:[eE][+-]?\d+)?|'(?:[^'\\]|\\.)*+'|\"(?:[^\"\\]|\\.)*+\"|`(?:[^`\\]|\\.)*+`|==?=?|!==?|=>|&&|\|\||[^\s\w]")
MAX_LINE = 400  # longer lines (minified / data tables) are only matched exactly


def norm(line):
    s = line.strip()
    s = re.sub(r"\s+", " ", s)
    s = s.rstrip(";,")
    return s


def is_trivial(s):
    if len(s) < 12:
        return True
    if not re.search(r"[A-Za-z]", s):
        return True
    if s.startswith(("//", "/*", "*", "#", "<!--")):
        return True
    return False


def skeleton(s):
    if len(s) > MAX_LINE:
        return None
    toks = TOKEN_RE.findall(s)
    out = []
    for t in toks:
        if t in KEYWORDS:
            out.append(t)
        elif re.match(r"[A-Za-z_$]", t):
            out.append("I")
        elif t[0] in "'\"`":
            out.append("S")
        elif t[0].isdigit():
            out.append("N")
        else:
            out.append(t)
    return " ".join(out) if len(out) >= 8 else None


class Corpus:
    def __init__(self):
        self.exact = defaultdict(set)
        self.skel = defaultdict(set)
        self.sources = {}  # sid -> {"kind","lines"}

    def add_text(self, sid, text, kind):
        n = 0
        for line in text.splitlines():
            s = norm(line)
            if not s:
                continue
            n += 1
            if is_trivial(s):
                continue
            self.exact[s].add(sid)
            sk = skeleton(s)
            if sk:
                self.skel[sk].add(sid)
        if sid in self.sources:
            self.sources[sid]["lines"] += n
        else:
            self.sources[sid] = {"kind": kind, "lines": n}


def build_corpus(ws, tool_index):
    c = Corpus()
    rdir = os.path.join(ws, ".retrieval")
    for base, kind in ((rdir, "retrieval_dir"), (os.path.join(ws, ".gui", "clipboard_history"), "gui_clipboard")):
        if not os.path.isdir(base):
            continue
        for d, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
            for fn in files:
                p = os.path.join(d, fn)
                ext = os.path.splitext(fn)[1].lower()
                if ext not in TEXT_EXT or os.path.getsize(p) > MAX_FILE_BYTES or ".min." in fn:
                    continue
                try:
                    c.add_text(os.path.relpath(p, ws), open(p, encoding="utf-8", errors="replace").read(), kind)
                except OSError:
                    pass
    for tid, info in tool_index.items():
        if info["kind"] in ("snippet_retrieval", "repository_inspection", "web_search", "github_search") and info["name"] in ("WebFetch", "WebSearch", "Bash"):
            txt = info["result"].get("text", "")
            if txt and ".retrieval" not in (info["input"].get("command", "") if info["name"] == "Bash" else ""):
                c.add_text(f"tool_result:{tid}", txt, "tool_result")
    return c


def analyse(ws, tool_index):
    corpus = build_corpus(ws, tool_index)
    totals = {"nontrivial": 0, "trivial": 0, "exact": 0, "modified": 0, "generated": 0}
    contributing = defaultdict(int)
    per_file = {}
    for d, dirs, files in os.walk(ws):
        dirs[:] = [x for x in dirs if x not in EXCLUDE_DIRS]
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            p = os.path.join(d, fn)
            rel = os.path.relpath(p, ws)
            if ext not in SRC_EXT or is_test_path(rel):
                continue
            f = {"exact": 0, "modified": 0, "generated": 0, "trivial": 0}
            for line in open(p, encoding="utf-8", errors="replace").read().splitlines():
                s = norm(line)
                if not s:
                    continue
                if is_trivial(s):
                    f["trivial"] += 1
                    continue
                if s in corpus.exact:
                    f["exact"] += 1
                    for sid in corpus.exact[s]:
                        contributing[sid] += 1
                else:
                    sk = skeleton(s)
                    if sk and sk in corpus.skel:
                        f["modified"] += 1
                        for sid in corpus.skel[sk]:
                            contributing[sid] += 1
                    else:
                        f["generated"] += 1
            per_file[rel] = f
            for k in ("exact", "modified", "generated", "trivial"):
                totals[k] += f[k]
    totals["nontrivial"] = totals["exact"] + totals["modified"] + totals["generated"]
    nt = totals["nontrivial"] or 1
    retrieved_lines = sum(s["lines"] for s in corpus.sources.values())
    by_kind = defaultdict(int)
    for s in corpus.sources.values():
        by_kind[s["kind"]] += s["lines"]
    n_sources = len(corpus.sources)
    n_contrib = sum(1 for sid in corpus.sources if contributing.get(sid))
    return {
        "external_exact_fraction": totals["exact"] / nt,
        "external_modified_fraction": totals["modified"] / nt,
        "external_fraction": (totals["exact"] + totals["modified"]) / nt,
        "line_classes": totals,
        "corpus_sources": n_sources,
        "corpus_sources_contributing": n_contrib,
        "corpus_lines": retrieved_lines,
        "corpus_lines_by_kind": dict(by_kind),
        "contributing_sources": sorted(((sid, n) for sid, n in contributing.items()), key=lambda x: -x[1])[:30],
        "per_file": per_file,
    }
