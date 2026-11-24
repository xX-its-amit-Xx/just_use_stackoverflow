import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

let dataDir, server, base;

const req = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-s5-test-'));
  server = createServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const suffix = () => crypto.randomBytes(3).toString('hex');

async function account(name) {
  const username = `${name}${suffix()}`;
  const r = await req('POST', '/api/auth/register', { username, password: 'secret123' });
  assert.equal(r.status, 201);
  const l = await req('POST', '/api/auth/login', { username, password: 'secret123' });
  assert.equal(l.status, 200);
  return { username, token: l.data.token };
}

test('auth: register, duplicate, login errors, token required', async () => {
  const u = await account('alice');
  assert.equal((await req('POST', '/api/auth/register', { username: u.username, password: 'secret123' })).status, 409);
  assert.equal((await req('POST', '/api/auth/login', { username: u.username, password: 'nope' })).status, 401);
  assert.equal((await req('POST', '/api/auth/register', { username: 'x', password: '1' })).status, 400);
  assert.equal((await req('GET', '/api/docs')).status, 401);
  assert.equal((await req('GET', '/api/docs', null, 'bogus')).status, 401);
});

test('documents: create, list, get, delete with access control', async () => {
  const owner = await account('owner');
  const other = await account('other');
  const c = await req('POST', '/api/docs', { title: 'Plan' }, owner.token);
  assert.equal(c.status, 201);
  const id = c.data.id;
  assert.equal((await req('GET', '/api/docs', null, owner.token)).data.some(d => d.id === id), true);
  assert.equal((await req('GET', '/api/docs', null, other.token)).data.some(d => d.id === id), false);
  assert.equal((await req('GET', `/api/docs/${id}`, null, other.token)).status, 403);
  assert.equal((await req('GET', '/api/docs/nosuchdoc', null, owner.token)).status, 404);
  const g = await req('GET', `/api/docs/${id}`, null, owner.token);
  assert.equal(g.status, 200);
  assert.equal(g.data.title, 'Plan');
  assert.ok(Array.isArray(g.data.elements));
  assert.equal((await req('DELETE', `/api/docs/${id}`, null, other.token)).status, 403);
  assert.equal((await req('DELETE', `/api/docs/${id}`, null, owner.token)).status, 204);
  assert.equal((await req('GET', `/api/docs/${id}`, null, owner.token)).status, 404);
});

test('sharing roles: viewers cannot push ops, editors can', async () => {
  const owner = await account('owner');
  const ed = await account('editor');
  const vw = await account('viewer');
  const id = (await req('POST', '/api/docs', { title: 'Shared' }, owner.token)).data.id;
  assert.equal((await req('POST', `/api/docs/${id}/share`, { username: ed.username, role: 'editor' }, owner.token)).status, 200);
  assert.equal((await req('POST', `/api/docs/${id}/share`, { username: vw.username, role: 'viewer' }, owner.token)).status, 200);
  assert.equal((await req('POST', `/api/docs/${id}/share`, { username: vw.username, role: 'admin' }, owner.token)).status, 400);
  assert.equal((await req('POST', `/api/docs/${id}/share`, { username: 'ghostuser', role: 'editor' }, owner.token)).status, 404);
  assert.equal((await req('POST', `/api/docs/${id}/share`, { username: ed.username, role: 'editor' }, ed.token)).status, 403);

  const mk = (actor) => {
    const d = { ...{ id: `e${suffix()}`, type: 'rect', x: 1, y: 2, width: 3, height: 4 } };
    return { id: `${actor}@1`, actor, lamport: 1, writes: [{ k: 'el', id: d.id, f: 'alive', v: true, t: [1, actor] }, { k: 'el', id: d.id, f: 'type', v: 'rect', t: [1, actor] }] };
  };
  const op = mk('ed1');
  assert.equal((await req('POST', `/api/docs/${id}/ops`, { ops: [op] }, vw.token)).status, 403);
  const ok = await req('POST', `/api/docs/${id}/ops`, { ops: [op] }, ed.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.seq, 1);
  assert.equal((await req('POST', `/api/docs/${id}/ops`, { ops: [{ bogus: true }] }, ed.token)).status, 400);
  const snap = await req('GET', `/api/docs/${id}`, null, vw.token);
  assert.equal(snap.data.elements.length, 1);
  assert.equal(snap.data.role, 'viewer');
});

