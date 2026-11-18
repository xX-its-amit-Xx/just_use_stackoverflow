import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../src/markdown.js';

const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX and setext headings, closing hashes stripped', () => {
  assert.equal(n(render('Setext\n===\n\n## Foo ##')), '<h1>Setext</h1><h2>Foo</h2>');
});
test('heading ids', () => {
  assert.equal(n(render('## My title', { headingIds: true })), '<h2 id="my-title">My title</h2>');
});
test('hard and soft breaks', () => {
  assert.equal(render('a  \nb\\\nc\nd').replace(/\n$/, ''), '<p>a<br />\nb<br />\nc\nd</p>');
});
test('emphasis, strong and triple emphasis', () => {
  assert.equal(n(render('***x*** _y_ __z__')), '<p><em><strong>x</strong></em> <em>y</em> <strong>z</strong></p>');
});
test('intraword underscore does not emphasize', () => {
  assert.equal(n(render('snake_case_name')), '<p>snake_case_name</p>');
});
test('strikethrough', () => {
  assert.equal(n(render('~~strike~~')), '<p><del>strike</del></p>');
});
test('code spans and fenced code with info string', () => {
  assert.equal(n(render('`a`` b`')), '<p><code>a`` b</code></p>');
  assert.match(render('```js extra\nx < y\n```'), /<pre><code class="language-js">x &lt; y\n<\/code><\/pre>/);
});
test('indented code block', () => {
  assert.equal(render('    code'), '<pre><code>code\n</code></pre>\n');
});
test('blockquote with lazy continuation and nesting', () => {
  assert.equal(n(render('> q\nlazy')), '<blockquote><p>q\nlazy</p></blockquote>');
});
test('thematic breaks', () => {
  for (const hr of ['---', '***', '___']) assert.match(render(hr), /<hr \/>/);
});
test('ordered list start attribute and tight/loose lists', () => {
  assert.equal(n(render('5. five\n6. six')), '<ol start="5"><li>five</li><li>six</li></ol>');
  assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
});
test('links, images, reference links and autolinks', () => {
  assert.match(render('[t](http://e.com "T")'), /<a href="http:\/\/e.com" title="T">t<\/a>/);
  assert.match(render('![alt](/i.png "ti")'), /<img src="\/i.png" alt="alt" title="ti" \/>/);
  assert.match(render('[Ref][R]\n\n[r]: /u'), /<a href="\/u">Ref<\/a>/);
  assert.match(render('<https://x.y/z>'), /<a href="https:\/\/x.y\/z">/);
  assert.match(render('<me@example.com>'), /<a href="mailto:me@example.com">/);
});
test('backslash escapes and entities', () => {
  assert.equal(n(render('\\*x\\* &copy; &amp; &#65;')), '<p>*x* © &amp; A</p>');
});
test('raw html is escaped, not passed through', () => {
  assert.equal(n(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(n(render('<b>x</b>')), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});
test('unsafe URL schemes become #', () => {
  assert.match(render('[a](javascript:alert(1))'), /<a href="#">a<\/a>/);
  assert.match(render('[a](VBScript:x)'), /<a href="#">a<\/a>/);
  assert.match(render('[a](file:///etc/passwd)'), /<a href="#">a<\/a>/);
  assert.match(render('[a](data:text/html,x)'), /<a href="#">a<\/a>/);
  assert.match(render('![i](data:image/png;base64,AA)'), /<img src="data:image\/png;base64,AA"/);
  assert.match(render('![i](file:///x.png)'), /<img src="#"/);
});
test('GFM table with alignment and inline markup', () => {
  const html = render('| a | b | c |\n|:--|:-:|--:|\n| **1** | \\| x | 3 |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="center">b<\/th>/);
  assert.match(html, /<th align="right">c<\/th>/);
  assert.match(html, /<td align="left"><strong>1<\/strong><\/td>/);
  assert.match(html, /<td align="center">\| x<\/td>/);
});
test('table without body rows and ragged rows', () => {
  assert.equal(n(render('A | B\n- | -')), '<table><thead><tr><th>A</th><th>B</th></tr></thead></table>');
  assert.match(render('A | B\n-|-\n1'), /<td>1<\/td><td><\/td>/);
});
test('toc lists headings with slugs and plain text', () => {
  assert.deepEqual(toc('# Hi *there*\n\nSub\n---\n\n# Hi *there*'), [
    { level: 1, text: 'Hi there', slug: 'hi-there' },
    { level: 2, text: 'Sub', slug: 'sub' },
    { level: 1, text: 'Hi there', slug: 'hi-there-1' },
  ]);
});
test('slugify', () => {
  assert.equal(slugify('Hello, World! _x_-y 2'), 'hello-world-_x_-y-2');
  const seen = new Map();
  assert.deepEqual([slugify('A', seen), slugify('A', seen), slugify('A', seen)], ['a', 'a-1', 'a-2']);
});
