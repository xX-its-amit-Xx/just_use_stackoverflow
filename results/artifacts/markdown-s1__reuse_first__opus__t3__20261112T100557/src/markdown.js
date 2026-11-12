// markdown-s1: Markdown -> HTML renderer.
// Built on vendored commonmark.js 0.31.2 (BSD-2-Clause), see THIRD_PARTY_NOTICES.md.
// Raw HTML is disabled in the parser so it is emitted as escaped text.
import Parser from "./vendor/commonmark/blocks.js";
import HtmlRenderer from "./vendor/commonmark/render/html.js";

const parser = new Parser({ disableHtml: true });
const renderer = new HtmlRenderer({ safe: false });

export function render(markdown) {
    if (markdown == null) markdown = "";
    return renderer.render(parser.parse(String(markdown)));
}

export default render;
