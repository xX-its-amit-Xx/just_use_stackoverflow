# Third-party notices

This project vendors or adapts the following third-party material. Each entry is also recorded in `PROVENANCE.json`.

## @dagrejs/dagre (MIT)
- Files: `src/vendor/dagre.esm.js` (unmodified minified ESM bundle), licence text in `src/vendor/dagre.LICENSE` and `src/vendor/dagre.esm.LEGAL.txt`.
- Source: https://github.com/dagrejs/dagre
- Copyright (c) 2012-2014 Chris Pettitt and contributors. Used for the layered (Sugiyama-style) auto-layout.

## fractional-indexing (CC0-1.0)
- Files: `src/vendor/fractional-indexing.js` (unmodified), licence in `src/vendor/fractional-indexing.LICENSE`.
- Source: https://github.com/rocicorp/fractional-indexing
- Dedicated to the public domain under CC0 1.0. Used for z-order keys.

## drawio-mcp (Apache-2.0)
- Adapted material: the attribute parsing, XML entity decoding, `<object>`/`<UserObject>` wrapper handling and `mxGeometry` points parsing, from `shared/mx-xml.js`, re-implemented in `src/core/drawio.js`.
- Source: https://github.com/jgraph/drawio-mcp
- Copyright of the upstream project belongs to its authors. Licence text in `src/vendor/drawio-mcp.LICENSE`.
- Modifications: the code was rewritten as a standalone importer that maps mxGraph cells to this project's element and connector model. The mxGraph model, write-back and other modules were not used.
