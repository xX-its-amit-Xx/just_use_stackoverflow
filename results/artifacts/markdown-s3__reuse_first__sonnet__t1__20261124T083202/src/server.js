import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiTargets } from './markdown.js';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

class HttpError extends Error { constructor(status, error, message, extra) { super(message); this.status = status; this.error = error; this.extra = extra; } }
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function diffLines(a, b) {
  const A = a === '' ? [] : a.split('\n'), B = b === '' ? [] : b.split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, minus = [], plus = [];
  const flush = () => { for (const t of minus) out.push({ op: '-', text: t }); for (const t of plus) out.push({ op: '+', text: t }); minus = []; plus = []; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); out.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) plus.push(B[j++]);
    else minus.push(A[i++]);
  }
  flush();
  return out;
}

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const file = (slug) => path.join(pagesDir, slug + '.json');
  const load = (slug) => { try { return JSON.parse(fs.readFileSync(file(slug), 'utf8')); } catch { return null; } };
  const save = (rec) => { const f = file(rec.slug); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); };
  const allSlugs = () => fs.readdirSync(pagesDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const allPages = () => allSlugs().map(load).filter(Boolean);
  const cur = (rec) => rec.versions[rec.versions.length - 1];
  const wl = () => { const s = new Set(allSlugs()); return { exists: (x) => s.has(x) }; };
  const pageView = (rec) => { const v = cur(rec); return { slug: rec.slug, title: v.title, body: v.body, tags: v.tags, version: v.version, createdAt: rec.createdAt, updatedAt: v.updatedAt }; };

  const normTags = (t) => {
    if (t === undefined) return [];
    if (!Array.isArray(t) || t.some((x) => typeof x !== 'string')) throw bad('tags must be an array of strings');
    return [...new Set(t.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
  };

  function putPage(slug, b, { checkBase = true } = {}) {
    if (!SLUG.test(slug)) throw bad('invalid slug');
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('title must be a non-empty string up to 200 chars');
    if (typeof b.body !== 'string') throw bad('body must be a string');
    const tags = normTags(b.tags);
    if (b.baseVersion !== undefined && b.baseVersion !== null && !Number.isInteger(b.baseVersion)) throw bad('baseVersion must be an integer');
    const rec = load(slug); const now = new Date().toISOString();
    if (!rec) {
      save({ slug, createdAt: now, versions: [{ version: 1, title: b.title, body: b.body, tags, updatedAt: now }] });
      return { status: 201, rec: load(slug) };
    }
    const c = cur(rec);
    if (checkBase && b.baseVersion != null && b.baseVersion !== c.version) throw new HttpError(409, 'conflict', 'version conflict', { currentVersion: c.version });
    if (c.title === b.title && c.body === b.body && JSON.stringify(c.tags) === JSON.stringify(tags)) return { status: 200, rec };
    rec.versions.push({ version: c.version + 1, title: b.title, body: b.body, tags, updatedAt: now });
    save(rec);
    return { status: 200, rec };
  }

  function fullPage(rec) {
    const v = cur(rec); const p = pageView(rec);
    p.html = render(v.body, { headingIds: true, wikiLinks: wl() });
    p.toc = toc(v.body);
    p.links = wikiTargets(v.body);
    p.backlinks = allPages().filter((o) => o.slug !== rec.slug && wikiTargets(cur(o).body).includes(rec.slug)).map((o) => o.slug).sort();
    return p;
  }

  const getRec = (slug) => { const r = SLUG.test(slug) ? load(slug) : null; if (!r) throw notFound('page not found'); return r; };
  const getVer = (rec, n) => { const v = rec.versions.find((x) => x.version === Number(n)); if (!v || !/^\d+$/.test(String(n))) throw notFound('version not found'); return v; };

  function snippet(body, q) {
    const i = body.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escHtml(body.slice(0, 80));
    const s = Math.max(0, i - 40), e = Math.min(body.length, i + q.length + 40);
    return escHtml(body.slice(s, i)) + '<mark>' + escHtml(body.slice(i, i + q.length)) + '</mark>' + escHtml(body.slice(i + q.length, e));
  }
  const countOcc = (h, n) => { let c = 0, i = 0; while ((i = h.indexOf(n, i)) >= 0) { c++; i += n.length; } return c; };

  async function route(req, res, url) {
    const m = req.method; const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const readJson = async () => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const t = Buffer.concat(chunks).toString('utf8');
      try { return t ? JSON.parse(t) : {}; } catch { throw bad('invalid JSON'); }
    };
    const json = (status, obj) => { const t = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(t); };
    if (m === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(here, 'static', 'index.html'))); }
    if (m === 'GET' && parts[0] === 'static' && parts.length === 2 && !parts[1].includes('..')) {
      const f = path.join(here, 'static', parts[1]);
      if (!fs.existsSync(f)) throw notFound();
      res.writeHead(200, { 'content-type': (MIME[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8' }); return res.end(fs.readFileSync(f));
    }
    if (m === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const rec = SLUG.test(parts[1]) ? load(parts[1]) : null;
      if (!rec) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>'); }
      const p = fullPage(rec);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(p.title)}</title></head><body><main>\n${p.html}</main></body></html>`);
    }
    if (parts[0] !== 'api') throw notFound('route not found');
    const [, r1, r2, r3] = parts;
    if (r1 === 'pages') {
      if (parts.length === 2) {
        if (m !== 'GET') throw notFound('route not found');
        const tag = url.searchParams.get('tag'); const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('invalid sort');
        let list = allPages().map(pageView);
        if (tag) list = list.filter((p) => p.tags.includes(tag.toLowerCase()));
        list = list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt }));
        if (sort === 'title') list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.slug < b.slug ? -1 : 1));
        else list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        return json(200, list);
      }
      const slug = r2;
      if (parts.length === 3) {
        if (m === 'PUT') { const { status, rec } = putPage(slug, await readJson()); return json(status, pageView(rec)); }
        if (m === 'GET') return json(200, fullPage(getRec(slug)));
        if (m === 'DELETE') { getRec(slug); fs.unlinkSync(file(slug)); res.writeHead(204); return res.end(); }
        throw notFound('route not found');
      }
      if (parts.length === 4 && r3 === 'history' && m === 'GET') {
        const rec = getRec(slug);
        return json(200, rec.versions.slice().reverse().map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })));
      }
      if (parts.length === 5 && r3 === 'versions' && m === 'GET') {
        const v = getVer(getRec(slug), parts[4]); return json(200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      }
      if (parts.length === 4 && r3 === 'revert' && m === 'POST') {
        const rec = getRec(slug); const b = await readJson();
        if (!Number.isInteger(b.version)) throw bad('version must be an integer');
        const v = getVer(rec, b.version);
        return json(200, pageView(putPage(slug, { title: v.title, body: v.body, tags: v.tags }).rec));
      }
      if (parts.length === 4 && r3 === 'diff' && m === 'GET') {
        const rec = getRec(slug); const f = url.searchParams.get('from'), t = url.searchParams.get('to');
        if (!/^\d+$/.test(f || '') || !/^\d+$/.test(t || '')) throw bad('from and to are required integers');
        const a = getVer(rec, f), b = getVer(rec, t);
        return json(200, { from: a.version, to: b.version, lines: diffLines(a.body, b.body) });
      }
      throw notFound('route not found');
    }
    if (r1 === 'search' && m === 'GET' && parts.length === 2) {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) throw bad('q is required');
      const ql = q.toLowerCase(); const res2 = [];
      for (const rec of allPages()) {
        const v = cur(rec); const tl = v.title.toLowerCase(), bl = v.body.toLowerCase();
        const inT = tl.includes(ql), inB = bl.includes(ql);
        if (!inT && !inB) continue;
        const score = countOcc(tl, ql) + countOcc(bl, ql);
        res2.push({ slug: rec.slug, title: v.title, snippet: inB ? snippet(v.body, q) : escHtml(v.body.slice(0, 80)), score, inT });
      }
      res2.sort((a, b) => (b.inT - a.inT) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return json(200, res2.map(({ inT, ...r }) => r));
    }
    if (r1 === 'render' && m === 'POST' && parts.length === 2) {
      const b = await readJson();
      if (typeof b.markdown !== 'string') throw bad('markdown must be a string');
      return json(200, { html: render(b.markdown, { headingIds: true, wikiLinks: wl() }), toc: toc(b.markdown) });
    }
    if (r1 === 'tags' && m === 'GET' && parts.length === 2) {
      const c = new Map(); for (const rec of allPages()) for (const t of cur(rec).tags) c.set(t, (c.get(t) || 0) + 1);
      return json(200, [...c].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })));
    }
    if (r1 === 'export' && m === 'GET' && parts.length === 2) {
      return json(200, { pages: allPages().sort((a, b) => (a.slug < b.slug ? -1 : 1)).map((r) => { const v = cur(r); return { slug: r.slug, title: v.title, body: v.body, tags: v.tags, version: v.version }; }) });
    }
    if (r1 === 'import' && m === 'POST' && parts.length === 2) {
      const b = await readJson();
      if (!Array.isArray(b.pages)) throw bad('pages must be an array');
      for (const p of b.pages) { if (!p || typeof p !== 'object' || !SLUG.test(p.slug || '') || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200 || typeof p.body !== 'string') throw bad('invalid page in import'); normTags(p.tags); }
      for (const p of b.pages) putPage(p.slug, { title: p.title, body: p.body, tags: p.tags });
      return json(200, { imported: b.pages.length });
    }
    throw notFound('route not found');
  }

  return http.createServer(async (req, res) => {
    try { await route(req, res, new URL(req.url, 'http://localhost')); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const body = e instanceof HttpError ? { error: e.error, message: e.message, ...e.extra } : { error: 'internal', message: String(e && e.message) };
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    }
  });
}
