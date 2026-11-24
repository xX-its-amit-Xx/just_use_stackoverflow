# Third-party notices

## dagre (directed graph layout)

- Files: `src/vendor/dagre/dagre.esm.js` (unmodified bundle copied from the dagre repository), `src/vendor/dagre/LEGAL.txt` (license text shipped with the bundle).
- Source: https://github.com/dagrejs/dagre (dist/dagre.esm.js, master branch)
- License: MIT, Copyright (c) 2012-2014 Chris Pettitt. Full text as shipped:

```
/*
@license

Copyright (c) 2012-2014 Chris Pettitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
```

The bundle is used by `src/core/layout.js` for the layered (Sugiyama-style) auto-layout. Nothing else in the project is copied from dagre.
