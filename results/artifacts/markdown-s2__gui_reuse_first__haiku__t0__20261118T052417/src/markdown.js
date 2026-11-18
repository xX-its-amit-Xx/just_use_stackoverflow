// Safe Markdown -> HTML renderer (CommonMark 0.31 + GFM tables/strikethrough).
// The parser and HTML renderer are vendored from commonmark.js (see
// src/upstream and PROVENANCE.json) and adapted for the safety rules.
import Parser from "./upstream/blocks.js";
import HtmlRenderer from "./upstream/render/html.js";
import { slugify, plainText } from "./slug.js";

export function render(markdown, { headingIds = false } = {}) {
    const doc = new Parser({}).parse(String(markdown));
    const renderer = new HtmlRenderer({ headingIds, slugSeen: new Map() });
    return renderer.render(doc);
}

export function toc(markdown) {
    const doc = new Parser({}).parse(String(markdown));
    const seen = new Map();
    const out = [];
    const walker = doc.walker();
    let event;
    while ((event = walker.next())) {
        if (event.entering && event.node.type === "heading") {
            const text = plainText(event.node);
            out.push({ level: event.node.level, text, slug: slugify(text, seen) });
        }
    }
    return out;
}

export { slugify };
