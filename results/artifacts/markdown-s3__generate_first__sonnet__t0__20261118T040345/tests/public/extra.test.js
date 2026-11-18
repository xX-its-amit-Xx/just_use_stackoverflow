import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../src/server.js';
import { render } from '../../src/markdown.js';
test('render basics', () => {
  assert.equal(render('~~x~~').trim(), '<p><del>x</del></p>');
  assert.match(render('[[A b]]', { wikiLinks: { exists: () => false } }), /class="wikilink missing"/);
});
test('api flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
  const srv = createServer({ dataDir: dir }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = (m, u, b) => fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
  await j('PUT', '/api/pages/a', { title: 'A', body: 'x\ny', tags: ['T'] });
  await j('PUT', '/api/pages/b', { title: 'B', body: 'see [[A]]' });
  assert.equal((await j('PUT', '/api/pages/a', { title: 'A', body: 'x\nz', baseVersion: 1 })).status, 200);
  assert.equal((await j('PUT', '/api/pages/a', { title: 'A', body: 'q', baseVersion: 1 })).status, 409);
  const a = await (await j('GET', '/api/pages/a')).json();
  assert.deepEqual(a.backlinks, ['b']);
  const d = await (await j('GET', '/api/pages/a/diff?from=1&to=2')).json();
  assert.deepEqual(d.lines.map(l => l.op), [' ', '-', '+']);
  const s = await (await j('GET', '/api/search?q=X')).json();
  assert.equal(s[0].slug, 'a');
  srv.close();
});
