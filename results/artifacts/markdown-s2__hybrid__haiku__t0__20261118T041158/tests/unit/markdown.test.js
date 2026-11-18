import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

test('GFM table with alignment and escaped pipe', () => {
  const html = render('| a | b |\n|:--|--:|\n| `x\\|y` | c |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="right">b<\/th>/);
  assert.match(html, /<code>x\|y<\/code>/);
});

test('strikethrough and emphasis nesting', () => {
  assert.equal(render('~~s~~ ***x***').trim(), '<p><del>s</del> <em><strong>x</strong></em></p>');
});

test('unsafe URLs are replaced by #; safe data image kept', () => {
  const html = render('[a](javascript:x) ![b](data:image/png;base64,AA) [c](data:text/html,x)');
  assert.match(html, /<a href="#">a<\/a>/);
  assert.match(html, /src="data:image\/png;base64,AA"/);
  assert.match(html, /<a href="#">c<\/a>/);
});

test('heading ids and toc with duplicate slugs', () => {
  assert.match(render('## My title', { headingIds: true }), /<h2 id="my-title">My title<\/h2>/);
  const t = toc('# A\n\n# A');
  assert.deepEqual(t.map((h) => h.slug), ['a', 'a-1']);
  assert.equal(t[0].text, 'A');
});

test('slugify removes punctuation and suffixes repeats', () => {
  const seen = new Map();
  assert.equal(slugify('Hello, World! 2', seen), 'hello-world-2');
  assert.equal(slugify('Hello, World! 2', seen), 'hello-world-2-1');
  assert.equal(slugify('a_b-c'), 'a_b-c');
});
