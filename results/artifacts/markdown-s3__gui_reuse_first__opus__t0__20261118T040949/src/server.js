import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinkTargets } from './markdown.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (msg, code = 'validation') => new HttpError(400, code, msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}
function checkSlug(slug) { if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('Invalid slug', 'invalid_slug'); return slug; }
function checkTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw bad('title must be a non-empty string of at most 200 characters', 'invalid_title');
  return title;
}
function checkBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw bad('body must be a string', 'invalid_body');
  return body;
}

/** Line diff via LCS. */
export function diffLines(a, b) {
  const A = a === '' ? [] : a.replace(/\r\n/g, '\n').split('\n');
  const B = b === '' ? [] : b.replace(/\r\n/g, '\n').split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let dels = [], adds = [];
  const flush = () => { out.push(...dels, ...adds); dels = []; adds = []; };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); out.push({ op: ' ', text: A[i] }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) { adds.push({ op: '+', text: B[j] }); j++; }
    else { dels.push({ op: '-', text: A[i] }); i++; }
  }
  flush();
  return out;
}

class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'pages');
    fs.mkdirSync(this.dir, { recursive: true });
    this.pages = new Map();
    this.lastTs = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (rec && SLUG_RE.test(rec.slug)) {
          this.pages.set(rec.slug, rec);
          for (const v of rec.versions) this.lastTs = Math.max(this.lastTs, Date.parse(v.updatedAt) || 0);
        }
      } catch { /* skip corrupt file */ }
    }
  }
  now() {
    let t = Date.now();
    if (t <= this.lastTs) t = this.lastTs + 1;
    this.lastTs = t;
    return new Date(t).toISOString();
  }
  save(rec) {
    const file = path.join(this.dir, rec.slug + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  }
  remove(slug) {
    this.pages.delete(slug);
    fs.rmSync(path.join(this.dir, slug + '.json'), { force: true });
  }
  get(slug) { return this.pages.get(slug); }
  current(rec) { return rec.versions[rec.versions.length - 1]; }
  view(rec) {
    const c = this.current(rec);
    return { slug: rec.slug, title: c.title, body: c.body, tags: [...c.tags], version: c.version, createdAt: rec.createdAt, updatedAt: c.updatedAt };
  }
  /** Returns { status, page } */
  upsert(slug, { title, body, tags }, { force = false } = {}) {
    let rec = this.pages.get(slug);
    if (!rec) {
      const ts = this.now();
      rec = { slug, createdAt: ts, versions: [{ version: 1, title, body, tags, updatedAt: ts }] };
      this.pages.set(slug, rec);
      this.save(rec);
      return { status: 201, page: this.view(rec) };
    }
    const c = this.current(rec);
    if (!force && c.title === title && c.body === body && JSON.stringify(c.tags) === JSON.stringify(tags)) {
      return { status: 200, page: this.view(rec) };
    }
    rec.versions.push({ version: c.version + 1, title, body, tags, updatedAt: this.now() });
    this.save(rec);
    return { status: 200, page: this.view(rec) };
  }
  all() { return [...this.pages.values()]; }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw bad('Request body is not valid JSON', 'bad_json'); }
}

function countOcc(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };

