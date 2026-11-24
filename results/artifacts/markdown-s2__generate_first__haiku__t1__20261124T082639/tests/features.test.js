import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify } from '../src/markdown.js';

const n = s => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('emphasis and strong', () => {
  assert.equal(n(render('***x***')), '<p><em><strong>x</strong></em></p>');
  assert.equal(n(render('a *b **c** d* e')), '<p>a <em>b <strong>c</strong> d</em> e</p>');
  assert.equal(n(render('snake_case_name')), '<p>snake_case_name</p>');
  assert.equal(n(render('~~strike~~')), '<p><del>strike</del></p>');
});

test('code spans and fenced code', () => {
  assert.equal(n(render('`` a ` b ``')), '<p><code>a ` b</code></p>');
  assert.equal(n(render('``` js\nconst a = 1 < 2;\n```')),
    '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>');
  assert.equal(n(render('    indented\n    code')), '<pre><code>indented\ncode\n</code></pre>');
});

test('blockquote with lazy continuation', () => {
  assert.equal(n(render('> quote\n> more\nlazy')),
    '<blockquote><p>quote\nmore\nlazy</p></blockquote>');
});

test('lists: tight, loose, ordered start, nesting', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.match(render('- a\n\n- b'), /<li><p>a<\/p>/);
  assert.equal(n(render('3. x\n4. y')), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(n(render('* a\n    * nested\n* b')),
    '<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>');
});

test('hard breaks and thematic breaks', () => {
  assert.equal(n(render('Foo  \nbar')), '<p>Foo<br />\nbar</p>');
  assert.equal(n(render('Foo\\\nbar')), '<p>Foo<br />\nbar</p>');
  assert.equal(n(render('***\n___\n- - -')), '<hr /><hr /><hr />');
});

test('headings: ATX closing hashes, setext, ids', () => {
  assert.equal(n(render('# Title #')), '<h1>Title</h1>');
  assert.equal(n(render('Setext\n===')), '<h1>Setext</h1>');
  assert.equal(n(render('## My title', { headingIds: true })), '<h2 id="my-title">My title</h2>');
  assert.equal(n(render('## A!\n## A!', { headingIds: true })),
    '<h2 id="a">A!</h2><h2 id="a-1">A!</h2>');
});

test('links, images, references, autolinks', () => {
  assert.equal(n(render('[t](http://x.com "T")')), '<p><a href="http://x.com" title="T">t</a></p>');
  assert.equal(n(render('![i](a.png "t")')), '<p><img src="a.png" alt="i" title="t" /></p>');
  assert.equal(n(render('[Ref][r]\n\n[R]: /u')), '<p><a href="/u">Ref</a></p>');
  assert.equal(n(render('<https://example.com>')),
    '<p><a href="https://example.com">https://example.com</a></p>');
  assert.equal(n(render('<me@x.org>')), '<p><a href="mailto:me@x.org">me@x.org</a></p>');
});

test('unsafe URLs are neutralised', () => {
  assert.equal(n(render('[x](javascript:alert(1))')), '<p><a href="#">x</a></p>');
  assert.equal(n(render('[x](vbscript:msgbox)')), '<p><a href="#">x</a></p>');
  assert.equal(n(render('[x](file:///etc/passwd)')), '<p><a href="#">x</a></p>');
  assert.equal(n(render('![x](data:text/html,hi)')), '<p><img src="#" alt="x" /></p>');
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
});

test('tables with alignment and escaped pipes', () => {
  const html = render('| a | b |\n|:--|--:|\n| 1 \\| 2 | **q** |');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<th align="right">b<\/th>/);
  assert.match(html, /<td align="left">1 \| 2<\/td>/);
  assert.match(html, /<td align="right"><strong>q<\/strong><\/td>/);
});

test('escapes and entities', () => {
  assert.equal(n(render('&amp; &copy; &#35; "q"')), '<p>&amp; © # &quot;q&quot;</p>');
  assert.equal(n(render('\\*lit\\*')), '<p>*lit*</p>');
  assert.equal(n(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});

test('toc lists headings in order with unique slugs', () => {
  assert.deepEqual(toc('# A *b*\n\ntext\n\n## A b\n\nX\n---\n'), [
    { level: 1, text: 'A b', slug: 'a-b' },
    { level: 2, text: 'A b', slug: 'a-b-1' },
    { level: 2, text: 'X', slug: 'x' },
  ]);
});

test('slugify with a seen map', () => {
  const seen = new Map();
  assert.equal(slugify('Hello, World!', seen), 'hello-world');
  assert.equal(slugify('Hello World', seen), 'hello-world-1');
  assert.equal(slugify('a_b c-d'), 'a_b-c-d');
});

test('CLI renders a file and supports --toc', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const file = fileURLToPath(new URL('./fixture-tmp.md', import.meta.url));
  void dir;
  execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, '# Hi\\n')`]);
  const out = execFileSync(process.execPath, [cli, file, '--ids']).toString();
  assert.equal(out, '<h1 id="hi">Hi</h1>\n');
  const js = JSON.parse(execFileSync(process.execPath, [cli, file, '--toc']).toString());
  assert.deepEqual(js, [{ level: 1, text: 'Hi', slug: 'hi' }]);
  const fromStdin = execFileSync(process.execPath, [cli, '-'], { input: '*x*' }).toString();
  assert.equal(fromStdin, '<p><em>x</em></p>\n');
  execFileSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(file)})`]);
});
