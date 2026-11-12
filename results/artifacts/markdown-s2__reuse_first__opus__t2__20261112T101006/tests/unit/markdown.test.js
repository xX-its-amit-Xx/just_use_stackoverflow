import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('heading ids', () => {
  assert.equal(n(render('## My title', { headingIds: true })), '<h2 id="my-title">My title</h2>');
});
test('slugify', () => {
  assert.equal(slugify('Hello, World! _x_ a-b'), 'hello-world-_x_-a-b');
  const m = new Map();
  assert.deepEqual(['a', 'a', 'a'].map(s => slugify(s, m)), ['a', 'a-1', 'a-2']);
});
test('toc', () => {
  assert.deepEqual(toc('# A *b*\n\nC\n===\n# A b'), [
    { level: 1, text: 'A b', slug: 'a-b' }, { level: 1, text: 'C', slug: 'c' }, { level: 1, text: 'A b', slug: 'a-b-1' }]);
});
test('unsafe urls', () => {
  assert.equal(n(render('[x](javascript:alert(1))')), '<p><a href="#">x</a></p>');
  assert.equal(n(render('![x](data:image/png;base64,AA)')), '<p><img src="data:image/png;base64,AA" alt="x" /></p>');
  assert.equal(n(render('[x](data:text/html,hi)')), '<p><a href="#">x</a></p>');
});
test('strike, table', () => {
  assert.equal(n(render('~~a~~')), '<p><del>a</del></p>');
  assert.match(render('|a|b|\n|:-:|--:|\n|1|\\|x|'), /<td[^>]*>\|x<\/td>/);
});
test('autolinks + escapes', () => {
  assert.equal(n(render('<a@b.co> & "q"')), '<p><a href="mailto:a@b.co">a@b.co</a> &amp; &quot;q&quot;</p>');
});
