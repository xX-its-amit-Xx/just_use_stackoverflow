CONDITION D — GUI REUSE-FIRST (browser / computer interaction).
- Same goal and MANDATORY PROTOCOL as reuse-first (skipping it invalidates the trial): before creating or editing any file under ./src, use the browser to search for existing implementations (e.g. GitHub repository/code search), inspect promising candidates visually, acquire code by copy/paste through the browser, and build the deliverable by adapting it. Generate only missing functionality and glue. Only if nothing usable exists after searching may you write from scratch; then say so explicitly in your final message and in PROVENANCE.json notes.
- BUT source discovery and acquisition must be done through the graphical browser, not through APIs or shell downloads. Do NOT use curl/wget/git clone/gh/npm view or any web API for discovery or acquisition. (Editor and terminal remain allowed for integration and testing.)
- The browser is driven by the `gui` command (a real Chromium; you see the page only through screenshots):
    gui open <url>                 # navigate (e.g. https://github.com/search?q=...&type=repositories)
    gui screenshot                 # saves a PNG and prints its path -> view it with the Read tool
    gui click <x> <y>              # click at viewport coordinates from the last screenshot (1280x800)
    gui type "<text>" [--enter]    # type into the focused element
    gui key <Key>                  # e.g. Enter, PageDown, Control+a
    gui scroll <dy>                # scroll vertically by dy pixels
    gui select <x1> <y1> <x2> <y2> # drag-select text
    gui copy                       # copy current selection (or clipboard after clicking a page's copy button) to the gui clipboard
    gui paste <file> [--append]    # paste the gui clipboard into a workspace file
    gui back | gui forward | gui url
  Every action is logged for the benchmark. Typical acquisition: open a GitHub file, click "Raw", `gui key Control+a`, `gui copy`, `gui paste src/foo.js`.
- Record ALL provenance in PROVENANCE.json, and keep attribution/license notices for vendored code in src/THIRD_PARTY_NOTICES.md.
