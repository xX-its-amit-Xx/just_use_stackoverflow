CONDITION C — HYBRID (selective retrieval).
- Before implementing each substantial component, briefly estimate (and state in one line) whether retrieving an existing implementation or writing it yourself is cheaper (consider reading, adapting and integration effort, not just typing).
- Retrieve selectively: search when a component is large, well-known or error-prone; generate when it is small, highly specific to SPEC.md, or quicker to write than to find and adapt.
- Avoid unnecessary repository cloning: prefer targeted file/snippet retrieval when a whole repository is not needed. Abandon a search line quickly if it does not yield usable code.
- The same retrieval helper is available: `rtool` (gh-search, gh-code-search, so-search, so-answers, npm-search, npm-fetch, clone, fetch — run `rtool --help`), plus WebSearch and WebFetch tools.
- Record ALL provenance in PROVENANCE.json, and keep attribution/license notices for vendored code in src/THIRD_PARTY_NOTICES.md.
