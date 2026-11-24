import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, toc, slugify } from '../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('heading ids and toc', () => {
  assert.equal(n(render('## My title\n\nSub\n===', { headingIds: true })), '<h2 id="my-title">My title</h2><h1 id="sub">Sub</h1>');
  assert.deepEqual(toc('# A *b*\n## A b'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'A b', slug: 'a-b-1' }]);
  const seen = new Map();
  assert.equal(slugify('Hello, World!', seen), 'hello-world');
  assert.equal(slugify('Hello World', seen), 'hello-world-1');
});
test('inline', () => {
  assert.equal(n(render('***x*** ~~y~~ `` a`b `` snake_case_word')), '<p><em><strong>x</strong></em> <del>y</del> <code>a`b</code> snake_case_word</p>');
  assert.equal(n(render('a  \nb\\\nc')), '<p>a<br />\nb<br />\nc</p>');
});
test('unsafe urls', () => {
  assert.equal(n(render('[a](javascript:alert(1)) [b](data:text/html,x)')), '<p><a href="#">a</a> <a href="#">b</a></p>');
  assert.match(render('![i](data:image/png;base64,AA)'), /src="data:image\/png;base64,AA"/);
  assert.equal(n(render('<x@y.com>')), '<p><a href="mailto:x@y.com">x@y.com</a></p>');
});
test('lists, tables, code', () => {
  assert.equal(n(render('3. a\n4. b')), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  assert.match(render('| a |\n|:-:|\n| `x\\|y` |'), /<code>x\|y<\/code>/);
  assert.equal(n(render('```js x\n<a>\n```')), '<pre><code class="language-js">&lt;a&gt;\n</code></pre>');
});
test('cli', () => {
  const out = execFileSync(process.execPath, ['src/cli.js', '-', '--toc'], { input: '# Hi' }).toString();
  assert.deepEqual(JSON.parse(out), [{ level: 1, text: 'Hi', slug: 'hi' }]);
  assert.match(execFileSync(process.execPath, ['src/cli.js', '-', '--ids'], { input: '# Hi' }).toString(), /<h1 id="hi">/);
});
