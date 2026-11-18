// Safe Markdown -> HTML renderer (CommonMark + GFM tables/strikethrough).
// Parser core is vendored from commonmark.js (see THIRD_PARTY_NOTICES.md).
import Parser from "./vendor/commonmark/blocks.js";
import HtmlRenderer from "./vendor/commonmark/render/html.js";
import { escapeXml } from "./vendor/commonmark/common.js";

const reUnsafeScheme = /^(?:javascript|vbscript|file|data):/i;
const reSafeData = /^data:image\/(?:png|gif|jpeg|webp);/i;

export function isUnsafeUrl(url) {
    // Strip whitespace/control characters that browsers ignore in schemes.
    const u = String(url || "").replace(/[\u0000- \u007f]/g, "");
    return reUnsafeScheme.test(u) && !reSafeData.test(u);
}

function safeUrl(url) {
    return isUnsafeUrl(url) ? "#" : url;
}

export function slugify(text, seen) {
    let slug = String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/ /g, "-");
    if (seen instanceof Map) {
        const original = slug;
        while (seen.has(slug)) {
            const n = seen.get(original) + 1;
            seen.set(original, n);
            slug = original + "-" + n;
        }
        seen.set(slug, 0);
    }
    return slug;
}

function plainText(node) {
    let out = "";
    const walker = node.walker();
    let ev;
    while ((ev = walker.next())) {
        const n = ev.node;
        if (!ev.entering) continue;
        switch (n.type) {
            case "text":
            case "code":
                out += n.literal;
                break;
            case "softbreak":
            case "linebreak":
                out += " ";
                break;
            case "html_inline":
                out += n.literal;
                break;
        }
    }
    return out;
}

function parse(markdown) {
    const parser = new Parser({ allowHtml: true });
    return parser.parse(String(markdown ?? ""));
}

function headingNodes(doc) {
    const res = [];
    const walker = doc.walker();
    let ev;
    while ((ev = walker.next())) {
        if (ev.entering && ev.node.type === "heading") res.push(ev.node);
    }
    return res;
}

class SafeRenderer extends HtmlRenderer {
    constructor(opts) {
        super({});
        this.headingIds = !!opts.headingIds;
        this.seen = new Map();
    }
    heading(node, entering) {
        const tagname = "h" + node.level;
        if (entering) {
            const attrs = this.attrs(node);
            if (this.headingIds) {
                attrs.push(["id", this.esc(slugify(plainText(node), this.seen))]);
            }
            this.cr();
            this.tag(tagname, attrs);
        } else {
            this.tag("/" + tagname);
            this.cr();
        }
    }
    link(node, entering) {
        if (entering) {
            const attrs = this.attrs(node);
            attrs.push(["href", this.esc(safeUrl(node.destination))]);
            if (node.title) attrs.push(["title", this.esc(node.title)]);
            this.tag("a", attrs);
        } else {
            this.tag("/a");
        }
    }
    image(node, entering) {
        if (entering) {
            if (this.disableTags === 0) {
                this.lit('<img src="' + this.esc(safeUrl(node.destination)) + '" alt="');
            }
            this.disableTags += 1;
        } else {
            this.disableTags -= 1;
            if (this.disableTags === 0) {
                if (node.title) this.lit('" title="' + this.esc(node.title));
                this.lit('" />');
            }
        }
    }
    html_inline(node) {
        this.out(node.literal);
    }
    html_block(node) {
        this.cr();
        this.tag("p");
        this.out(node.literal);
        this.tag("/p");
        this.cr();
    }
    strikethrough(node, entering) {
        this.tag(entering ? "del" : "/del");
    }
    table(node, entering) {
        if (entering) {
            this.cr();
            this.tag("table");
            this.cr();
        } else {
            const last = node.lastChild;
            if (last && !last.isHeader) {
                this.cr();
                this.tag("/tbody");
            }
            this.cr();
            this.tag("/table");
            this.cr();
        }
    }
    table_row(node, entering) {
        if (entering) {
            if (node.isHeader) {
                this.cr();
                this.tag("thead");
                this.cr();
            } else if (node.prev && node.prev.isHeader) {
                this.cr();
                this.tag("tbody");
                this.cr();
            }
            this.cr();
            this.tag("tr");
            this.cr();
        } else {
            this.cr();
            this.tag("/tr");
            this.cr();
            if (node.isHeader) {
                this.tag("/thead");
                this.cr();
            }
        }
    }
    table_cell(node, entering) {
        const name = node.isHeader ? "th" : "td";
        if (entering) {
            const attrs = [];
            if (node.align) attrs.push(["align", node.align]);
            this.cr();
            this.tag(name, attrs);
        } else {
            this.tag("/" + name);
            this.cr();
        }
    }
}

export function render(markdown, { headingIds = false } = {}) {
    const doc = parse(markdown);
    return new SafeRenderer({ headingIds }).render(doc);
}

export function toc(markdown) {
    const doc = parse(markdown);
    const seen = new Map();
    return headingNodes(doc).map((h) => {
        const text = plainText(h);
        return { level: h.level, text, slug: slugify(text, seen) };
    });
}

export { escapeXml as escapeHtml };
export default { render, toc, slugify };
