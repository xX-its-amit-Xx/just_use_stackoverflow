import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';

const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX and setext headings', () => {
  assert.equal(n(render('# Title ##')), '<h1>Title</h1>');
  assert.equal(n(render('Title\n===')), '<h1>Title</h1>');
  assert.equal(n(render('Sub\n---')), '<h2>Sub</h2>');
  assert.equal(n(render('#5 bolt')), '<p>#5 bolt</p>');
});

test('heading ids', () => {
  assert.equal(render('## My Title', { headingIds: true }).trim(), '<h2 id="my-title">My Title</h2>');
  assert.equal(n(render('## My Title')), '<h2>My Title</h2>');
});

test('emphasis, strong, strikethrough', () => {
  assert.equal(n(render('***x***')), '<p><em><strong>x</strong></em></p>');
  assert.equal(n(render('a_b_c')), '<p>a_b_c</p>');
  assert.equal(n(render('~~gone~~')), '<p><del>gone</del></p>');
});

test('code spans and fenced/indented code', () => {
  assert.equal(n(render('`` a ` b ``')), '<p><code>a ` b</code></p>');
  assert.equal(n(render('```js\nx < 1\n```')), '<pre><code class="language-js">x &lt; 1\n</code></pre>');
  assert.equal(n(render('    code\n    more')), '<pre><code>code\nmore\n</code></pre>');
});

test('blockquote with lazy continuation', () => {
  assert.equal(n(render('> a\nb')), '<blockquote><p>a\nb</p></blockquote>');
});

test('lists: tight, loose, ordered start, nesting', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(n(render('3. x\n4. y')), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(n(render('- a\n  - b')), '<ul><li>a<ul><li>b</li></ul></li></ul>');
});

test('thematic break', () => {
  assert.equal(n(render('***')), '<hr />');
  assert.equal(n(render('___')), '<hr />');
});

test('hard breaks', () => {
  assert.equal(render('a  \nb').trim(), '<p>a<br />\nb</p>');
  assert.equal(render('a\\\nb').trim(), '<p>a<br />\nb</p>');
});

test('links, images, references, autolinks', () => {
  assert.equal(n(render('[t](http://x "ti")')), '<p><a href="http://x" title="ti">t</a></p>');
  assert.equal(n(render('![a](p.png)')), '<p><img src="p.png" alt="a" /></p>');
  assert.equal(n(render('[R][Ref]\n\n[ref]: /u "T"')), '<p><a href="/u" title="T">R</a></p>');
  assert.equal(n(render('<me@example.com>')), '<p><a href="mailto:me@example.com">me@example.com</a></p>');
});

test('tables with alignment and escaped pipes', () => {
  const out = render('| a | b |\n|:-|-:|\n| `c` | d \\| e |');
  assert.match(out, /<th align="left">a<\/th>/);
  assert.match(out, /<th align="right">b<\/th>/);
  assert.match(out, /<td align="left"><code>c<\/code><\/td>/);
  assert.match(out, /<td align="right">d \| e<\/td>/);
});

test('safety: raw html escaped, dangerous URLs neutralised', () => {
  assert.equal(n(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('![x](vbscript:go)'), /src="#"/);
  assert.match(render('[x](file:///etc/passwd)'), /href="#"/);
  assert.match(render('![x](data:text/html;base64,AAAA)'), /src="#"/);
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
});

test('toc and slugify', () => {
  assert.deepEqual(toc('# A *b*\n\n## A *b*'), [
    { level: 1, text: 'A b', slug: 'a-b' },
    { level: 2, text: 'A b', slug: 'a-b-1' },
  ]);
  const seen = new Map();
  assert.equal(slugify('Hello, World!', seen), 'hello-world');
  assert.equal(slugify('Hello, World!', seen), 'hello-world-1');
});
