// HTTP server for the personal markdown wiki. Storage: one JSON file per page
// under <dataDir>/pages/<slug>.json, written atomically (tmp file + rename).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, wikiLinkTargets } from './markdown.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const invalid = (message) => new HttpError(400, 'validation', message);

// ---------- storage ----------

function makeStore(dataDir) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const fileFor = (slug) => path.join(pagesDir, `${slug}.json`);

  function load(slug) {
    if (!SLUG_RE.test(slug)) return null;
    let raw;
    try {
      raw = fs.readFileSync(fileFor(slug), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(raw);
  }

  function save(record) {
    const file = fileFor(record.slug);
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  }

  function remove(slug) {
    fs.rmSync(fileFor(slug), { force: true });
  }

  function all() {
    const out = [];
    for (const f of fs.readdirSync(pagesDir)) {
      if (!f.endsWith('.json')) continue;
      out.push(JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')));
    }
    return out;
  }

  return { load, save, remove, all, exists: (slug) => load(slug) !== null };
}

// ---------- helpers ----------

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw invalid('tags must be an array of strings');
  const set = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') throw invalid('tags must be an array of strings');
    const v = t.trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set].sort();
}

function validateSlug(slug) {
  if (!SLUG_RE.test(slug)) throw invalid('slug must match ^[a-z0-9][a-z0-9_-]*$');
  return slug;
}

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw invalid('title must be a non-empty string');
  if (title.trim().length > 200) throw invalid('title must be at most 200 characters');
  return title.trim();
}

function validateBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw invalid('body must be a string');
  return body;
}

function validateBaseVersion(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v)) throw invalid('baseVersion must be an integer');
  return v;
}

function parseVersionNumber(s) {
  if (!/^\d+$/.test(s)) throw new HttpError(404, 'not_found', `no version ${s}`);
  return Number(s);
}

function currentOf(record) {
  return record.versions[record.versions.length - 1];
}

function pageView(record) {
  const cur = currentOf(record);
  return {
    slug: record.slug,
    title: cur.title,
    body: cur.body,
    tags: cur.tags,
    version: cur.version,
    createdAt: record.createdAt,
    updatedAt: cur.updatedAt,
  };
}

function sameContent(a, b) {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

// Create or update a page. Returns { record, created, changed }.
function upsertPage(store, slug, input, baseVersion, now) {
  const title = validateTitle(input.title);
  const body = validateBody(input.body);
  const tags = normalizeTags(input.tags);
  const existing = store.load(slug);
  const currentVersion = existing ? currentOf(existing).version : 0;
  if (baseVersion !== undefined && baseVersion !== currentVersion) {
    throw new HttpError(409, 'conflict', `base version ${baseVersion} is not current (${currentVersion})`, {
      currentVersion,
    });
  }
  const next = { title, body, tags };
  if (!existing) {
    const record = {
      slug,
      createdAt: now,
      versions: [{ version: 1, ...next, updatedAt: now }],
    };
    store.save(record);
    return { record, created: true, changed: true };
  }
  if (sameContent(currentOf(existing), next)) {
    return { record: existing, created: false, changed: false };
  }
  existing.versions.push({ version: existing.versions.length + 1, ...next, updatedAt: now });
  store.save(existing);
  return { record: existing, created: false, changed: true };
}

function renderFor(store, markdown, { headingIds }) {
  return render(markdown, {
    headingIds,
    wikiLinks: { exists: (s) => SLUG_RE.test(s) && store.exists(s) },
  });
}

function backlinksFor(store, slug) {
  const out = [];
  for (const rec of store.all()) {
    if (rec.slug === slug) continue;
    if (wikiLinkTargets(currentOf(rec).body).includes(slug)) out.push(rec.slug);
  }
  return out.sort();
}

function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let minus = [];
  let plus = [];
  const flush = () => {
    for (const t of minus) lines.push({ op: '-', text: t });
    for (const t of plus) lines.push({ op: '+', text: t });
    minus = [];
    plus = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      lines.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      minus.push(a[i]);
      i++;
    } else {
      plus.push(b[j]);
      j++;
    }
  }
  flush();
  return lines;
}

function splitBody(body) {
  return body === '' ? [] : body.split('\n');
}

