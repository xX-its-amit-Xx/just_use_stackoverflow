// HTTP server for the markdown wiki. Pure node:http, no runtime dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, wikiLinkTargets, slugify } from './markdown.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC_DIR, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const validation = (message) => new ApiError(400, 'validation_error', message);
const notFound = (message) => new ApiError(404, 'not_found', message);

// ---------- storage ----------

function openStore(dataDir) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const pages = new Map();
  for (const file of fs.readdirSync(pagesDir)) {
    if (!file.endsWith('.json')) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8'));
    pages.set(rec.slug, rec);
  }
  // Write-through: each page is one JSON file, replaced atomically.
  const persist = (rec) => {
    const file = path.join(pagesDir, `${rec.slug}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  };
  const remove = (slug) => fs.rmSync(path.join(pagesDir, `${slug}.json`), { force: true });
  return { pages, persist, remove };
}

// ---------- validation helpers ----------

function checkSlug(raw) {
  let slug;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    throw validation('Invalid slug encoding');
  }
  if (!SLUG_RE.test(slug)) throw validation('Slug must match ^[a-z0-9][a-z0-9_-]*$');
  return slug;
}

function checkTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw validation('Title must be a non-empty string');
  if ([...title].length > 200) throw validation('Title must be at most 200 characters');
  return title;
}

function checkBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw validation('Body must be a string');
  return body;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw validation('Tags must be an array of strings');
  }
  const set = new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ''));
  return [...set].sort();
}

function checkInt(value, name) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0) throw validation(`${name} must be a non-negative integer`);
  return n;
}

function checkObject(value) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validation('Request body must be a JSON object');
  }
  return value;
}

// Validated page content from a request body.
function pageContent(input) {
  return {
    title: checkTitle(input.title),
    body: checkBody(input.body),
    tags: normalizeTags(input.tags),
  };
}

const sameContent = (a, b) =>
  a.title === b.title && a.body === b.body && a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);

// ---------- views ----------

const pageView = (rec) => ({
  slug: rec.slug,
  title: rec.title,
  body: rec.body,
  tags: rec.tags,
  version: rec.version,
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt,
});

const summaryView = (rec) => ({
  slug: rec.slug,
  title: rec.title,
  tags: rec.tags,
  version: rec.version,
  updatedAt: rec.updatedAt,
});

// ---------- diff ----------

function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

// Line diff via LCS. Within each changed run, '-' lines precede '+' lines.
function lineDiff(fromText, toText) {
  const a = splitLines(fromText);
  const b = splitLines(toText);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push({ op: '-', text: a[i] });
      i++;
    } else {
      ops.push({ op: '+', text: b[j] });
      j++;
    }
  }
  // Reorder each changed run so that all '-' come before all '+'.
  const lines = [];
  let run = [];
  const flush = () => {
    run.filter((l) => l.op === '-').forEach((l) => lines.push(l));
    run.filter((l) => l.op === '+').forEach((l) => lines.push(l));
    run = [];
  };
  for (const entry of ops) {
    if (entry.op === ' ') {
      flush();
      lines.push(entry);
    } else {
      run.push(entry);
    }
  }
  flush();
  return lines;
}

// ---------- search ----------

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}

function buildSnippet(body, needle, bodyIndex) {
  const window = 40;
  if (bodyIndex < 0) return escapeHtml(body.slice(0, window));
  const start = Math.max(0, bodyIndex - window);
  const end = Math.min(body.length, bodyIndex + needle.length + window);
  const matched = body.slice(bodyIndex, bodyIndex + needle.length);
  return (
    escapeHtml(body.slice(start, bodyIndex)) +
    `<mark>${escapeHtml(matched)}</mark>` +
    escapeHtml(body.slice(bodyIndex + needle.length, end))
  );
}

// ---------- request handling ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new ApiError(400, 'payload_too_large', 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, 'invalid_json', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not_found', message: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  });
}

export function createServer({ dataDir }) {
  const store = openStore(dataDir);
  const { pages, persist, remove } = store;

  const wikiOptions = () => ({ exists: (slug) => pages.has(slug) });

  const renderBody = (body) => ({
    html: render(body, { headingIds: true, wikiLinks: wikiOptions() }),
    toc: toc(body, { wikiLinks: wikiOptions() }),
  });

  const getPageOr404 = (slug) => {
    const rec = pages.get(slug);
    if (!rec) throw notFound(`Page '${slug}' does not exist`);
    return rec;
  };

  const backlinksOf = (slug) =>
    [...pages.values()]
      .filter((other) => wikiLinkTargets(other.body).includes(slug))
      .map((other) => other.slug)
      .sort();

  // Writes new content as the next version. Callers decide whether a change happened.
  const commit = (rec, content, now) => {
    rec.title = content.title;
    rec.body = content.body;
    rec.tags = content.tags;
    rec.version += 1;
    rec.updatedAt = now;
    rec.history.push({ version: rec.version, title: rec.title, body: rec.body, tags: rec.tags, updatedAt: now });
    persist(rec);
    return rec;
  };

  // Creates or updates a page. Returns { created, rec }; unchanged content does not bump the version.
  const upsert = (slug, content, baseVersion, now) => {
    const existing = pages.get(slug);
    const currentVersion = existing ? existing.version : 0;
    if (baseVersion !== undefined && baseVersion !== currentVersion) {
      throw new ApiError(409, 'conflict', `Version conflict: current version is ${currentVersion}`, {
        currentVersion,
      });
    }
    if (!existing) {
      const rec = {
        slug,
        title: content.title,
        body: content.body,
        tags: content.tags,
        version: 0,
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      pages.set(slug, rec);
      return { created: true, rec: commit(rec, content, now) };
    }
    if (sameContent(existing, content)) return { created: false, rec: existing };
    return { created: false, rec: commit(existing, content, now) };
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter((p) => p !== '');
    const method = req.method;

    // UI and static assets
    if (method === 'GET' && parts.length === 0) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (method === 'GET' && parts[0] === 'static' && parts.length === 2) {
      const name = path.basename(decodeURIComponent(parts[1]));
      return sendFile(res, path.join(PUBLIC_DIR, name));
    }
    if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const slug = parts[1];
      const rec = SLUG_RE.test(slug) ? pages.get(slug) : undefined;
      if (!rec) {
        return sendHtml(
          res,
          404,
          '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head>' +
            '<body><h1>Page not found</h1></body></html>',
        );
      }
      const { html } = renderBody(rec.body);
      return sendHtml(
        res,
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(rec.title)}</title></head>` +
          `<body><h1>${escapeHtml(rec.title)}</h1>\n${html}</body></html>`,
      );
    }

    if (parts[0] !== 'api') throw notFound('No such route');

    // /api/pages
    if (parts.length === 2 && parts[1] === 'pages') {
      if (method !== 'GET') throw notFound('No such route');
      const sort = url.searchParams.get('sort') ?? 'title';
      if (sort !== 'title' && sort !== 'updated') throw validation("sort must be 'title' or 'updated'");
      const tag = (url.searchParams.get('tag') ?? '').trim().toLowerCase();
      let list = [...pages.values()].filter((rec) => tag === '' || rec.tags.includes(tag));
      if (sort === 'updated') {
        list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      } else {
        const key = (r) => r.title.toLowerCase();
        list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      }
      return sendJson(res, 200, list.map(summaryView));
    }

    // /api/pages/:slug[/...]
    if (parts[1] === 'pages' && parts.length >= 3) {
      const slug = checkSlug(parts[2]);
      const sub = parts.slice(3);

      if (sub.length === 0) {
        if (method === 'GET') {
          const rec = getPageOr404(slug);
          const { html, toc: headings } = renderBody(rec.body);
          return sendJson(res, 200, {
            ...pageView(rec),
            html,
            toc: headings,
            backlinks: backlinksOf(slug),
            links: wikiLinkTargets(rec.body),
          });
        }
        if (method === 'PUT') {
          const input = checkObject(await readBody(req));
          const content = pageContent(input);
          let baseVersion = input.baseVersion;
          if (baseVersion === null) baseVersion = undefined;
          if (baseVersion !== undefined) baseVersion = checkInt(baseVersion, 'baseVersion');
          const { created, rec } = upsert(slug, content, baseVersion, new Date().toISOString());
          return sendJson(res, created ? 201 : 200, pageView(rec));
        }
        if (method === 'DELETE') {
          getPageOr404(slug);
          pages.delete(slug);
          remove(slug);
          res.writeHead(204);
          return res.end();
        }
        throw notFound('No such route');
      }

      if (sub.length === 1 && sub[0] === 'history' && method === 'GET') {
        const rec = getPageOr404(slug);
        const history = rec.history
          .map((h) => ({ version: h.version, title: h.title, updatedAt: h.updatedAt }))
          .reverse();
        return sendJson(res, 200, history);
      }

      if (sub.length === 2 && sub[0] === 'versions' && method === 'GET') {
        const rec = getPageOr404(slug);
        const n = checkInt(sub[1], 'version');
        const entry = rec.history.find((h) => h.version === n);
        if (!entry) throw notFound(`Version ${n} does not exist`);
        return sendJson(res, 200, { version: entry.version, title: entry.title, body: entry.body, tags: entry.tags });
      }

      if (sub.length === 1 && sub[0] === 'revert' && method === 'POST') {
        const rec = getPageOr404(slug);
        const input = checkObject(await readBody(req));
        const n = checkInt(input.version, 'version');
        const entry = rec.history.find((h) => h.version === n);
        if (!entry) throw notFound(`Version ${n} does not exist`);
        commit(rec, { title: entry.title, body: entry.body, tags: entry.tags }, new Date().toISOString());
        return sendJson(res, 200, pageView(rec));
      }

      if (sub.length === 1 && sub[0] === 'diff' && method === 'GET') {
        const rec = getPageOr404(slug);
        const from = checkInt(url.searchParams.get('from'), 'from');
        const to = checkInt(url.searchParams.get('to'), 'to');
        const fromEntry = rec.history.find((h) => h.version === from);
        const toEntry = rec.history.find((h) => h.version === to);
        if (!fromEntry || !toEntry) throw notFound('Unknown version in diff');
        return sendJson(res, 200, { from, to, lines: lineDiff(fromEntry.body, toEntry.body) });
      }
      throw notFound('No such route');
    }

    if (parts.length === 2 && parts[1] === 'search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q === '') throw validation('Query parameter q must not be empty');
      const needle = q.toLowerCase();
      const results = [];
      for (const rec of pages.values()) {
        const titleLower = rec.title.toLowerCase();
        const bodyLower = rec.body.toLowerCase();
        const titleMatch = titleLower.includes(needle);
        const bodyIndex = bodyLower.indexOf(needle);
        if (!titleMatch && bodyIndex < 0) continue;
        results.push({
          slug: rec.slug,
          title: rec.title,
          snippet: buildSnippet(rec.body, needle, bodyIndex),
          score: countOccurrences(titleLower, needle) + countOccurrences(bodyLower, needle),
          titleMatch,
        });
      }
      results.sort((a, b) => {
        if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
        if (a.score !== b.score) return b.score - a.score;
        return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
      });
      return sendJson(
        res,
        200,
        results.map(({ slug, title, snippet, score }) => ({ slug, title, snippet, score })),
      );
    }

    if (parts.length === 2 && parts[1] === 'render' && method === 'POST') {
      const input = checkObject(await readBody(req));
      if (typeof input.markdown !== 'string') throw validation('markdown must be a string');
      return sendJson(res, 200, renderBody(input.markdown));
    }

    if (parts.length === 2 && parts[1] === 'tags' && method === 'GET') {
      const counts = new Map();
      for (const rec of pages.values()) {
        for (const tag of rec.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const list = [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) }));
      return sendJson(res, 200, list);
    }

    if (parts.length === 2 && parts[1] === 'export' && method === 'GET') {
      const list = [...pages.values()]
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .map((rec) => ({ slug: rec.slug, title: rec.title, body: rec.body, tags: rec.tags, version: rec.version }));
      return sendJson(res, 200, { pages: list });
    }

    if (parts.length === 2 && parts[1] === 'import' && method === 'POST') {
      const input = checkObject(await readBody(req));
      if (!Array.isArray(input.pages)) throw validation('pages must be an array');
      // Validate everything first so a bad entry changes nothing.
      const entries = input.pages.map((p) => {
        const obj = checkObject(p);
        if (typeof obj.slug !== 'string' || !SLUG_RE.test(obj.slug)) {
          throw validation('Slug must match ^[a-z0-9][a-z0-9_-]*$');
        }
        return { slug: obj.slug, content: pageContent(obj) };
      });
      const now = new Date().toISOString();
      for (const { slug, content } of entries) upsert(slug, content, undefined, now);
      return sendJson(res, 200, { imported: entries.length });
    }

    throw notFound('No such route');
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else {
        sendJson(res, 500, { error: 'internal', message: 'Internal server error' });
        console.error(err);
      }
    });
  });
}
