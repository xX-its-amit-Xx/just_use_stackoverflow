import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(dataDir) {
  const srv = createServer({ dataDir: dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-')) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* html or empty */
    }
    return { status: res.status, json, text, type: res.headers.get('content-type') };
  };
  const stop = () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return { srv, call, stop, dir: srv.dataDir };
}

test('PUT create/update/no-op, GET page with html, toc, links, backlinks', async () => {
  const { call, stop } = await start();
  try {
    let r = await call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\n\nSee [[Guide]]', tags: ['B', 'a', 'a'] });
    assert.equal(r.status, 201);
    assert.equal(r.json.version, 1);
    assert.deepEqual(r.json.tags, ['a', 'b']);

    r = await call('PUT', '/api/pages/home', { title: 'Home', body: '# Welcome\n\nSee [[Guide]]', tags: ['a', 'b'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1, 'unchanged PUT keeps version');

    r = await call('PUT', '/api/pages/guide', { title: 'Guide', body: 'Back to [[home]]' });
    assert.equal(r.status, 201);

    r = await call('GET', '/api/pages/home');
    assert.equal(r.status, 200);
    assert.match(r.json.html, /<h1 id="welcome">Welcome<\/h1>/);
    assert.match(r.json.html, /href="\/wiki\/guide" class="wikilink">Guide<\/a>/);
    assert.deepEqual(r.json.toc, [{ level: 1, text: 'Welcome', slug: 'welcome' }]);
    assert.deepEqual(r.json.links, ['guide']);
    assert.deepEqual(r.json.backlinks, ['guide']);

    r = await call('PUT', '/api/pages/home', { title: 'Home 2', body: 'x', baseVersion: 7 });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'conflict');
    assert.equal(r.json.currentVersion, 1);
  } finally {
    await stop();
  }
});

test('validation and not-found errors', async () => {
  const { call, stop } = await start();
  try {
    assert.equal((await call('PUT', '/api/pages/Bad_Slug', { title: 'x' })).status, 400);
    assert.equal((await call('PUT', '/api/pages/ok', { title: '' })).status, 400);
    assert.equal((await call('PUT', '/api/pages/ok', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await call('GET', '/api/pages/none')).status, 404);
    assert.equal((await call('GET', '/api/search?q=')).status, 400);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  } finally {
    await stop();
  }
});

test('bad JSON gives 400', async () => {
  const { srv, stop } = await start();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const res = await fetch(base + '/api/pages/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  } finally {
    await stop();
  }
});

test('history, version view, revert, diff', async () => {
  const { call, stop } = await start();
  try {
    await call('PUT', '/api/pages/doc', { title: 'Doc', body: 'a\nb\nc' });
    await call('PUT', '/api/pages/doc', { title: 'Doc', body: 'a\nB\nc\nd' });
    await call('PUT', '/api/pages/doc', { title: 'Doc v3', body: 'a\nB\nc\nd' });

    let r = await call('GET', '/api/pages/doc/history');
    assert.deepEqual(r.json.map((h) => h.version), [3, 2, 1]);

    r = await call('GET', '/api/pages/doc/versions/1');
    assert.deepEqual(r.json, { version: 1, title: 'Doc', body: 'a\nb\nc', tags: [] });

    r = await call('GET', '/api/pages/doc/diff?from=1&to=2');
    assert.deepEqual(r.json.lines, [
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);

    r = await call('POST', '/api/pages/doc/revert', { version: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 4);
    assert.equal(r.json.body, 'a\nb\nc');
    assert.equal(r.json.title, 'Doc');
    assert.equal((await call('POST', '/api/pages/doc/revert', { version: 99 })).status, 404);
  } finally {
    await stop();
  }
});

test('search ordering and snippets', async () => {
  const { call, stop } = await start();
  try {
    await call('PUT', '/api/pages/alpha', { title: 'Cats', body: 'nothing here' });
    await call('PUT', '/api/pages/beta', { title: 'Notes', body: 'the cat sat; cat cat' });
    await call('PUT', '/api/pages/gamma', { title: 'About cat', body: 'x' });
    const r = await call('GET', '/api/search?q=CAT');
    assert.deepEqual(r.json.map((h) => h.slug), ['alpha', 'gamma', 'beta']);
    const beta = r.json.find((h) => h.slug === 'beta');
    assert.equal(beta.snippet, 'the <mark>cat</mark> sat; cat cat');
    assert.equal(beta.score, 3);
  } finally {
    await stop();
  }
});

test('tags, list filter and sort, delete', async () => {
  const { call, stop } = await start();
  try {
    await call('PUT', '/api/pages/b-page', { title: 'banana', body: '', tags: ['fruit'] });
    await call('PUT', '/api/pages/a-page', { title: 'Apple', body: '', tags: ['Fruit', 'red'] });
    await call('PUT', '/api/pages/c-page', { title: 'cherry', body: '' });
    let r = await call('GET', '/api/pages');
    assert.deepEqual(r.json.map((p) => p.slug), ['a-page', 'b-page', 'c-page']);
    r = await call('GET', '/api/pages?tag=fruit');
    assert.deepEqual(r.json.map((p) => p.slug), ['a-page', 'b-page']);
    r = await call('GET', '/api/tags');
    assert.deepEqual(r.json, [{ tag: 'fruit', count: 2 }, { tag: 'red', count: 1 }]);
    assert.equal((await call('DELETE', '/api/pages/a-page')).status, 204);
    assert.equal((await call('GET', '/api/pages/a-page/history')).status, 404);
    assert.equal((await call('DELETE', '/api/pages/a-page')).status, 404);
  } finally {
    await stop();
  }
});

test('render endpoint, export and import', async () => {
  const { call, stop } = await start();
  try {
    let r = await call('POST', '/api/render', { markdown: '## Sub [[Target]]' });
    assert.match(r.json.html, /<h2 id="sub-target">Sub <a href="\/wiki\/target" class="wikilink missing">Target<\/a><\/h2>/);
    assert.deepEqual(r.json.toc, [{ level: 2, text: 'Sub Target', slug: 'sub-target' }]);
    await call('PUT', '/api/pages/one', { title: 'One', body: 'hi', tags: ['x'] });
    r = await call('GET', '/api/export');
    assert.deepEqual(r.json.pages, [{ slug: 'one', title: 'One', body: 'hi', tags: ['x'], version: 1 }]);
    r = await call('POST', '/api/import', { pages: [{ slug: 'two', title: 'Two', body: 'yo' }, { slug: 'one', title: 'One', body: 'changed' }] });
    assert.deepEqual(r.json, { imported: 2 });
    r = await call('GET', '/api/pages/one');
    assert.equal(r.json.version, 2);
  } finally {
    await stop();
  }
});

test('wiki HTML page, UI routes, persistence across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-persist-'));
  let s = await start(dir);
  await s.call('PUT', '/api/pages/keep', { title: 'Kept', body: '# Title here\n\n[[Other]]' });
  await s.stop();

  s = await start(dir);
  try {
    const r = await s.call('GET', '/api/pages/keep');
    assert.equal(r.json.title, 'Kept');
    const w = await s.call('GET', '/wiki/keep');
    assert.equal(w.status, 200);
    assert.match(w.type, /text\/html/);
    assert.match(w.text, /<title>Kept<\/title>/);
    assert.match(w.text, /<h1 id="title-here">Title here<\/h1>/);
    assert.equal((await s.call('GET', '/wiki/missing')).status, 404);
    const idx = await s.call('GET', '/');
    assert.equal(idx.status, 200);
    assert.match(idx.type, /text\/html/);
    const js = await s.call('GET', '/static/app.js');
    assert.equal(js.status, 200);
    assert.equal((await s.call('GET', '/static/..%2Fmarkdown.js')).status, 404);
  } finally {
    await s.stop();
  }
});
