import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinkTargets, escapeHtml } from './markdown.js';
import { Store } from './store.js';
import { diffLines } from './diff.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);

function normTags(tags) {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

function validateContent(b, existingTags) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
  if (typeof b.title !== 'string' || b.title.trim() === '') throw bad('title is required');
  if (b.title.length > 200) throw bad('title must be at most 200 characters');
  if (b.body === undefined || b.body === null) b.body = '';
  if (typeof b.body !== 'string') throw bad('body must be a string');
  const tags = normTags(b.tags);
  return { title: b.title, body: b.body, tags: tags === null ? (existingTags || []) : tags };
}

function checkSlug(slug) {
  if (!SLUG_RE.test(slug)) throw bad('invalid slug');
  return slug;
}

function pagePublic(p) {
  return { slug: p.slug, title: p.title, body: p.body, tags: p.tags, version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

export function createServer({ dataDir } = {}) {
  const store = new Store(dataDir || './data');
  const linkCache = new Map();

  const linksOf = (p) => {
    const c = linkCache.get(p.slug);
    if (c && c.body === p.body) return c.links;
    const links = [...new Set(wikiLinkTargets(p.body))].sort();
    linkCache.set(p.slug, { body: p.body, links });
    return links;
  };
  const wikiLinks = { exists: (slug) => store.get(slug) !== null };
  const renderPage = (md) => render(md, { headingIds: true, wikiLinks });

  const fullPage = (p) => ({
    ...pagePublic(p),
    html: renderPage(p.body),
    toc: toc(p.body),
    backlinks: store.all().filter((o) => linksOf(o).includes(p.slug)).map((o) => o.slug).sort(),
    links: linksOf(p),
  });

  const getPage = (slug) => {
    const p = store.get(slug);
    if (!p) throw notFound('page not found');
    return p;
  };

  const parseVersion = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    let parts;
    try {
      parts = url.pathname.split('/').filter((s, i) => i > 0).map(decodeURIComponent);
    } catch {
      throw bad('malformed URL');
    }
    if (parts.length && parts[parts.length - 1] === '' && parts.length > 1) parts.pop();

    // ---- UI
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(res, path.join(STATIC_DIR, 'index.html'));
    }
    if (method === 'GET' && parts[0] === 'static' && parts.length === 2) {
      const name = parts[1];
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith('.')) throw notFound();
      return sendFile(res, path.join(STATIC_DIR, name));
    }
    if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const p = store.get(parts[1]);
      if (!p) {
        return sendHtml(res, 404, doc('Page not found', `<h1>Page not found</h1><p>No page named <code>${escapeHtml(parts[1])}</code>. <a href="/">Back to the wiki</a></p>`));
      }
      return sendHtml(res, 200, doc(p.title, `<nav><a href="/">Wiki home</a></nav><article><h1 class="page-title">${escapeHtml(p.title)}</h1>\n${renderPage(p.body)}</article>`));
    }

    if (parts[0] !== 'api') throw notFound('unknown route');
    const r = parts.slice(1);

    // ---- pages
    if (r[0] === 'pages') {
      if (r.length === 1) {
        if (method !== 'GET') throw notFound('unknown route');
        const tag = url.searchParams.get('tag');
        const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
        let list = store.all();
        if (tag) { const t = tag.trim().toLowerCase(); list = list.filter((p) => p.tags.includes(t)); }
        if (sort === 'title') {
          list.sort((a, b) => {
            const x = a.title.toLowerCase(), y = b.title.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
          });
        } else {
          list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        }
        return sendJson(res, 200, list.map((p) => ({ slug: p.slug, title: p.title, tags: p.tags, version: p.version, updatedAt: p.updatedAt })));
      }
      const slug = r[1];
      if (r.length === 2) {
        if (method === 'PUT') {
          checkSlug(slug);
          const b = await readJson(req);
          const existing = store.get(slug);
          const content = validateContent(b, existing && existing.tags);
          if (b.baseVersion !== undefined && b.baseVersion !== null) {
            if (!Number.isInteger(b.baseVersion)) throw bad('baseVersion must be an integer');
            const cur = existing ? existing.version : 0;
            if (b.baseVersion !== cur) throw new HttpError(409, 'conflict', 'page was modified', { currentVersion: cur });
          }
          const { page, created } = store.put(slug, content);
          return sendJson(res, created ? 201 : 200, pagePublic(page));
        }
        if (method === 'GET') { checkSlug(slug); return sendJson(res, 200, fullPage(getPage(slug))); }
        if (method === 'DELETE') {
          checkSlug(slug);
          getPage(slug);
          store.delete(slug);
          linkCache.delete(slug);
          res.writeHead(204); return res.end();
        }
        throw notFound('unknown route');
      }
      if (r.length === 3 && r[2] === 'history' && method === 'GET') {
        checkSlug(slug);
        const p = getPage(slug);
        return sendJson(res, 200, p.history.slice().reverse().map((h) => ({ version: h.version, title: h.title, updatedAt: h.updatedAt })));
      }
      if (r.length === 4 && r[2] === 'versions' && method === 'GET') {
        checkSlug(slug);
        const p = getPage(slug);
        const n = parseVersion(r[3]);
        const h = n && p.history.find((x) => x.version === n);
        if (!h) throw notFound('version not found');
        return sendJson(res, 200, { version: h.version, title: h.title, body: h.body, tags: h.tags });
      }
      if (r.length === 3 && r[2] === 'revert' && method === 'POST') {
        checkSlug(slug);
        const b = await readJson(req);
        const p = getPage(slug);
        if (!b || typeof b !== 'object') throw bad('body must be a JSON object');
        if (!Number.isInteger(b.version)) throw bad('version must be an integer');
        const h = p.history.find((x) => x.version === b.version);
        if (!h) throw notFound('version not found');
        const page = store.addVersion(p, { title: h.title, body: h.body, tags: h.tags.slice() });
        return sendJson(res, 200, pagePublic(page));
      }
      if (r.length === 3 && r[2] === 'diff' && method === 'GET') {
        checkSlug(slug);
        const p = getPage(slug);
        const fs_ = url.searchParams.get('from'), ts_ = url.searchParams.get('to');
        if (fs_ === null || ts_ === null) throw bad('from and to are required');
        const from = parseVersion(fs_), to = parseVersion(ts_);
        if (from === null || to === null) throw bad('from and to must be positive integers');
        const a = p.history.find((x) => x.version === from), bv = p.history.find((x) => x.version === to);
        if (!a || !bv) throw notFound('version not found');
        return sendJson(res, 200, { from, to, lines: diffLines(a.body, bv.body) });
      }
      throw notFound('unknown route');
    }

    if (r.length === 1 && r[0] === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 1) throw bad('q is required');
      return sendJson(res, 200, search(store.all(), q));
    }
    if (r.length === 1 && r[0] === 'render' && method === 'POST') {
      const b = await readJson(req);
      if (!b || typeof b !== 'object' || typeof b.markdown !== 'string') throw bad('markdown must be a string');
      return sendJson(res, 200, { html: renderPage(b.markdown), toc: toc(b.markdown) });
    }
    if (r.length === 1 && r[0] === 'tags' && method === 'GET') {
      const counts = new Map();
      for (const p of store.all()) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return sendJson(res, 200, [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) })));
    }
    if (r.length === 1 && r[0] === 'export' && method === 'GET') {
      const pages = store.all().sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .map((p) => ({ slug: p.slug, title: p.title, body: p.body, tags: p.tags, version: p.version }));
      return sendJson(res, 200, { pages });
    }
    if (r.length === 1 && r[0] === 'import' && method === 'POST') {
      const b = await readJson(req);
      if (!b || typeof b !== 'object' || !Array.isArray(b.pages)) throw bad('pages must be an array');
      const items = b.pages.map((p) => {
        if (!p || typeof p !== 'object') throw bad('invalid page');
        if (typeof p.slug !== 'string') throw bad('invalid slug');
        checkSlug(p.slug);
        const existing = store.get(p.slug);
        return { slug: p.slug, content: validateContent({ ...p }, existing && existing.tags) };
      });
      for (const it of items) store.put(it.slug, it.content);
      return sendJson(res, 200, { imported: items.length });
    }
    throw notFound('unknown route');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      } else {
        sendJson(res, 500, { error: 'internal', message: String(err && err.message || err) });
      }
    });
  });
  return server;
}

