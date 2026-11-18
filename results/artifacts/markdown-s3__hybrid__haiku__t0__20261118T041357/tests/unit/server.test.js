import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(dir) {
  const srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { srv, call, base };
}

test('versioning, conflicts, history, revert and diff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-u-'));
  let { srv, call } = await start(dir);
  assert.equal((await call('PUT', '/api/pages/a', { title: 'A', body: 'one\ntwo' })).status, 201);
  let r = await call('PUT', '/api/pages/a', { title: 'A', body: 'one\ntwo', tags: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1, 'unchanged PUT does not create a version');
  r = await call('PUT', '/api/pages/a', { title: 'A', body: 'one\nthree', baseVersion: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'conflict');
  assert.equal(r.body.currentVersion, 1);
  r = await call('PUT', '/api/pages/a', { title: 'A', body: 'one\nthree', baseVersion: 1 });
  assert.equal(r.body.version, 2);
  const diff = await call('GET', '/api/pages/a/diff?from=1&to=2');
  assert.deepEqual(diff.body.lines, [{ op: ' ', text: 'one' }, { op: '-', text: 'two' }, { op: '+', text: 'three' }]);
  const hist = await call('GET', '/api/pages/a/history');
  assert.deepEqual(hist.body.map((h) => h.version), [2, 1]);
  r = await call('POST', '/api/pages/a/revert', { version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 3);
  assert.equal(r.body.body, 'one\ntwo');
  await new Promise((res) => srv.close(res));
  // persistence across restart
  ({ srv, call } = await start(dir));
  assert.equal((await call('GET', '/api/pages/a')).body.version, 3);
  await new Promise((res) => srv.close(res));
});

test('listing, tags, search, validation and delete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-u-'));
  const { srv, call } = await start(dir);
  await call('PUT', '/api/pages/zeta', { title: 'zeta', body: 'Apple apple', tags: ['X', 'x', 'b'] });
  await call('PUT', '/api/pages/alpha', { title: 'Alpha', body: 'nothing <b>here</b>', tags: ['b'] });
  let list = (await call('GET', '/api/pages')).body.map((p) => p.slug);
  assert.deepEqual(list, ['alpha', 'zeta']);
  assert.deepEqual((await call('GET', '/api/tags')).body, [{ tag: 'b', count: 2 }, { tag: 'x', count: 1 }]);
  assert.deepEqual((await call('GET', '/api/pages?tag=x')).body.map((p) => p.slug), ['zeta']);
  const s = (await call('GET', '/api/search?q=APPLE')).body;
  assert.equal(s[0].slug, 'zeta');
  assert.match(s[0].snippet, /<mark>Apple<\/mark>/);
  assert.equal((await call('GET', '/api/search?q=%20')).status, 400);
  assert.equal((await call('PUT', '/api/pages/x', { title: '' })).status, 400);
  assert.equal((await call('PUT', '/api/pages/x', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await call('GET', '/api/pages/nope')).status, 404);
  assert.equal((await call('DELETE', '/api/pages/zeta')).status, 204);
  assert.equal((await call('GET', '/api/pages/zeta/history')).status, 404);
  const w = await fetch(`http://127.0.0.1:${srv.address().port}/wiki/nope`);
  assert.equal(w.status, 404);
  await new Promise((res) => srv.close(res));
});

test('backlinks and links', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-u-'));
  const { srv, call } = await start(dir);
  await call('PUT', '/api/pages/home', { title: 'Home', body: '# Hi\n\n[[Notes]] and [[Ghost]]' });
  await call('PUT', '/api/pages/notes', { title: 'Notes', body: 'back to [[Home]]' });
  const home = (await call('GET', '/api/pages/home')).body;
  assert.deepEqual(home.links, ['ghost', 'notes']);
  assert.deepEqual(home.backlinks, ['notes']);
  const notes = (await call('GET', '/api/pages/notes')).body;
  assert.match(notes.html, /<a href="\/wiki\/home" class="wikilink">Home<\/a>/);
  assert.deepEqual(notes.backlinks, ['home']);
  await new Promise((res) => srv.close(res));
});
