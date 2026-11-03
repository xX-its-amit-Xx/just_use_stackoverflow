import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../src/server.js';
import { render, toc, slugify } from '../src/markdown.js';

async function start(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'))) {
  const srv = createServer({ dataDir: dir }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, type: r.headers.get('content-type') }; };
  return { srv, req, dir };
}

test('markdown basics', () => {
  assert.match(render('~~x~~'), /<del>x<\/del>/);
  assert.match(render('<b>x</b>'), /&lt;b&gt;/);
  assert.match(render('[a](javascript:alert(1))'), /href="#"/);
  assert.match(render('![a](data:image/png;base64,AAA)'), /src="data:image\/png;base64,AAA"/);
  assert.match(render('[a](data:text/html,x)'), /href="#"/);
  assert.equal(slugify('Hello, World!'), 'hello-world');
  const seen = new Map(); assert.deepEqual(['a', 'a', 'a'].map(x => slugify(x, seen)), ['a', 'a-1', 'a-2']);
  assert.deepEqual(toc('# A\n## A\n'), [{ level: 1, text: 'A', slug: 'a' }, { level: 2, text: 'A', slug: 'a-1' }]);
  const wl = { exists: s => s === 'foo' };
  assert.equal(render('[[Foo]] [[Bar baz|x]] `[[Foo]]`', { wikiLinks: wl }).trim(), '<p><a href="/wiki/foo" class="wikilink">Foo</a> <a href="/wiki/bar-baz" class="wikilink missing">x</a> <code>[[Foo]]</code></p>');
  assert.equal(render('[[Foo]]').trim(), '<p>[[Foo]]</p>');
  assert.match(render('| a | b |\n|:-|-:|\n| 1 | 2 |'), /<table>/);
});

test('pages, versions, conflict, history, diff, search, persistence', async () => {
  const { srv, req, dir } = await start();
  assert.equal((await req('PUT', '/api/pages/Bad', { title: 'x', body: '' })).status, 400);
  assert.equal((await req('PUT', '/api/pages/a', '{bad')).status, 400);
  assert.equal((await req('PUT', '/api/pages/a', { title: '', body: '' })).status, 400);
  let r = await req('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\ntwo\nthree', tags: ['X', 'b', 'x'] });
  assert.equal(r.status, 201); assert.deepEqual(r.body.tags, ['b', 'x']); assert.equal(r.body.version, 1);
  r = await req('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\ntwo\nthree', tags: ['x', 'b'] });
  assert.equal(r.status, 200); assert.equal(r.body.version, 1);
  r = await req('PUT', '/api/pages/a', { title: 'Alpha', body: 'one\n2\nthree\nfour [[B]]', baseVersion: 1 });
  assert.equal(r.body.version, 2);
  r = await req('PUT', '/api/pages/a', { title: 'Alpha', body: 'z', baseVersion: 1 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'conflict'); assert.equal(r.body.currentVersion, 2);
  await req('PUT', '/api/pages/b', { title: 'beta', body: 'alpha alpha see [[a]]' });
  r = await req('GET', '/api/pages/a');
  assert.deepEqual(r.body.backlinks, ['b']); assert.deepEqual(r.body.links, ['b']);
  assert.match(r.body.html, /class="wikilink"/);
  r = await req('GET', '/api/pages/a/diff?from=1&to=2');
  assert.deepEqual(r.body.lines, [{ op: ' ', text: 'one' }, { op: '-', text: 'two' }, { op: '+', text: '2' }, { op: ' ', text: 'three' }, { op: '+', text: 'four [[B]]' }]);
  r = await req('GET', '/api/pages/a/history'); assert.deepEqual(r.body.map(h => h.version), [2, 1]);
  r = await req('POST', '/api/pages/a/revert', { version: 1 }); assert.equal(r.body.version, 3);
  r = await req('GET', '/api/pages/a/versions/3'); assert.equal(r.body.body, 'one\ntwo\nthree');
  r = await req('GET', '/api/search?q=ALPHA');
  assert.deepEqual(r.body.map(x => x.slug), ['a', 'b']);
  assert.match(r.body[1].snippet, /<mark>alpha<\/mark>/);
  assert.equal((await req('GET', '/api/search?q=%20')).status, 400);
  r = await req('GET', '/api/pages?sort=updated'); assert.deepEqual(r.body.map(p => p.slug), ['a', 'b']);
  r = await req('GET', '/api/tags'); assert.deepEqual(r.body, [{ tag: 'b', count: 1 }, { tag: 'x', count: 1 }]);
  r = await req('GET', '/wiki/a'); assert.equal(r.status, 200); assert.match(r.type, /text\/html/);
  assert.equal((await req('GET', '/wiki/zzz')).status, 404);
  assert.equal((await req('GET', '/')).status, 200);
  const exp = (await req('GET', '/api/export')).body;
  srv.close();
  const s2 = await start(dir);
  r = await s2.req('GET', '/api/pages/a'); assert.equal(r.body.version, 3);
  assert.equal((await s2.req('DELETE', '/api/pages/a')).status, 204);
  assert.equal((await s2.req('GET', '/api/pages/a/history')).status, 404);
  r = await s2.req('POST', '/api/import', exp); assert.deepEqual(r.body, { imported: 2 });
  s2.srv.close();
});
