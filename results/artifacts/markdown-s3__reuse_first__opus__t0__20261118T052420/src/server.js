import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinkTargets } from './markdown.js';
import { lineDiff } from './diff.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normTags(tags) {
  if (tags === undefined || tags === null) return undefined;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

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
        if (rec && SLUG_RE.test(rec.slug) && Array.isArray(rec.versions) && rec.versions.length) {
          this.pages.set(rec.slug, rec);
          for (const v of rec.versions) this.lastTs = Math.max(this.lastTs, Date.parse(v.updatedAt) || 0);
        }
      } catch { /* ignore corrupt file */ }
    }
  }
  now() {
    // strictly increasing timestamps so "newest first" ordering is well defined
    const t = Math.max(Date.now(), this.lastTs + 1);
    this.lastTs = t;
    return new Date(t).toISOString();
  }
  file(slug) { return path.join(this.dir, slug + '.json'); }
  save(rec) {
    const f = this.file(rec.slug);
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, f);
  }
  remove(slug) {
    this.pages.delete(slug);
    try { fs.unlinkSync(this.file(slug)); } catch { /* ignore */ }
  }
  get(slug) { return this.pages.get(slug); }
  exists(slug) { return this.pages.has(slug); }
  all() { return [...this.pages.values()]; }

  /** Create/update; returns { rec, created, changed } */
  write(slug, { title, body, tags }) {
    let rec = this.pages.get(slug);
    const cur = rec && rec.versions[rec.versions.length - 1];
    const finalTags = tags ?? (cur ? cur.tags : []);
    if (cur && cur.title === title && cur.body === body && sameTags(cur.tags, finalTags)) {
      return { rec, created: false, changed: false };
    }
    const ts = this.now();
    const created = !rec;
    if (!rec) rec = { slug, createdAt: ts, versions: [] };
    rec.versions.push({ version: (cur ? cur.version : 0) + 1, title, body, tags: finalTags, updatedAt: ts });
    this.pages.set(slug, rec);
    this.save(rec);
    return { rec, created, changed: true };
  }
}

function current(rec) { return rec.versions[rec.versions.length - 1]; }
function pageView(rec) {
  const c = current(rec);
  return { slug: rec.slug, title: c.title, body: c.body, tags: c.tags, version: c.version, createdAt: rec.createdAt, updatedAt: c.updatedAt };
}

function validateSlug(slug) {
  if (!SLUG_RE.test(slug)) throw bad('invalid slug');
  return slug;
}

function validateContent(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw bad('title must be a non-empty string of at most 200 characters');
  if (b.body !== undefined && b.body !== null && typeof b.body !== 'string') throw bad('body must be a string');
  return { title: b.title, body: b.body ?? '', tags: normTags(b.tags) };
}

function parseVersion(v, name = 'version') {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 1) throw bad(`${name} must be a positive integer`);
  return n;
}

function countOcc(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json', 'request body is not valid JSON'); }
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const body = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };

