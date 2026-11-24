import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/markdown.js';
const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)\b[^>]*>)\s*/g, '$1').trim();
test('heading + emphasis', () => { assert.equal(n(render('# Hi\n\nSome *text*.')), '<h1>Hi</h1><p>Some <em>text</em>.</p>'); });
