# Third-party notices

This project vendors three small third-party libraries under `src/vendor/`
(no runtime npm dependencies are used). Their licenses are reproduced in the
LICENSE files next to the copied code.

## commonmark.js 0.31.2 — BSD-2-Clause
Copyright (c) 2014–2015 John MacFarlane (commonmark.js contributors).
Location: `src/vendor/commonmark/` (license: `src/vendor/commonmark/LICENSE`).
Locally modified: GFM tables, `~~strikethrough~~`, raw HTML escaping, safe URL
handling (`#` replacement), heading ids, wiki-link class attribute, vendored
import paths. See `PROVENANCE.json` for details.

## entities 9.0.0 — BSD-2-Clause
Copyright (c) Felix Böhm; entity data also credits Mathias Bynens (see LICENSE).
Location: `src/vendor/entities/` (license: `src/vendor/entities/LICENSE`).
Used unmodified (HTML entity decoding for commonmark).

## mdurl 2.1.0 — MIT
Copyright (c) 2014–2015 Vitaly Puzrin, Alex Kocharin.
Location: `src/vendor/mdurl/` (license: `src/vendor/mdurl/LICENSE`).
Used unmodified (`encode.js`, URL normalisation for commonmark).
