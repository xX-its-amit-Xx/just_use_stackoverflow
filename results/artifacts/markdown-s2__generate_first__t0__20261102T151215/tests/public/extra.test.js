import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, toc, slugify } from '../../src/markdown.js';
test('slugify dedupe', () => { const m = new Map(); assert.equal(slugify('A b!', m), 'a-b'); assert.equal(slugify('A b', m), 'a-b-1'); });
test('toc', () => { assert.deepEqual(toc('# A *b*\n\nT\n---\n'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'T', slug: 't' }]); });
test('ids', () => { assert.match(render('## My title', { headingIds: true }), /<h2 id="my-title">My title<\/h2>/); });
test('unsafe url', () => { assert.match(render('[x](javascript:alert(1))'), /href="#"/); });
test('table', () => { assert.match(render('a|b\n:-:|--:\n1|2'), /<th align="center">a<\/th>/); });
