import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiTargets } from './markdown.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);

export function diffLines(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ op: '-', text: a[i++] });
    else ops.push({ op: '+', text: b[j++] });
  }
  while (i < n) ops.push({ op: '-', text: a[i++] });
  while (j < m) ops.push({ op: '+', text: b[j++] });
  const out = []; let k = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') { out.push(ops[k++]); continue; }
    const run = [];
    while (k < ops.length && ops[k].op !== ' ') run.push(ops[k++]);
    out.push(...run.filter((o) => o.op === '-'), ...run.filter((o) => o.op === '+'));
  }
  return out;
}

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  let lastTs = 0;
  const now = () => { lastTs = Math.max(Date.now(), lastTs + 1); return new Date(lastTs).toISOString(); };
  const file = (slug) => path.join(pagesDir, slug + '.json');
  const exists = (slug) => SLUG_RE.test(slug) && fs.existsSync(file(slug));
  const load = (slug) => (exists(slug) ? JSON.parse(fs.readFileSync(file(slug), 'utf8')) : null);
  const save = (rec) => { const f = file(rec.slug); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); };
  const allRecs = () => fs.readdirSync(pagesDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')));
  const wikiLinks = { exists };
  const pageOf = (rec) => { const v = rec.versions[rec.versions.length - 1]; return { slug: rec.slug, title: v.title, body: v.body, tags: v.tags, version: v.version, createdAt: rec.createdAt, updatedAt: v.updatedAt }; };

  function normTags(tags) {
    if (tags === undefined) return [];
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
    return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
  }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('body must be an object');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw bad('title must be a non-empty string of at most 200 characters');
    if (typeof input.body !== 'string') throw bad('body must be a string');
    return { title: input.title, body: input.body, tags: normTags(input.tags) };
  }
  function upsert(slug, content, baseVersion) {
    if (!SLUG_RE.test(slug)) throw bad('invalid slug');
    if (baseVersion !== undefined && baseVersion !== null && !Number.isInteger(baseVersion)) throw bad('baseVersion must be an integer');
    const rec = load(slug);
    const cur = rec ? rec.versions[rec.versions.length - 1] : null;
    if (baseVersion != null && baseVersion !== (cur ? cur.version : 0))
      throw new HttpError(409, 'conflict', 'version conflict', { currentVersion: cur ? cur.version : 0 });
    const ts = now();
    if (!rec) {
      save({ slug, createdAt: ts, versions: [{ version: 1, ...content, updatedAt: ts }] });
      return { status: 201, page: pageOf(load(slug)) };
    }
    if (cur.title === content.title && cur.body === content.body && JSON.stringify(cur.tags) === JSON.stringify(content.tags))
      return { status: 200, page: pageOf(rec) };
    rec.versions.push({ version: cur.version + 1, ...content, updatedAt: ts });
    save(rec);
    return { status: 200, page: pageOf(rec) };
  }
  function getRec(slug) { const r = load(slug); if (!r) throw notFound('page not found'); return r; }
  function fullPage(rec) {
    const p = pageOf(rec);
    const backlinks = allRecs().filter((r) => r.slug !== p.slug && wikiTargets(pageOf(r).body).includes(p.slug)).map((r) => r.slug).sort();
    return { ...p, html: render(p.body, { headingIds: true, wikiLinks }), toc: toc(p.body), backlinks, links: wikiTargets(p.body) };
  }
  function getVersion(rec, n) {
    const v = rec.versions.find((x) => x.version === n);
    if (!v) throw notFound('version not found');
    return v;
  }
  const intParam = (s, name) => { if (s === null || !/^\d+$/.test(s)) throw bad(`${name} must be an integer`); return Number(s); };

  function search(q) {
    q = (q ?? '').trim();
    if (!q) throw bad('q must not be empty');
    const lq = q.toLowerCase();
    const count = (s) => { let c = 0, i = 0; s = s.toLowerCase(); while ((i = s.indexOf(lq, i)) >= 0) { c++; i += lq.length; } return c; };
    const res = [];
    for (const rec of allRecs()) {
      const p = pageOf(rec);
      const inTitle = p.title.toLowerCase().includes(lq);
      const idx = p.body.toLowerCase().indexOf(lq);
      if (!inTitle && idx < 0) continue;
      let snippet;
      if (idx >= 0) {
        const s = Math.max(0, idx - 40), e = Math.min(p.body.length, idx + q.length + 40);
        snippet = escHtml(p.body.slice(s, idx)) + '<mark>' + escHtml(p.body.slice(idx, idx + q.length)) + '</mark>' + escHtml(p.body.slice(idx + q.length, e));
      } else snippet = escHtml(p.body.slice(0, 40));
      res.push({ slug: p.slug, title: p.title, snippet, score: count(p.title) + count(p.body), inTitle });
    }
    res.sort((a, b) => (b.inTitle - a.inTitle) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return res.map(({ inTitle, ...r }) => r);
  }

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const txt = Buffer.concat(chunks).toString('utf8');
    if (!txt.trim()) return {};
    try { return JSON.parse(txt); } catch { throw bad('invalid JSON'); }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { throw bad('bad url'); } });
    const method = req.method;
    const json = (status, data) => { const b = JSON.stringify(data); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(b); };
    const sendFile = (name, type) => { res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(path.join(UI_DIR, name))); };

    if (method === 'GET' && parts.length === 0) return sendFile('index.html', 'text/html; charset=utf-8');
    if (method === 'GET' && parts[0] === 'static' && parts.length === 2 && /^[\w.-]+$/.test(parts[1]) && fs.existsSync(path.join(UI_DIR, parts[1]))) {
      const t = parts[1].endsWith('.js') ? 'text/javascript' : parts[1].endsWith('.css') ? 'text/css' : 'application/octet-stream';
      return sendFile(parts[1], t + '; charset=utf-8');
    }
    if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const rec = load(parts[1]);
      if (!rec) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>'); }
      const p = fullPage(rec);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(p.title)}</title></head><body><article>\n${p.html}\n</article></body></html>`);
    }
    if (parts[0] !== 'api') throw notFound('route not found');
    const r = parts.slice(1);

    if (r[0] === 'pages') {
      if (r.length === 1 && method === 'GET') {
        const tag = url.searchParams.get('tag')?.toLowerCase();
        const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('invalid sort');
        let list = allRecs().map(pageOf);
        if (tag) list = list.filter((p) => p.tags.includes(tag));
        if (sort === 'updated') list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        else list.sort((a, b) => { const x = a.title.toLowerCase(), y = b.title.toLowerCase(); return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : 1; });
        return json(200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      const slug = r[1];
      if (r.length === 2) {
        if (method === 'PUT') {
          const input = await readJson(req);
          const content = validate(input);
          const out = upsert(slug, content, input.baseVersion);
          return json(out.status, out.page);
        }
        if (method === 'GET') return json(200, fullPage(getRec(slug)));
        if (method === 'DELETE') { getRec(slug); fs.unlinkSync(file(slug)); res.writeHead(204); return res.end(); }
      }
      if (r.length === 3 && method === 'GET' && r[2] === 'history') {
        const rec = getRec(slug);
        return json(200, rec.versions.map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })).reverse());
      }
      if (r.length === 4 && r[2] === 'versions' && method === 'GET') {
        const rec = getRec(slug);
        if (!/^\d+$/.test(r[3])) throw notFound('version not found');
        const v = getVersion(rec, Number(r[3]));
        return json(200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      }
      if (r.length === 3 && r[2] === 'revert' && method === 'POST') {
        const input = await readJson(req);
        const rec = getRec(slug);
        if (!Number.isInteger(input.version)) throw bad('version must be an integer');
        const v = getVersion(rec, input.version);
        const cur = rec.versions[rec.versions.length - 1];
        rec.versions.push({ version: cur.version + 1, title: v.title, body: v.body, tags: v.tags, updatedAt: now() });
        save(rec);
        return json(200, pageOf(rec));
      }
      if (r.length === 3 && r[2] === 'diff' && method === 'GET') {
        const rec = getRec(slug);
        const from = intParam(url.searchParams.get('from'), 'from'), to = intParam(url.searchParams.get('to'), 'to');
        const a = getVersion(rec, from), b = getVersion(rec, to);
        const split = (s) => (s === '' ? [] : s.split('\n'));
        return json(200, { from, to, lines: diffLines(split(a.body), split(b.body)) });
      }
    }
    if (r[0] === 'search' && r.length === 1 && method === 'GET') return json(200, search(url.searchParams.get('q')));
    if (r[0] === 'render' && r.length === 1 && method === 'POST') {
      const input = await readJson(req);
      if (typeof input.markdown !== 'string') throw bad('markdown must be a string');
      return json(200, { html: render(input.markdown, { wikiLinks }), toc: toc(input.markdown) });
    }
    if (r[0] === 'tags' && r.length === 1 && method === 'GET') {
      const m = new Map();
      for (const rec of allRecs()) for (const t of pageOf(rec).tags) m.set(t, (m.get(t) || 0) + 1);
      return json(200, [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)));
    }
    if (r[0] === 'export' && r.length === 1 && method === 'GET') {
      const pages = allRecs().map(pageOf).sort((a, b) => (a.slug < b.slug ? -1 : 1)).map(({ slug, title, body, tags, version }) => ({ slug, title, body, tags, version }));
      return json(200, { pages });
    }
    if (r[0] === 'import' && r.length === 1 && method === 'POST') {
      const input = await readJson(req);
      if (!Array.isArray(input.pages)) throw bad('pages must be an array');
      const items = input.pages.map((p) => {
        if (!p || typeof p !== 'object' || typeof p.slug !== 'string' || !SLUG_RE.test(p.slug)) throw bad('invalid slug in import');
        return [p.slug, validate(p)];
      });
      for (const [slug, c] of items) upsert(slug, c);
      return json(200, { imported: items.length });
    }
    throw notFound('route not found');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', String(err?.message || err));
      if (res.headersSent) return res.end();
      res.writeHead(e.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.code, message: e.message, ...(e.extra || {}) }));
    });
  });
}
