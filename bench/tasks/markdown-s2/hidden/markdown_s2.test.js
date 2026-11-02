import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
import { spawnSync } from 'node:child_process';
const APP = process.env.APP_DIR;
const { render, toc, slugify } = await import(path.join(APP, 'src/markdown.js'));
const BLOCK = /\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g;
const n = s => s.replace(/<(br|hr|img)([^>]*?)\s*\/>/g, '<$1$2>').replace(/style="text-align:\s*(left|right|center);?"/g, 'align="$1"')
  .replace(BLOCK, '$1').replace(/<br>\s*/g, '<br>').trim();
const R = (md, o) => n(render(md, o));
const cases = [
  ['atx h1', '# Hello', '<h1>Hello</h1>'],
  ['atx h3 closing hashes', '### Title ###', '<h3>Title</h3>'],
  ['atx inline', '## A *b*', '<h2>A <em>b</em></h2>'],
  ['seven hashes is paragraph', '####### x', '<p>####### x</p>'],
  ['setext h1', 'Title\n=====', '<h1>Title</h1>'],
  ['setext h2', 'Sub\n---', '<h2>Sub</h2>'],
  ['soft break', 'a\nb', '<p>a\nb</p>'],
  ['two paragraphs', 'a\n\nb', '<p>a</p><p>b</p>'],
  ['hard break spaces', 'a  \nb', '<p>a<br>b</p>'],
  ['hard break backslash', 'a\\\nb', '<p>a<br>b</p>'],
  ['emphasis mix', '*a* _b_ **c** __d__', '<p><em>a</em> <em>b</em> <strong>c</strong> <strong>d</strong></p>'],
  ['triple', '***e***', '<p><em><strong>e</strong></em></p>'],
  ['intraword underscore', 'snake_case_name', '<p>snake_case_name</p>'],
  ['intraword star', 'un*frigging*believable', '<p>un<em>frigging</em>believable</p>'],
  ['nested em in strong', '**a *b* c**', '<p><strong>a <em>b</em> c</strong></p>'],
  ['strike', '~~gone~~', '<p><del>gone</del></p>'],
  ['code span escape', '`a < b`', '<p><code>a &lt; b</code></p>'],
  ['double backtick', '`` a ` b ``', '<p><code>a ` b</code></p>'],
  ['no em in code', '`*x*`', '<p><code>*x*</code></p>'],
  ['escape text', 'a & b < c > d "e"', '<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>'],
  ['backslash escapes', '\\*not em\\*', '<p>*not em*</p>'],
  ['link title', '[text](http://x.com "T")', '<p><a href="http://x.com" title="T">text</a></p>'],
  ['link inline markup', '[**b**](/u)', '<p><a href="/u"><strong>b</strong></a></p>'],
  ['image', '![alt text](a.png)', '<p><img src="a.png" alt="alt text"></p>'],
  ['image title', '![a](b.png "c")', '<p><img src="b.png" alt="a" title="c"></p>'],
  ['autolink', '<https://a.b/c>', '<p><a href="https://a.b/c">https://a.b/c</a></p>'],
  ['email autolink', '<me@ex.com>', '<p><a href="mailto:me@ex.com">me@ex.com</a></p>'],
  ['reference link', '[foo]\n\n[FOO]: /url "title"', '<p><a href="/url" title="title">foo</a></p>'],
  ['full reference', '[x][r]\n\n[r]: http://r.io', '<p><a href="http://r.io">x</a></p>'],
  ['hr variants', '***\n\n---\n\n___', '<hr><hr><hr>'],
  ['fenced', '```js\nconst a = 1 < 2;\n```', '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>'],
  ['fenced tilde no lang', '~~~\nx\n~~~', '<pre><code>x\n</code></pre>'],
  ['fenced keeps blank lines and markup', '```\n# no\n\n*no*\n```', '<pre><code># no\n\n*no*\n</code></pre>'],
  ['indented code', '    code <x>\n    more', '<pre><code>code &lt;x&gt;\nmore\n</code></pre>'],
  ['blockquote', '> a\n> b', '<blockquote><p>a\nb</p></blockquote>'],
  ['blockquote lazy', '> a\nb', '<blockquote><p>a\nb</p></blockquote>'],
  ['nested blockquote', '> > x', '<blockquote><blockquote><p>x</p></blockquote></blockquote>'],
  ['blockquote with heading', '> # H\n> text', '<blockquote><h1>H</h1><p>text</p></blockquote>'],
  ['tight ul', '- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['star and plus', '* a\n* b\n\n+ c', '<ul><li>a</li><li>b</li></ul><ul><li>c</li></ul>'],
  ['ordered start', '3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['ordered paren', '1) a\n2) b', '<ol><li>a</li><li>b</li></ol>'],
  ['nested list', '- a\n  - b\n- c', '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>'],
  ['loose list', '- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['list item with code', '1. x\n\n   ```\n   y\n   ```', '<ol><li><p>x</p><pre><code>y\n</code></pre></li></ol>'],
  ['table', '| a | b | c |\n|:--|:-:|--:|\n| 1 | *2* | 3 |',
    '<table><thead><tr><th align="left">a</th><th align="center">b</th><th align="right">c</th></tr></thead><tbody><tr><td align="left">1</td><td align="center"><em>2</em></td><td align="right">3</td></tr></tbody></table>'],
  ['table no align, escaped pipe', '| x |\n|---|\n| a \\| b |', '<table><thead><tr><th>x</th></tr></thead><tbody><tr><td>a | b</td></tr></tbody></table>'],
  ['raw html block escaped', '<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
  ['raw inline html escaped', 'a <img src=x onerror=alert(1)> b', '<p>a &lt;img src=x onerror=alert(1)&gt; b</p>'],
];
for (const [name, md, html] of cases) test(name, () => assert.equal(R(md), html));
test('unsafe urls neutralised', () => {
  for (const u of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const out = render(`[x](${u}) ![y](${u})`); assert.ok(!/javascript:|vbscript:|file:|data:text/i.test(out), out); assert.match(out, /href="#"/);
  }
  assert.match(render('![p](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
});
test('attribute escaping', () => { assert.match(render('[a](/u "x\\"y")'), /title="x&quot;y"/); });
test('heading ids', () => { assert.equal(R('# Hello World!\n\n## Hello World', { headingIds: true }), '<h1 id="hello-world">Hello World!</h1><h2 id="hello-world-1">Hello World</h2>'); });
test('slugify', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world'); assert.equal(slugify('API v2_beta-test'), 'api-v2_beta-test');
  const seen = new Map(); assert.equal(slugify('A', seen), 'a'); assert.equal(slugify('A', seen), 'a-1'); assert.equal(slugify('A', seen), 'a-2');
});
test('toc', () => {
  assert.deepEqual(toc('# Intro\n\ntext\n\nUsage *now*\n---\n\n```\n# not heading\n```\n\n### Intro'), [
    { level: 1, text: 'Intro', slug: 'intro' }, { level: 2, text: 'Usage now', slug: 'usage-now' }, { level: 3, text: 'Intro', slug: 'intro-1' }]);
});
test('larger document smoke', () => {
  const md = '# Doc\n\nIntro with `code` and [link](https://x.y).\n\n- one\n- two\n  1. nested\n  2. list\n\n> quote\n\n```py\nprint(1)\n```\n\n| h |\n|---|\n| c |\n';
  const out = R(md);
  for (const frag of ['<h1>Doc</h1>', '<code>code</code>', '<a href="https://x.y">link</a>', '<ol><li>nested</li><li>list</li></ol>', '<blockquote><p>quote</p></blockquote>', 'class="language-py"', '<td>c</td>'])
    assert.ok(out.includes(frag), frag);
});
test('CLI file, stdin and toc', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-')), 'a.md'); fs.writeFileSync(f, '# T\n\nx');
  const cli = path.join(APP, 'src/cli.js');
  let r = spawnSync(process.execPath, [cli, f], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.equal(n(r.stdout), '<h1>T</h1><p>x</p>');
  r = spawnSync(process.execPath, [cli, '-'], { input: '*a*', encoding: 'utf8' }); assert.equal(n(r.stdout), '<p><em>a</em></p>');
  r = spawnSync(process.execPath, [cli, f, '--toc'], { encoding: 'utf8' }); assert.deepEqual(JSON.parse(r.stdout), [{ level: 1, text: 'T', slug: 't' }]);
});
