import { test } from "node:test";
import assert from "node:assert/strict";
import { render, toc, slugify } from "../../src/markdown.js";

test("slugify follows GitHub-style rules and de-duplicates", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  const seen = new Map();
  assert.equal(slugify("A b", seen), "a-b");
  assert.equal(slugify("A b", seen), "a-b-1");
  assert.equal(slugify("A b", seen), "a-b-2");
});

test("headings get ids and toc lists them in order", () => {
  const md = "# Top\n\n## Top\n\nText\n\n### Deep *one*";
  assert.match(render(md, { headingIds: true }), /<h1 id="top">Top<\/h1>[\s\S]*<h2 id="top-1">Top<\/h2>/);
  assert.deepEqual(toc(md), [
    { level: 1, text: "Top", slug: "top" },
    { level: 2, text: "Top", slug: "top-1" },
    { level: 3, text: "Deep one", slug: "deep-one" },
  ]);
});

test("raw HTML is escaped and unsafe URLs become #", () => {
  const html = render('<b>x</b>\n\n[a](javascript:alert(1)) [b](data:text/html,x) ![c](data:image/png;base64,AA)');
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<a href="#">a<\/a>/);
  assert.match(html, /<a href="#">b<\/a>/);
  assert.match(html, /<img src="data:image\/png;base64,AA" alt="c" \/>/);
});

test("GFM tables and strikethrough", () => {
  const html = render("| a | b |\n|:-|-:|\n| 1 | ~~x~~ |");
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="right">b<\/th>/);
  assert.match(html, /<td align="right"><del>x<\/del><\/td>/);
});

test("wiki links resolve, mark missing targets and skip code", () => {
  const exists = (s) => s === "page-title";
  const html = render("[[Page Title]] [[x|Label]] `[[no]]`", { wikiLinks: { exists } });
  assert.match(html, /<a href="\/wiki\/page-title" class="wikilink">Page Title<\/a>/);
  assert.match(html, /<a href="\/wiki\/x" class="wikilink missing">Label<\/a>/);
  assert.match(html, /<code>\[\[no\]\]<\/code>/);
  assert.equal(render("[[Plain]]"), "<p>[[Plain]]</p>\n");
});

test("entities and CommonMark basics", () => {
  assert.equal(render("a &amp; &copy; &#65;"), "<p>a &amp; © A</p>\n");
  assert.equal(render("```js\nx\n```"), '<pre><code class="language-js">x\n</code></pre>\n');
  assert.equal(render("1. a\n2. b").startsWith("<ol>"), true);
});