export function createServer({ dataDir = './data' } = {}) {
  const store = new Store(dataDir);
  const wikiLinks = { exists: (s) => store.exists(s) };

  const linksOf = (body) => [...new Set(wikiLinkTargets(body))].sort();
  const fullPage = (rec) => {
    const v = pageView(rec);
    const backlinks = store.all().filter((r) => wikiLinkTargets(current(r).body).includes(rec.slug)).map((r) => r.slug).sort();
    return { ...v, html: render(v.body, { headingIds: true, wikiLinks }), toc: toc(v.body), backlinks, links: linksOf(v.body) };
  };
  const mustGet = (slug) => {
    const rec = store.get(validateSlug(slug));
    if (!rec) throw notFound('page not found');
    return rec;
  };
  const findVersion = (rec, n) => {
    const v = rec.versions.find((x) => x.version === n);
    if (!v) throw notFound('version not found');
    return v;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const m = req.method;
    const q = url.searchParams;

    // ---- UI ----
    if (m === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (m === 'GET' && parts[0] === 'static' && parts.length === 2) {
      const name = parts[1];
      const ext = path.extname(name);
      if (/^[\w.-]+$/.test(name) && STATIC_TYPES[ext] && fs.existsSync(path.join(PUBLIC_DIR, name))) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'), STATIC_TYPES[ext]);
      }
      throw notFound();
    }
    if (m === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const rec = SLUG_RE.test(parts[1]) ? store.get(parts[1]) : null;
      if (!rec) {
        return send(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1><p>No page named <code>${escapeHtml(parts[1])}</code>. <a href="/">Back to wiki</a></p></body></html>`, 'text/html; charset=utf-8');
      }
      const p = fullPage(rec);
      return send(res, 200, `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="wiki-page"><header><a href="/">Wiki</a></header><main><h1 class="page-title">${escapeHtml(p.title)}</h1>
<article class="markdown-body">
${p.html}
</article></main></body></html>`, 'text/html; charset=utf-8');
    }

    if (parts[0] !== 'api') throw notFound('unknown route');

    // ---- API ----
    if (parts[1] === 'pages') {
      if (parts.length === 2 && m === 'GET') {
        const tag = q.get('tag');
        const sort = q.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
        let list = store.all().map(pageView);
        if (tag) list = list.filter((p) => p.tags.includes(tag.trim().toLowerCase()));
        if (sort === 'title') {
          list.sort((a, b) => { const x = a.title.toLowerCase(), y = b.title.toLowerCase(); return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; });
        } else {
          list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        }
        return send(res, 200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      if (parts.length === 3) {
        const slug = validateSlug(parts[2]);
        if (m === 'GET') return send(res, 200, fullPage(mustGet(slug)));
        if (m === 'PUT') {
          const b = await readJson(req);
          const content = validateContent(b);
          const rec = store.get(slug);
          const curVersion = rec ? current(rec).version : 0;
          if (b.baseVersion !== undefined && b.baseVersion !== null) {
            if (typeof b.baseVersion !== 'number' || !Number.isInteger(b.baseVersion)) throw bad('baseVersion must be an integer');
            if (b.baseVersion !== curVersion) {
              throw new HttpError(409, 'conflict', `page was modified (current version ${curVersion})`, { currentVersion: curVersion });
            }
          }
          const r = store.write(slug, content);
          return send(res, r.created ? 201 : 200, pageView(r.rec));
        }
        if (m === 'DELETE') {
          mustGet(slug);
          store.remove(slug);
          return send(res, 204);
        }
        throw notFound('unknown route');
      }
      if (parts.length >= 4) {
        const slug = validateSlug(parts[2]);
        const sub = parts[3];
        if (sub === 'history' && parts.length === 4 && m === 'GET') {
          const rec = mustGet(slug);
          return send(res, 200, [...rec.versions].reverse().map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })));
        }
        if (sub === 'versions' && parts.length === 5 && m === 'GET') {
          const rec = mustGet(slug);
          if (!/^\d+$/.test(parts[4])) throw notFound('version not found');
          const v = findVersion(rec, Number(parts[4]));
          return send(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
        }
        if (sub === 'revert' && parts.length === 4 && m === 'POST') {
          const b = await readJson(req);
          const rec = mustGet(slug);
          if (!b || typeof b !== 'object') throw bad('body must be a JSON object');
          const v = findVersion(rec, parseVersion(b.version));
          const cur = current(rec);
          const ts = store.now();
          rec.versions.push({ version: cur.version + 1, title: v.title, body: v.body, tags: [...v.tags], updatedAt: ts });
          store.save(rec);
          return send(res, 200, pageView(rec));
        }
        if (sub === 'diff' && parts.length === 4 && m === 'GET') {
          const rec = mustGet(slug);
          const cur = current(rec);
          const from = q.has('from') ? parseVersion(q.get('from'), 'from') : Math.max(1, cur.version - 1);
          const to = q.has('to') ? parseVersion(q.get('to'), 'to') : cur.version;
          const a = findVersion(rec, from), b = findVersion(rec, to);
          return send(res, 200, { from, to, lines: lineDiff(a.body, b.body) });
        }
      }
      throw notFound('unknown route');
    }

    if (parts[1] === 'search' && parts.length === 2 && m === 'GET') {
      const raw = (q.get('q') || '').trim();
      if (!raw) throw bad('q must contain at least one character');
      const needle = raw.toLowerCase();
      const results = [];
      for (const rec of store.all()) {
        const c = current(rec);
        const lt = c.title.toLowerCase(), lb = c.body.toLowerCase();
        const inTitle = lt.includes(needle);
        const bi = lb.indexOf(needle);
        if (!inTitle && bi < 0) continue;
        const score = countOcc(lt, needle) + countOcc(lb, needle);
        let snippet;
        if (bi >= 0) {
          const s = Math.max(0, bi - 40);
          const e = Math.min(c.body.length, bi + raw.length + 40);
          snippet = escapeHtml(c.body.slice(s, bi)) + '<mark>' + escapeHtml(c.body.slice(bi, bi + raw.length)) + '</mark>' + escapeHtml(c.body.slice(bi + raw.length, e));
        } else {
          snippet = escapeHtml(c.body.slice(0, 80));
        }
        results.push({ slug: rec.slug, title: c.title, snippet, score, _t: inTitle });
      }
      results.sort((a, b) => (a._t !== b._t ? (a._t ? -1 : 1) : b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)));
      return send(res, 200, results.map(({ _t, ...r }) => r));
    }

    if (parts[1] === 'render' && parts.length === 2 && m === 'POST') {
      const b = await readJson(req);
      const md = b && typeof b === 'object' ? b.markdown : undefined;
      if (md !== undefined && typeof md !== 'string') throw bad('markdown must be a string');
      return send(res, 200, { html: render(md ?? '', { headingIds: true, wikiLinks }), toc: toc(md ?? '') });
    }

    if (parts[1] === 'tags' && parts.length === 2 && m === 'GET') {
      const counts = new Map();
      for (const rec of store.all()) for (const t of current(rec).tags) counts.set(t, (counts.get(t) || 0) + 1);
      return send(res, 200, [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })));
    }

    if (parts[1] === 'export' && parts.length === 2 && m === 'GET') {
      const pages = store.all().map(pageView).sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .map(({ slug, title, body, tags, version }) => ({ slug, title, body, tags, version }));
      return send(res, 200, { pages });
    }

    if (parts[1] === 'import' && parts.length === 2 && m === 'POST') {
      const b = await readJson(req);
      if (!b || typeof b !== 'object' || !Array.isArray(b.pages)) throw bad('pages must be an array');
      const items = b.pages.map((p) => {
        if (!p || typeof p !== 'object' || typeof p.slug !== 'string') throw bad('each page needs a slug');
        return { slug: validateSlug(p.slug), content: validateContent(p) };
      });
      for (const it of items) store.write(it.slug, it.content);
      return send(res, 200, { imported: items.length });
    }

    throw notFound('unknown route');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      } else {
        send(res, 500, { error: 'internal', message: String(err && err.message || err) });
      }
    });
  });
}