test('ops: sync endpoint returns ops since seq, long-poll wakes on new ops', async () => {
  const owner = await account('sync');
  const id = (await req('POST', '/api/docs', { title: 'Sync' }, owner.token)).data.id;
  const e1 = { id: 'x@1', actor: 'x', lamport: 1, writes: [{ k: 'el', id: 'q', f: 'alive', v: true, t: [1, 'x'] }, { k: 'el', id: 'q', f: 'type', v: 'rect', t: [1, 'x'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e1] }, owner.token);
  const all = await req('GET', `/api/docs/${id}/ops?since=0`, null, owner.token);
  assert.equal(all.data.ops.length, 1);
  assert.equal(all.data.seq, 1);
  const none = await req('GET', `/api/docs/${id}/ops?since=1`, null, owner.token);
  assert.equal(none.data.ops.length, 0);

  const pending = req('GET', `/api/docs/${id}/ops?since=1&wait=1`, null, owner.token);
  setTimeout(() => {
    req('POST', `/api/docs/${id}/ops`, { ops: [{ ...e1, id: 'x@2', lamport: 2 }] }, owner.token);
  }, 100);
  const woke = await pending;
  assert.equal(woke.data.ops.length, 1);
  assert.equal(woke.data.seq, 2);
});

test('versions: create, list and restore', async () => {
  const owner = await account('ver');
  const id = (await req('POST', '/api/docs', { title: 'V' }, owner.token)).data.id;
  const e1 = { id: 'v@1', actor: 'v', lamport: 1, writes: [{ k: 'el', id: 'a', f: 'alive', v: true, t: [1, 'v'] }, { k: 'el', id: 'a', f: 'type', v: 'rect', t: [1, 'v'] }, { k: 'el', id: 'a', f: 'x', v: 1, t: [1, 'v'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e1] }, owner.token);
  const v = await req('POST', `/api/docs/${id}/versions`, { label: 'first' }, owner.token);
  assert.equal(v.status, 201);
  const e2 = { id: 'v@2', actor: 'v', lamport: 2, writes: [{ k: 'el', id: 'a', f: 'x', v: 99, t: [2, 'v'] }, { k: 'el', id: 'b', f: 'alive', v: true, t: [2, 'v'] }, { k: 'el', id: 'b', f: 'type', v: 'ellipse', t: [2, 'v'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e2] }, owner.token);
  assert.equal((await req('GET', `/api/docs/${id}`, null, owner.token)).data.elements.length, 2);
  const list = await req('GET', `/api/docs/${id}/versions`, null, owner.token);
  assert.equal(list.data[0].label, 'first');
  const r = await req('POST', `/api/docs/${id}/versions/${v.data.id}/restore`, {}, owner.token);
  assert.equal(r.status, 200);
  const after = (await req('GET', `/api/docs/${id}`, null, owner.token)).data;
  assert.equal(after.elements.length, 1);
  assert.equal(after.elements[0].x, 1);
});

test('comments: threads, replies, resolve, anchored to elements', async () => {
  const owner = await account('cm');
  const id = (await req('POST', '/api/docs', { title: 'C' }, owner.token)).data.id;
  const e1 = { id: 'c@1', actor: 'c', lamport: 1, writes: [{ k: 'el', id: 'n1', f: 'alive', v: true, t: [1, 'c'] }, { k: 'el', id: 'n1', f: 'type', v: 'rect', t: [1, 'c'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e1] }, owner.token);
  const c = await req('POST', `/api/docs/${id}/comments`, { elementId: 'n1', body: 'looks good' }, owner.token);
  assert.equal(c.status, 201);
  assert.equal((await req('POST', `/api/docs/${id}/comments`, { elementId: 'missing', body: 'x' }, owner.token)).status, 404);
  const rep = await req('POST', `/api/docs/${id}/comments`, { parentId: c.data.id, body: 'thanks' }, owner.token);
  assert.equal(rep.status, 201);
  const list = (await req('GET', `/api/docs/${id}/comments`, null, owner.token)).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].replies.length, 1);
  const res = await req('POST', `/api/docs/${id}/comments/${c.data.id}/resolve`, {}, owner.token);
  assert.equal(res.data.resolved, true);
});

test('exports: svg and json', async () => {
  const owner = await account('exp');
  const id = (await req('POST', '/api/docs', { title: 'E' }, owner.token)).data.id;
  const e1 = { id: 'x@1', actor: 'x', lamport: 1, writes: [{ k: 'el', id: 'q', f: 'alive', v: true, t: [1, 'x'] }, { k: 'el', id: 'q', f: 'type', v: 'ellipse', t: [1, 'x'] }, { k: 'el', id: 'q', f: 'width', v: 10, t: [1, 'x'] }, { k: 'el', id: 'q', f: 'height', v: 10, t: [1, 'x'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e1] }, owner.token);
  const svgRes = await fetch(`${base}/api/docs/${id}/export.svg`, { headers: { Authorization: `Bearer ${owner.token}` } });
  assert.equal(svgRes.status, 200);
  assert.match(await svgRes.text(), /data-id="q"/);
  const jsonRes = await req('GET', `/api/docs/${id}/export.json`, null, owner.token);
  assert.equal(jsonRes.data.elements[0].id, 'q');
});

test('persistence: state survives a server restart', async () => {
  const owner = await account('persist');
  const id = (await req('POST', '/api/docs', { title: 'Durable' }, owner.token)).data.id;
  const e1 = { id: 'p@1', actor: 'p', lamport: 1, writes: [{ k: 'el', id: 'z', f: 'alive', v: true, t: [1, 'p'] }, { k: 'el', id: 'z', f: 'type', v: 'rect', t: [1, 'p'] }] };
  await req('POST', `/api/docs/${id}/ops`, { ops: [e1] }, owner.token);
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  server = createServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const l = await req('POST', '/api/auth/login', { username: owner.username, password: 'secret123' });
  const g = await req('GET', `/api/docs/${id}`, null, l.data.token);
  assert.equal(g.status, 200);
  assert.equal(g.data.title, 'Durable');
  assert.equal(g.data.elements.length, 1);
  assert.equal(g.data.elements[0].id, 'z');
});

test('static: index page and editor assets are served', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /diagram-s5/);
  assert.equal((await fetch(`${base}/static/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/static/lib/core/index.js`)).status, 200);
  assert.equal((await fetch(`${base}/static/lib/vendor/dagre/dagre.esm.js`)).status, 200);
  assert.equal((await fetch(`${base}/static/../server.js`)).status, 404);
});
