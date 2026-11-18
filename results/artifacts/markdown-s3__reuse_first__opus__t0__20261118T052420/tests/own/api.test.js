import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../src/server.js';
import { render, toc, slugify } from '../../src/markdown.js';

async function start(dir) {
  const srv = createServer({ dataDir: dir }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : (typeof b === 'string' ? b : JSON.stringify(b)) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d, ct: r.headers.get('content-type') }; };
  return { srv, call };
}

test('markdown basics', () => {
  assert.equal(render('~~a~~').trim(), '<p><del>a</del></p>');
  assert.match(render('[x](javascript:alert(1))'), /href="#"/);
  assert.match(render('<script>x</script>'), /&lt;script&gt;/);
  assert.match(render('`[[A]]` [[A]]', { wikiLinks: { exists: () => false } }), /<code>\[\[A\]\]<\/code> <a href="\/wiki\/a" class="wikilink missing">A<\/a>/);
  const seen = new Map(); assert.deepEqual([slugify('A b', seen), slugify('A b', seen), slugify('A b', seen)], ['a-b', 'a-b-1', 'a-b-2']);
  assert.deepEqual(toc('# One\n## Two!'), [{ level: 1, text: 'One', slug: 'one' }, { level: 2, text: 'Two!', slug: 'two' }]);
});

test('full API flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  let { srv, call } = await start(dir);
  assert.equal((await call('PUT', '/api/pages/Bad', { title: 'x', body: '' })).s, 400);
  assert.equal((await call('PUT', '/api/pages/a', '{bad')).s, 400);
  assert.equal((await call('PUT', '/api/pages/a', { title: 'Alpha', body: 'line1\nline2\nsee [[Beta]]', tags: ['X', 'y', 'x'] })).s, 201);
  let r = await call('PUT', '/api/pages/a', { title: 'Alpha', body: 'line1\nline2\nsee [[Beta]]', tags: ['x', 'y'] });
  assert.equal(r.s, 200); assert.equal(r.d.version, 1); assert.deepEqual(r.d.tags, ['x', 'y']);
  r = await call('PUT', '/api/pages/a', { title: 'Alpha', body: 'line1\nchanged\nsee [[Beta]]', baseVersion: 1 });
  assert.equal(r.d.version, 2);
  r = await call('PUT', '/api/pages/a', { title: 'Alpha', body: 'z', baseVersion: 1 });
  assert.equal(r.s, 409); assert.equal(r.d.error, 'conflict'); assert.equal(r.d.currentVersion, 2);
  await call('PUT', '/api/pages/beta', { title: 'beta page', body: '# H\n# H' });
  r = await call('GET', '/api/pages/beta');
  assert.deepEqual(r.d.backlinks, ['a']); assert.match(r.d.html, /id="h-1"/);
  r = await call('GET', '/api/pages/a'); assert.deepEqual(r.d.links, ['beta']); assert.match(r.d.html, /class="wikilink"/);
  r = await call('GET', '/api/pages/a/diff?from=1&to=2');
  assert.deepEqual(r.d.lines, [{ op: ' ', text: 'line1' }, { op: '-', text: 'line2' }, { op: '+', text: 'changed' }, { op: ' ', text: 'see [[Beta]]' }]);
  r = await call('GET', '/api/pages/a/history'); assert.deepEqual(r.d.map(h => h.version), [2, 1]);
  r = await call('POST', '/api/pages/a/revert', { version: 1 }); assert.equal(r.s, 200); assert.equal(r.d.version, 3); assert.equal(r.d.body, 'line1\nline2\nsee [[Beta]]');
  assert.equal((await call('GET', '/api/pages/a/versions/9')).s, 404);
  r = await call('GET', '/api/search?q=LINE'); assert.equal(r.d[0].slug, 'a'); assert.match(r.d[0].snippet, /<mark>line<\/mark>1/);
  assert.equal((await call('GET', '/api/search?q=%20')).s, 400);
  r = await call('GET', '/api/pages'); assert.deepEqual(r.d.map(p => p.slug), ['a', 'beta']);
  r = await call('GET', '/api/pages?sort=updated'); assert.deepEqual(r.d.map(p => p.slug), ['a', 'beta']);
  r = await call('GET', '/api/tags'); assert.deepEqual(r.d, [{ tag: 'x', count: 1 }, { tag: 'y', count: 1 }]);
  r = await call('GET', '/wiki/a'); assert.match(r.ct, /text\/html/); assert.match(r.d, /Alpha/);
  assert.equal((await call('GET', '/wiki/nope')).s, 404);
  assert.match((await call('GET', '/')).ct, /text\/html/);
  const exp = (await call('GET', '/api/export')).d;
  srv.close();
  ({ srv, call } = await start(dir));
  assert.equal((await call('GET', '/api/pages/a')).d.version, 3);
  assert.equal((await call('DELETE', '/api/pages/a')).s, 204);
  assert.equal((await call('GET', '/api/pages/a/history')).s, 404);
  r = await call('POST', '/api/import', exp); assert.deepEqual(r.d, { imported: 2 });
  assert.equal((await call('GET', '/api/pages/a')).d.version, 1);
  r = await call('POST', '/api/render', { markdown: '[[Beta]] [[Nope]]' }); assert.match(r.d.html, /wikilink"/); assert.match(r.d.html, /wikilink missing/);
  srv.close();
});
