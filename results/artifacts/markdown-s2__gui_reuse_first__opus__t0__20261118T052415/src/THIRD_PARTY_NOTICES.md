# Third-party notices

## commonmark.js 0.31.2 — `src/vendor/commonmark.cjs`

- Source: https://unpkg.com/commonmark@0.31.2/dist/commonmark.js (project: https://github.com/commonmark/commonmark.js)
- License: BSD-2-Clause, Copyright (c) 2014, John MacFarlane. Full license text (including the
  notices for the bundled `from-code-point` polyfill by Mathias Bynens, MIT, and other bundled parts)
  is kept verbatim in `src/vendor/COMMONMARK_LICENSE.txt`.
- The UMD bundle also contains bundled copies of:
  - `mdurl` (MIT, Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin) — URL percent-encoding.
  - `entities` (BSD-2-Clause, Copyright (c) Felix Böhm) — HTML entity decoding tables.
- Modifications made in this project:
  - GFM pipe tables (new `table` block type, block-start rule, row/cell nodes, cell inline parsing).
  - GFM strikethrough (`~` delimiter run handling producing `del` nodes).
  - Container-type list extended for the new node types.
  - HTML rendering (raw-HTML escaping, URL sanitising, heading ids, table/del output) is done by a
    renderer subclass in `src/markdown.js`.
