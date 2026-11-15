import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['###### h6', '<h6>h6</h6>'],
  ['a\nb', '<p>a\nb</p>'],
  ['**s** __t__ _e_ foo_bar_baz', '<p><strong>s</strong> <strong>t</strong> <em>e</em> foo_bar_baz</p>'],
  ['`a<b`', '<p><code>a&lt;b</code></p>'],
  ['[x](/u "t")', '<p><a href="/u" title="t">x</a></p>'],
  ['![a](s.png)', '<p><img src="s.png" alt="a" /></p>'],
  ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['2. a\n3. b', '<ol start="2"><li>a</li><li>b</li></ol>'],
  ['```js\n*x* <y>\n```', '<pre><code class="language-js">*x* &lt;y&gt;\n</code></pre>'],
  ['> q', '<blockquote><p>q</p></blockquote>'],
  ['---', '<hr />'],
  ['<div>"&"</div>', '<p>&lt;div&gt;&quot;&amp;&quot;&lt;/div&gt;</p>'],
];
for (const [i, o] of cases) test(JSON.stringify(i), () => assert.equal(n(render(i)), o));
