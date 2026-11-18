import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, wikiTargets } from './markdown.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);

export function diffLines(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, dels = [], adds = [];
  const flush = () => { for (const t of dels) out.push({ op: '-', text: t }); for (const t of adds) out.push({ op: '+', text: t }); dels = []; adds = []; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) adds.push(b[j++]);
    else dels.push(a[i++]);
  }
  flush();
  return out;
}

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const pages = new Map(); // slug -> {slug, createdAt, versions:[{version,title,body,tags,updatedAt}]}
  for (const f of fs.readdirSync(pagesDir)) {
    if (!f.endsWith('.json')) continue;
    try { const p = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')); pages.set(p.slug, p); } catch {}
  }
  const persist = (p) => {
    const f = path.join(pagesDir, p.slug + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(p)); fs.renameSync(f + '.tmp', f);
  };
  const cur = (p) => p.versions[p.versions.length - 1];
  const view = (p) => { const c = cur(p); return { slug: p.slug, title: c.title, body: c.body, tags: c.tags, version: c.version, createdAt: p.createdAt, updatedAt: c.updatedAt }; };
  const wikiLinks = { exists: (s) => pages.has(s) };
  let lastTs = 0;
  const now = () => { let t = Date.now(); if (t <= lastTs) t = lastTs; lastTs = t; return new Date(t).toISOString(); };

  function normTags(t) {
    if (t === undefined || t === null) return [];
    if (!Array.isArray(t) || t.some((x) => typeof x !== 'string')) throw bad('tags must be an array of strings');
    return [...new Set(t.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
  }
  function validate(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('title must be 1-200 characters');
    if (typeof b.body !== 'string') throw bad('body must be a string');
    return { title: b.title, body: b.body, tags: normTags(b.tags) };
  }
  function save(slug, data, baseVersion) {
    if (!SLUG_RE.test(slug)) throw bad('invalid slug');
    const p = pages.get(slug);
    const t = now();
    if (!p) {
      if (baseVersion !== undefined && baseVersion !== null && baseVersion !== 0) throw new HttpError(409, 'conflict', 'page does not exist', { currentVersion: 0 });
      const np = { slug, createdAt: t, versions: [{ version: 1, ...data, updatedAt: t }] };
      pages.set(slug, np); persist(np); return { status: 201, page: np };
    }
    const c = cur(p);
    if (baseVersion !== undefined && baseVersion !== null && baseVersion !== c.version)
      throw new HttpError(409, 'conflict', 'version conflict', { currentVersion: c.version });
    if (c.title === data.title && c.body === data.body && JSON.stringify(c.tags) === JSON.stringify(data.tags)) return { status: 200, page: p };
    p.versions.push({ version: c.version + 1, ...data, updatedAt: t });
    persist(p); return { status: 200, page: p };
  }
  function checkBase(b) {
    if (b.baseVersion !== undefined && b.baseVersion !== null && !Number.isInteger(b.baseVersion)) throw bad('baseVersion must be an integer');
    return b.baseVersion;
  }
  const getPage = (slug) => { const p = pages.get(slug); if (!p) throw notFound('page not found'); return p; };
  const getVer = (p, n) => {
    const v = /^\d+$/.test(String(n)) ? p.versions.find((x) => x.version === Number(n)) : null;
    if (!v) throw notFound('version not found'); return v;
  };
  function linksOf(p) { return wikiTargets(cur(p).body).sort(); }

  function fullPage(p) {
    const c = cur(p);
    const backlinks = [];
    for (const o of pages.values()) if (o.slug !== p.slug && linksOf(o).includes(p.slug)) backlinks.push(o.slug);
    return { ...view(p), html: render(c.body, { headingIds: true, wikiLinks }), toc: toc(c.body), backlinks: backlinks.sort(), links: linksOf(p) };
  }

  function search(q) {
    const ql = q.toLowerCase(); const res = [];
    const count = (s) => { let n = 0, i = 0; while ((i = s.indexOf(ql, i)) >= 0) { n++; i += ql.length; } return n; };
    for (const p of pages.values()) {
      const c = cur(p); const tl = c.title.toLowerCase(), bl = c.body.toLowerCase();
      const tc = count(tl), bc = count(bl);
      if (!tc && !bc) continue;
      let snippet;
      const bi = bl.indexOf(ql);
      if (bi >= 0) {
        const s = Math.max(0, bi - 40), e = Math.min(c.body.length, bi + q.length + 40);
        snippet = esc(c.body.slice(s, bi)) + '<mark>' + esc(c.body.slice(bi, bi + q.length)) + '</mark>' + esc(c.body.slice(bi + q.length, e));
      } else snippet = esc(c.body.slice(0, 80));
      res.push({ slug: p.slug, title: c.title, snippet, score: tc + bc, _t: tc > 0 });
    }
    res.sort((a, b) => (b._t - a._t) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return res.map(({ _t, ...r }) => r);
  }

  async function readJson(req) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8');
    if (!s.trim()) return {};
    try { return JSON.parse(s); } catch { throw bad('invalid JSON'); }
  }

  const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const method = req.method;
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw bad('bad path'); }
    const json = (status, data) => {
      const s = JSON.stringify(data);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(s);
    };
    const html = (status, s) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };

    if (method === 'GET' && parts.length === 0) return html(200, fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8'));
    if (method === 'GET' && parts[0] === 'static' && parts.length === 2) {
      const f = path.join(STATIC_DIR, path.basename(parts[1]));
      if (!fs.existsSync(f)) throw notFound();
      res.writeHead(200, { 'content-type': (MIME[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8' });
      return res.end(fs.readFileSync(f));
    }
    if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const p = pages.get(parts[1]);
      if (!p) return html(404, '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>');
      const fp = fullPage(p);
      return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>${esc(fp.title)}</title></head><body><article><h1 class="page-title">${esc(fp.title)}</h1>\n${fp.html}</article></body></html>`);
    }
    if (parts[0] !== 'api') throw notFound('route not found');
    const [r1, slug, r3] = parts.slice(1); parts = parts.slice(1);

    if (r1 === 'pages') {
      if (parts.length === 1 && method === 'GET') {
        const tag = url.searchParams.get('tag'); const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('invalid sort');
        let list = [...pages.values()].map(view);
        if (tag) list = list.filter((p) => p.tags.includes(tag.toLowerCase()));
        if (sort === 'title') list.sort((a, b) => { const x = a.title.toLowerCase(), y = b.title.toLowerCase(); return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : 1; });
        else list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        return json(200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      if (parts.length === 2) {
        if (method === 'PUT') {
          const b = await readJson(req);
          if (!SLUG_RE.test(slug)) throw bad('invalid slug');
          const data = validate(b); const bv = checkBase(b);
          const r = save(slug, data, bv); return json(r.status, view(r.page));
        }
        if (method === 'GET') return json(200, fullPage(getPage(slug)));
        if (method === 'DELETE') {
          getPage(slug); pages.delete(slug);
          fs.rmSync(path.join(pagesDir, slug + '.json'), { force: true });
          res.writeHead(204); return res.end();
        }
      }
      if (parts.length === 3 && method === 'GET' && r3 === 'history') {
        const p = getPage(slug);
        return json(200, p.versions.slice().reverse().map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })));
      }
      if (parts.length === 4 && method === 'GET' && r3 === 'versions') {
        const v = getVer(getPage(slug), parts[3]);
        return json(200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      }
      if (parts.length === 3 && method === 'POST' && r3 === 'revert') {
        const p = getPage(slug); const b = await readJson(req);
        if (!Number.isInteger(b.version)) throw bad('version must be an integer');
        const v = getVer(p, b.version);
        const r = save(slug, { title: v.title, body: v.body, tags: v.tags.slice() });
        return json(200, view(r.page));
      }
      if (parts.length === 3 && method === 'GET' && r3 === 'diff') {
        const p = getPage(slug);
        const f = url.searchParams.get('from'), t = url.searchParams.get('to');
        if (f === null || t === null || !/^\d+$/.test(f) || !/^\d+$/.test(t)) throw bad('from and to are required');
        const a = getVer(p, f), b = getVer(p, t);
        return json(200, { from: a.version, to: b.version, lines: diffLines(a.body.split('\n'), b.body.split('\n')) });
      }
      throw notFound('route not found');
    }
    if (r1 === 'search' && parts.length === 1 && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) throw bad('q is required');
      return json(200, search(q));
    }
    if (r1 === 'render' && parts.length === 1 && method === 'POST') {
      const b = await readJson(req);
      if (!b || typeof b.markdown !== 'string') throw bad('markdown must be a string');
      return json(200, { html: render(b.markdown, { headingIds: true, wikiLinks }), toc: toc(b.markdown) });
    }
    if (r1 === 'tags' && parts.length === 1 && method === 'GET') {
      const m = new Map();
      for (const p of pages.values()) for (const t of cur(p).tags) m.set(t, (m.get(t) || 0) + 1);
      return json(200, [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })));
    }
    if (r1 === 'export' && parts.length === 1 && method === 'GET') {
      const list = [...pages.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)).map((p) => { const v = view(p); return { slug: v.slug, title: v.title, body: v.body, tags: v.tags, version: v.version }; });
      return json(200, { pages: list });
    }
    if (r1 === 'import' && parts.length === 1 && method === 'POST') {
      const b = await readJson(req);
      if (!b || !Array.isArray(b.pages)) throw bad('pages must be an array');
      const items = b.pages.map((x) => {
        if (!x || typeof x.slug !== 'string' || !SLUG_RE.test(x.slug)) throw bad('invalid slug');
        return [x.slug, validate(x)];
      });
      for (const [s, d] of items) save(s, d);
      return json(200, { imported: items.length });
    }
    throw notFound('route not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      const status = e instanceof HttpError ? e.status : 500;
      const body = { error: e instanceof HttpError ? e.code : 'internal_error', message: e.message, ...(e.extra || {}) };
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
    });
  });
}
