// markdown-s1: CommonMark-style Markdown -> HTML renderer.
// Parsing and HTML generation are delegated to the vendored lil-marky bundle
// (MIT, see src/vendor/LICENSE-lil-marky.txt and src/THIRD_PARTY_NOTICES.md).
// This module only configures it for the S1 subset: raw HTML is escaped as
// text (never passed through) and bare-URL autolinking is disabled.
import { create, html } from './vendor/lil-marky.mjs';

const parser = create({
  features: { html: false, extLinkify: false },
  unsafeLinks: true,
});
const toHtml = html({ unsafeLinks: true });

export function render(markdown) {
  return toHtml(parser.parse(String(markdown ?? '')));
}
