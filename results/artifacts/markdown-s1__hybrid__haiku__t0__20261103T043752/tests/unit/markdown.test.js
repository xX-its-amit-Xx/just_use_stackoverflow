import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

const cases = [
  ['# Title', '<h1>Title</h1>\n'],
  ['### Closed ###', '<h3>Closed</h3>\n'],
  ['#nospace', '<p>#nospace</p>\n'],
  ['a *b* _c_ **d** __e__', '<p>a <em>b</em> <em>c</em> <strong>d</strong> <strong>e</strong></p>\n'],
  ['snake_case_name', '<p>snake_case_name</p>\n'],
  ['***x***', '<p><em><strong>x</strong></em></p>\n'],
  ['`a < b`', '<p><code>a &lt; b</code></p>\n'],
  ['[t](http://x.y/a "ti")', '<p><a href="http://x.y/a" title="ti">t</a></p>\n'],
  ['![alt *x*](s.png)', '<p><img src="s.png" alt="alt x" /></p>\n'],
  ['line1\nline2', '<p>line1\nline2</p>\n'],
  ['a  \nb', '<p>a<br />\nb</p>\n'],
  ['- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n'],
  ['3. a\n4. b', '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>\n'],
  ['```js\nx < y\n```', '<pre><code class="language-js">x &lt; y\n</code></pre>\n'],
  ['```\n*no*\n```', '<pre><code>*no*\n</code></pre>\n'],
  ['> quote *x*', '<blockquote>\n<p>quote <em>x</em></p>\n</blockquote>\n'],
  ['---', '<hr />\n'],
  ['<b>raw</b>', '<p>&lt;b&gt;raw&lt;/b&gt;</p>\n'],
  ['say "hi" & bye', '<p>say &quot;hi&quot; &amp; bye</p>\n'],
  ['\\*not em\\*', '<p>*not em*</p>\n'],
  ['', ''],
];

for (const [input, expected] of cases) {
  test(`renders ${JSON.stringify(input)}`, () => {
    assert.equal(render(input), expected);
  });
}

test('loose list wraps paragraphs', () => {
  assert.equal(render('- a\n\n- b'), '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n');
});

test('nested list inside tight item', () => {
  assert.equal(render('1. a\n2. b\n   - c'),
    '<ol>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul>\n</li>\n</ol>\n');
});

test('code span takes precedence over emphasis', () => {
  assert.equal(render('*a `*` b*'), '<p><em>a <code>*</code> b</em></p>\n');
});

test('indented code block', () => {
  assert.equal(render('    x\n    y'), '<pre><code>x\ny\n</code></pre>\n');
});

test('intraword underscore does not emphasise', () => {
  assert.equal(render('foo_bar_baz'), '<p>foo_bar_baz</p>\n');
});
