import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

const cases = [
  ['# Hi', '<h1>Hi</h1>\n'],
  ['### a ###', '<h3>a</h3>\n'],
  ['a\nb', '<p>a\nb</p>\n'],
  ['Foo\n---', '<h2>Foo</h2>\n'],
  ['*a* _b_ **c** __d__', '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>\n'],
  ['a_b_c', '<p>a_b_c</p>\n'],
  ['*foo**bar**baz*', '<p><em>foo<strong>bar</strong>baz</em></p>\n'],
  ['`a<b`', '<p><code>a&lt;b</code></p>\n'],
  ['[t](u "ti")', '<p><a href="u" title="ti">t</a></p>\n'],
  ['![alt *x*](s.png)', '<p><img src="s.png" alt="alt x" /></p>\n'],
  ['- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n'],
  ['3. a\n4. b', '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>\n'],
  ['> q', '<blockquote>\n<p>q</p>\n</blockquote>\n'],
  ['---', '<hr />\n'],
  ['```js\nx<y\n```', '<pre><code class="language-js">x&lt;y\n</code></pre>\n'],
  ['<b>x</b>', '<p>&lt;b&gt;x&lt;/b&gt;</p>\n'],
  ['a "q" & \'s\'', '<p>a &quot;q&quot; &amp; \'s\'</p>\n'],
];

for (const [input, expected] of cases) {
  test(`render ${JSON.stringify(input)}`, () => {
    assert.equal(render(input), expected);
  });
}
