import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
const APP = process.env.APP_DIR;
const { render, toc, slugify } = await import(path.join(APP, 'src/markdown.js'));
const { createServer } = await import(path.join(APP, 'src/server.js'));

const BLOCK = /\s*(<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr)\b[^>]*>)\s*/g;
const n = s => s.replace(/<(br|hr|img)([^>]*?)\s*\/>/g, '<$1$2>').replace(/style="text-align:\s*(left|right|center);?"/g, 'align="$1"')
  .replace(BLOCK, '$1').replace(/<br>\s*/g, '<br>').trim();

// ---------- renderer ----------
const cases = [
  ['setext', 'Title\n=====\n\nSub\n---', '<h1>Title</h1><h2>Sub</h2>'],
  ['hard break', 'a  \nb', '<p>a<br>b</p>'],
  ['triple emphasis', '***e***', '<p><em><strong>e</strong></em></p>'],
  ['intraword underscore', 'snake_case_name', '<p>snake_case_name</p>'],
  ['strike', '~~x~~', '<p><del>x</del></p>'],
  ['code span backticks', '`` a ` b ``', '<p><code>a ` b</code></p>'],
  ['indented code', '    x <y>', '<pre><code>x &lt;y&gt;\n</code></pre>'],
  ['fenced', '~~~py\nprint(1)\n~~~', '<pre><code class="language-py">print(1)\n</code></pre>'],
  ['nested lists', '- a\n  1. b\n  2. c\n- d', '<ul><li>a<ol><li>b</li><li>c</li></ol></li><li>d</li></ul>'],
  ['loose list', '- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['ordered start', '7) x', '<ol start="7"><li>x</li></ol>'],
  ['blockquote lazy', '> a\nb', '<blockquote><p>a\nb</p></blockquote>'],
  ['reference link', '[foo]\n\n[FOO]: /url "t"', '<p><a href="/url" title="t">foo</a></p>'],
  ['autolink', '<https://a.b>', '<p><a href="https://a.b">https://a.b</a></p>'],
  ['image title', '![a](b.png "c")', '<p><img src="b.png" alt="a" title="c"></p>'],
  ['escapes', '\\*x\\* & <y>', '<p>*x* &amp; &lt;y&gt;</p>'],
  ['table', '| a | b |\n|:-:|--:|\n| *1* | 2 |', '<table><thead><tr><th align="center">a</th><th align="right">b</th></tr></thead><tbody><tr><td align="center"><em>1</em></td><td align="right">2</td></tr></tbody></table>'],
  ['raw html escaped', '<div onclick="x()">hi</div>', '<p>&lt;div onclick=&quot;x()&quot;&gt;hi&lt;/div&gt;</p>'],
  ['hr', '***', '<hr>'],
];
for (const [name, md, html] of cases) test(`render: ${name}`, () => assert.equal(n(render(md)), html));
test('render: unsafe urls', () => {
  const out = render('[a](javascript:alert(1)) ![b](data:text/html,x) ![c](data:image/png;base64,AA==)');
  assert.ok(!/javascript:|data:text/i.test(out)); assert.match(out, /href="#"/); assert.match(out, /src="data:image\/png;base64,AA=="/);
});
test('render: heading ids, toc, slugify', () => {
  assert.equal(n(render('# Hello World!\n\n## Hello World', { headingIds: true })), '<h1 id="hello-world">Hello World!</h1><h2 id="hello-world-1">Hello World</h2>');
  assert.deepEqual(toc('# A\n\n```\n# no\n```\n\nB *b*\n---'), [{ level: 1, text: 'A', slug: 'a' }, { level: 2, text: 'B b', slug: 'b-b' }]);
  assert.equal(slugify('API v2_beta-test!'), 'api-v2_beta-test');
});
test('render: wiki links', () => {
  const exists = s => s === 'home';
  const out = n(render('See [[Home]], [[home|the start]] and [[Missing Page]]. `[[code]]`', { wikiLinks: { exists } }));
  assert.equal(out, '<p>See <a href="/wiki/home" class="wikilink">Home</a>, <a href="/wiki/home" class="wikilink">the start</a> and <a href="/wiki/missing-page" class="wikilink missing">Missing Page</a>. <code>[[code]]</code></p>');
  assert.equal(n(render('[[Home]]')), '<p>[[Home]]</p>');
});

