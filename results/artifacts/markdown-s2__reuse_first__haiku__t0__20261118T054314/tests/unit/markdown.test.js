import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX and setext headings, closing hashes stripped', () => {
  assert.equal(n(render('## Title ##')), '<h2>Title</h2>');
  assert.equal(n(render('Head\n===')), '<h1>Head</h1>');
});

test('heading ids and toc', () => {
  const md = '# My Title\n\n## My Title\n\nSetext *x*\n---';
  assert.match(render(md, { headingIds: true }), /<h1 id="my-title">My Title<\/h1>\s*<h2 id="my-title-1">My Title<\/h2>/);
  assert.deepEqual(toc(md).map(h => h.slug), ['my-title', 'my-title-1', 'setext-x']);
  assert.deepEqual(toc(md)[2], { level: 2, text: 'Setext x', slug: 'setext-x' });
});

test('slugify', () => {
  assert.equal(slugify('Hello, World!_a-b'), 'hello-world_a-b');
  const seen = new Map();
  assert.deepEqual([slugify('A', seen), slugify('A', seen), slugify('A', seen)], ['a', 'a-1', 'a-2']);
});

test('emphasis, strong and triple', () => {
  assert.equal(render('***x***').trim(), '<p><em><strong>x</strong></em></p>');
  assert.equal(render('a_b_c and _x_').trim(), '<p>a_b_c and <em>x</em></p>');
});

test('strikethrough to del', () => {
  assert.equal(render('~~s~~').trim(), '<p><del>s</del></p>');
});

test('code spans and fences', () => {
  assert.equal(render('`` a ` b ``').trim(), '<p><code>a ` b</code></p>');
  assert.match(render('```js extra\nx<y\n```'), /<pre><code class="language-js">x&lt;y\n<\/code><\/pre>/);
  assert.match(render('    code\n'), /<pre><code>code\n<\/code><\/pre>/);
});

test('blockquote lazy continuation and thematic break', () => {
  assert.equal(n(render('> a\nb')), '<blockquote><p>a\nb</p></blockquote>');
  assert.match(render('***'), /<hr \/>/);
});

test('lists: ordered start, tight and loose', () => {
  assert.match(render('3. a\n4. b'), /<ol start="3">/);
  assert.doesNotMatch(render('- a\n- b'), /<p>/);
  assert.match(render('- a\n\n- b'), /<li>\s*<p>a<\/p>/);
});

test('links, images, references, autolinks', () => {
  assert.match(render('[t](http://a "ti")'), /<a href="http:\/\/a" title="ti">t<\/a>/);
  assert.match(render('![alt](/i.png)'), /<img src="\/i.png" alt="alt" \/>/);
  assert.match(render('[Foo][REF]\n\n[ref]: /u "T"'), /<a href="\/u" title="T">Foo<\/a>/);
  assert.match(render('<me@example.com>'), /href="mailto:me@example.com"/);
});

test('dangerous URLs replaced with #', () => {
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('[x](vbscript:msg)'), /href="#"/);
  assert.match(render('[x](file:///etc/passwd)'), /href="#"/);
  assert.match(render('![x](data:text/html;base64,AA)'), /src="#"/);
  assert.match(render('![x](data:image/gif;base64,AA)'), /src="data:image\/gif;base64,AA"/);
});

test('raw html is escaped, not passed through', () => {
  assert.equal(render('<div onclick="x">hi</div>').trim(), '<p>&lt;div onclick=&quot;x&quot;&gt;hi&lt;/div&gt;</p>');
  assert.match(render('a <span>b</span>'), /&lt;span&gt;/);
});

test('escapes and hard breaks', () => {
  assert.equal(render('\\*x\\*').trim(), '<p>*x*</p>');
  assert.match(render('a  \nb'), /a<br \/>\nb/);
  assert.match(render('a\\\nb'), /a<br \/>\nb/);
  assert.match(render('a\nb'), /a\nb/);
});

test('tables with alignment, inline markup, escaped pipes', () => {
  const html = render('| a | b | c |\n|:-|:-:|--:|\n| *x* | `y` | p \\| q |');
  assert.match(html, /<th style="text-align:left">a<\/th>/);
  assert.match(html, /<th style="text-align:center">b<\/th>/);
  assert.match(html, /<td style="text-align:right">p \| q<\/td>/);
  assert.match(html, /<em>x<\/em>/);
});
