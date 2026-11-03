import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinkTargets } from './markdown.js';
import { diffLines } from './diff.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

class HttpError extends Error {
  constructor(status, error, message, extra) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function normTags(tags) {
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags)) throw bad('tags must be an array of strings');
  const out = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw bad('tags must be an array of strings');
    const v = t.trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out].sort();
}

function validateContent(obj, { requireTitle = true } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad('body must be a JSON object');
  const { title, body } = obj;
  if (requireTitle || title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '') throw bad('title must be a non-empty string');
    if (title.length > 200) throw bad('title must be at most 200 characters');
  }
  if (body !== undefined && body !== null && typeof body !== 'string') throw bad('body must be a string');
  return { title, body: typeof body === 'string' ? body : '', tags: normTags(obj.tags) };
}

function sameTags(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'pages');
    fs.mkdirSync(this.dir, { recursive: true });
    this.pages = new Map();
    this.lastTime = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!rec || !SLUG_RE.test(rec.slug)) continue;
        rec.links = wikiLinkTargets(rec.body);
        this.pages.set(rec.slug, rec);
        const t = Date.parse(rec.updatedAt);
        if (t > this.lastTime) this.lastTime = t;
      } catch {
        /* ignore corrupt files */
      }
    }
  }
  now() {
    let t = Date.now();
    if (t <= this.lastTime) t = this.lastTime + 1;
    this.lastTime = t;
    return new Date(t).toISOString();
  }
  save(rec) {
    const { links, ...data } = rec;
    const file = path.join(this.dir, rec.slug + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  remove(slug) {
    this.pages.delete(slug);
    fs.rmSync(path.join(this.dir, slug + '.json'), { force: true });
  }
  get(slug) {
    return this.pages.get(slug);
  }
  exists(slug) {
    return this.pages.has(slug);
  }
  /** returns { rec, created, changed } */
  upsert(slug, { title, body, tags }) {
    const existing = this.pages.get(slug);
    if (!existing) {
      const ts = this.now();
      const t = tags || [];
      const rec = {
        slug, title, body, tags: t, version: 1, createdAt: ts, updatedAt: ts,
        versions: [{ version: 1, title, body, tags: t, updatedAt: ts }],
      };
      rec.links = wikiLinkTargets(body);
      this.pages.set(slug, rec);
      this.save(rec);
      return { rec, created: true, changed: true };
    }
    const newTags = tags === undefined ? existing.tags : tags;
    if (existing.title === title && existing.body === body && sameTags(existing.tags, newTags)) {
      return { rec: existing, created: false, changed: false };
    }
    const ts = this.now();
    existing.version += 1;
    existing.title = title;
    existing.body = body;
    existing.tags = newTags;
    existing.updatedAt = ts;
    existing.versions.push({ version: existing.version, title, body, tags: newTags, updatedAt: ts });
    existing.links = wikiLinkTargets(body);
    this.save(existing);
    return { rec: existing, created: false, changed: true };
  }
  forceVersion(slug, { title, body, tags }) {
    const existing = this.pages.get(slug);
    const ts = this.now();
    existing.version += 1;
    Object.assign(existing, { title, body, tags: [...tags], updatedAt: ts });
    existing.versions.push({ version: existing.version, title, body, tags: [...tags], updatedAt: ts });
    existing.links = wikiLinkTargets(body);
    this.save(existing);
    return existing;
  }
  all() {
    return [...this.pages.values()];
  }
}

function pageMeta(rec) {
  return { slug: rec.slug, title: rec.title, body: rec.body, tags: rec.tags, version: rec.version, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function makeSnippet(body, q, idx) {
  if (idx < 0) {
    return escapeHtml(body.slice(0, 80));
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + q.length + 40);
  return escapeHtml(body.slice(start, idx)) + '<mark>' + escapeHtml(body.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(body.slice(idx + q.length, end));
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function wikiDocument(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="wiki-page">
<nav><a href="/">← Wiki editor</a></nav>
<main>
<h1 class="page-title">${escapeHtml(title)}</h1>
<article class="markdown-body">
${inner}
</article>
</main>
</body>
</html>`;
}

export function createServer({ dataDir } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const store = new Store(dataDir);
  const resolver = { exists: (slug) => store.exists(slug) };

  function fullPage(rec) {
    const backlinks = store
      .all()
      .filter((p) => p.links.includes(rec.slug))
      .map((p) => p.slug)
      .sort();
    return {
      ...pageMeta(rec),
      html: render(rec.body, { headingIds: true, wikiLinks: resolver }),
      toc: toc(rec.body),
      backlinks,
      links: [...rec.links],
    };
  }

  function getPage(slug) {
    if (!SLUG_RE.test(slug)) throw bad('invalid slug');
    const rec = store.get(slug);
    if (!rec) throw notFound(`page '${slug}' not found`);
    return rec;
  }

  function parseVersion(v, name = 'version') {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 1) throw bad(`${name} must be a positive integer`);
    return n;
  }

  function findVersion(rec, n) {
    const v = rec.versions.find((x) => x.version === n);
    if (!v) throw notFound(`version ${n} not found`);
    return v;
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/pages', ({ query }) => {
    const tag = (query.get('tag') || '').trim().toLowerCase();
    const sort = query.get('sort') || 'title';
    if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
    let list = store.all();
    if (tag) list = list.filter((p) => p.tags.includes(tag));
    if (sort === 'updated') {
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
    } else {
      list.sort((a, b) => {
        const x = a.title.toLowerCase();
        const y = b.title.toLowerCase();
        return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
      });
    }
    return [200, list.map((p) => ({ slug: p.slug, title: p.title, tags: p.tags, version: p.version, updatedAt: p.updatedAt }))];
  });

  route('PUT', '/api/pages/:slug', ({ params, body }) => {
    const { slug } = params;
    if (!SLUG_RE.test(slug)) throw bad('invalid slug');
    const content = validateContent(body);
    const { baseVersion } = body;
    if (baseVersion !== undefined && baseVersion !== null) {
      if (!Number.isInteger(baseVersion) || baseVersion < 0) throw bad('baseVersion must be an integer');
      const cur = store.get(slug);
      if (cur && cur.version !== baseVersion) {
        throw new HttpError(409, 'conflict', `page was modified (current version ${cur.version})`, { currentVersion: cur.version });
      }
    }
    const { rec, created } = store.upsert(slug, content);
    return [created ? 201 : 200, pageMeta(rec)];
  });

  route('GET', '/api/pages/:slug', ({ params }) => [200, fullPage(getPage(params.slug))]);

  route('DELETE', '/api/pages/:slug', ({ params }) => {
    getPage(params.slug);
    store.remove(params.slug);
    return [204, null];
  });

  route('GET', '/api/pages/:slug/history', ({ params }) => {
    const rec = getPage(params.slug);
    return [200, rec.versions.map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })).reverse()];
  });

  route('GET', '/api/pages/:slug/versions/:n', ({ params }) => {
    const rec = getPage(params.slug);
    const v = findVersion(rec, parseVersion(params.n));
    return [200, { version: v.version, title: v.title, body: v.body, tags: v.tags }];
  });

  route('POST', '/api/pages/:slug/revert', ({ params, body }) => {
    const rec = getPage(params.slug);
    if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
    const v = findVersion(rec, parseVersion(body.version));
    const updated = store.forceVersion(rec.slug, v);
    return [200, pageMeta(updated)];
  });

  route('GET', '/api/pages/:slug/diff', ({ params, query }) => {
    const rec = getPage(params.slug);
    const toRaw = query.get('to');
    const to = toRaw === null || toRaw === '' ? rec.version : parseVersion(toRaw, 'to');
    const fromRaw = query.get('from');
    const from = fromRaw === null || fromRaw === '' ? Math.max(1, to - 1) : parseVersion(fromRaw, 'from');
    const a = findVersion(rec, from);
    const b = findVersion(rec, to);
    return [200, { from, to, lines: diffLines(a.body, b.body) }];
  });

  route('GET', '/api/search', ({ query }) => {
    const q = (query.get('q') || '').trim();
    if (!q) throw bad('q must contain at least one character');
    const ql = q.toLowerCase();
    const results = [];
    for (const p of store.all()) {
      const tl = p.title.toLowerCase();
      const bl = p.body.toLowerCase();
      const inTitle = tl.includes(ql);
      const idx = bl.indexOf(ql);
      if (!inTitle && idx < 0) continue;
      const score = countOccurrences(tl, ql) + countOccurrences(bl, ql);
      results.push({ slug: p.slug, title: p.title, snippet: makeSnippet(p.body, q, idx), score, _t: inTitle });
    }
    results.sort((a, b) => (a._t !== b._t ? (a._t ? -1 : 1) : b.score !== a.score ? b.score - a.score : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return [200, results.map(({ _t, ...r }) => r)];
  });

  route('POST', '/api/render', ({ body }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
    const { markdown } = body;
    if (markdown !== undefined && typeof markdown !== 'string') throw bad('markdown must be a string');
    const src = markdown || '';
    return [200, { html: render(src, { headingIds: true, wikiLinks: resolver }), toc: toc(src) }];
  });

  route('GET', '/api/tags', () => {
    const counts = new Map();
    for (const p of store.all()) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [200, [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) }))];
  });

  route('GET', '/api/export', () => {
    const pages = store
      .all()
      .sort((a, b) => (a.slug < b.slug ? -1 : 1))
      .map((p) => ({ slug: p.slug, title: p.title, body: p.body, tags: p.tags, version: p.version }));
    return [200, { pages }];
  });

  route('POST', '/api/import', ({ body }) => {
    if (!body || typeof body !== 'object' || !Array.isArray(body.pages)) throw bad('pages must be an array');
    const items = body.pages.map((p, i) => {
      if (!p || typeof p !== 'object') throw bad(`pages[${i}] must be an object`);
      if (typeof p.slug !== 'string' || !SLUG_RE.test(p.slug)) throw bad(`pages[${i}].slug is invalid`);
      return { slug: p.slug, content: validateContent(p) };
    });
    for (const { slug, content } of items) store.upsert(slug, content);
    return [200, { imported: items.length }];
  });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
    }
  }

  function sendJson(res, status, data) {
    if (status === 204) {
      res.writeHead(204);
      return res.end();
    }
    const s = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    res.end(html);
  }

  function serveStatic(res, file) {
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    const data = fs.readFileSync(full);
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: 'invalid URL' });
    }
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') {
          if (serveStatic(res, 'index.html')) return;
        }
        if (pathname.startsWith('/static/')) {
          let rel;
          try {
            rel = decodeURIComponent(pathname.slice('/static/'.length));
          } catch {
            rel = '';
          }
          if (rel && serveStatic(res, rel)) return;
          return sendJson(res, 404, { error: 'not_found', message: 'asset not found' });
        }
        const m = pathname.match(/^\/wiki\/([^/]+)\/?$/);
        if (m) {
          let slug;
          try {
            slug = decodeURIComponent(m[1]);
          } catch {
            slug = '';
          }
          const rec = SLUG_RE.test(slug) ? store.get(slug) : null;
          if (!rec) {
            return sendHtml(res, 404, wikiDocument('Page not found', `<p>The page <code>${escapeHtml(slug)}</code> does not exist. <a href="/#edit/${encodeURIComponent(slug)}">Create it</a>.</p>`));
          }
          return sendHtml(res, 200, wikiDocument(rec.title, render(rec.body, { headingIds: true, wikiLinks: resolver })));
        }
      }
      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.re);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => {
            try {
              params[k] = decodeURIComponent(m[i + 1]);
            } catch {
              params[k] = m[i + 1];
            }
          });
          const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
          const [status, data] = await r.handler({ params, query: url.searchParams, body, req });
          return sendJson(res, status, data);
        }
      }
      throw notFound(`no route for ${req.method} ${pathname}`);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.error, message: err.message, ...(err.extra || {}) });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'internal', message: 'internal server error' });
    }
  });
  return server;
}
