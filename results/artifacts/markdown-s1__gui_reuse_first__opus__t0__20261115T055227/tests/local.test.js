import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();

const cases = [
  ['# Hi\n\nSome *text*.\nline2', '<h1>Hi</h1><p>Some <em>text</em>.\nline2</p>'],
  ['foo_bar_baz __s__ `a<b`', '<p>foo_bar_baz <strong>s</strong> <code>a&lt;b</code></p>'],
  ['[x](/u "t&") ![al *t*](i.png)', '<p><a href="/u" title="t&amp;">x</a> <img src="i.png" alt="al t" /></p>'],
  ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['3. x\n4. y', '<ol start="3"><li>x</li><li>y</li></ol>'],
  ['```js\n<a>&\n```', '<pre><code class="language-js">&lt;a&gt;&amp;\n</code></pre>'],
  ['> q\n\n---\n', '<blockquote><p>q</p></blockquote><hr />'],
  ['<div>hi</div> & "x"', '<p>&lt;div&gt;hi&lt;/div&gt; &amp; &quot;x&quot;</p>'],
  ['a\n---', '<h2>a</h2>'],
  ['###### six\n####### seven', '<h6>six</h6><p>####### seven</p>'],
];
for (const [md, html] of cases) test(JSON.stringify(md), () => assert.equal(n(render(md)), html));
