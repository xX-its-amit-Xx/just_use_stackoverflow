import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['## A ##', '<h2>A</h2>'],
  ['a\nb', '<p>a\nb</p>'],
  ['**b** __s__ _e_ snake_case_x', '<p><strong>b</strong> <strong>s</strong> <em>e</em> snake_case_x</p>'],
  ['`<a>&`', '<p><code>&lt;a&gt;&amp;</code></p>'],
  ['[t](/u "ti") ![al](/i.png)', '<p><a href="/u" title="ti">t</a> <img src="/i.png" alt="al" /></p>'],
  ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['```js\n*x* <y>\n```', '<pre><code class="language-js">*x* &lt;y&gt;\n</code></pre>'],
  ['> q', '<blockquote><p>q</p></blockquote>'],
  ['a\n\n---', '<p>a</p><hr />'],
  ['<b>"x"</b>', '<p>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</p>'],
  ['- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
];
for (const [md, html] of cases) test(JSON.stringify(md), () => assert.equal(n(render(md)), html));
