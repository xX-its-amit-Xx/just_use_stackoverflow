"""Redact personal/account data from raw logs before they are committed.

* system-prompt snapshot records are replaced by their SHA-256 (the prompt is reproducible from bench/prompts)
* e-mail addresses -> <redacted-email>
* account / organization UUIDs from the environment -> <redacted-uuid>
Token usage fields are untouched.
"""
import hashlib
import json
import os
import re
import sys

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@(?!anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRETS = [os.environ.get(k) for k in ("CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_USER_EMAIL")]
SECRETS = [s for s in SECRETS if s and len(s) > 6]


def scrub_text(s):
    for x in SECRETS:
        s = s.replace(x, "<redacted>")
    return EMAIL.sub("<redacted-email>", s)


def sanitize_file(path):
    out = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            out.append(scrub_text(line))
            continue
        att = d.get("attachment") if isinstance(d, dict) else None
        if isinstance(att, dict) and att.get("type") == "prompt_snapshot":
            blob = json.dumps(att, sort_keys=True)
            d["attachment"] = {"type": "prompt_snapshot", "redacted": True, "sha256": hashlib.sha256(blob.encode()).hexdigest()}
        out.append(scrub_text(json.dumps(d)) + "\n")
    with open(path, "w") as f:
        f.writelines(out)


if __name__ == "__main__":
    for p in sys.argv[1:]:
        sanitize_file(p)
