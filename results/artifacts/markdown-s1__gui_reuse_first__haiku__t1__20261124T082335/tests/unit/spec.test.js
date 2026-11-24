import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';

const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX headings', () => {
  assert.equal(n(render('# A\n\n## B\n\n###### F')), '<h1>A</h1><h2>B</h2><h6>F</h6>');
});

test('paragraphs and soft line breaks', () => {
  assert.equal(n(render('one\ntwo\n\nthree')), '<p>one\ntwo</p><p>three</p>');
});

test('emphasis and strong', () => {
  assert.equal(n(render('*a* _b_ **c** __d__')), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>');
});

test('no intraword underscore emphasis', () => {
  assert.equal(n(render('snake_case_name')), '<p>snake_case_name</p>');
});

test('inline code escapes html', () => {
  assert.equal(n(render('`x<y&z`')), '<p><code>x&lt;y&amp;z</code></p>');
});

test('links with and without title', () => {
  assert.equal(n(render('[t](http://a.b)')), '<p><a href="http://a.b">t</a></p>');
  assert.equal(n(render('[t](http://a.b "ti")')), '<p><a href="http://a.b" title="ti">t</a></p>');
});

test('images', () => {
  const out = n(render('![alt](s.png)'));
  assert.match(out, /^<p><img src="s\.png" alt="alt"\s*\/?>\s*<\/p>$/);
});

test('unordered list tight', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('* a\n* b')), '<ul><li>a</li><li>b</li></ul>');
});

test('ordered list with and without start', () => {
  assert.equal(n(render('1. a\n2. b')), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(n(render('3. a\n4. b')), '<ol start="3"><li>a</li><li>b</li></ol>');
});

test('fenced code with language, contents not parsed', () => {
  assert.equal(
    n(render('```js\nlet a = *b* <c>\n```')),
    '<pre><code class="language-js">let a = *b* &lt;c&gt;\n</code></pre>',
  );
});

test('fenced code without language', () => {
  assert.equal(n(render('```\nx\n```')), '<pre><code>x\n</code></pre>');
});

test('blockquote', () => {
  assert.equal(n(render('> quoted *x*')), '<blockquote><p>quoted <em>x</em></p></blockquote>');
});

test('thematic break', () => {
  assert.match(n(render('---')), /^<hr\s*\/?>$/);
  assert.equal(n(render('a\n---')).includes('<hr'), false);
});

test('raw html is escaped, not passed through', () => {
  assert.equal(n(render('<b>x</b>')), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});

test('escapes quotes in text', () => {
  assert.equal(n(render('say "hi" & bye')), '<p>say &quot;hi&quot; &amp; bye</p>');
});
