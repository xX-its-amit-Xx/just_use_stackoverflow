import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../src/server.js';
import { render, toc, slugify } from '../src/markdown.js';
import { diffLines } from '../src/diff.js';

async function start(dir) {
  const srv = createServer({ dataDir: dir }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    let data = text; try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, type: res.headers.get('content-type') };
  };
  return { srv, call };
}

test('renderer basics', () => {
  assert.equal(render('~~x~~').trim(), '<p><del>x</del></p>');
  assert.equal(render('<b>x</b>').trim(), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.match(render('[a](JavaScript:alert(1))'), /href="#"/);
  assert.match(render('![a](data:image/gif;base64,AA)'), /src="data:image\/gif/);
  assert.match(render('[[Foo Bar]]', { wikiLinks: { exists: () => false } }), /<a href="\/wiki\/foo-bar" class="wikilink missing">Foo Bar<\/a>/);
  assert.equal(render('[[x]]').trim(), '<p>[[x]]</p>');
  assert.deepEqual(toc('# A\n## A'), [{ level: 1, text: 'A', slug: 'a' }, { level: 2, text: 'A', slug: 'a-1' }]);
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('diff', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc\nd'), [
    { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' }]);
});

test('full api flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  let { srv, call } = await start(dir);
  assert.equal((await call('PUT', '/api/pages/Bad', { title: 'x', body: '' })).status, 400);
  assert.equal((await call('PUT', '/api/pages/a', '{bad')).data.error, 'bad_json');
  assert.equal((await call('PUT', '/api/pages/a', { title: '', body: '' })).status, 400);
  let r = await call('PUT', '/api/pages/home', { title: 'Home', body: 'See [[Other]] and [[Missing|m]]', tags: ['B', 'a', 'b'] });
  assert.equal(r.status, 201); assert.deepEqual(r.data.tags, ['a', 'b']); assert.equal(r.data.version, 1);
  r = await call('PUT', '/api/pages/other', { title: 'other page', body: 'line1\nline2 apple' });
  r = await call('PUT', '/api/pages/home', { title: 'Home', body: 'See [[Other]] and [[Missing|m]]', tags: ['a', 'b'] });
  assert.equal(r.status, 200); assert.equal(r.data.version, 1);
  r = await call('PUT', '/api/pages/other', { title: 'Other page', body: 'line1\nline3 apple apple', baseVersion: 5 });
  assert.equal(r.status, 409); assert.equal(r.data.currentVersion, 1);
  r = await call('PUT', '/api/pages/other', { title: 'Other page', body: 'line1\nline3 apple apple', baseVersion: 1 });
  assert.equal(r.data.version, 2);
  r = await call('GET', '/api/pages/home');
  assert.match(r.data.html, /class="wikilink">Other</); assert.match(r.data.html, /wikilink missing">m</);
  assert.deepEqual(r.data.links, ['missing', 'other']);
  assert.deepEqual((await call('GET', '/api/pages/other')).data.backlinks, ['home']);
  assert.deepEqual((await call('GET', '/api/pages/other/history')).data.map(h => h.version), [2, 1]);
  assert.equal((await call('GET', '/api/pages/other/versions/1')).data.body, 'line1\nline2 apple');
  assert.equal((await call('GET', '/api/pages/other/versions/9')).status, 404);
  r = await call('GET', '/api/pages/other/diff?from=1&to=2');
  assert.deepEqual(r.data.lines.map(l => l.op), [' ', '-', '+']);
  r = await call('GET', '/api/search?q=APPLE');
  assert.equal(r.data[0].slug, 'other'); assert.match(r.data[0].snippet, /<mark>apple<\/mark>/);
  r = await call('GET', '/api/search?q=page');
  assert.equal(r.data[0].slug, 'other');
  assert.equal((await call('GET', '/api/search?q=%20')).status, 400);
  assert.deepEqual((await call('GET', '/api/tags')).data, [{ tag: 'a', count: 1 }, { tag: 'b', count: 1 }]);
  assert.deepEqual((await call('GET', '/api/pages?tag=a')).data.map(p => p.slug), ['home']);
  assert.deepEqual((await call('GET', '/api/pages?sort=updated')).data.map(p => p.slug), ['other', 'home']);
  r = await call('POST', '/api/pages/other/revert', { version: 1 });
  assert.equal(r.status, 200); assert.equal(r.data.version, 3); assert.equal(r.data.body, 'line1\nline2 apple');
  r = await call('GET', '/wiki/home'); assert.equal(r.status, 200); assert.match(r.type, /text\/html/); assert.match(r.data, /Home/);
  assert.equal((await call('GET', '/wiki/nope')).status, 404);
  assert.match((await call('GET', '/')).type, /text\/html/);
  assert.equal((await call('GET', '/static/app.js')).status, 200);
  r = await call('POST', '/api/render', { markdown: '# T\n[[Home]]' });
  assert.match(r.data.html, /id="t"/); assert.match(r.data.html, /class="wikilink"/);
  srv.close();
  ({ srv, call } = await start(dir));
  r = await call('GET', '/api/export');
  assert.equal(r.data.pages.length, 2);
  assert.equal((await call('GET', '/api/pages/other')).data.version, 3);
  r = await call('POST', '/api/import', { pages: [{ slug: 'new', title: 'New', body: 'x' }, { slug: 'home', title: 'Home', body: 'changed' }] });
  assert.equal(r.data.imported, 2);
  assert.equal((await call('GET', '/api/pages/home')).data.version, 2);
  assert.equal((await call('DELETE', '/api/pages/home')).status, 204);
  assert.equal((await call('GET', '/api/pages/home')).status, 404);
  assert.equal((await call('GET', '/api/pages/home/history')).status, 404);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  srv.close();
});
