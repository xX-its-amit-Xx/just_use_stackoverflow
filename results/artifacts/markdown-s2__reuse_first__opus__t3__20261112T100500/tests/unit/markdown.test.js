import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, toc, slugify } from '../../src/markdown.js'

test('strikethrough uses del', () => assert.match(render('~~x~~'), /<del>x<\/del>/))
test('unsafe urls replaced', () => {
  assert.match(render('[a](javascript:alert(1))'), /href="#"/)
  assert.match(render('![a](data:image/png;base64,AA)'), /src="data:image\/png;base64,AA"/)
})
test('heading ids and toc', () => {
  assert.match(render('# A b\n# A b', { headingIds: true }), /<h1 id="a-b-1">/)
  assert.deepEqual(toc('# Hi *x*\n\nT\n---'), [
    { level: 1, text: 'Hi x', slug: 'hi-x' }, { level: 2, text: 'T', slug: 't' }])
})
test('slugify', () => {
  const seen = new Map()
  assert.equal(slugify('Hello, World!', seen), 'hello-world')
  assert.equal(slugify('Hello World', seen), 'hello-world-1')
})
test('table alignment', () => assert.match(render('|a|b|\n|:-|-:|\n|1|2|'), /text-align:left/))
