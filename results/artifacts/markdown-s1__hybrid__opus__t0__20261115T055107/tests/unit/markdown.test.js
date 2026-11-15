import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const cases = [
  ['## a ##', '<h2>a</h2>'],
  ['a\nb', '<p>a\nb</p>'],
  ['*a* _b_ **c** __d__', '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>'],
  ['foo_bar_baz', '<p>foo_bar_baz</p>'],
  ['`a<b`', '<p><code>a&lt;b</code></p>'],
  ['[t](/u "ti")', '<p><a href="/u" title="ti">t</a></p>'],
  ['![alt](/i.png)', '<p><img src="/i.png" alt="alt" /></p>'],
  ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['```js\n<x> *y*\n```', '<pre><code class="language-js">&lt;x&gt; *y*\n</code></pre>'],
  ['> a\n> b', '<blockquote><p>a\nb</p></blockquote>'],
  ['---', '<hr />'],
  ['a\n---', '<h2>a</h2>'],
  ['<div>"&"</div>', '<p>&lt;div&gt;&quot;&amp;&quot;&lt;/div&gt;</p>'],
  ['1. a\n=', '<ol><li>a\n=</li></ol>'],
];
for (const [md, html] of cases) test(JSON.stringify(md), () => assert.equal(n(render(md)), html));
