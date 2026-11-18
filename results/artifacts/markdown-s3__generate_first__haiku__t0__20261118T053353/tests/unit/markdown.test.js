import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify, wikiLinkSlugs } from '../../src/markdown.js';

const norm = (s) => s.replace(/\n/g, '').trim();

test('basic blocks and inlines', () => {
  assert.equal(norm(render('# Hello *there*')), '<h1>Hello <em>there</em></h1>');
  assert.equal(norm(render('a **b** `c` ~~d~~')), '<p>a <strong>b</strong> <code>c</code> <del>d</del></p>');
  assert.equal(norm(render('a  \nb')), '<p>a<br />b</p>');
  assert.equal(norm(render('***')), '<hr />');
  assert.equal(norm(render('> q')), '<blockquote><p>q</p></blockquote>');
});

test('code blocks carry language classes', () => {
  assert.equal(
    render('```js\nx\n```'),
    '<pre><code class="language-js">x\n</code></pre>\n',
  );
  assert.equal(render('    a\n    b'), '<pre><code>a\nb\n</code></pre>\n');
});

test('lists: tight, loose, ordered start', () => {
  assert.equal(norm(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(norm(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(norm(render('3. x\n4. y')), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(norm(render('- a\n  - b')), '<ul><li>a<ul><li>b</li></ul></li></ul>');
});

test('links, images, autolinks and references', () => {
  assert.equal(norm(render('[t](http://x.io "ti")')), '<p><a href="http://x.io" title="ti">t</a></p>');
  assert.equal(norm(render('![alt *x*](a.png)')), '<p><img src="a.png" alt="alt x" /></p>');
  assert.equal(norm(render('<https://e.com>')), '<p><a href="https://e.com">https://e.com</a></p>');
  assert.equal(norm(render('[r][id]\n\n[id]: /u')), '<p><a href="/u">r</a></p>');
  assert.equal(norm(render('[a](b\\(c\\))')), '<p><a href="b(c)">a</a></p>');
});

test('unsafe URL schemes become #', () => {
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('[x](JaVaScRiPt:alert(1))'), /href="#"/);
  assert.match(render('[x](vbscript:x)'), /href="#"/);
  assert.match(render('[x](file:///etc/passwd)'), /href="#"/);
  assert.match(render('![x](data:text/html;base64,AAAA)'), /src="#"/);
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
});

test('raw HTML is escaped text', () => {
  const html = render('<b onclick="x">hi</b>\n\n<div>\n*blk*\n</div>');
  assert.doesNotMatch(html, /<b /);
  assert.doesNotMatch(html, /<div>/);
  assert.match(html, /&lt;b onclick=&quot;x&quot;&gt;hi&lt;\/b&gt;/);
});

test('backslash escapes and entities', () => {
  assert.equal(norm(render('\\*x\\* &amp; &copy; &#65;')), '<p>*x* &amp; © A</p>');
});

test('GFM tables with alignment', () => {
  const html = render('| a | b |\n|:-|-:|\n| 1 | 2 |\n| 3 |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="right">b<\/th>/);
  assert.match(html, /<td align="right">2<\/td>/);
  assert.match(html, /<td align="right"><\/td>/);
});

test('headings: ids, slugs, duplicates, toc', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('a_b-c d'), 'a_b-c-d');
  const seen = new Map();
  assert.equal(slugify('Intro', seen), 'intro');
  assert.equal(slugify('Intro', seen), 'intro-1');
  assert.equal(slugify('Intro', seen), 'intro-2');
  const t = toc('# One\n## Two *x*\n# One');
  assert.deepEqual(t, [
    { level: 1, text: 'One', slug: 'one' },
    { level: 2, text: 'Two x', slug: 'two-x' },
    { level: 1, text: 'One', slug: 'one-1' },
  ]);
  assert.match(render('# One\n# One', { headingIds: true }), /<h1 id="one">One<\/h1>\n<h1 id="one-1">One<\/h1>/);
});

test('wiki links', () => {
  const opts = { wikiLinks: { exists: (s) => s === 'page-title' } };
  assert.equal(
    norm(render('[[Page Title]]', opts)),
    '<p><a href="/wiki/page-title" class="wikilink">Page Title</a></p>',
  );
  assert.equal(
    norm(render('[[Missing|Label]]', opts)),
    '<p><a href="/wiki/missing" class="wikilink missing">Label</a></p>',
  );
  assert.equal(norm(render('`[[Page Title]]`', opts)), '<p><code>[[Page Title]]</code></p>');
  assert.equal(norm(render('[[Page Title]]')), '<p>[[Page Title]]</p>');
  assert.deepEqual(wikiLinkSlugs('[[B]] [[a|x]] [[B]]'), ['a', 'b']);
});

test('emphasis edge cases', () => {
  assert.equal(norm(render('*a **b** c*')), '<p><em>a <strong>b</strong> c</em></p>');
  assert.equal(norm(render('foo_bar_baz')), '<p>foo_bar_baz</p>');
  assert.equal(norm(render('**a*b*c**')), '<p><strong>a<em>b</em>c</strong></p>');
});
