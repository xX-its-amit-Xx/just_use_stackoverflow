"""Functional line-of-code counting.

Functional LOC = non-blank, non-comment-only lines in source files (js/mjs/cjs/ts/jsx/tsx/css/html/py).
Separately reported: test LOC (tests/**, *.test.*), comment lines, blank lines. Excluded entirely:
node_modules, .retrieval, .gui, .telemetry, .git, lock files, generated/minified bundles (*.min.*, dist/, build/).
"""
import os
import re

SRC_EXT = {".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm", ".py"}
EXCLUDE_DIRS = {"node_modules", ".retrieval", ".gui", ".telemetry", ".git", "dist", "build", "coverage"}


def classify_lines(text, ext):
    """Return (functional, comment, blank) line counts."""
    functional = comment = blank = 0
    in_block = False
    in_html_comment = False
    line_comment = "#" if ext == ".py" else "//"
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            blank += 1
            continue
        if ext in (".html", ".htm"):
            if in_html_comment:
                comment += 1
                if "-->" in s:
                    in_html_comment = False
                continue
            if s.startswith("<!--"):
                comment += 1
                in_html_comment = "-->" not in s
                continue
        if in_block:
            comment += 1
            if "*/" in s:
                in_block = False
                rest = s.split("*/", 1)[1].strip()
                if rest:
                    comment -= 1
                    functional += 1
            continue
        if ext != ".py" and s.startswith("/*"):
            if "*/" not in s:
                in_block = True
                comment += 1
                continue
            rest = re.sub(r"/\*.*?\*/", "", s).strip()
            if rest:
                functional += 1
            else:
                comment += 1
            continue
        if ext not in (".css",) and s.startswith(line_comment):
            comment += 1
            continue
        functional += 1
    return functional, comment, blank


def is_test_path(rel):
    parts = rel.replace("\\", "/").split("/")
    return parts[0] in ("tests", "test", "__tests__") or ".test." in parts[-1] or ".spec." in parts[-1]


def count_tree(root):
    out = {"functional_loc": 0, "test_loc": 0, "comment_lines": 0, "blank_lines": 0, "src_files": 0, "test_files": 0,
           "boilerplate_files": 0, "per_file": {}}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in EXCLUDE_DIRS]
        for fn in files:
            p = os.path.join(d, fn)
            rel = os.path.relpath(p, root)
            ext = os.path.splitext(fn)[1].lower()
            if ext not in SRC_EXT:
                if fn in ("package.json", "tsconfig.json", ".eslintrc", ".prettierrc"):
                    out["boilerplate_files"] += 1
                continue
            if ".min." in fn:
                continue
            try:
                text = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            f, c, b = classify_lines(text, ext)
            out["comment_lines"] += c
            out["blank_lines"] += b
            if is_test_path(rel):
                out["test_loc"] += f
                out["test_files"] += 1
            else:
                out["functional_loc"] += f
                out["src_files"] += 1
                out["per_file"][rel] = f
    return out


if __name__ == "__main__":
    import json
    import sys
    r = count_tree(sys.argv[1])
    r.pop("per_file") if "--brief" in sys.argv else None
    print(json.dumps(r, indent=1))
