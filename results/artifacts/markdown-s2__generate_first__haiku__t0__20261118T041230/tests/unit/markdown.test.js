import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

const flat = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX and setext headings, closing hashes stripped', () => {
  assert.equal(flat(render('## Title ##')), '<h2>Title</h2>');
  assert.equal(flat(render('Title\n===')), '<h1>Title</h1>');
  assert.equal(flat(render('Sub\n---')), '<h2>Sub</h2>');
});

test('heading ids use GitHub-style slugs with dedupe', () => {
  assert.equal(flat(render('# My title\n\n# My title', { headingIds: true })),
    '<h1 id="my-title">My title</h1><h1 id="my-title-1">My title</h1>');
});

test('emphasis rules', () => {
  assert.equal(flat(render('***x***')), '<p><em><strong>x</strong></em></p>');
  assert.equal(flat(render('snake_case_word')), '<p>snake_case_word</p>');
  assert.equal(flat(render('~~gone~~')), '<p><del>gone</del></p>');
});

test('code spans and fenced code', () => {
  assert.equal(flat(render('`` a ` b ``')), '<p><code>a ` b</code></p>');
  assert.equal(flat(render('```js\nx\n```')), '<pre><code class="language-js">x\n</code></pre>');
  assert.equal(flat(render('    code')), '<pre><code>code\n</code></pre>');
});

test('lists: tight, loose, ordered start', () => {
  assert.equal(flat(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(flat(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(flat(render('3) x\n4) y')), '<ol start="3"><li>x</li><li>y</li></ol>');
});

test('links, images, references and autolinks', () => {
  assert.equal(flat(render('[t](http://x "T")')), '<p><a href="http://x" title="T">t</a></p>');
  assert.equal(flat(render('![i](a.png)')), '<p><img src="a.png" alt="i" /></p>');
  assert.equal(flat(render('[Foo][bar]\n\n[BAR]: /u')), '<p><a href="/u">Foo</a></p>');
  assert.equal(flat(render('<me@x.io>')), '<p><a href="mailto:me@x.io">me@x.io</a></p>');
});

test('unsafe URLs are neutralised', () => {
  assert.equal(flat(render('[x](javascript:alert(1))')), '<p><a href="#">x</a></p>');
  assert.equal(flat(render('![x](data:text/html,hi)')), '<p><img src="#" alt="x" /></p>');
  assert.match(flat(render('![x](data:image/png;base64,AA)')), /src="data:image\/png;base64,AA"/);
});

test('raw HTML is escaped, entities decoded', () => {
  assert.equal(flat(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(flat(render('&copy; &amp; &lt;')), '<p>© &amp; &lt;</p>');
});

test('hard breaks and escapes', () => {
  assert.equal(flat(render('a  \nb')), '<p>a<br />\nb</p>');
  assert.equal(flat(render('\\*x\\*')), '<p>*x*</p>');
});

test('GFM table with alignment and escaped pipe', () => {
  const html = render('| a | b |\n|:-|-:|\n| `x` | c \\| d |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<td align="right">c \| d<\/td>/);
});

test('toc lists headings in document order with slugs', () => {
  assert.deepEqual(toc('# A\n\n> ## B *x*\n\nC\n---\n\n## A').map(h => [h.level, h.text, h.slug]), [
    [1, 'A', 'a'], [2, 'B x', 'b-x'], [2, 'C', 'c'], [2, 'A', 'a-1'],
  ]);
});

test('slugify', () => {
  assert.equal(slugify('Hello, World! 2'), 'hello-world-2');
  const seen = new Map();
  assert.equal(slugify('x', seen), 'x');
  assert.equal(slugify('x', seen), 'x-1');
});
