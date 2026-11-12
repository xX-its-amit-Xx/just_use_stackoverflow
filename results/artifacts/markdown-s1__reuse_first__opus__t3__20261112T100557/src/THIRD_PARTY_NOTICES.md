# Third-party notices

## commonmark.js 0.31.2 — src/vendor/commonmark/
https://github.com/commonmark/commonmark.js — BSD-2-Clause, Copyright (c) 2014, John MacFarlane. Full license: src/vendor/commonmark/LICENSE.
Modified: raw HTML parsing (HTML blocks and inline HTML) can be disabled via a `disableHtml` option; import paths rewritten to vendored deps.

## mdurl 1.0.1 (encode.js) — src/vendor/mdurl/
https://github.com/markdown-it/mdurl — MIT, Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin. Full license: src/vendor/mdurl/LICENSE.
Modified: converted from CommonJS to ES module export.

## entities 3.0.1 — src/vendor/entities/
https://github.com/fb55/entities — BSD-2-Clause, Copyright (c) Felix Böhm. Full license: src/vendor/entities/LICENSE.
Used: the named entity map (maps/entities.json, converted to an ES module) and decodeCodePoint (lib/decode_codepoint.js, itself adapted from mathiasbynens/he, MIT). The decodeHTMLStrict wrapper is a small rewrite.
