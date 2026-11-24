import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../src/server.js';
test('create and read a page', async () => {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-')) }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const put = await fetch(base + '/api/pages/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Home', body: '# Welcome' }) });
  assert.equal(put.status, 201);
  const page = await (await fetch(base + '/api/pages/home')).json();
  assert.match(page.html, /<h1 id="welcome">Welcome<\/h1>/);
  srv.close();
});
