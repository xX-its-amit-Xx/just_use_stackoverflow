import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinks } from './markdown.js';
import { lineDiff } from './diff.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- storage ----------------
class Store {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'pages');
    fs.mkdirSync(this.dir, { recursive: true });
    this.pages = new Map(); // slug -> { slug, createdAt, versions: [{version,title,body,tags,updatedAt}] }
    this.links = new Map(); // slug -> sorted link slugs
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (rec && SLUG_RE.test(rec.slug) && Array.isArray(rec.versions) && rec.versions.length) {
          this.pages.set(rec.slug, rec);
          this.links.set(rec.slug, wikiLinks(current(rec).body));
        }
      } catch { /* skip corrupt file */ }
    }
  }
  save(rec) {
    const file = path.join(this.dir, rec.slug + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
    this.pages.set(rec.slug, rec);
    this.links.set(rec.slug, wikiLinks(current(rec).body));
  }
  remove(slug) {
    this.pages.delete(slug);
    this.links.delete(slug);
    fs.rmSync(path.join(this.dir, slug + '.json'), { force: true });
  }
}
const current = (rec) => rec.versions[rec.versions.length - 1];

function pageView(rec) {
  const v = current(rec);
  return { slug: rec.slug, title: v.title, body: v.body, tags: v.tags, version: v.version, createdAt: rec.createdAt, updatedAt: v.updatedAt };
}

