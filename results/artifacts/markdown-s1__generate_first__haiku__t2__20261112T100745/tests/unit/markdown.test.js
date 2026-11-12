import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

const n = (s) => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
const eq = (md, html) => assert.equal(n(render(md)), html);

test('ATX headings incl. closing hashes', () => {
  eq('# Hi #\n\n###### six', '<h1>Hi</h1><h6>six</h6>');
  eq('#nospace', '<p>#nospace</p>');
});

test('paragraphs and soft newlines', () => {
  assert.equal(render('a\nb'), '<p>a\nb</p>');
  eq('a\n\nb', '<p>a</p><p>b</p>');
});

test('hard line breaks', () => {
  eq('a  \nb', '<p>a<br />\nb</p>');
  eq('a\\\nb', '<p>a<br />\nb</p>');
});

test('emphasis and strong', () => {
  eq('**bold** and __b2__', '<p><strong>bold</strong> and <strong>b2</strong></p>');
  eq('*a **b** c*', '<p><em>a <strong>b</strong> c</em></p>');
  eq('snake_case_word and _em_', '<p>snake_case_word and <em>em</em></p>');
});

test('inline code escapes and ignores markup', () => {
  eq('`a < b *c*`', '<p><code>a &lt; b *c*</code></p>');
  eq('``x ` y``', '<p><code>x ` y</code></p>');
});

test('links, titles, images', () => {
  eq('[link](http://x.com "T")', '<p><a href="http://x.com" title="T">link</a></p>');
  eq('![img](a.png)', '<p><img src="a.png" alt="img" /></p>');
  eq('[n](<a b>)', '<p><a href="a%20b">n</a></p>');
  eq("[t](u 'x')", '<p><a href="u" title="x">t</a></p>');
});

test('bullet lists tight and loose', () => {
  eq('- a\n- b', '<ul><li>a</li><li>b</li></ul>');
  eq('- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  eq('* a\n* b', '<ul><li>a</li><li>b</li></ul>');
});

test('ordered lists with start', () => {
  eq('1. one\n2. two', '<ol><li>one</li><li>two</li></ol>');
  eq('3. three\n4. four', '<ol start="3"><li>three</li><li>four</li></ol>');
});

test('fenced code with and without language; contents not parsed', () => {
  eq('```js\nlet x = 1 < 2;\n*no*\n```', '<pre><code class="language-js">let x = 1 &lt; 2;\n*no*\n</code></pre>');
  eq('```\nplain\n```', '<pre><code>plain\n</code></pre>');
});

test('blockquote', () => {
  eq('> quote\ncontinued\n\n> two', '<blockquote><p>quote\ncontinued</p></blockquote><blockquote><p>two</p></blockquote>');
});

test('thematic break and setext interaction', () => {
  eq('---', '<hr />');
  eq('***', '<hr />');
  eq('before\n---', '<h2>before</h2>');
});

test('raw HTML is escaped, entities handled', () => {
  eq('<div>x "q"</div>', '<p>&lt;div&gt;x &quot;q&quot;&lt;/div&gt;</p>');
  eq('a & b', '<p>a &amp; b</p>');
  eq('&copy; &#35;', '<p>© #</p>');
});

test('backslash escapes', () => {
  eq('\\*not em\\*', '<p>*not em*</p>');
});
