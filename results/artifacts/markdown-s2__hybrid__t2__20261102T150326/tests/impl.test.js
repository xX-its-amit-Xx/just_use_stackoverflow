import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['## T\n\nx', '<h2>T</h2><p>x</p>'],
  ['Title\n===\n\nSub\n---', '<h1>Title</h1><h2>Sub</h2>'],
  ['***x***', '<p><em><strong>x</strong></em></p>'],
  ['snake_case_word *a* **b** ~~c~~', '<p>snake_case_word <em>a</em> <strong>b</strong> <del>c</del></p>'],
  ['- a\n- b\n  - c', '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>'],
  ['- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['> a\nb\n\n> > c', '<blockquote><p>a\nb</p></blockquote><blockquote><blockquote><p>c</p></blockquote></blockquote>'],
  ['```js x\na<b\n```', '<pre><code class="language-js">a&lt;b\n</code></pre>'],
  ['    code\n\n    more', '<pre><code>code\n\nmore\n</code></pre>'],
  ['[a][R] [R]\n\n[r]: /u?a=1&b "T"', '<p><a href="/u?a=1&amp;b" title="T">a</a> <a href="/u?a=1&amp;b" title="T">R</a></p>'],
  ['[x](javascript:alert(1)) ![i](data:text/html,x)', '<p><a href="#">x</a> <img src="#" alt="i" /></p>'],
  ['<a@b.co> <https://x.y/z>', '<p><a href="mailto:a@b.co">a@b.co</a> <a href="https://x.y/z">https://x.y/z</a></p>'],
  ['a  \nb\\\nc', '<p>a<br />\nb<br />\nc</p>'],
  ['`` a`b ``', '<p><code>a`b</code></p>'],
  ['| a | b |\n|:--|--:|\n| *x* | y\\|z |', '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="left"><em>x</em></td><td align="right">y|z</td></tr></tbody></table>'],
  ['<script>x</script>', '<p>&lt;script&gt;x&lt;/script&gt;</p>'],
  ['***\n___', '<hr /><hr />'],
];
for (const [i, o] of cases) test(JSON.stringify(i), () => assert.equal(n(render(i)), o));
test('ids/toc', () => {
  assert.equal(n(render('## My title\n## My title', { headingIds: true })), '<h2 id="my-title">My title</h2><h2 id="my-title-1">My title</h2>');
  assert.deepEqual(toc('# A *b*\n\nx\n---'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'x', slug: 'x' }]);
  assert.equal(slugify("Hi, there!"), 'hi-there');
});
