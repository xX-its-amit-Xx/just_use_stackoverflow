import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();
test('heading ids + dedupe', () => {
  assert.equal(n(render('## My title\n## My title', { headingIds: true })), '<h2 id="my-title">My title</h2><h2 id="my-title-1">My title</h2>');
});
test('toc', () => {
  assert.deepEqual(toc('# A *b*\nX\n---'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'X', slug: 'x' }]);
});
test('slugify', () => { assert.equal(slugify('Hello, World!'), 'hello-world'); });
test('unsafe urls', () => {
  assert.equal(n(render('[x](javascript:alert(1))')), '<p><a href="#">x</a></p>');
  assert.equal(n(render('![x](data:image/png;base64,AA)')), '<p><img src="data:image/png;base64,AA" alt="x" /></p>');
});
test('loose list', () => { assert.equal(n(render('- a\n\n- b')), '<ul><li><p>a</p></li><li><p>b</p></li></ul>'); });
test('table', () => {
  assert.equal(n(render('| a |\n|:-:|\n| `x\\|y` |')), '<table><thead><tr><th align="center">a</th></tr></thead><tbody><tr><td align="center"><code>x|y</code></td></tr></tbody></table>');
});
test('emphasis', () => { assert.equal(n(render('***x*** ~~y~~ snake_case')), '<p><em><strong>x</strong></em> <del>y</del> snake_case</p>'); });
