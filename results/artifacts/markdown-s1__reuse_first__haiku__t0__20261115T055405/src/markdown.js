// Markdown -> HTML renderer (SPEC.md, tier S1).
//
// The parser and HTML renderer are the vendored commonmark.js 0.31.2 sources
// in ./vendor/commonmark (BSD-2-Clause, see vendor/commonmark/LICENSE and
// THIRD_PARTY_NOTICES.md). This file is integration glue only: it adds the
// SPEC rule that raw HTML is never passed through but escaped as text.
import { Parser, HtmlRenderer } from "./vendor/commonmark/index.js";

class SpecHtmlRenderer extends HtmlRenderer {
  // Inline raw HTML: emit it as escaped text.
  html_inline(node) {
    this.out(node.literal);
  }

  // Block raw HTML: emit it as escaped text inside a paragraph so that the
  // output stays well-formed block markup.
  html_block(node) {
    this.cr();
    this.lit("<p>");
    this.out(node.literal.replace(/\n+$/, ""));
    this.lit("</p>");
    this.cr();
  }
}

const parser = new Parser();

/**
 * Render a Markdown string to HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function render(markdown) {
  const doc = parser.parse(String(markdown));
  return new SpecHtmlRenderer({ safe: false }).render(doc);
}
