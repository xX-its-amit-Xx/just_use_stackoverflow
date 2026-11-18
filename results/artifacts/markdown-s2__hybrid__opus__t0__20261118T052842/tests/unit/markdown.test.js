import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();
const r = (s, o) => n(render(s, o));

test('headings', () => {
  assert.equal(r('## Title ##'), '<h2>Title</h2>');
  assert.equal(r('Title\n==='), '<h1>Title</h1>');
  assert.equal(r('# My title\n## My title', { headingIds: true }), '<h1 id="my-title">My title</h1><h2 id="my-title-1">My title</h2>');
});
test('inline', () => {
  assert.equal(r('***x*** ~~y~~ snake_case_x'), '<p><em><strong>x</strong></em> <del>y</del> snake_case_x</p>');
  assert.equal(r('`` a`b ``'), '<p><code>a`b</code></p>');
  assert.equal(r('a  \nb\\\nc'), '<p>a<br />\nb<br />\nc</p>');
  assert.equal(r('<https://x.y> <me@x.y>'), '<p><a href="https://x.y">https://x.y</a> <a href="mailto:me@x.y">me@x.y</a></p>');
  assert.equal(r('[a][R]\n\n[r]: /u "t"'), '<p><a href="/u" title="t">a</a></p>');
});
test('blocks', () => {
  assert.equal(r('```js extra\n<x>\n```'), '<pre><code class="language-js">&lt;x&gt;\n</code></pre>');
  assert.equal(r('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(r('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.equal(r('> a\nb'), '<blockquote><p>a\nb</p></blockquote>');
});
test('tables', () => {
  assert.equal(r('| a | b |\n|:-:|--:|\n| *x* | y\\|z |'),
    '<table><thead><tr><th align="center">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="center"><em>x</em></td><td align="right">y|z</td></tr></tbody></table>');
});
test('safety', () => {
  assert.equal(r('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(r('[a](javascript:alert(1)) ![b](data:image/png;base64,AA) ![c](data:text/html,x)'),
    '<p><a href="#">a</a> <img src="data:image/png;base64,AA" alt="b" /> <img src="#" alt="c" /></p>');
});
test('toc + slugify', () => {
  assert.deepEqual(toc('# A *b*\n\nx\n---\n# A b'), [
    { level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'x', slug: 'x' }, { level: 1, text: 'A b', slug: 'a-b-1' }]);
  assert.equal(slugify('Hello, World! _x_'), 'hello-world-_x_');
});
test('cli', () => {
  const out = execFileSync('node', ['src/cli.js', '-', '--ids'], { input: '# Hi' }).toString();
  assert.equal(n(out), '<h1 id="hi">Hi</h1>');
  const t = JSON.parse(execFileSync('node', ['src/cli.js', '-', '--toc'], { input: '# Hi' }).toString());
  assert.deepEqual(t, [{ level: 1, text: 'Hi', slug: 'hi' }]);
});
