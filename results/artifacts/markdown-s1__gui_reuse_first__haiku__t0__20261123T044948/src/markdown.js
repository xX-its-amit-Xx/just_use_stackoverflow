// Minimal Markdown -> HTML renderer (markdown-s1 tier S1).
// Built on the vendored commonmark.js parser/HTML renderer (BSD-2-Clause, see
// THIRD_PARTY_NOTICES.md). Glue here: raw HTML is escaped as text instead of
// being passed through (commonmark.js' default), so output never contains
// unescaped markup from the source.
import { Parser, HtmlRenderer } from "./vendor/commonmark/index.js";
import { escapeXml } from "./vendor/commonmark/common.js";

function makeRenderer() {
  const renderer = new HtmlRenderer({ safe: false });
  // Inline raw HTML: emit the literal source as escaped text.
  renderer.html_inline = function (node) {
    this.lit(escapeXml(node.literal));
  };
  // Block raw HTML: emit the literal source as an escaped paragraph.
  renderer.html_block = function (node) {
    this.cr();
    this.lit("<p>" + escapeXml(node.literal.replace(/\n+$/, "")) + "</p>");
    this.cr();
  };
  return renderer;
}

export function render(markdown) {
  const parser = new Parser();
  const ast = parser.parse(String(markdown).replace(/\r\n?/g, "\n"));
  return makeRenderer().render(ast);
}
