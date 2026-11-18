import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

let dir;
let srv;
let base;

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, type: res.headers.get('content-type') };
}

const put = (slug, body) => call('PUT', `/api/pages/${slug}`, body);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-unit-'));
  srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('create, conflict, no-op PUT and versions', async () => {
  let r = await put('alpha', { title: 'Alpha', body: '# Hi\n\nSee [[Beta]]', tags: ['X', 'x', 'b'] });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 1);
  assert.deepEqual(r.json.tags, ['b', 'x']);

  r = await put('alpha', { title: 'Alpha', body: '# Hi\n\nSee [[Beta]]', tags: ['b', 'x'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 1);

  r = await put('alpha', { title: 'Alpha 2', body: 'changed', baseVersion: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);

  r = await put('alpha', { title: 'Stale', body: 'x', baseVersion: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
  assert.equal(r.json.currentVersion, 2);

  r = await call('GET', '/api/pages/alpha/history');
  assert.deepEqual(r.json.map((v) => v.version), [2, 1]);

  r = await call('GET', '/api/pages/alpha/versions/1');
  assert.equal(r.json.title, 'Alpha');
  assert.equal(r.json.body, '# Hi\n\nSee [[Beta]]');

  r = await call('POST', '/api/pages/alpha/revert', { version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 3);
  assert.equal(r.json.title, 'Alpha');
});

test('validation and error codes', async () => {
  assert.equal((await put('Bad Slug', { title: 'x', body: '' })).status, 400);
  assert.equal((await put('ok', { title: '', body: '' })).status, 400);
  assert.equal((await put('ok', { title: 'x'.repeat(201), body: '' })).status, 400);
  assert.equal((await put('ok', { title: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/pages/ok', '{bad json')).status, 400);
  assert.equal((await call('GET', '/api/pages/missing-page')).status, 404);
  assert.equal((await call('GET', '/api/pages/alpha/versions/99')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/api/search?q=')).status, 400);
});

test('page view includes html, toc, links, backlinks', async () => {
  await put('beta', { title: 'Beta', body: '## Sub Heading\n\nback to [[alpha|Alpha]] and [[ghost]]' });
  const r = await call('GET', '/api/pages/beta');
  assert.equal(r.status, 200);
  assert.match(r.json.html, /<h2 id="sub-heading">Sub Heading<\/h2>/);
  assert.match(r.json.html, /<a href="\/wiki\/alpha" class="wikilink">Alpha<\/a>/);
  assert.match(r.json.html, /<a href="\/wiki\/ghost" class="wikilink missing">ghost<\/a>/);
  assert.deepEqual(r.json.toc, [{ level: 2, text: 'Sub Heading', slug: 'sub-heading' }]);
  assert.deepEqual(r.json.links, ['alpha', 'ghost']);
  const a = await call('GET', '/api/pages/alpha');
  assert.deepEqual(a.json.backlinks, ['beta']);
});

test('list, tags, search, export/import', async () => {
  await put('gamma', { title: 'apple pie', body: 'Recipe with apples. apples apples', tags: ['food'] });
  let r = await call('GET', '/api/pages?tag=food');
  assert.deepEqual(r.json.map((p) => p.slug), ['gamma']);
  r = await call('GET', '/api/pages?sort=bogus');
  assert.equal(r.status, 400);
  r = await call('GET', '/api/tags');
  assert.deepEqual(r.json, [{ tag: 'b', count: 1 }, { tag: 'food', count: 1 }, { tag: 'x', count: 1 }]);

  r = await call('GET', '/api/search?q=APPLE');
  assert.equal(r.json[0].slug, 'gamma');
  assert.match(r.json[0].snippet, /<mark>apple<\/mark>/);

  r = await call('GET', '/api/export');
  assert.ok(r.json.pages.some((p) => p.slug === 'gamma'));
  r = await call('POST', '/api/import', { pages: [{ slug: 'delta', title: 'Delta', body: 'd', tags: [] }] });
  assert.deepEqual(r.json, { imported: 1 });
  assert.equal((await call('GET', '/api/pages/delta')).status, 200);
});

test('diff puts removals before additions', async () => {
  await put('diffy', { title: 'D', body: 'a\nb\nc' });
  await put('diffy', { title: 'D', body: 'a\nX\nY\nc', baseVersion: 1 });
  const r = await call('GET', '/api/pages/diffy/diff?from=1&to=2');
  assert.deepEqual(r.json.lines, [
    { op: ' ', text: 'a' },
    { op: '-', text: 'b' },
    { op: '+', text: 'X' },
    { op: '+', text: 'Y' },
    { op: ' ', text: 'c' },
  ]);
});

test('render endpoint, wiki page, static files, delete', async () => {
  let r = await call('POST', '/api/render', { markdown: '# T\n\n[[alpha]]' });
  assert.equal(r.status, 200);
  assert.match(r.json.html, /<h1 id="t">T<\/h1>/);
  assert.equal(r.json.toc[0].slug, 't');

  r = await call('GET', '/wiki/alpha');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.text, /<title>Alpha<\/title>/);
  assert.match(r.text, /<a href="\/wiki\/beta" class="wikilink">Beta<\/a>/);
  assert.equal((await call('GET', '/wiki/nothere')).status, 404);

  r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.equal((await call('GET', '/static/app.js')).status, 200);
  assert.equal((await call('GET', '/static/..%2fpackage.json')).status, 404);

  r = await call('DELETE', '/api/pages/delta');
  assert.equal(r.status, 204);
  assert.equal((await call('GET', '/api/pages/delta')).status, 404);
});

test('state survives restart', async () => {
  await new Promise((r) => srv.close(r));
  srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const r = await call('GET', '/api/pages/gamma');
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 1);
  const h = await call('GET', '/api/pages/alpha/history');
  assert.equal(h.json.length, 3);
});
