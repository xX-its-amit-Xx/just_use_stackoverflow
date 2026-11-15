import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

const norm = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();

test('headings', () => {
  assert.equal(norm(render('# H1\n## H2\n###### H6')), '<h1>H1</h1><h2>H2</h2><h6>H6</h6>');
});
test('paragraph soft break kept as newline', () => {
  assert.equal(render('a\nb'), '<p>a\nb</p>\n');
});
test('emphasis and strong, no intraword underscore emphasis', () => {
  assert.equal(norm(render('*a* _b_ **c** __d__ x_y_z')), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong> x_y_z</p>');
});
test('inline code escapes', () => {
  assert.equal(norm(render('`a<b&"c"`')), '<p><code>a&lt;b&amp;&quot;c&quot;</code></p>');
});
test('links and images with title', () => {
  assert.equal(norm(render('[t](http://x.com "T") ![alt](s.png)')),
    '<p><a href="http://x.com" title="T">t</a> <img src="s.png" alt="alt" /></p>');
});
test('unordered and ordered lists, start attribute', () => {
  assert.equal(norm(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(norm(render('1. a\n2. b')), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(norm(render('3. x\n4. y')), '<ol start="3"><li>x</li><li>y</li></ol>');
});
test('fenced code block with language, contents not parsed', () => {
  assert.equal(render('```js\nif (a<b) { *x* }\n```\n'),
    '<pre><code class="language-js">if (a&lt;b) { *x* }\n</code></pre>\n');
});
test('blockquote', () => {
  assert.equal(norm(render('> quote')), '<blockquote><p>quote</p></blockquote>');
});
test('thematic break', () => {
  assert.equal(norm(render('---')), '<hr />');
});
test('raw HTML is escaped, not passed through', () => {
  assert.equal(norm(render('x <span>y</span>')), '<p>x &lt;span&gt;y&lt;/span&gt;</p>');
  assert.equal(norm(render('<div>hi</div>')), '<p>&lt;div&gt;hi&lt;/div&gt;</p>');
});
test('text escaping', () => {
  assert.equal(norm(render('a & <b> "q"')), '<p>a &amp; &lt;b&gt; &quot;q&quot;</p>');
});
