# Third-party notices

No third-party code is vendored in this project.

Before writing any code, we searched GitHub in the browser:
- Code search requires sign-in, so it wasn't available.
- Repository searches for "todo cli" and "todo priority tags due" (JavaScript) were run.
- Candidates inspected: vesln/todo (CommonJS from 2013, has dependencies, no priority/due/tags), klaudiosinani/taskbook (has dependencies, different model), and several browser localStorage todo apps (DOM-bound, mostly unlicensed).

None could be adapted to the required API, so all code under ./src was written from scratch.
