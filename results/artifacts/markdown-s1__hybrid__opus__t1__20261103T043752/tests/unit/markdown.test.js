import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['###### h6', '<h6>h6</h6>'],
  ['a\nb\n\nc', '<p>a\nb</p><p>c</p>'],
  ['**s** __t__ _e_ snake_case', '<p><strong>s</strong> <strong>t</strong> <em>e</em> snake_case</p>'],
  ['`a<b`', '<p><code>a&lt;b</code></p>'],
  ['[t](/u "ti") ![a](/i.png)', '<p><a href="/u" title="ti">t</a> <img src="/i.png" alt="a" /></p>'],
  ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['```py\nx = "<1>"\n```', '<pre><code class="language-py">x = &quot;&lt;1&gt;&quot;\n</code></pre>'],
  ['> q', '<blockquote><p>q</p></blockquote>'],
  ['---', '<hr />'],
  ['<b>x</b> & y', '<p>&lt;b&gt;x&lt;/b&gt; &amp; y</p>'],
];
for (const [md, html] of cases) test(md, () => assert.equal(n(render(md)), html));
