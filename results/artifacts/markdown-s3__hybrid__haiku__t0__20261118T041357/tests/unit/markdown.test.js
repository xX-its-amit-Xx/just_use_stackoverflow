import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

test('slugify follows GitHub style and dedupes', () => {
  assert.equal(slugify('Hello, World! 2'), 'hello-world-2');
  const seen = new Map();
  assert.equal(slugify('A', seen), 'a');
  assert.equal(slugify('A', seen), 'a-1');
  assert.equal(slugify('A', seen), 'a-2');
});

test('headings get ids and toc matches them', () => {
  const md = '# Hi *x*\n\n## Hi *x*\n';
  assert.match(render(md, { headingIds: true }), /<h1 id="hi-x">Hi <em>x<\/em><\/h1>/);
  assert.match(render(md, { headingIds: true }), /<h2 id="hi-x-1">/);
  assert.deepEqual(toc(md).map((h) => h.slug), ['hi-x', 'hi-x-1']);
});

test('raw HTML is escaped and unsafe URLs become #', () => {
  assert.match(render('<script>x</script>'), /&lt;script&gt;/);
  assert.match(render('[a](javascript:alert(1))'), /<a href="#">a<\/a>/);
  assert.match(render('![a](data:text/html,x)'), /<img src="#"/);
  assert.match(render('![a](data:image/png;base64,AA)'), /src="data:image\/png;base64,AA"/);
});

test('GFM tables with alignment', () => {
  const html = render('| a | b |\n|:-|-:|\n| 1 | 2 |\n');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<td align="right">2<\/td>/);
});

test('strikethrough', () => {
  assert.match(render('~~gone~~ *x*'), /<del>gone<\/del>/);
});

test('wiki links resolve and mark missing pages', () => {
  const html = render('[[Home Page]] [[Other|label]] [[Nope]]', {
    wikiLinks: { exists: (s) => s === 'home-page' },
  });
  assert.match(html, /<a href="\/wiki\/home-page" class="wikilink">Home Page<\/a>/);
  assert.match(html, /<a href="\/wiki\/other" class="wikilink missing">label<\/a>/);
  assert.match(html, /<a href="\/wiki\/nope" class="wikilink missing">Nope<\/a>/);
});

test('wiki links are not converted in code, or without the option', () => {
  assert.match(render('`[[x]]`', { wikiLinks: { exists: () => true } }), /<code>\[\[x\]\]<\/code>/);
  assert.match(render('[[x]]'), /\[\[x\]\]/);
});
