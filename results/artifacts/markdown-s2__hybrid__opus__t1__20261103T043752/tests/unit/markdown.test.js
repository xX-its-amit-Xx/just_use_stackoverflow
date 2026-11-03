import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('headings with ids and dedup', () => {
  assert.equal(n(render('## My title ##\n\nMy title\n---', { headingIds: true })),
    '<h2 id="my-title">My title</h2><h2 id="my-title-1">My title</h2>');
});
test('toc', () => {
  assert.deepEqual(toc('# A *b* `c`\n\nx\n===\n\n# A b c'), [
    { level: 1, text: 'A b c', slug: 'a-b-c' },
    { level: 1, text: 'x', slug: 'x' },
    { level: 1, text: 'A b c', slug: 'a-b-c-1' },
  ]);
});
test('slugify', () => {
  assert.equal(slugify('Hello, World! _x_ -y'), 'hello-world-_x_--y');
  const m = new Map();
  assert.deepEqual(['a', 'a', 'a'].map(s => slugify(s, m)), ['a', 'a-1', 'a-2']);
});
test('emphasis, strike, code', () => {
  assert.equal(n(render('***x*** foo_bar_ ~~s~~ `` a`b ``')),
    '<p><em><strong>x</strong></em> foo_bar_ <del>s</del> <code>a`b</code></p>');
});
test('table', () => {
  assert.equal(n(render('| a | b |\n|:-|--:|\n| `x\\|y` | *e* |')),
    '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead>' +
    '<tbody><tr><td align="left"><code>x|y</code></td><td align="right"><em>e</em></td></tr></tbody></table>');
});
test('lists', () => {
  assert.equal(n(render('3. a\n4. b')), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
});
test('unsafe urls', () => {
  assert.equal(n(render('[a](javascript:alert(1)) ![i](data:image/png;base64,AA) [d](data:text/html,x) [f](FILE:///x)')),
    '<p><a href="#">a</a> <img src="data:image/png;base64,AA" alt="i" /> <a href="#">d</a> <a href="#">f</a></p>');
});
test('raw html escaped', () => {
  assert.equal(n(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(n(render('<div>\n\nhi\n</div>')), '<p>&lt;div&gt;</p><p>hi\n&lt;/div&gt;</p>');
});
test('links, refs, autolinks', () => {
  assert.equal(n(render('[t](/u "T") [R] <https://a.b> <me@x.org>\n\n[r]: /ref')),
    '<p><a href="/u" title="T">t</a> <a href="/ref">R</a> <a href="https://a.b">https://a.b</a> <a href="mailto:me@x.org">me@x.org</a></p>');
});
test('cli', () => {
  const out = execFileSync(process.execPath, ['src/cli.js', '-', '--toc'], { input: '# Hi there' }).toString();
  assert.deepEqual(JSON.parse(out), [{ level: 1, text: 'Hi there', slug: 'hi-there' }]);
  const html = execFileSync(process.execPath, ['src/cli.js', '-', '--ids'], { input: '# Hi' }).toString();
  assert.equal(n(html), '<h1 id="hi">Hi</h1>');
});
