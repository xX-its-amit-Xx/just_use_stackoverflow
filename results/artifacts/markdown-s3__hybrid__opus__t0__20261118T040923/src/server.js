import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, extractWikiLinks } from './markdown.js';
import { diffLines } from './diff.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const MAX_BODY = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw bad('tags must be an array of strings');
  const set = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw bad('tags must be an array of strings');
    const v = t.trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set].sort();
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw bad('Invalid slug');
}

function validateContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Body must be a JSON object');
  const { title, body } = input;
  if (typeof title !== 'string' || title.trim() === '') throw bad('title is required');
  if (title.length > 200) throw bad('title must be at most 200 characters');
  if (body !== undefined && body !== null && typeof body !== 'string') throw bad('body must be a string');
  return { title, body: body ?? '', tags: normalizeTags(input.tags) };
}

function sameTags(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
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
        if (rec && SLUG_RE.test(rec.slug) && Array.isArray(rec.versions) && rec.versions.length) {
          rec.links = extractWikiLinks(rec.versions[rec.versions.length - 1].body);
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
  persist(rec) {
    const file = path.join(this.dir, `${rec.slug}.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const { links, ...data } = rec;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  remove(slug) {
    this.pages.delete(slug);
    try { fs.unlinkSync(path.join(this.dir, `${slug}.json`)); } catch { /* ignore */ }
  }
  current(rec) {
    return rec.versions[rec.versions.length - 1];
  }
  view(rec) {
    const cur = this.current(rec);
    return {
      slug: rec.slug, title: cur.title, body: cur.body, tags: cur.tags,
      version: cur.version, createdAt: rec.createdAt, updatedAt: cur.updatedAt,
    };
  }
  /** returns { rec, created, changed } */
  save(slug, content, baseVersion) {
    let rec = this.pages.get(slug);
    if (baseVersion !== undefined && baseVersion !== null) {
      const curV = rec ? this.current(rec).version : 0;
      if (baseVersion !== curV) {
        throw new HttpError(409, 'conflict', `Version conflict: current version is ${curV}`, { currentVersion: curV });
      }
    }
    if (!rec) {
      const ts = this.now();
      rec = { slug, createdAt: ts, versions: [{ version: 1, ...content, updatedAt: ts }] };
      rec.links = extractWikiLinks(content.body);
      this.pages.set(slug, rec);
      this.persist(rec);
      return { rec, created: true, changed: true };
    }
    const cur = this.current(rec);
    if (cur.title === content.title && cur.body === content.body && sameTags(cur.tags, content.tags)) {
      return { rec, created: false, changed: false };
    }
    this.appendVersion(rec, content);
    return { rec, created: false, changed: true };
  }
  appendVersion(rec, content) {
    const cur = this.current(rec);
    rec.versions.push({ version: cur.version + 1, title: content.title, body: content.body, tags: [...content.tags], updatedAt: this.now() });
    rec.links = extractWikiLinks(content.body);
    this.persist(rec);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) throw new HttpError(400, 'bad_json', 'Request body must be JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Invalid JSON');
  }
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendText(res, status, type, text) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function parseIntStrict(v, name) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  throw bad(`${name} must be an integer`);
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function wikiDoc(title, html) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="wiki-page">
<nav><a href="/">&larr; Wiki editor</a></nav>
<article>
<h1 class="page-title">${escapeHtml(title)}</h1>
<div class="markdown-body">
${html}
</div>
</article>
</body>
</html>
`;
}

const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };

export function createServer({ dataDir } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const store = new Store(dataDir);
  const wikiOpts = () => ({ exists: (s) => store.pages.has(s) });

  function getPageOr404(slug) {
    validateSlug(slug);
    const rec = store.pages.get(slug);
    if (!rec) throw notFound(`Page '${slug}' not found`);
    return rec;
  }

  function fullPage(rec) {
    const v = store.view(rec);
    const backlinks = [];
    for (const [s, other] of store.pages) if (other.links.includes(rec.slug)) backlinks.push(s);
    backlinks.sort();
    return {
      ...v,
      html: render(v.body, { headingIds: true, wikiLinks: wikiOpts() }),
      toc: toc(v.body),
      backlinks,
      links: [...rec.links],
    };
  }

  function findVersion(rec, n) {
    const v = rec.versions.find((x) => x.version === n);
    if (!v) throw notFound(`Version ${n} not found`);
    return v;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let parts;
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw bad('Malformed URL');
    }
    const method = req.method;
    const q = url.searchParams;

    // UI
    if (parts.length === 0 && (method === 'GET' || method === 'HEAD')) {
      return sendText(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'));
    }
    if (parts[0] === 'static' && parts.length === 2 && method === 'GET') {
      const name = parts[1];
      const ext = path.extname(name);
      if (/^[\w.-]+$/.test(name) && STATIC_TYPES[ext]) {
        const file = path.join(UI_DIR, name);
        if (fs.existsSync(file)) return sendText(res, 200, STATIC_TYPES[ext], fs.readFileSync(file, 'utf8'));
      }
      throw notFound();
    }
    if (parts[0] === 'wiki' && parts.length === 2 && method === 'GET') {
      const slug = parts[1];
      const rec = SLUG_RE.test(slug) ? store.pages.get(slug) : null;
      if (!rec) {
        return sendText(res, 404, 'text/html; charset=utf-8', wikiDoc('Page not found',
          `<p>The page <code>${escapeHtml(slug)}</code> does not exist. <a href="/">Create it in the editor</a>.</p>`));
      }
      const p = fullPage(rec);
      return sendText(res, 200, 'text/html; charset=utf-8', wikiDoc(p.title, p.html));
    }

    if (parts[0] !== 'api') throw notFound('Unknown route');
    const r = parts.slice(1);

    if (r[0] === 'pages') {
      if (r.length === 1 && method === 'GET') {
        const tag = q.get('tag');
        const sort = q.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
        let list = [...store.pages.values()].map((rec) => store.view(rec));
        if (tag) {
          const t = tag.trim().toLowerCase();
          list = list.filter((p) => p.tags.includes(t));
        }
        if (sort === 'title') {
          list.sort((a, b) => {
            const x = a.title.toLowerCase(), y = b.title.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
          });
        } else {
          list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        }
        return sendJson(res, 200, list.map(({ slug, title, tags, version, updatedAt }) => ({ slug, title, tags, version, updatedAt })));
      }
      const slug = r[1];
      if (r.length === 2) {
        if (method === 'PUT') {
          validateSlug(slug);
          const input = await readJson(req);
          const content = validateContent(input);
          let baseVersion;
          if (input.baseVersion !== undefined && input.baseVersion !== null) {
            if (!Number.isInteger(input.baseVersion)) throw bad('baseVersion must be an integer');
            baseVersion = input.baseVersion;
          }
          const { rec, created } = store.save(slug, content, baseVersion);
          return sendJson(res, created ? 201 : 200, store.view(rec));
        }
        if (method === 'GET') return sendJson(res, 200, fullPage(getPageOr404(slug)));
        if (method === 'DELETE') {
          getPageOr404(slug);
          store.remove(slug);
          res.writeHead(204);
          return res.end();
        }
      }
      if (r.length === 3 && r[2] === 'history' && method === 'GET') {
        const rec = getPageOr404(slug);
        return sendJson(res, 200, rec.versions.map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })).reverse());
      }
      if (r.length === 4 && r[2] === 'versions' && method === 'GET') {
        const rec = getPageOr404(slug);
        if (!/^\d+$/.test(r[3])) throw notFound(`Version ${r[3]} not found`);
        const v = findVersion(rec, Number(r[3]));
        return sendJson(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      }
      if (r.length === 3 && r[2] === 'revert' && method === 'POST') {
        const rec = getPageOr404(slug);
        const input = await readJson(req);
        if (!input || typeof input !== 'object') throw bad('Body must be a JSON object');
        const n = parseIntStrict(input.version, 'version');
        const v = findVersion(rec, n);
        store.appendVersion(rec, { title: v.title, body: v.body, tags: v.tags });
        return sendJson(res, 200, store.view(rec));
      }
      if (r.length === 3 && r[2] === 'diff' && method === 'GET') {
        const rec = getPageOr404(slug);
        if (!q.has('from') || !q.has('to')) throw bad('from and to are required');
        const from = parseIntStrict(q.get('from'), 'from');
        const to = parseIntStrict(q.get('to'), 'to');
        const a = findVersion(rec, from), b = findVersion(rec, to);
        return sendJson(res, 200, { from, to, lines: diffLines(a.body, b.body) });
      }
    }

    if (r.length === 1 && r[0] === 'search' && method === 'GET') {
      const raw = (q.get('q') || '').trim();
      if (!raw) throw bad('q must not be empty');
      const needle = raw.toLowerCase();
      const results = [];
      for (const rec of store.pages.values()) {
        const p = store.view(rec);
        const tl = p.title.toLowerCase(), bl = p.body.toLowerCase();
        const inTitle = tl.includes(needle);
        const bodyIdx = bl.indexOf(needle);
        if (!inTitle && bodyIdx < 0) continue;
        const score = countOccurrences(tl, needle) + countOccurrences(bl, needle);
        let snippet;
        if (bodyIdx >= 0) {
          const s = Math.max(0, bodyIdx - 40);
          const end = bodyIdx + needle.length;
          snippet = escapeHtml(p.body.slice(s, bodyIdx)) + '<mark>' + escapeHtml(p.body.slice(bodyIdx, end)) + '</mark>' + escapeHtml(p.body.slice(end, end + 40));
        } else {
          snippet = escapeHtml(p.body.slice(0, 80));
        }
        results.push({ slug: p.slug, title: p.title, snippet, score, _t: inTitle });
      }
      results.sort((a, b) => (a._t !== b._t ? (a._t ? -1 : 1) : b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)));
      return sendJson(res, 200, results.map(({ _t, ...x }) => x));
    }

    if (r.length === 1 && r[0] === 'render' && method === 'POST') {
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || typeof (input.markdown ?? '') !== 'string') throw bad('markdown must be a string');
      const md = input.markdown ?? '';
      return sendJson(res, 200, { html: render(md, { headingIds: true, wikiLinks: wikiOpts() }), toc: toc(md) });
    }

    if (r.length === 1 && r[0] === 'tags' && method === 'GET') {
      const counts = new Map();
      for (const rec of store.pages.values()) for (const t of store.current(rec).tags) counts.set(t, (counts.get(t) || 0) + 1);
      return sendJson(res, 200, [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) })));
    }

    if (r.length === 1 && r[0] === 'export' && method === 'GET') {
      const pages = [...store.pages.values()].map((rec) => {
        const v = store.view(rec);
        return { slug: v.slug, title: v.title, body: v.body, tags: v.tags, version: v.version };
      }).sort((a, b) => (a.slug < b.slug ? -1 : 1));
      return sendJson(res, 200, { pages });
    }

    if (r.length === 1 && r[0] === 'import' && method === 'POST') {
      const input = await readJson(req);
      if (!input || !Array.isArray(input.pages)) throw bad('pages must be an array');
      const items = input.pages.map((p) => {
        if (!p || typeof p !== 'object') throw bad('Each page must be an object');
        validateSlug(p.slug);
        return { slug: p.slug, content: validateContent(p) };
      });
      for (const it of items) store.save(it.slug, it.content);
      return sendJson(res, 200, { imported: items.length });
    }

    throw notFound('Unknown route');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      } else {
        sendJson(res, 500, { error: 'internal', message: String(err && err.message || err) });
      }
    });
  });
}
