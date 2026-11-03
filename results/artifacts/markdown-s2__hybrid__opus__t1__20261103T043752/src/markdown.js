// Safe Markdown -> HTML renderer (CommonMark 0.31 + GFM tables/strikethrough).
// Parsing/rendering core is adapted from commonmark.js (see THIRD_PARTY_NOTICES.md).
import Parser from "./cm/blocks.js";
import HtmlRenderer from "./cm/html.js";

function parse(markdown) {
    const parser = new Parser({});
    return parser.parse(String(markdown ?? ""));
}

// Plain text of a node's inline content (markup removed).
function plainText(node) {
    let out = "";
    const walker = node.walker();
    let ev;
    while ((ev = walker.next())) {
        if (!ev.entering) continue;
        const n = ev.node;
        switch (n.type) {
            case "text":
            case "code":
            case "html_inline":
                out += n.literal;
                break;
            case "softbreak":
            case "linebreak":
                out += " ";
                break;
        }
    }
    return out;
}

function headings(doc) {
    const result = [];
    const walker = doc.walker();
    let ev;
    while ((ev = walker.next())) {
        if (ev.entering && ev.node.type === "heading") result.push(ev.node);
    }
    return result;
}

export function slugify(text, seen) {
    let slug = String(text ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
        .replace(/ /g, "-");
    if (seen instanceof Map) {
        const original = slug;
        while (seen.has(slug)) {
            const count = seen.get(original) + 1;
            seen.set(original, count);
            slug = original + "-" + count;
        }
        seen.set(slug, 0);
    }
    return slug;
}

export function render(markdown, { headingIds = false } = {}) {
    const doc = parse(markdown);
    if (headingIds) {
        const seen = new Map();
        for (const h of headings(doc)) h._headingId = slugify(plainText(h), seen);
    }
    return new HtmlRenderer({}).render(doc);
}

export function toc(markdown) {
    const doc = parse(markdown);
    const seen = new Map();
    return headings(doc).map((h) => {
        const text = plainText(h);
        return { level: h.level, text, slug: slugify(text, seen) };
    });
}

export default { render, toc, slugify };
