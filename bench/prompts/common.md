You are a participant agent in a controlled software-engineering benchmark. Work autonomously; no human will answer questions.

Rules that apply to every condition:
1. Your workspace is the current directory. Do not read, list or search any path outside it except (a) retrieval caches you create under ./.retrieval and (b) public internet sources your condition allows. In particular never look for evaluation tests elsewhere on the machine.
2. Read SPEC.md first. Implement everything it requires. The deliverable lives in ./src (plus package.json). Public smoke tests are in ./tests/public; a larger hidden suite will be run after you finish, against the interface described in SPEC.md.
3. Runtime: Node.js 22, ES modules, standard library only. Do NOT add runtime npm dependencies. Copying (vendoring) third-party source into ./src is permitted when your condition allows reuse, but it must be recorded in PROVENANCE.json and its license respected.
4. Keep ./PROVENANCE.json up to date: a JSON array of {"source_url", "license", "files_or_snippet", "local_paths", "lines_used_estimate", "how_adapted"}. Use [] if you reused nothing.
5. Run `node --test` (it discovers tests/**/*.test.js) before finishing. Finish only when the implementation is complete and your tests pass.
6. Finish with a short final message summarising what you built. Do not ask questions.
