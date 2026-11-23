import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/markdown.js';

test('headings and paragraphs', () => {
  assert.equal(render('## Two'), '<h2>Two</h2>\n');
  assert.match(render('a\nb'), /<p>a\nb<\/p>/);
});
test('strong, inline code, escaping', () => {
  assert.match(render('**a** __b__ `x<y`'), /<strong>a<\/strong> <strong>b<\/strong> <code>x&lt;y<\/code>/);
  assert.match(render('a & "b"'), /<p>a &amp; &quot;b&quot;<\/p>/);
});
test('links and images with title', () => {
  assert.match(render('[l](http://a.com "t")'), /<a href="http:\/\/a.com" title="t">l<\/a>/);
  assert.match(render('![alt](s.png)'), /<img src="s.png" alt="alt" \/>/);
});
test('lists: tight, ordered start', () => {
  assert.match(render('- a\n- b'), /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(render('3. x\n4. y'), /<ol start="3">/);
});
test('fenced code is not parsed and has language class', () => {
  assert.equal(render('```js\n*no*\n```'), '<pre><code class="language-js">*no*\n</code></pre>\n');
});
test('blockquote and thematic break', () => {
  assert.match(render('> q'), /<blockquote>\n<p>q<\/p>\n<\/blockquote>/);
  assert.match(render('---'), /<hr \/>/);
});
test('raw HTML is escaped, not passed through', () => {
  assert.match(render('text <b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(render('<div>hi</div>'), /<div>/);
});
