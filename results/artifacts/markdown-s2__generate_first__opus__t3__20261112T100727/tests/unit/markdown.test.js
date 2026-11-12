import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('emphasis and strike', () => {
  assert.equal(n(render('***x*** foo_bar_ ~~d~~')), '<p><em><strong>x</strong></em> foo_bar_ <del>d</del></p>');
});
test('lists tight/loose', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('3. a\n\n4. b')), '<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>');
});
test('links and safety', () => {
  assert.equal(n(render('[a][R] <x@y.z>\n\n[r]: /u "t"')), '<p><a href="/u" title="t">a</a> <a href="mailto:x@y.z">x@y.z</a></p>');
  assert.equal(n(render('[a](javascript:alert(1)) ![i](data:image/png;base64,A)')), '<p><a href="#">a</a> <img src="data:image/png;base64,A" alt="i" /></p>');
});
test('tables', () => {
  assert.equal(n(render('| a | b |\n|:-|-:|\n| `x\\|y` | 2 |')),
    '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="left"><code>x|y</code></td><td align="right">2</td></tr></tbody></table>');
});
test('code', () => {
  assert.equal(n(render('```js x\n<a>\n```')), '<pre><code class="language-js">&lt;a&gt;\n</code></pre>');
});
test('heading ids and toc', () => {
  assert.equal(n(render('# My title\n## My title', { headingIds: true })), '<h1 id="my-title">My title</h1><h2 id="my-title-1">My title</h2>');
  assert.deepEqual(toc('# A *b*\nC\n---'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'C', slug: 'c' }]);
  const m = new Map();
  assert.deepEqual([slugify('Hi!', m), slugify('hi', m), slugify('Hi', m)], ['hi', 'hi-1', 'hi-2']);
});
test('cli', () => {
  const out = execFileSync(process.execPath, ['src/cli.js', '-', '--ids'], { input: '# Hi' }).toString();
  assert.equal(n(out), '<h1 id="hi">Hi</h1>');
  const t = JSON.parse(execFileSync(process.execPath, ['src/cli.js', '-', '--toc'], { input: '## X' }).toString());
  assert.deepEqual(t, [{ level: 2, text: 'X', slug: 'x' }]);
});