function search(pages, q) {
  const ql = q.toLowerCase();
  const count = (s) => {
    let n = 0, i = 0;
    const l = s.toLowerCase();
    while ((i = l.indexOf(ql, i)) !== -1) { n++; i += ql.length; }
    return n;
  };
  const results = [];
  for (const p of pages) {
    const inTitle = p.title.toLowerCase().includes(ql);
    const idx = p.body.toLowerCase().indexOf(ql);
    if (!inTitle && idx === -1) continue;
    const score = count(p.title) + count(p.body);
    let snippet;
    if (idx === -1) snippet = escapeHtml(p.body.slice(0, 80));
    else {
      const start = Math.max(0, idx - 40), end = Math.min(p.body.length, idx + q.length + 40);
      snippet = escapeHtml(p.body.slice(start, idx)) + '<mark>' + escapeHtml(p.body.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(p.body.slice(idx + q.length, end));
    }
    results.push({ slug: p.slug, title: p.title, snippet, score, inTitle });
  }
  results.sort((a, b) => (a.inTitle !== b.inTitle ? (a.inTitle ? -1 : 1) : b.score !== a.score ? b.score - a.score : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return results.map(({ inTitle, ...r }) => r);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return reject(new HttpError(400, 'bad_json', 'request body must be JSON'));
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'bad_json', 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function sendFile(res, file) {
  let data;
  try { data = fs.readFileSync(file); } catch { throw notFound('asset not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
  res.end(data);
}

function doc(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="wiki-view">
${body}
</body>
</html>
`;
}
