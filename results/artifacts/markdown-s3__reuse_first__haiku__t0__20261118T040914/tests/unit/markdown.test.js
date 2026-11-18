import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

test('slugify: GitHub style, drops punctuation, dedupes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('A_b-c'), 'a_b-c');
  const seen = new Map();
  assert.equal(slugify('Intro', seen), 'intro');
  assert.equal(slugify('Intro', seen), 'intro-1');
  assert.equal(slugify('Intro', seen), 'intro-2');
});

test('headings get ids only when headingIds is set; toc matches ids', () => {
  assert.equal(render('# Hi there'), '<h1>Hi there</h1>\n');
  assert.match(render('# Hi there', { headingIds: true }), /<h1 id="hi-there">Hi there<\/h1>/);
  const src = '# Dup\n\n## Dup';
  assert.match(render(src, { headingIds: true }), /<h2 id="dup-1">Dup<\/h2>/);
  assert.deepEqual(toc(src), [
    { level: 1, text: 'Dup', slug: 'dup' },
    { level: 2, text: 'Dup', slug: 'dup-1' },
  ]);
});

test('GFM tables with alignment', () => {
  const html = render('| a | b |\n|:--|--:|\n| 1 | **2** |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="right">b<\/th>/);
  assert.match(html, /<td align="right"><strong>2<\/strong><\/td>/);
});

test('strikethrough renders <del>', () => {
  assert.match(render('~~gone~~'), /<del>gone<\/del>/);
});

test('raw HTML is escaped text, unsafe URLs become #', () => {
  const html = render('<b>x</b>\n\n[a](javascript:alert(1)) [b](data:text/html,x) ![i](data:image/png;base64,AA)');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<a href="#">a<\/a>/);
  assert.match(html, /<a href="#">b<\/a>/);
  assert.match(html, /src="data:image\/png;base64,AA"/);
});

test('wiki links resolve and mark missing targets; code is untouched', () => {
  const opts = { wikiLinks: { exists: (s) => s === 'home-page' } };
  const html = render('[[Home Page]] [[Other|label]] `[[Home Page]]`', opts);
  assert.match(html, /<a href="\/wiki\/home-page" class="wikilink">Home Page<\/a>/);
  assert.match(html, /<a href="\/wiki\/other" class="wikilink missing">label<\/a>/);
  assert.match(html, /<code>\[\[Home Page\]\]<\/code>/);
  assert.equal(render('[[x]]'), '<p>[[x]]</p>\n');
});

test('core CommonMark: lists, code, breaks, thematic break', () => {
  assert.match(render('1. x\n2. y'), /<ol>\n<li>x<\/li>\n<li>y<\/li>\n<\/ol>/);
  assert.match(render('3. x'), /<ol start="3">/);
  assert.match(render('```js\nvar a;\n```'), /<pre><code class="language-js">var a;\n<\/code><\/pre>/);
  assert.match(render('a  \nb'), /a<br \/>\nb/);
  assert.match(render('***'), /<hr \/>/);
});
