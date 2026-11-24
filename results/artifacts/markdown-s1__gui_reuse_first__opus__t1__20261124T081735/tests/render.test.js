import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['## T #', '<h2>T</h2>'],
  ['a\nb', '<p>a\nb</p>'],
  ['foo_bar_baz __x__', '<p>foo_bar_baz <strong>x</strong></p>'],
  ['[t](u "T") ![a](s)', '<p><a href="u" title="T">t</a> <img src="s" alt="a" /></p>'],
  ['2. a\n3. b', '<ol start="2"><li>a</li><li>b</li></ol>'],
  ['* a\n* b', '<ul><li>a</li><li>b</li></ul>'],
  ['```py\n*x* <\n```', '<pre><code class="language-py">*x* &lt;\n</code></pre>'],
  ['> q', '<blockquote><p>q</p></blockquote>'],
  ['a\n\n---', '<p>a</p><hr />'],
  ['<b>"&"</b>', '<p>&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;</p>'],
];
for (const [md, html] of cases) test(JSON.stringify(md), () => assert.equal(n(render(md)), html));
