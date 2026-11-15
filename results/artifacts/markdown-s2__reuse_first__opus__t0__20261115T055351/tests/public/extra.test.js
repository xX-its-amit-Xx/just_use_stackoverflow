import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';
test('strike, ids, unsafe urls', () => {
  assert.match(render('~~a~~'), /<del>a<\/del>/);
  assert.match(render('## My title', { headingIds: true }), /<h2 id="my-title">My title<\/h2>/);
  assert.match(render('[x](javascript:alert(1))'), /<a href="#">x<\/a>/);
  assert.match(render('![x](data:image/png;base64,AA)'), /src="data:image\/png;base64,AA"/);
});
test('toc + slugify', () => {
  assert.deepEqual(toc('# A *b*\n\nB\n-\n# A b'), [
    { level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'B', slug: 'b' }, { level: 1, text: 'A b', slug: 'a-b-1' }]);
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
