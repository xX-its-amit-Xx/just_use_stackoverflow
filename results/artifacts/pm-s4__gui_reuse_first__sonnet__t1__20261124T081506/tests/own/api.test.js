import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/server.js';

async function setup(clockRef) {
  const srv = createServer({ clock: clockRef ? () => new Date(clockRef.t) : undefined });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => {
    const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : raw ? b : JSON.stringify(b) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const user = async (name) => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, base, call, user };
}

test('full flow', async () => {
  const clk = { t: '2026-03-01T10:00:00Z' };
  const { srv, call, user } = await setup(clk);
  const a = await user('alice'), b = await user('bob'), g = await user('gus');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a)).status, 409);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, a);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'ZZ' }, g)).status, 403);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, g)).status, 403);
  const bobId = (await call('GET', '/api/auth/me', undefined, b)).body.user.id;
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-03-01', endDate: '2026-03-05' }, a)).body;
  const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'One', storyPoints: 5, assigneeId: bobId, sprintId: sp.id, labels: ['x'] }, a)).body;
  const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Two', storyPoints: 3, sprintId: sp.id }, a)).body;
  assert.equal(i1.status, 'Todo'); assert.equal(i2.key, 'WEB-2');
  await call('POST', `/api/issues/${i1.key}/links`, { type: 'blocks', target: i2.key }, a);
  assert.equal((await call('GET', `/api/issues/${i2.key}`, undefined, a)).body.links[0].type, 'blocked_by');
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a)).status, 200);
  clk.t = '2026-03-02T10:00:00Z';
  assert.equal((await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a)).body.error, 'blocked');
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, b)).body.resolvedAt, '2026-03-02T10:00:00.000Z');
  assert.equal((await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a)).status, 200);
  clk.t = '2026-03-03T10:00:00Z';
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a)).body;
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [8, 0, 0]);
  assert.equal(rep.committedPoints, 8);
  const hist = (await call('GET', `/api/issues/${i1.key}/history`, undefined, a)).body;
  assert.equal(hist[0].field, 'status');
  const c = await call('POST', `/api/issues/${i2.key}/comments`, { body: 'hi @bob.' }, a);
  assert.equal(c.status, 201);
  const notes = (await call('GET', '/api/notifications?unread=true', undefined, b)).body;
  assert.ok(notes.some(n => n.type === 'mention'));
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('status:Done -label:x "two" assignee:none'), undefined, a);
  assert.deepEqual(s.body.map(x => x.key), ['WEB-2']);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), undefined, a)).status, 400);
  const csv = await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a);
  assert.ok(csv.body.startsWith('key,type,title'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, 'key,type,title,status\r\n,task,"A, b",Todo\r\n,nope,x,Todo\r\n', a, true);
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors[0].line, 3);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: 'backlog' }, a)).status, 200);
  const st = (await call('GET', `/api/projects/${pr.id}/stats`, undefined, a)).body;
  assert.equal(st.byStatus.Done, 2);
  const wf = await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, a);
  assert.equal(wf.status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Backlog: 'Open', Todo: 'Open', 'In Progress': 'Open', 'In Review': 'Open', Done: 'Closed' } }, a)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a)).body.some(e => e.action === 'workflow.updated'), true);
  srv.close();
});

test('login rate limit and webhooks', async () => {
  const { srv, call, user } = await setup();
  const a = await user('alice');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'bad' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 429);
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const t = (await call('POST', '/api/tokens', { name: 'ci' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', undefined, t.token)).status, 200);
  const got = [];
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ sig: req.headers['x-pm-signature'], d }); res.statusCode = got.length < 2 ? 500 : 200; res.end(); }); });
  await new Promise(r => hook.listen(0, r));
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/`, events: ['issue.created'], secret: 's' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'x' }, a);
  await new Promise(r => setTimeout(r, 600));
  const d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, undefined, a)).body;
  assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 2);
  assert.match(got[0].sig, /^sha256=[0-9a-f]{64}$/);
  hook.close(); srv.close();
});
