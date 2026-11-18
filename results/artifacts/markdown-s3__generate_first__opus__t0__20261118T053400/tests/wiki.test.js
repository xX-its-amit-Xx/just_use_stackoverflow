import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../src/server.js';
import { render, toc, slugify } from '../src/markdown.js';

async function start(dir) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  const srv = createServer({ dataDir });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const t = await res.text();
    let data = t; try { data = JSON.parse(t); } catch {}
    return { status: res.status, data, type: res.headers.get('content-type') };
  };
  return { srv, call, dataDir, close: () => new Promise((r) => srv.close(r)) };
}

test('renderer basics', () => {
  assert.equal(render('# Hi'), '<h1>Hi</h1>\n');
  assert.equal(render('*a* **b** ~~c~~'), '<p><em>a</em> <strong>b</strong> <del>c</del></p>\n');
  assert.match(render('<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('![x](data:image/png;base64,AA)'), /src="data:image\/png;base64,AA"/);
  assert.match(render('```js\nx\n```'), /<pre><code class="language-js">x\n<\/code><\/pre>/);
  assert.match(render('| a |\n|:-:|\n| b |'), /<td align="center">b<\/td>/);
});

test('slugs and toc', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  const seen = new Map();
  assert.deepEqual(['A', 'A', 'A'].map((t) => slugify(t, seen)), ['a', 'a-1', 'a-2']);
  assert.deepEqual(toc('# One\n## Two *x*\n# One'), [
    { level: 1, text: 'One', slug: 'one' }, { level: 2, text: 'Two x', slug: 'two-x' }, { level: 1, text: 'One', slug: 'one-1' }]);
  assert.match(render('# One\n# One', { headingIds: true }), /<h1 id="one-1">/);
});

test('wiki links', () => {
  const wl = { exists: (s) => s === 'page-title' };
  assert.equal(render('[[Page Title]] [[other|Label]]', { wikiLinks: wl }),
    '<p><a href="/wiki/page-title" class="wikilink">Page Title</a> <a href="/wiki/other" class="wikilink missing">Label</a></p>\n');
  assert.equal(render('`[[x]]`', { wikiLinks: wl }), '<p><code>[[x]]</code></p>\n');
  assert.equal(render('[[x]]'), '<p>[[x]]</p>\n');
});

test('pages, versions, conflicts, history, diff', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('PUT', '/api/pages/Bad', { title: 'x', body: '' })).status, 400);
    assert.equal((await s.call('PUT', '/api/pages/a', { title: '', body: '' })).status, 400);
    assert.equal((await s.call('PUT', '/api/pages/a', '{bad')).status, 400);
    let r = await s.call('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\ntwo\nthree', tags: ['X', 'b', 'x'] });
    assert.equal(r.status, 201); assert.equal(r.data.version, 1); assert.deepEqual(r.data.tags, ['b', 'x']);
    r = await s.call('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\ntwo\nthree', tags: ['x', 'b'] });
    assert.equal(r.status, 200); assert.equal(r.data.version, 1);
    r = await s.call('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\n2\nthree\nfour', baseVersion: 1 });
    assert.equal(r.data.version, 2);
    r = await s.call('PUT', '/api/pages/a', { title: 'Alpha', body: 'zzz', baseVersion: 1 });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'conflict'); assert.equal(r.data.currentVersion, 2);
    r = await s.call('GET', '/api/pages/a/history');
    assert.deepEqual(r.data.map((h) => h.version), [2, 1]);
    r = await s.call('GET', '/api/pages/a/diff?from=1&to=2');
    assert.deepEqual(r.data.lines, [{ op: ' ', text: 'one' }, { op: '-', text: 'two' }, { op: '+', text: '2' }, { op: ' ', text: 'three' }, { op: '+', text: 'four' }]);
    r = await s.call('POST', '/api/pages/a/revert', { version: 1 });
    assert.equal(r.status, 200); assert.equal(r.data.version, 3); assert.equal(r.data.body, 'one\ntwo\nthree');
    r = await s.call('GET', '/api/pages/a/versions/2');
    assert.equal(r.data.body, 'one\n2\nthree\nfour');
    assert.equal((await s.call('GET', '/api/pages/a/versions/9')).status, 404);
    assert.equal((await s.call('GET', '/api/pages/nope')).status, 404);
    assert.equal((await s.call('GET', '/api/nothing')).status, 404);
  } finally { await s.close(); }
});

test('links, backlinks, search, tags, export/import, persistence, wiki page', async () => {
  const s = await start();
  try {
    await s.call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\nSee [[Guide]] and [[Missing Page|m]] `[[Code]]`', tags: ['main'] });
    await s.call('PUT', '/api/pages/guide', { title: 'Guide', body: 'Back to [[home]]. guide guide', tags: ['main', 'doc'] });
    let r = await s.call('GET', '/api/pages/home');
    assert.deepEqual(r.data.links, ['guide', 'missing-page']);
    assert.deepEqual(r.data.backlinks, ['guide']);
    assert.match(r.data.html, /<a href="\/wiki\/guide" class="wikilink">Guide<\/a>/);
    assert.match(r.data.html, /class="wikilink missing">m<\/a>/);
    assert.deepEqual(r.data.toc, [{ level: 1, text: 'Welcome', slug: 'welcome' }]);
    r = await s.call('GET', '/api/search?q=GUIDE');
    assert.equal(r.data[0].slug, 'guide'); assert.equal(r.data[1].slug, 'home');
    assert.match(r.data[1].snippet, /<mark>Guide<\/mark>/);
    assert.equal((await s.call('GET', '/api/search?q=%20')).status, 400);
    r = await s.call('GET', '/api/tags');
    assert.deepEqual(r.data, [{ tag: 'doc', count: 1 }, { tag: 'main', count: 2 }]);
    r = await s.call('GET', '/api/pages?tag=doc');
    assert.deepEqual(r.data.map((p) => p.slug), ['guide']);
    await s.call('PUT', '/api/pages/home', { title: 'Home', body: 'changed' });
    r = await s.call('GET', '/api/pages?sort=updated');
    assert.deepEqual(r.data.map((p) => p.slug), ['home', 'guide']);
    r = await s.call('POST', '/api/render', { markdown: '[[Home]]' });
    assert.match(r.data.html, /class="wikilink"/);
    r = await s.call('GET', '/wiki/home');
    assert.equal(r.status, 200); assert.match(r.type, /text\/html/); assert.match(r.data, /Home/);
    assert.equal((await s.call('GET', '/wiki/zzz')).status, 404);
    r = await s.call('GET', '/');
    assert.match(r.type, /text\/html/);
    const exp = (await s.call('GET', '/api/export')).data;
    assert.equal(exp.pages.length, 2);
    assert.equal((await s.call('DELETE', '/api/pages/guide')).status, 204);
    assert.equal((await s.call('GET', '/api/pages/guide/history')).status, 404);
    r = await s.call('POST', '/api/import', exp);
    assert.deepEqual(r.data, { imported: 2 });
    await s.close();
    const s2 = await start(s.dataDir);
    r = await s2.call('GET', '/api/pages/guide');
    assert.equal(r.data.title, 'Guide');
    await s2.close();
  } finally { s.srv.close(); }
});
