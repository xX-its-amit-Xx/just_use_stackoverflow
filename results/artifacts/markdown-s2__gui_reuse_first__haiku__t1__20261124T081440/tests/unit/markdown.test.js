import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { render, toc, slugify } from '../../src/markdown.js';

// Collapse whitespace between block-level tags, as the public tests do.
const n = (s) => s.replace(/\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g, '$1').trim();

test('ATX headings strip closing hashes and setext headings work', () => {
  assert.equal(n(render('## Title ##')), '<h2>Title</h2>');
  assert.equal(n(render('Title\n===')), '<h1>Title</h1>');
  assert.equal(n(render('Title\n---')), '<h2>Title</h2>');
});

test('headingIds adds slug ids', () => {
  assert.equal(n(render('## My title', { headingIds: true })), '<h2 id="my-title">My title</h2>');
  assert.equal(n(render('# A\n\n# A', { headingIds: true })), '<h1 id="a">A</h1><h1 id="a-1">A</h1>');
  assert.equal(n(render('## My title')), '<h2>My title</h2>');
});

test('hard breaks, soft breaks and escapes', () => {
  assert.match(render('a  \nb'), /a<br ?\/?>\nb/);
  assert.match(render('a\\\nb'), /a<br ?\/?>\nb/);
  assert.equal(n(render('a\nb')), '<p>a\nb</p>');
  assert.equal(n(render('\\*x\\*')), '<p>*x*</p>');
});

test('emphasis, strong, triple and intraword underscore rules', () => {
  assert.equal(n(render('*a* _b_ **c** __d__')), '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>');
  assert.equal(n(render('***x***')), '<p><em><strong>x</strong></em></p>');
  assert.equal(n(render('snake_case_word')), '<p>snake_case_word</p>');
});

test('strikethrough renders as del', () => {
  assert.equal(n(render('~~gone~~')), '<p><del>gone</del></p>');
});

test('code spans: multi-backtick delimiters and single space stripping', () => {
  assert.equal(n(render('`` a`b ``')), '<p><code>a`b</code></p>');
  assert.equal(n(render('` c `')), '<p><code>c</code></p>');
  assert.equal(n(render('`<b>`')), '<p><code>&lt;b&gt;</code></p>');
});

test('fenced and indented code blocks', () => {
  assert.equal(n(render('```js\nlet a = 1;\n```')), '<pre><code class="language-js">let a = 1;\n</code></pre>');
  assert.equal(n(render('~~~ py extra\nx\n~~~')), '<pre><code class="language-py">x\n</code></pre>');
  assert.equal(n(render('    code <x>')), '<pre><code>code &lt;x&gt;\n</code></pre>');
});

test('blockquotes nest and allow lazy continuation', () => {
  assert.equal(n(render('> a\nb')), '<blockquote><p>a\nb</p></blockquote>');
  assert.equal(n(render('> a\n> > b')), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>');
});

test('thematic breaks', () => {
  for (const src of ['---', '***', '___']) assert.equal(n(render(src)), '<hr>');
});

test('lists: bullets, ordered start, nesting and tightness', () => {
  assert.equal(n(render('- a\n- b')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(n(render('3) x\n4) y')), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(n(render('- a\n  - b\n- c')), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.match(render('* a\n\n* b'), /<li>\s*<p>a<\/p>/);
});

test('links, images, titles and reference definitions (case-insensitive)', () => {
  assert.equal(n(render('[t](http://x.io "T")')), '<p><a href="http://x.io" title="T">t</a></p>');
  assert.equal(n(render('![alt](/i.png "ti")')), '<p><img src="/i.png" alt="alt" title="ti"></p>');
  assert.equal(n(render('[Foo][REF]\n\n[ref]: /u')), '<p><a href="/u">Foo</a></p>');
});

test('autolinks, including email to mailto', () => {
  assert.equal(n(render('<https://ex.com/a>')), '<p><a href="https://ex.com/a">https://ex.com/a</a></p>');
  assert.equal(n(render('<me@example.com>')), '<p><a href="mailto:me@example.com">me@example.com</a></p>');
});

test('GFM tables with alignment, inline markup and escaped pipes', () => {
  const html = render('| a \\| b | c |\n|:--|:-:|\n| *x* | `y` |');
  assert.match(html, /<th[^>]*>a \| b<\/th>/);
  assert.match(html, /text-align:\s*center/);
  assert.match(html, /<td[^>]*><em>x<\/em><\/td>/);
  assert.match(html, /<td[^>]*><code>y<\/code><\/td>/);
});

test('raw HTML is escaped, never passed through', () => {
  assert.equal(n(render('<script>x</script>')), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(n(render('a <span onclick="x">b</span>')), '<p>a &lt;span onclick=&quot;x&quot;&gt;b&lt;/span&gt;</p>');
});

test('unsafe URL schemes are replaced by #; safe data images are kept', () => {
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('[x](vbscript:msgbox)'), /href="#"/);
  assert.match(render('[x](file:///etc/passwd)'), /href="#"/);
  assert.match(render('[x](data:text/html,hi)'), /href="#"/);
  assert.match(render('<javascript:alert(1)>'), /href="#"/);
  assert.match(render('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
  // A raw tab makes the destination invalid in CommonMark: no link at all.
  assert.doesNotMatch(render('[x](java\tscript:alert(1))'), /<a /);
});

test('entities and character references decode, text is HTML-escaped', () => {
  assert.equal(n(render('&copy; &amp; &#65; &#x42;')), '<p>© &amp; A B</p>');
  assert.equal(n(render('"quoted" & <')), '<p>&quot;quoted&quot; &amp; &lt;</p>');
});

test('slugify follows GitHub-style rules and de-duplicates with a seen Map', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('snake_case-Dash 1'), 'snake_case-dash-1');
  const seen = new Map();
  assert.equal(slugify('Foo', seen), 'foo');
  assert.equal(slugify('Foo', seen), 'foo-1');
  assert.equal(slugify('Foo', seen), 'foo-2');
});

test('toc lists ATX and setext headings in order with plain text', () => {
  const doc = '# Hi *there*\n\nBody\n\nSub `x`\n---\n\n### Hi *there* ###';
  assert.deepEqual(toc(doc), [
    { level: 1, text: 'Hi there', slug: 'hi-there' },
    { level: 2, text: 'Sub x', slug: 'sub-x' },
    { level: 3, text: 'Hi there', slug: 'hi-there-1' }
  ]);
});

test('CLI prints HTML, TOC JSON, and reads stdin with -', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.resolve(here, '../../src/cli.js');
  const out = execFileSync(process.execPath, [cli, '-', '--ids'], { input: '# T\n' }).toString();
  assert.equal(n(out), '<h1 id="t">T</h1>');
  const json = JSON.parse(execFileSync(process.execPath, [cli, '-', '--toc'], { input: '## Q\n' }).toString());
  assert.deepEqual(json, [{ level: 2, text: 'Q', slug: 'q' }]);
});
