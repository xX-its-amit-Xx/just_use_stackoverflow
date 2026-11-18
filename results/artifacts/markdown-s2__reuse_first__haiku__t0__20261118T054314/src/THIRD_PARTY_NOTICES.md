# Third-party notices

This project vendors the following MIT / BSD-2-Clause packages under `src/vendor/`.
Full license texts are in `src/vendor/licenses/`. Provenance is recorded in `PROVENANCE.json`.

| Package | Version | License | Location |
|---|---|---|---|
| markdown-it | 15.0.3 | MIT | `src/vendor/markdown-it/` |
| mdurl | 2.1.0 | MIT | `src/vendor/mdurl/` |
| uc.micro | 3.0.0 | MIT | `src/vendor/uc.micro/` |
| linkify-it | 6.1.0 | MIT | `src/vendor/linkify-it/` |
| entities | 9.0.0 | BSD-2-Clause | `src/vendor/entities/` |
| punycode.js | 2.3.1 | MIT | `src/vendor/punycode/` |

Copyright notices are reproduced in the license files. Only import specifiers were modified
(rewritten to relative paths so the code runs without `node_modules`).

`src/markdown.js` (glue: heading ids, TOC, GFM `<del>`, URL policy), `src/cli.js` and the tests
are original code for this project.
