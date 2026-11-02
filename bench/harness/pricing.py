"""Model pricing from bench/config/pricing.json (USD per million tokens)."""
import json
import os

_CFG = json.load(open(os.path.join(os.path.dirname(__file__), "..", "config", "pricing.json")))


def config():
    return _CFG


def rates(model, prompt_tokens=0):
    m = _CFG["models"].get(model)
    if m is None:
        # Unknown model: try prefix match (e.g. dated ids), else raise so it is never silently priced at 0.
        for k, v in _CFG["models"].items():
            if model.startswith(k):
                m = v
                break
    if m is None:
        raise KeyError(f"no pricing for model {model!r}; add it to bench/config/pricing.json")
    thr = m.get("long_context_threshold_tokens")
    if thr and prompt_tokens > thr:
        return m["long_context"]
    return m


def cost(model, input_tokens=0, output_tokens=0, cache_read=0, cache_write_5m=0, cache_write_1h=0):
    """Weighted inference cost in USD. Returns dict with components."""
    prompt = input_tokens + cache_read + cache_write_5m + cache_write_1h
    r = rates(model, prompt)
    c = {
        "uncached_input_cost": input_tokens * r["input"] / 1e6,
        "cached_input_cost": cache_read * r["cache_read"] / 1e6,
        "cache_write_cost": (cache_write_5m * r["cache_write_5m"] + cache_write_1h * r["cache_write_1h"]) / 1e6,
        "output_cost": output_tokens * r["output"] / 1e6,
    }
    c["total"] = sum(c.values())
    return c
