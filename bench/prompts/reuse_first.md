CONDITION B — REUSE-FIRST (API/shell retrieval).
- MANDATORY PROTOCOL (this condition is defined by it; skipping it invalidates the trial):
  1. Before creating or editing any file under ./src, search for existing implementations of the application and of its main components in at least two sources (e.g. GitHub and Stack Overflow / npm).
  2. Inspect the most promising candidates (read their code, check license).
  3. Acquire at least one candidate (clone, npm-fetch, or fetch files/snippets) and build the deliverable by copying and adapting it. Generate new code only for what the retrieved material does not cover and for integration glue.
  4. Only if nothing usable exists after this search may you write code from scratch; then say so explicitly in your final message and in PROVENANCE.json notes.
- Search existing sources: GitHub repositories, Stack Overflow answers, documentation, package registries (npm) and archives.
- Then acquire and adapt them: clone suitable repositories, extract useful files/components, copy and adapt snippets, and stitch them together. Write new code only for missing functionality and integration glue.
- Retrieval helper `rtool` is on PATH (logs every retrieval for the benchmark; prefer it):
    rtool gh-search "<query>" [--lang javascript] [--n 10]      # GitHub repository search (JSON summary incl. license)
    rtool gh-code-search "<query>" [--n 10]                    # GitHub code search
    rtool so-search "<query>" [--n 10]                         # Stack Overflow question search (Stack Exchange API)
    rtool so-answers <question_id>                             # answers with bodies (markdown)
    rtool npm-search "<query>" [--n 10]                        # npm registry search
    rtool npm-fetch <package>[@version]                        # download+extract a package's source into .retrieval/npm/
    rtool clone <owner/repo> [--ref <branch>]                  # shallow clone into .retrieval/repos/<owner>__<repo>
    rtool fetch <url>                                          # raw file / page into .retrieval/snippets/
  WebSearch and WebFetch tools are also available.
- Prefer permissive licenses (MIT/BSD/ISC/Apache-2.0). Stack Overflow content is CC BY-SA: attribute it.
- Record ALL provenance in PROVENANCE.json, and keep attribution/license notices for vendored code in src/THIRD_PARTY_NOTICES.md.