function searchPages(store, rawQ) {
  const q = rawQ.trim();
  if (q.length < 1) throw invalid('q must contain at least one character');
  const needle = q.toLowerCase();
  const results = [];
  for (const rec of store.all()) {
    const cur = currentOf(rec);
    const titleLc = cur.title.toLowerCase();
    const bodyLc = cur.body.toLowerCase();
    const titleHit = titleLc.includes(needle);
    const bodyIdx = bodyLc.indexOf(needle);
    if (!titleHit && bodyIdx === -1) continue;
    const countIn = (s) => {
      let c = 0;
      let p = s.indexOf(needle);
      while (p !== -1) {
        c++;
        p = s.indexOf(needle, p + needle.length);
      }
      return c;
    };
    const score = countIn(titleLc) + countIn(bodyLc);
    let snippet;
    if (bodyIdx !== -1) {
      const start = Math.max(0, bodyIdx - 40);
      const end = Math.min(cur.body.length, bodyIdx + q.length + 40);
      snippet =
        escapeHtml(cur.body.slice(start, bodyIdx)) +
        '<mark>' +
        escapeHtml(cur.body.slice(bodyIdx, bodyIdx + q.length)) +
        '</mark>' +
        escapeHtml(cur.body.slice(bodyIdx + q.length, end));
    } else {
      snippet = escapeHtml(cur.body.slice(0, 40));
    }
    results.push({ slug: rec.slug, title: cur.title, snippet, score, titleHit });
  }
  results.sort((x, y) => {
    if (x.titleHit !== y.titleHit) return x.titleHit ? -1 : 1;
    if (x.score !== y.score) return y.score - x.score;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });
  return results.map(({ slug, title, snippet, score }) => ({ slug, title, snippet, score }));
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res, err) {
  const body = { error: err.code, message: err.message, ...err.extra };
  sendJson(res, err.status, body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, 'validation', 'request body too large'));
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
  if (text.trim() === '') throw new HttpError(400, 'bad_json', 'request body must be JSON');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('request body must be a JSON object');
  }
  return parsed;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, relPath) {
  const full = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not_found', 'not found');
  let data;
  try {
    data = fs.readFileSync(full);
  } catch {
    throw new HttpError(404, 'not_found', 'not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(full)] || 'application/octet-stream',
    'content-length': data.length,
  });
  res.end(data);
}