function normTags(tags) {
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

function validateContent(input, { requireAll = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('body must be a JSON object');
  const { title, body } = input;
  if (typeof title !== 'string' || !title.trim()) throw bad('title is required');
  if (title.length > 200) throw bad('title must be at most 200 characters');
  if (body === undefined && !requireAll) return { title, body: '', tags: normTags(input.tags) };
  if (typeof body !== 'string') throw bad('body must be a string');
  return { title, body, tags: normTags(input.tags) };
}

const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// Creates or updates; returns { rec, created, changed }
function upsert(store, slug, content, baseVersion) {
  const now = new Date().toISOString();
  const rec = store.pages.get(slug);
  if (!rec) {
    const v = { version: 1, title: content.title, body: content.body, tags: content.tags || [], updatedAt: now };
    const nrec = { slug, createdAt: now, versions: [v] };
    store.save(nrec);
    return { rec: nrec, created: true, changed: true };
  }
  const cur = current(rec);
  if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== cur.version) {
    throw new HttpError(409, 'conflict', `page is at version ${cur.version}`, { currentVersion: cur.version });
  }
  const tags = content.tags === undefined ? cur.tags : content.tags;
  if (cur.title === content.title && cur.body === content.body && sameTags(cur.tags, tags)) {
    return { rec, created: false, changed: false };
  }
  rec.versions.push({ version: cur.version + 1, title: content.title, body: content.body, tags, updatedAt: now });
  store.save(rec);
  return { rec, created: false, changed: true };
}

// ---------------- helpers ----------------
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json', 'invalid JSON body'); }
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

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function makeSnippet(body, q) {
  const lower = body.toLowerCase();
  const ql = q.toLowerCase();
  const idx = lower.indexOf(ql);
  if (idx < 0) return escapeHtml(body.slice(0, 80));
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + q.length + 40);
  return escapeHtml(body.slice(start, idx)) + '<mark>' + escapeHtml(body.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(body.slice(idx + q.length, end));
}

function wikiDoc(title, html) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static/app.css"></head>
<body class="wiki-page"><header><a href="/">&larr; Wiki</a></header>
<main><h1 class="page-title">${escapeHtml(title)}</h1>
<article class="markdown-body">
${html}
</article></main></body></html>`;
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------------- server ----------------
export function createServer({ dataDir } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const store = new Store(dataDir);
  const resolver = { exists: (slug) => store.pages.has(slug) };

  const fullPage = (rec) => {
    const p = pageView(rec);
    const backlinks = [];
    for (const [slug, links] of store.links) if (links.includes(rec.slug)) backlinks.push(slug);
    backlinks.sort();
    return {
      ...p,
      html: render(p.body, { headingIds: true, wikiLinks: resolver }),
      toc: toc(p.body),
      backlinks,
      links: store.links.get(rec.slug) || [],
    };
  };

  const getRec = (slug) => {
    if (!SLUG_RE.test(slug)) throw bad('invalid slug');
    const rec = store.pages.get(slug);
    if (!rec) throw notFound(`page '${slug}' not found`);
    return rec;
  };
  const getVersion = (rec, n) => {
    if (n === null || n === undefined || n === '' || !/^\d+$/.test(String(n))) throw bad('version must be a positive integer');
    const v = rec.versions.find((x) => x.version === Number(n));
    if (!v) throw notFound(`version ${n} not found`);
    return v;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const m = req.method;

    if (parts[0] === 'api') {
      const [, a, slug, sub, n] = parts;
      if (a === 'pages' && parts.length === 2 && m === 'GET') {
        const tag = (url.searchParams.get('tag') || '').trim().toLowerCase();
        const sort = url.searchParams.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
        let list = [...store.pages.values()].map(pageView);
        if (tag) list = list.filter((p) => p.tags.includes(tag));
        if (sort === 'updated') list.sort((x, y) => (y.updatedAt.localeCompare(x.updatedAt)) || x.slug.localeCompare(y.slug));
        else list.sort((x, y) => {
          const a1 = x.title.toLowerCase(), b1 = y.title.toLowerCase();
          return a1 < b1 ? -1 : a1 > b1 ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
        });
        return sendJson(res, 200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      if (a === 'pages' && slug !== undefined) {
        if (parts.length === 3) {
          if (m === 'GET') return sendJson(res, 200, fullPage(getRec(slug)));
          if (m === 'PUT') {
            if (!SLUG_RE.test(slug)) throw bad('invalid slug');
            const input = await readJson(req);
            const content = validateContent(input);
            const bv = input.baseVersion;
            if (bv !== undefined && bv !== null && !Number.isInteger(bv)) throw bad('baseVersion must be an integer');
            const { rec, created } = upsert(store, slug, content, bv);
            return sendJson(res, created ? 201 : 200, fullPage(rec));
          }
          if (m === 'DELETE') {
            getRec(slug);
            store.remove(slug);
            res.writeHead(204); return res.end();
          }
        }
        if (parts.length === 4 && sub === 'history' && m === 'GET') {
          const rec = getRec(slug);
          return sendJson(res, 200, rec.versions.slice().reverse().map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })));
        }
        if (parts.length === 5 && sub === 'versions' && m === 'GET') {
          const rec = getRec(slug);
          const v = getVersion(rec, n);
          return sendJson(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags, updatedAt: v.updatedAt });
        }
        if (parts.length === 4 && sub === 'revert' && m === 'POST') {
          const rec = getRec(slug);
          const input = await readJson(req);
          if (!input || typeof input !== 'object') throw bad('body must be a JSON object');
          const raw = input.version;
          if (!Number.isInteger(raw) && !(typeof raw === 'string' && /^\d+$/.test(raw))) throw bad('version must be an integer');
          const v = getVersion(rec, raw);
          const cur = current(rec);
          rec.versions.push({ version: cur.version + 1, title: v.title, body: v.body, tags: [...v.tags], updatedAt: new Date().toISOString() });
          store.save(rec);
          return sendJson(res, 200, fullPage(rec));
        }
        if (parts.length === 4 && sub === 'diff' && m === 'GET') {
          const rec = getRec(slug);
          const fromV = getVersion(rec, url.searchParams.get('from'));
          const toV = getVersion(rec, url.searchParams.get('to'));
          return sendJson(res, 200, { from: fromV.version, to: toV.version, lines: lineDiff(fromV.body, toV.body) });
        }
      }
      if (a === 'search' && parts.length === 2 && m === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) throw bad('q is required');
        const ql = q.toLowerCase();
        const results = [];
        for (const rec of store.pages.values()) {
          const v = current(rec);
          const t = v.title.toLowerCase(), b = v.body.toLowerCase();
          const inTitle = t.includes(ql);
          if (!inTitle && !b.includes(ql)) continue;
          const score = countOccurrences(t, ql) + countOccurrences(b, ql);
          results.push({ slug: rec.slug, title: v.title, snippet: makeSnippet(v.body, q), score, _t: inTitle ? 1 : 0 });
        }
        results.sort((x, y) => (y._t - x._t) || (y.score - x.score) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
        return sendJson(res, 200, results.map(({ _t, ...r }) => r));
      }
      if (a === 'render' && parts.length === 2 && m === 'POST') {
        const input = await readJson(req);
        const md = input && typeof input === 'object' ? input.markdown : undefined;
        if (typeof md !== 'string') throw bad('markdown must be a string');
        return sendJson(res, 200, { html: render(md, { headingIds: true, wikiLinks: resolver }), toc: toc(md) });
      }
      if (a === 'tags' && parts.length === 2 && m === 'GET') {
        const counts = new Map();
        for (const rec of store.pages.values()) for (const t of current(rec).tags) counts.set(t, (counts.get(t) || 0) + 1);
        return sendJson(res, 200, [...counts].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })));
      }
      if (a === 'export' && parts.length === 2 && m === 'GET') {
        const pages = [...store.pages.values()].sort((x, y) => (x.slug < y.slug ? -1 : 1)).map((rec) => {
          const v = current(rec);
          return { slug: rec.slug, title: v.title, body: v.body, tags: v.tags, version: v.version };
        });
        return sendJson(res, 200, { pages });
      }
      if (a === 'import' && parts.length === 2 && m === 'POST') {
        const input = await readJson(req);
        if (!input || !Array.isArray(input.pages)) throw bad('pages must be an array');
        const items = input.pages.map((p, i) => {
          if (!p || typeof p !== 'object' || typeof p.slug !== 'string' || !SLUG_RE.test(p.slug)) throw bad(`pages[${i}]: invalid slug`);
          const c = validateContent(p, { requireAll: false });
          return { slug: p.slug, ...c };
        });
        for (const it of items) upsert(store, it.slug, it, undefined);
        return sendJson(res, 200, { imported: items.length });
      }
      throw notFound('unknown route');
    }

    if (m === 'GET' || m === 'HEAD') {
      if (parts[0] === 'wiki' && parts.length === 2) {
        const rec = SLUG_RE.test(parts[1]) ? store.pages.get(parts[1]) : null;
        if (!rec) return sendHtml(res, 404, wikiDoc('Page not found', `<p>No page named <code>${escapeHtml(parts[1])}</code>. <a href="/#edit/${encodeURIComponent(parts[1])}">Create it</a>.</p>`));
        const p = fullPage(rec);
        return sendHtml(res, 200, wikiDoc(p.title, p.html));
      }
      if (parts.length === 0) {
        return sendHtml(res, 200, fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8'));
      }
      if (parts[0] === 'static' && parts.length === 2 && /^[\w.-]+$/.test(parts[1])) {
        const file = path.join(STATIC_DIR, parts[1]);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const data = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
          return res.end(data);
        }
      }
    }
    throw notFound('unknown route');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      sendJson(res, 500, { error: 'internal', message: String(err && err.message || err) });
    });
  });
}
