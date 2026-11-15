import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, escapeHtml } from './markdown.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
class HttpError extends Error { constructor(status, error, message, extra) { super(message); this.status = status; this.error = error; this.extra = extra; } }
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const file = (slug) => path.join(pagesDir, slug + '.json');
  const load = (slug) => { try { return JSON.parse(fs.readFileSync(file(slug), 'utf8')); } catch { return null; } };
  const save = (rec) => { const f = file(rec.slug); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); };
  const allSlugs = () => fs.readdirSync(pagesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const all = () => allSlugs().map(load).filter(Boolean);
  const exists = (s) => fs.existsSync(file(s));
  const wl = { exists: (s) => SLUG.test(s) && exists(s) };
  const linksOf = (body) => { const set = new Set(); render(body, { wikiLinks: { exists: (s) => { set.add(s); return true; } } }); return [...set].sort(); };
  const pub = (r) => ({ slug: r.slug, title: r.title, body: r.body, tags: r.tags, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt });

  function validate(slug, b) {
    if (!SLUG.test(slug)) throw bad('invalid slug');
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('title must be a non-empty string of at most 200 chars');
    if (typeof b.body !== 'string') throw bad('body must be a string');
    let tags = [];
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
      tags = [...new Set(b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
    }
    if (b.baseVersion !== undefined && b.baseVersion !== null && !Number.isInteger(b.baseVersion)) throw bad('baseVersion must be an integer');
    return { title: b.title, body: b.body, tags };
  }
  const sameContent = (a, b) => a.title === b.title && a.body === b.body && JSON.stringify(a.tags) === JSON.stringify(b.tags);

  function upsert(slug, content, baseVersion) {
    const cur = load(slug);
    const now = new Date().toISOString();
    if (!cur) {
      const rec = { slug, ...content, version: 1, createdAt: now, updatedAt: now, history: [{ version: 1, ...content, updatedAt: now }] };
      save(rec); return { status: 201, rec };
    }
    if (baseVersion !== undefined && baseVersion !== null && baseVersion !== cur.version)
      throw new HttpError(409, 'conflict', 'page was modified by someone else', { currentVersion: cur.version });
    if (sameContent(cur, content)) return { status: 200, rec: cur };
    cur.title = content.title; cur.body = content.body; cur.tags = content.tags; cur.version++; cur.updatedAt = now;
    cur.history.push({ version: cur.version, ...content, updatedAt: now });
    save(cur); return { status: 200, rec: cur };
  }

  function diff(a, b) {
    const A = a === '' ? [] : a.split('\n'), B = b === '' ? [] : b.split('\n');
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0, minus = [], plus = [];
    const fl = () => { out.push(...minus, ...plus); minus = []; plus = []; };
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { fl(); out.push({ op: ' ', text: A[i] }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { plus.push({ op: '+', text: B[j++] }); }
      else { minus.push({ op: '-', text: A[i++] }); }
    }
    fl(); return out;
  }

  function snippet(body, q) {
    const lb = body.toLowerCase(), lq = q.toLowerCase();
    const idx = lb.indexOf(lq);
    if (idx < 0) return escapeHtml(body.slice(0, 40));
    const s = Math.max(0, idx - 40), e = Math.min(body.length, idx + q.length + 40);
    return escapeHtml(body.slice(s, idx)) + '<mark>' + escapeHtml(body.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(body.slice(idx + q.length, e));
  }
  const countOcc = (h, n) => { let c = 0, p = 0; while ((p = h.indexOf(n, p)) >= 0) { c++; p += n.length; } return c; };

  const pageDoc = (r) => ({ ...pub(r), html: render(r.body, { headingIds: true, wikiLinks: wl }), toc: toc(r.body),
    backlinks: all().filter((p) => p.slug !== r.slug && linksOf(p.body).includes(r.slug)).map((p) => p.slug).sort(), links: linksOf(r.body) });

  const send = (res, status, data, type = 'application/json; charset=utf-8') => {
    const body = type.startsWith('application/json') ? JSON.stringify(data) : data;
    res.writeHead(status, { 'content-type': type }); res.end(status === 204 ? undefined : body);
  };
  const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); req.on('error', reject); });
  const json = async (req) => { const t = await readBody(req); if (!t.trim()) return {}; try { return JSON.parse(t); } catch { throw bad('invalid JSON'); } };
  const getPage = (slug) => { const r = SLUG.test(slug) ? load(slug) : null; if (!r) throw notFound('page not found'); return r; };
  const getVer = (r, n) => { const v = r.history.find((h) => String(h.version) === String(n)); if (!v) throw notFound('version not found'); return v; };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, method = req.method, q = url.searchParams;
    let m;
    if (method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(HERE, 'static', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (method === 'GET' && (m = /^\/static\/([\w.-]+)$/.exec(p))) {
      const f = path.join(HERE, 'static', m[1]);
      if (!fs.existsSync(f)) throw notFound();
      return send(res, 200, fs.readFileSync(f), m[1].endsWith('.js') ? 'text/javascript; charset=utf-8' : m[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    }
    if (method === 'GET' && (m = /^\/wiki\/([^/]+)$/.exec(p))) {
      const slug = decodeURIComponent(m[1]); const r = SLUG.test(slug) ? load(slug) : null;
      if (!r) return send(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1><p><a href="/">Home</a></p></body></html>`, 'text/html; charset=utf-8');
      const html = render(r.body, { headingIds: true, wikiLinks: wl });
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(r.title)}</title></head><body><article><h1 class="page-title">${escapeHtml(r.title)}</h1>\n${html}</article></body></html>`, 'text/html; charset=utf-8');
    }
    if (!p.startsWith('/api/')) throw notFound('route not found');
    if (p === '/api/pages' && method === 'GET') {
      let list = all();
      const tag = q.get('tag'); if (tag) list = list.filter((r) => r.tags.includes(tag.toLowerCase()));
      const sort = q.get('sort') || 'title';
      if (sort !== 'title' && sort !== 'updated') throw bad('invalid sort');
      if (sort === 'title') list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.slug < b.slug ? -1 : 1));
      else list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return send(res, 200, list.map((r) => ({ slug: r.slug, title: r.title, tags: r.tags, version: r.version, updatedAt: r.updatedAt })));
    }
    if ((m = /^\/api\/pages\/([^/]+)(?:\/(history|revert|diff|versions)(?:\/([^/]+))?)?$/.exec(p))) {
      const slug = decodeURIComponent(m[1]), sub = m[2];
      if (!sub) {
        if (method === 'PUT') { const b = await json(req); const c = validate(slug, b); const { status, rec } = upsert(slug, c, b.baseVersion); return send(res, status, pub(rec)); }
        if (method === 'GET') return send(res, 200, pageDoc(getPage(slug)));
        if (method === 'DELETE') { getPage(slug); fs.unlinkSync(file(slug)); return send(res, 204); }
      } else if (sub === 'history' && method === 'GET') {
        return send(res, 200, getPage(slug).history.slice().reverse().map((h) => ({ version: h.version, title: h.title, updatedAt: h.updatedAt })));
      } else if (sub === 'versions' && method === 'GET' && m[3]) {
        const v = getVer(getPage(slug), m[3]); return send(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      } else if (sub === 'revert' && method === 'POST') {
        const r = getPage(slug); const b = await json(req);
        if (!Number.isInteger(b.version)) throw bad('version must be an integer');
        const v = getVer(r, b.version);
        return send(res, 200, pub(upsert(slug, { title: v.title, body: v.body, tags: v.tags }).rec));
      } else if (sub === 'diff' && method === 'GET') {
        const r = getPage(slug);
        const f = q.get('from'), t = q.get('to');
        if (!/^\d+$/.test(f || '') || !/^\d+$/.test(t || '')) throw bad('from and to are required integers');
        const a = getVer(r, f), b = getVer(r, t);
        return send(res, 200, { from: a.version, to: b.version, lines: diff(a.body, b.body) });
      }
      throw notFound('route not found');
    }
    if (p === '/api/search' && method === 'GET') {
      const term = (q.get('q') || '').trim();
      if (!term) throw bad('q is required');
      const lq = term.toLowerCase();
      const res2 = [];
      for (const r of all()) {
        const lt = r.title.toLowerCase(), lb = r.body.toLowerCase();
        const inT = lt.includes(lq), inB = lb.includes(lq);
        if (!inT && !inB) continue;
        res2.push({ slug: r.slug, title: r.title, snippet: snippet(r.body, term), score: countOcc(lt, lq) + countOcc(lb, lq), inT });
      }
      res2.sort((a, b) => (b.inT - a.inT) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return send(res, 200, res2.map(({ inT, ...x }) => x));
    }
    if (p === '/api/render' && method === 'POST') {
      const b = await json(req);
      if (typeof b.markdown !== 'string') throw bad('markdown must be a string');
      return send(res, 200, { html: render(b.markdown, { headingIds: true, wikiLinks: wl }), toc: toc(b.markdown) });
    }
    if (p === '/api/tags' && method === 'GET') {
      const c = new Map(); for (const r of all()) for (const t of r.tags) c.set(t, (c.get(t) || 0) + 1);
      return send(res, 200, [...c].map(([tag, count]) => ({ tag, count })).sort((a, b) => (a.tag < b.tag ? -1 : 1)));
    }
    if (p === '/api/export' && method === 'GET') return send(res, 200, { pages: all().sort((a, b) => (a.slug < b.slug ? -1 : 1)).map((r) => ({ slug: r.slug, title: r.title, body: r.body, tags: r.tags, version: r.version })) });
    if (p === '/api/import' && method === 'POST') {
      const b = await json(req);
      if (!Array.isArray(b.pages)) throw bad('pages must be an array');
      const items = b.pages.map((pg) => { if (!pg || typeof pg !== 'object') throw bad('invalid page'); return [pg.slug, validate(String(pg.slug), pg)]; });
      for (const [slug, c] of items) upsert(slug, c);
      return send(res, 200, { imported: items.length });
    }
    throw notFound('route not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message, ...(e.extra || {}) });
      send(res, 500, { error: 'internal', message: String(e && e.message) });
    });
  });
}