// ---------- server ----------
let S, base, dir;
const call = async (m, p, b, raw) => {
  const r = await fetch(base + p, { method: m, headers: b !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}, body: raw !== undefined ? raw : b !== undefined ? JSON.stringify(b) : undefined });
  const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = t; } return { status: r.status, body, headers: r.headers };
};
async function start() { S = createServer({ dataDir: dir }); await new Promise(r => S.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${S.address().port}`; }
const stop = () => new Promise(r => { S.closeAllConnections?.(); S.close(r); });
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-')); await start(); });
after(stop);

test('api: create, validate, update, no-op update, conflict', async () => {
  assert.equal((await call('PUT', '/api/pages/Bad Slug', { title: 'x', body: '' })).status, 400);
  assert.equal((await call('PUT', '/api/pages/ok', { title: '', body: '' })).status, 400);
  assert.equal((await call('PUT', '/api/pages/ok', undefined, '{oops')).status, 400);
  const c = await call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\n\nGo to [[Guide]].', tags: ['Intro', 'intro', 'b'] });
  assert.equal(c.status, 201); assert.equal(c.body.version, 1); assert.deepEqual(c.body.tags, ['b', 'intro']);
  const u = await call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\n\nGo to [[Guide]] and [[Missing]].', tags: ['intro'] });
  assert.equal(u.status, 200); assert.equal(u.body.version, 2);
  const same = await call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\n\nGo to [[Guide]] and [[Missing]].', tags: ['intro'] });
  assert.equal(same.body.version, 2);
  const cf = await call('PUT', '/api/pages/home', { title: 'Home', body: 'x', baseVersion: 1 });
  assert.equal(cf.status, 409); assert.equal(cf.body.currentVersion, 2);
});
test('api: get page with html, toc, links, backlinks', async () => {
  await call('PUT', '/api/pages/guide', { title: 'Guide', body: '## Steps\n\nBack to [[Home]]. [[home|again]]', tags: ['docs'] });
  const p = (await call('GET', '/api/pages/home')).body;
  assert.match(p.html, /<h1 id="welcome">Welcome<\/h1>/);
  assert.match(p.html, /<a href="\/wiki\/guide" class="wikilink">Guide<\/a>/); assert.match(p.html, /class="wikilink missing">Missing<\/a>/);
  assert.deepEqual(p.toc, [{ level: 1, text: 'Welcome', slug: 'welcome' }]);
  assert.deepEqual(p.links, ['guide', 'missing']); assert.deepEqual(p.backlinks, ['guide']);
  assert.deepEqual((await call('GET', '/api/pages/guide')).body.backlinks, ['home']);
  assert.equal((await call('GET', '/api/pages/nope')).status, 404);
});
test('api: list, tags, sort', async () => {
  await call('PUT', '/api/pages/alpha', { title: 'alpha page', body: 'a', tags: ['docs'] });
  assert.deepEqual((await call('GET', '/api/pages')).body.map(p => p.slug), ['alpha', 'guide', 'home']);
  assert.deepEqual((await call('GET', '/api/pages?tag=docs')).body.map(p => p.slug), ['alpha', 'guide']);
  assert.equal((await call('GET', '/api/pages?sort=updated')).body[0].slug, 'alpha');
  assert.deepEqual((await call('GET', '/api/tags')).body, [{ tag: 'docs', count: 2 }, { tag: 'intro', count: 1 }]);
});
test('api: history, versions, revert', async () => {
  const h = (await call('GET', '/api/pages/home/history')).body; assert.deepEqual(h.map(x => x.version), [2, 1]);
  assert.equal((await call('GET', '/api/pages/home/versions/1')).body.body, '# Welcome\n\nGo to [[Guide]].');
  assert.equal((await call('GET', '/api/pages/home/versions/9')).status, 404);
  const r = await call('POST', '/api/pages/home/revert', { version: 1 }); assert.equal(r.status, 200); assert.equal(r.body.version, 3);
  assert.equal((await call('GET', '/api/pages/home')).body.body, '# Welcome\n\nGo to [[Guide]].');
});
test('api: line diff', async () => {
  await call('PUT', '/api/pages/d', { title: 'D', body: 'a\nb\nc\nd' });
  await call('PUT', '/api/pages/d', { title: 'D', body: 'a\nx\nc\nd\ne' });
  const d = (await call('GET', '/api/pages/d/diff?from=1&to=2')).body;
  assert.deepEqual(d.lines, [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: ' ', text: 'c' }, { op: ' ', text: 'd' }, { op: '+', text: 'e' }]);
});
test('api: search ranking and snippet', async () => {
  await call('PUT', '/api/pages/s1', { title: 'Zebra notes', body: 'Nothing about it here.' });
  await call('PUT', '/api/pages/s2', { title: 'Other', body: 'The ZEBRA crossed. A zebra again & <again>.' });
  await call('PUT', '/api/pages/s3', { title: 'Third', body: 'one zebra' });
  const r = (await call('GET', '/api/search?q=zebra')).body;
  assert.deepEqual(r.map(x => x.slug), ['s1', 's2', 's3']);
  assert.match(r[1].snippet, /<mark>ZEBRA<\/mark>/); assert.ok(!r[1].snippet.includes('<again>'));
  assert.equal((await call('GET', '/api/search?q=%20')).status, 400);
});
test('api: render endpoint, export/import, delete', async () => {
  const rr = (await call('POST', '/api/render', { markdown: '# T\n\n[[Guide]]' })).body;
  assert.match(rr.html, /class="wikilink">Guide/); assert.equal(rr.toc[0].slug, 't');
  const ex = (await call('GET', '/api/export')).body; assert.ok(ex.pages.find(p => p.slug === 'guide'));
  const im = await call('POST', '/api/import', { pages: [{ slug: 'imp', title: 'Imported', body: 'x', tags: [] }] }); assert.equal(im.body.imported, 1);
  assert.equal((await call('DELETE', '/api/pages/imp')).status, 204); assert.equal((await call('GET', '/api/pages/imp/history')).status, 404);
});
test('wiki html page and UI', async () => {
  const r = await fetch(base + '/wiki/guide'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text(); assert.match(html, /<html/i); assert.match(html, /Guide/); assert.match(html, /id="steps"/);
  assert.equal((await fetch(base + '/wiki/zzz')).status, 404);
  const ui = await fetch(base + '/'); assert.equal(ui.status, 200); assert.match(await ui.text(), /<html/i);
});
test('persistence across restart', async () => {
  await stop(); await start();
  const p = (await call('GET', '/api/pages/home')).body; assert.equal(p.version, 3); assert.deepEqual(p.backlinks, ['guide']);
  assert.equal((await call('GET', '/api/pages/home/history')).body.length, 3);
});
