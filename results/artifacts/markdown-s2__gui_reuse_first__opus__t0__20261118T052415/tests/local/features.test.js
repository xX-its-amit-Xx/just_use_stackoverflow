import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { render, toc, slugify } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('strikethrough and emphasis', () => {
  assert.equal(n(render('***x*** ~~y~~ foo_bar_baz')), '<p><em><strong>x</strong></em> <del>y</del> foo_bar_baz</p>');
});
test('tables', () => {
  assert.equal(n(render('| a | b |\n|:-|-:|\n| *1* | 2 \\| 3 |')),
    '<table><thead><tr><th align="left">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="left"><em>1</em></td><td align="right">2 | 3</td></tr></tbody></table>');
});
test('unsafe urls', () => {
  assert.equal(n(render('[a](javascript:alert(1)) ![b](data:image/png;base64,x)')), '<p><a href="#">a</a> <img src="data:image/png;base64,x" alt="b" /></p>');
});
test('heading ids, toc, slugify', () => {
  assert.equal(n(render('# My title\n## My title', { headingIds: true })), '<h1 id="my-title">My title</h1><h2 id="my-title-1">My title</h2>');
  assert.deepEqual(toc('# A *b*\nC\n---'), [{ level: 1, text: 'A b', slug: 'a-b' }, { level: 2, text: 'C', slug: 'c' }]);
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
test('cli', () => {
  const out = execFileSync('node', ['src/cli.js', '-', '--toc'], { input: '# Hi' }).toString();
  assert.deepEqual(JSON.parse(out), [{ level: 1, text: 'Hi', slug: 'hi' }]);
});