function wikiPageHtml(record, html) {
  const title = escapeHtml(currentOf(record).title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}a.missing{color:#b00}a.wikilink.missing{color:#b00}pre{background:#f5f5f5;padding:.5rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}</style>
</head>
<body>
<article>
<h1>${title}</h1>
${html}
</article>
</body>
</html>
`;
}

// ---------- routing ----------

async function route(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
  const method = req.method;

  if (method === 'GET' && parts.length === 0) {
    return serveStatic(res, 'index.html');
  }
  if (method === 'GET' && parts[0] === 'static' && parts.length >= 2) {
    return serveStatic(res, parts.slice(1).join('/'));
  }
  if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
    const slug = parts[1];
    const rec = SLUG_RE.test(slug) ? store.load(slug) : null;
    if (!rec) {
      return sendHtml(res, 404, '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>');
    }
    return sendHtml(res, 200, wikiPageHtml(rec, renderFor(store, currentOf(rec).body, { headingIds: true })));
  }

  if (parts[0] !== 'api') throw new HttpError(404, 'not_found', 'route not found');
  const api = parts.slice(1);

  // /api/render
  if (api.length === 1 && api[0] === 'render' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body.markdown !== 'string') throw invalid('markdown must be a string');
    const html = renderFor(store, body.markdown, { headingIds: true });
    return sendJson(res, 200, { html, toc: toc(body.markdown) });
  }

  // /api/tags
  if (api.length === 1 && api[0] === 'tags' && method === 'GET') {
    const counts = new Map();
    for (const rec of store.all()) {
      for (const t of currentOf(rec).tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const list = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    return sendJson(res, 200, list);
  }

  // /api/search
  if (api.length === 1 && api[0] === 'search' && method === 'GET') {
    const q = url.searchParams.get('q');
    if (q === null) throw invalid('q is required');
    return sendJson(res, 200, searchPages(store, q));
  }

  // /api/export and /api/import
  if (api.length === 1 && api[0] === 'export' && method === 'GET') {
    const pages = store
      .all()
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((rec) => {
        const cur = currentOf(rec);
        return { slug: rec.slug, title: cur.title, body: cur.body, tags: cur.tags, version: cur.version };
      });
    return sendJson(res, 200, { pages });
  }
  if (api.length === 1 && api[0] === 'import' && method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.pages)) throw invalid('pages must be an array');
    // Validate everything before applying anything.
    for (const p of body.pages) {
      if (p === null || typeof p !== 'object') throw invalid('each page must be an object');
      validateSlug(p.slug);
      validateTitle(p.title);
      validateBody(p.body);
      normalizeTags(p.tags);
    }
    const now = new Date().toISOString();
    for (const p of body.pages) {
      upsertPage(store, p.slug, p, undefined, now);
    }
    return sendJson(res, 200, { imported: body.pages.length });
  }

  // /api/pages
  if (api[0] === 'pages') {
    if (api.length === 1) {
      if (method !== 'GET') throw new HttpError(404, 'not_found', 'route not found');
      const tag = url.searchParams.get('tag');
      const sort = url.searchParams.get('sort') || 'title';
      if (sort !== 'title' && sort !== 'updated') throw invalid('sort must be title or updated');
      let list = store.all().map((rec) => {
        const cur = currentOf(rec);
        return { slug: rec.slug, title: cur.title, tags: cur.tags, version: cur.version, updatedAt: cur.updatedAt };
      });
      if (tag) list = list.filter((p) => p.tags.includes(tag.trim().toLowerCase()));
      if (sort === 'updated') {
        list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      } else {
        const key = (p) => p.title.toLowerCase();
        list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      }
      return sendJson(res, 200, list);
    }

    const slug = validateSlug(api[1]);
    const rest = api.slice(2);

    if (rest.length === 0) {
      if (method === 'GET') {
        const rec = store.load(slug);
        if (!rec) throw new HttpError(404, 'not_found', `page ${slug} not found`);
        const cur = currentOf(rec);
        return sendJson(res, 200, {
          ...pageView(rec),
          html: renderFor(store, cur.body, { headingIds: true }),
          toc: toc(cur.body),
          backlinks: backlinksFor(store, slug),
          links: wikiLinkTargets(cur.body),
        });
      }
      if (method === 'PUT') {
        const input = await readJson(req);
        const baseVersion = validateBaseVersion(input.baseVersion);
        const { record, created, changed } = upsertPage(store, slug, input, baseVersion, new Date().toISOString());
        return sendJson(res, created ? 201 : 200, pageView(record));
      }
      if (method === 'DELETE') {
        if (!store.exists(slug)) throw new HttpError(404, 'not_found', `page ${slug} not found`);
        store.remove(slug);
        res.writeHead(204);
        return res.end();
      }
      throw new HttpError(404, 'not_found', 'route not found');
    }

    if (rest.length === 1 && rest[0] === 'history' && method === 'GET') {
      const rec = store.load(slug);
      if (!rec) throw new HttpError(404, 'not_found', `page ${slug} not found`);
      const list = rec.versions
        .map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt }))
        .reverse();
      return sendJson(res, 200, list);
    }

    if (rest.length === 2 && rest[0] === 'versions' && method === 'GET') {
      const rec = store.load(slug);
      if (!rec) throw new HttpError(404, 'not_found', `page ${slug} not found`);
      const n = parseVersionNumber(rest[1]);
      const v = rec.versions.find((x) => x.version === n);
      if (!v) throw new HttpError(404, 'not_found', `version ${n} not found`);
      return sendJson(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
    }

    if (rest.length === 1 && rest[0] === 'revert' && method === 'POST') {
      const input = await readJson(req);
      if (!Number.isInteger(input.version)) throw invalid('version must be an integer');
      const rec = store.load(slug);
      if (!rec) throw new HttpError(404, 'not_found', `page ${slug} not found`);
      const v = rec.versions.find((x) => x.version === input.version);
      if (!v) throw new HttpError(404, 'not_found', `version ${input.version} not found`);
      rec.versions.push({
        version: rec.versions.length + 1,
        title: v.title,
        body: v.body,
        tags: [...v.tags],
        updatedAt: new Date().toISOString(),
      });
      store.save(rec);
      return sendJson(res, 200, pageView(rec));
    }

    if (rest.length === 1 && rest[0] === 'diff' && method === 'GET') {
      const rec = store.load(slug);
      if (!rec) throw new HttpError(404, 'not_found', `page ${slug} not found`);
      const fromRaw = url.searchParams.get('from');
      const toRaw = url.searchParams.get('to');
      if (fromRaw === null || toRaw === null || !/^\d+$/.test(fromRaw) || !/^\d+$/.test(toRaw)) {
        throw invalid('from and to must be version numbers');
      }
      const from = Number(fromRaw);
      const to = Number(toRaw);
      const vf = rec.versions.find((x) => x.version === from);
      const vt = rec.versions.find((x) => x.version === to);
      if (!vf || !vt) throw new HttpError(404, 'not_found', 'version not found');
      return sendJson(res, 200, { from, to, lines: lineDiff(splitBody(vf.body), splitBody(vt.body)) });
    }

    throw new HttpError(404, 'not_found', 'route not found');
  }

  throw new HttpError(404, 'not_found', 'route not found');
}

export function createServer({ dataDir }) {
  const store = makeStore(path.resolve(dataDir));
  return http.createServer((req, res) => {
    route(req, res, store).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err);
      } else if (err instanceof URIError) {
        sendError(res, new HttpError(400, 'validation', 'malformed URL'));
      } else {
        console.error(err);
        sendError(res, new HttpError(500, 'internal', 'internal server error'));
      }
    });
  });
}
