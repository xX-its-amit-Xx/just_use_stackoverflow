import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

// Collapse whitespace between block-level tags for comparison.
const n = (s) => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX headings', () => {
  assert.equal(n(render('# a\n## b ##\n###### c')), '<h1>a</h1><h2>b</h2><h6>c</h6>');
  assert.equal(n(render('#nospace')), '<p>#nospace</p>');
  assert.equal(n(render('####### seven')), '<p>####### seven</p>');
});

test('paragraphs and soft line breaks', () => {
  assert.equal(n(render('one\ntwo\n\nthree')), '<p>one\ntwo</p><p>three</p>');
});

test('emphasis and strong', () => {
  assert.equal(n(render('*a* _b_ **c** __d__')), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>');
  assert.equal(n(render('***x***')), '<p><em><strong>x</strong></em></p>');
  assert.equal(n(render('snake_case_name')), '<p>snake_case_name</p>');
  assert.equal(n(render('2 * 3 * 4')), '<p>2 * 3 * 4</p>');
});

test('inline code escapes content', () => {
  assert.equal(n(render('use `a<b> & *c*`')), '<p>use <code>a&lt;b&gt; &amp; *c*</code></p>');
});

test('links and images', () => {
  assert.equal(n(render('[x](http://e.com/a?b=1&c=2)')), '<p><a href="http://e.com/a?b=1&amp;c=2">x</a></p>');
  assert.equal(n(render('[x](/u "T")')), '<p><a href="/u" title="T">x</a></p>');
  assert.equal(n(render('![alt *t*](s.png)')), '<p><img src="s.png" alt="alt t" /></p>');
  assert.equal(n(render('[unclosed](x')), '<p>[unclosed](x</p>');
});

test('unordered and ordered lists', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('* a\n* b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('3. x\n4. y')), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(n(render('1. x\n2. y')), '<ol><li>x</li><li>y</li></ol>');
});

test('loose list wraps paragraphs', () => {
  assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
});

test('fenced code blocks', () => {
  assert.equal(
    render('```js\nconst x = "<a>";\n\n*no*\n```'),
    '<pre><code class="language-js">const x = &quot;&lt;a&gt;&quot;;\n\n*no*\n</code></pre>\n',
  );
  assert.equal(render('```\nx\n```'), '<pre><code>x\n</code></pre>\n');
});

test('blockquote', () => {
  assert.equal(n(render('> quoted *x*\n> more')), '<blockquote><p>quoted <em>x</em>\nmore</p></blockquote>');
});

test('thematic break and setext interplay', () => {
  assert.equal(n(render('a\n\n---\n\nb')), '<p>a</p><hr /><p>b</p>');
  assert.equal(n(render('***')), '<hr />');
  assert.equal(n(render('- - -')), '<hr />');
});

test('raw html is escaped, not passed through', () => {
  assert.equal(n(render('<b>hi</b>')), '<p>&lt;b&gt;hi&lt;/b&gt;</p>');
});

test('ampersand and quotes are escaped', () => {
  assert.equal(n(render('AT&T "q"')), '<p>AT&amp;T &quot;q&quot;</p>');
  assert.equal(n(render('&amp; &copy; &#65;')), '<p>&amp; © A</p>');
});

test('backslash escapes', () => {
  assert.equal(n(render('\\*not em\\*')), '<p>*not em*</p>');
});
