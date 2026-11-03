import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
const APP = process.env.APP_DIR;
const { render } = await import(path.join(APP, 'src/markdown.js'));
const BLOCK = /\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g;
const n = s => s.replace(/<(hr|img)([^>]*?)\s*\/>/g, '<$1$2>').replace(BLOCK, '$1').trim();
const cases = [
  ['h1', '# Hello', '<h1>Hello</h1>'], ['h6', '###### six', '<h6>six</h6>'], ['h2 inline', '## A *b*', '<h2>A <em>b</em></h2>'],
  ['not heading', '#nospace', '<p>#nospace</p>'],
  ['paragraphs', 'a\n\nb', '<p>a</p><p>b</p>'], ['soft break', 'a\nb', '<p>a\nb</p>'],
  ['em/strong', '*a* _b_ **c** __d__', '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>'],
  ['nested', '**a *b* c**', '<p><strong>a <em>b</em> c</strong></p>'],
  ['intraword underscore', 'snake_case_name', '<p>snake_case_name</p>'],
  ['code', '`a < b`', '<p><code>a &lt; b</code></p>'], ['no em in code', '`*x*`', '<p><code>*x*</code></p>'],
  ['escape', 'a & b < c > d "e"', '<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>'],
  ['link', '[t](http://x.io)', '<p><a href="http://x.io">t</a></p>'],
  ['link title', '[t](/u "T")', '<p><a href="/u" title="T">t</a></p>'],
  ['image', '![alt](a.png)', '<p><img src="a.png" alt="alt"></p>'],
  ['ul', '- a\n- b', '<ul><li>a</li><li>b</li></ul>'], ['ul star', '* a\n* b', '<ul><li>a</li><li>b</li></ul>'],
  ['ol', '1. a\n2. b', '<ol><li>a</li><li>b</li></ol>'], ['ol start', '3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['list inline', '- *x* and `y`', '<ul><li><em>x</em> and <code>y</code></li></ul>'],
  ['fenced', '```js\nconst a = 1 < 2;\n```', '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>'],
  ['fenced raw', '```\n# no *no*\n```', '<pre><code># no *no*\n</code></pre>'],
  ['blockquote', '> a\n> b', '<blockquote><p>a\nb</p></blockquote>'],
  ['hr', 'a\n\n---\n\nb', '<p>a</p><hr><p>b</p>'],
  ['raw html escaped', '<b>x</b>', '<p>&lt;b&gt;x&lt;/b&gt;</p>'],
  ['mixed doc', '# T\n\nIntro *x*.\n\n- one\n- two\n\n> q', '<h1>T</h1><p>Intro <em>x</em>.</p><ul><li>one</li><li>two</li></ul><blockquote><p>q</p></blockquote>'],
];
for (const [name, md, html] of cases) test(name, () => assert.equal(n(render(md)), html));