export function createServer({ dataDir = './data' } = {}) {
  const store = new Store(dataDir);
  const wikiOpt = { exists: (s) => store.pages.has(s) };

  const fullPage = (rec) => {
    const p = store.view(rec);
    const backlinks = store.all()
      .filter((r) => wikiLinkTargets(store.current(r).body).includes(rec.slug))
      .map((r) => r.slug).sort();
    return { ...p, html: render(p.body, { headingIds: true, wikiLinks: wikiOpt }), toc: toc(p.body), backlinks, links: wikiLinkTargets(p.body) };
  };
  const requirePage = (slug) => {
    checkSlug(slug);
    const rec = store.get(slug);
    if (!rec) throw notFound(`Page "${slug}" not found`);
    return rec;
  };
  const getVersion = (rec, n) => {
    const num = Number(n);
    if (n === undefined || n === null || n === '' || !Number.isInteger(num)) throw bad('version must be an integer', 'invalid_version');
    const v = rec.versions.find((x) => x.version === num);
    if (!v) throw notFound(`Version ${n} not found`);
    return v;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw bad('Bad URL'); }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendHtml(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    }
    if (parts[0] === 'static' && method === 'GET' && parts.length === 2) {
      const name = parts[1];
      const ext = path.extname(name);
      if (!/^[\w.-]+$/.test(name) || !STATIC_TYPES[ext]) throw notFound();
      const file = path.join(PUBLIC_DIR, name);
      if (!fs.existsSync(file)) throw notFound();
      res.writeHead(200, { 'content-type': STATIC_TYPES[ext] });
      return res.end(fs.readFileSync(file));
    }
    if (parts[0] === 'wiki' && parts.length === 2 && method === 'GET') {
      const slug = parts[1];
      const rec = SLUG_RE.test(slug) ? store.get(slug) : null;
      if (!rec) {
        return sendHtml(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1><p>No page named <code>${escapeHtml(slug)}</code>. <a href="/">Back to wiki</a></p></body></html>`);
      }
      const p = fullPage(rec);
      return sendHtml(res, 200, `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="wiki-view"><header><a href="/">Wiki</a></header><main><h1 class="page-title">${escapeHtml(p.title)}</h1>
<article class="markdown-body">${p.html}</article></main></body></html>`);
    }
    if (parts[0] !== 'api') throw notFound('Unknown route');
    const [, res1, slug, sub, arg] = parts;

    if (res1 === 'pages') {
      if (parts.length === 2 && method === 'GET') {
        const tag = url.searchParams.get('tag');
        const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated', 'invalid_sort');
        let list = store.all().map((r) => store.view(r));
        if (tag) { const t = tag.trim().toLowerCase(); list = list.filter((p) => p.tags.includes(t)); }
        if (sort === 'title') list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
        else list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        return sendJson(res, 200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      if (parts.length === 3) {
        if (method === 'PUT') {
          checkSlug(slug);
          const data = await readJson(req);
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Body must be a JSON object');
          const title = checkTitle(data.title);
          const body = checkBody(data.body);
          const tags = normTags(data.tags);
          const rec = store.get(slug);
          if (data.baseVersion !== undefined && data.baseVersion !== null) {
            if (!Number.isInteger(data.baseVersion)) throw bad('baseVersion must be an integer', 'invalid_version');
            const cur = rec ? store.current(rec).version : 0;
            if (rec && data.baseVersion !== cur) {
              throw new HttpError(409, 'conflict', `Page was modified (current version ${cur})`, { currentVersion: cur });
            }
          }
          const { status, page } = store.upsert(slug, { title, body, tags });
          return sendJson(res, status, page);
        }
        if (method === 'GET') return sendJson(res, 200, fullPage(requirePage(slug)));
        if (method === 'DELETE') { requirePage(slug); store.remove(slug); res.writeHead(204); return res.end(); }
      }
      if (parts.length === 4 && sub === 'history' && method === 'GET') {
        const rec = requirePage(slug);
        return sendJson(res, 200, [...rec.versions].reverse().map(({ version, title, updatedAt }) => ({ version, title, updatedAt })));
      }
      if (parts.length === 5 && sub === 'versions' && method === 'GET') {
        const rec = requirePage(slug);
        if (!/^\d+$/.test(arg)) throw notFound(`Version ${arg} not found`);
        const v = getVersion(rec, arg);
        return sendJson(res, 200, { version: v.version, title: v.title, body: v.body, tags: [...v.tags] });
      }
      if (parts.length === 4 && sub === 'revert' && method === 'POST') {
        const rec = requirePage(slug);
        const data = await readJson(req);
        const v = getVersion(rec, data?.version);
        const { page } = store.upsert(slug, { title: v.title, body: v.body, tags: [...v.tags] }, { force: true });
        return sendJson(res, 200, page);
      }
      if (parts.length === 4 && sub === 'diff' && method === 'GET') {
        const rec = requirePage(slug);
        const a = getVersion(rec, url.searchParams.get('from') ?? undefined);
        const b = getVersion(rec, url.searchParams.get('to') ?? undefined);
        return sendJson(res, 200, { from: a.version, to: b.version, lines: diffLines(a.body, b.body) });
      }
      throw notFound('Unknown route');
    }

    if (res1 === 'search' && parts.length === 2 && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) throw bad('q must not be empty', 'invalid_query');
      const ql = q.toLowerCase();
      const results = [];
      for (const rec of store.all()) {
        const c = store.current(rec);
        const tl = c.title.toLowerCase(), bl = c.body.toLowerCase();
        const inTitle = tl.includes(ql);
        const bi = bl.indexOf(ql);
        if (!inTitle && bi < 0) continue;
        const score = countOcc(tl, ql) + countOcc(bl, ql);
        let snippet;
        if (bi >= 0) {
          const s = Math.max(0, bi - 40), e = Math.min(c.body.length, bi + q.length + 40);
          snippet = escapeHtml(c.body.slice(s, bi)) + '<mark>' + escapeHtml(c.body.slice(bi, bi + q.length)) + '</mark>' + escapeHtml(c.body.slice(bi + q.length, e));
        } else {
          snippet = escapeHtml(c.body.slice(0, 40));
        }
        results.push({ slug: rec.slug, title: c.title, snippet, score, _t: inTitle });
      }
      results.sort((a, b) => (b._t - a._t) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return sendJson(res, 200, results.map(({ _t, ...r }) => r));
    }
    if (res1 === 'render' && parts.length === 2 && method === 'POST') {
      const data = await readJson(req);
      const md = data?.markdown ?? '';
      if (typeof md !== 'string') throw bad('markdown must be a string');
      return sendJson(res, 200, { html: render(md, { headingIds: true, wikiLinks: wikiOpt }), toc: toc(md) });
    }
    if (res1 === 'tags' && parts.length === 2 && method === 'GET') {
      const counts = new Map();
      for (const r of store.all()) for (const t of store.current(r).tags) counts.set(t, (counts.get(t) || 0) + 1);
      return sendJson(res, 200, [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })));
    }
    if (res1 === 'export' && parts.length === 2 && method === 'GET') {
      const pages = store.all().map((r) => store.view(r)).sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .map(({ slug, title, body, tags, version }) => ({ slug, title, body, tags, version }));
      return sendJson(res, 200, { pages });
    }
    if (res1 === 'import' && parts.length === 2 && method === 'POST') {
      const data = await readJson(req);
      if (!data || !Array.isArray(data.pages)) throw bad('pages must be an array');
      const items = data.pages.map((p) => {
        if (!p || typeof p !== 'object') throw bad('Each page must be an object');
        return { slug: checkSlug(p.slug), title: checkTitle(p.title), body: checkBody(p.body), tags: normTags(p.tags) };
      });
      for (const it of items) store.upsert(it.slug, it);
      return sendJson(res, 200, { imported: items.length });
    }
    throw notFound('Unknown route');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      } else {
        sendJson(res, 500, { error: 'internal', message: String(err?.message || err) });
      }
    });
  });
}
