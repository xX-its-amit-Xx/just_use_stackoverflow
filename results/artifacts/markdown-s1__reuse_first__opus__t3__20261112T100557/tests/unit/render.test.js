import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['a\nb', '<p>a\nb</p>'],
  ['**s** __t__ _e_ snake_case_x', '<p><strong>s</strong> <strong>t</strong> <em>e</em> snake_case_x</p>'],
  ['[x](http://a.com "T") ![i](p.png)', '<p><a href="http://a.com" title="T">x</a> <img src="p.png" alt="i" /></p>'],
  ['* a\n* b', '<ul><li>a</li><li>b</li></ul>'],
  ['2. a\n3. b', '<ol start="2"><li>a</li><li>b</li></ol>'],
  ['```py\n*a* <b>\n```', '<pre><code class="language-py">*a* &lt;b&gt;\n</code></pre>'],
  ['> quote', '<blockquote><p>quote</p></blockquote>'],
  ['x\n\n---', '<p>x</p><hr />'],
  ['<div>"&"</div>', '<p>&lt;div&gt;&quot;&amp;&quot;&lt;/div&gt;</p>'],
  ['###### h6', '<h6>h6</h6>'],
];
for (const [md, html] of cases) test(JSON.stringify(md), () => assert.equal(n(render(md)), html));
