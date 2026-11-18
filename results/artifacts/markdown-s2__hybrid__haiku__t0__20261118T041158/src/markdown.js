// markdown-s2: safe Markdown -> HTML renderer.
// Built on the vendored commonmark.js 0.31.2 parser (BSD-2-Clause, see
// src/vendor/commonmark/LICENSE and PROVENANCE.json), with local adaptations:
// GFM tables and strikethrough, raw HTML rendered as escaped text, unsafe URL
// schemes replaced by "#", and GitHub-style heading ids.
import { Parser, HtmlRenderer } from "./vendor/commonmark/index.js";

/**
 * GitHub-style slug. Removes every character that is not a letter, digit,
 * space, "-" or "_", then turns spaces into "-". If `seen` (a Map) is given,
 * repeated slugs get "-1", "-2", ... suffixes and the result is recorded in it.
 */
export function slugify(text, seen) {
    const base = String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/ /g, "-");
    if (!seen) {
        return base;
    }
    const count = seen.get(base);
    if (count === undefined) {
        seen.set(base, 0);
        return base;
    }
    let n = count + 1;
    let slug = `${base}-${n}`;
    while (seen.has(slug)) {
        n += 1;
        slug = `${base}-${n}`;
    }
    seen.set(base, n);
    seen.set(slug, 0);
    return slug;
}

function parseDocument(markdown) {
    const src = String(markdown).replace(/\r\n?/g, "\n");
    return new Parser().parse(src);
}

// Calls fn(node, plainText) for every heading in document order.
function forEachHeading(doc, fn) {
    const walker = doc.walker();
    let event;
    while ((event = walker.next())) {
        const node = event.node;
        if (!event.entering || node.type !== "heading") {
            continue;
        }
        let text = "";
        const inner = node.walker();
        let ev;
        while ((ev = inner.next())) {
            if (ev.entering && (ev.node.type === "text" || ev.node.type === "code")) {
                text += ev.node.literal;
            }
        }
        fn(node, text);
    }
}

export function render(markdown, { headingIds = false } = {}) {
    const doc = parseDocument(markdown);
    if (headingIds) {
        const seen = new Map();
        forEachHeading(doc, (node, text) => {
            node._slug = slugify(text, seen);
        });
    }
    const renderer = new HtmlRenderer({ headingIds: Boolean(headingIds) });
    return renderer.render(doc);
}

export function toc(markdown) {
    const doc = parseDocument(markdown);
    const seen = new Map();
    const out = [];
    forEachHeading(doc, (node, text) => {
        out.push({ level: node.level, text, slug: slugify(text, seen) });
    });
    return out;
}
