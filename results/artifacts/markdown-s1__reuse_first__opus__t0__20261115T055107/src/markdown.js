// Markdown -> HTML renderer (CommonMark 0.31 subset).
// Built on a vendored copy of commonmark.js 0.31.2 (BSD-2-Clause), see
// THIRD_PARTY_NOTICES.md. Raw HTML is never passed through: HTML block/inline
// recognition is disabled (local `noHtml` patch), so tags are parsed as
// literal text and escaped by the HTML renderer.
import { Parser, HtmlRenderer } from "./vendor/commonmark/index.js";

const parser = new Parser({ noHtml: true });
const renderer = new HtmlRenderer();

export function render(markdown) {
    const src = markdown == null ? "" : String(markdown);
    return renderer.render(parser.parse(src));
}

export default render;
