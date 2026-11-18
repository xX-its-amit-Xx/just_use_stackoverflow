import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, wikiLinkSlugs } from './markdown.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (message) => new HttpError(400, 'bad_request', message);
const notFound = (message) => new HttpError(404, 'not_found', message);

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function checkSlug(slug) {
  if (!SLUG_RE.test(slug)) throw bad(`invalid slug "${slug}"`);
  return slug;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ''))].sort();
}

function validatePage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('request body must be a JSON object');
  const { title, body, tags, baseVersion } = input;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    throw bad('title must be a non-empty string of at most 200 characters');
  }
  if (typeof body !== 'string') throw bad('body must be a string');
  if (baseVersion !== undefined && baseVersion !== null && !(Number.isInteger(baseVersion) && baseVersion >= 0)) {
    throw bad('baseVersion must be a non-negative integer');
  }
  return {
    title,
    body,
    tags: normalizeTags(tags),
    baseVersion: baseVersion === null ? undefined : baseVersion,
  };
}

function sameContent(rec, v) {
  return rec.title === v.title && rec.body === v.body && rec.tags.join('\u0000') === v.tags.join('\u0000');
}

function publicPage(rec) {
  return {
    slug: rec.slug,
    title: rec.title,
    body: rec.body,
    tags: rec.tags,
    version: rec.version,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw bad('invalid JSON body');
  }
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
  } else {
    console.error(err);
    sendJson(res, 500, { error: 'internal', message: 'internal server error' });
  }
}

// Myers-free LCS line diff. Within each changed run, "-" lines precede "+" lines.
function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: '-', text: a[i++] });
    } else {
      ops.push({ op: '+', text: b[j++] });
    }
  }
  while (i < n) ops.push({ op: '-', text: a[i++] });
  while (j < m) ops.push({ op: '+', text: b[j++] });

  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') {
      out.push(ops[k++]);
      continue;
    }
    const minus = [];
    const plus = [];
    while (k < ops.length && ops[k].op !== ' ') {
      (ops[k].op === '-' ? minus : plus).push(ops[k]);
      k++;
    }
    out.push(...minus, ...plus);
  }
  return out;
}

const splitLines = (body) => (body === '' ? [] : body.split('\n'));

function countOccurrences(hay, needle) {
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx >= 0) {
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });

  const pages = new Map();
  let lastTs = 0;
  for (const f of fs.readdirSync(pagesDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8'));
      pages.set(rec.slug, rec);
      lastTs = Math.max(lastTs, Date.parse(rec.updatedAt) || 0);
    } catch {
      // skip unreadable files
    }
  }

  // Strictly increasing timestamps so "updated" ordering is deterministic.
  const stamp = () => {
    lastTs = Math.max(Date.now(), lastTs + 1);
    return new Date(lastTs).toISOString();
  };

  const fileFor = (slug) => path.join(pagesDir, `${slug}.json`);

  function save(rec) {
    const target = fileFor(rec.slug);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, target);
  }

  const existsFn = (slug) => pages.has(slug);

  const linksCache = new Map();
  function linksOf(rec) {
    const key = `${rec.slug}@${rec.version}`;
    if (!linksCache.has(key)) linksCache.set(key, wikiLinkSlugs(rec.body));
    return linksCache.get(key);
  }

  function getPageOr404(slug) {
    checkSlug(slug);
    const rec = pages.get(slug);
    if (!rec) throw notFound(`page "${slug}" not found`);
    return rec;
  }

  function commitVersion(rec, content) {
    const ts = stamp();
    rec.title = content.title;
    rec.body = content.body;
    rec.tags = content.tags;
    rec.version += 1;
    rec.updatedAt = ts;
    rec.versions.push({ version: rec.version, title: rec.title, body: rec.body, tags: rec.tags, updatedAt: ts });
    save(rec);
    return rec;
  }

  function putPage(slug, v) {
    const cur = pages.get(slug);
    const currentVersion = cur ? cur.version : 0;
    if (v.baseVersion !== undefined && v.baseVersion !== currentVersion) {
      throw new HttpError(409, 'conflict', `version conflict: current version is ${currentVersion}`, {
        currentVersion,
      });
    }
    if (!cur) {
      const ts = stamp();
      const rec = {
        slug,
        title: v.title,
        body: v.body,
        tags: v.tags,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
        versions: [{ version: 1, title: v.title, body: v.body, tags: v.tags, updatedAt: ts }],
      };
      pages.set(slug, rec);
      save(rec);
      return { status: 201, rec };
    }
    if (sameContent(cur, v)) return { status: 200, rec: cur };
    return { status: 200, rec: commitVersion(cur, v) };
  }

  function pageView(rec) {
    return {
      ...publicPage(rec),
      html: render(rec.body, { headingIds: true, wikiLinks: { exists: existsFn } }),
      toc: toc(rec.body),
      backlinks: [...pages.values()]
        .filter((p) => linksOf(p).includes(rec.slug))
        .map((p) => p.slug)
        .sort(),
      links: linksOf(rec),
    };
  }

  function handleList(url) {
    const tag = (url.searchParams.get('tag') || '').trim().toLowerCase();
    const sort = url.searchParams.get('sort') || 'title';
    if (sort !== 'title' && sort !== 'updated') throw bad('sort must be "title" or "updated"');
    let list = [...pages.values()];
    if (tag) list = list.filter((r) => r.tags.includes(tag));
    if (sort === 'updated') {
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
    } else {
      list.sort((a, b) => {
        const ta = a.title.toLowerCase();
        const tb = b.title.toLowerCase();
        if (ta !== tb) return ta < tb ? -1 : 1;
        return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
      });
    }
    return list.map((r) => ({ slug: r.slug, title: r.title, tags: r.tags, version: r.version, updatedAt: r.updatedAt }));
  }

  function handleSearch(url) {
    const q = (url.searchParams.get('q') || '').trim();
    if (q === '') throw bad('q must contain at least one character');
    const ql = q.toLowerCase();
    const results = [];
    for (const rec of pages.values()) {
      const tl = rec.title.toLowerCase();
      const bl = rec.body.toLowerCase();
      const inTitle = tl.includes(ql);
      const score = countOccurrences(tl, ql) + countOccurrences(bl, ql);
      if (!inTitle && score === 0) continue;
      const idx = bl.indexOf(ql);
      let snippet;
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(rec.body.length, idx + ql.length + 40);
        snippet =
          esc(rec.body.slice(start, idx)) +
          '<mark>' +
          esc(rec.body.slice(idx, idx + ql.length)) +
          '</mark>' +
          esc(rec.body.slice(idx + ql.length, end));
      } else {
        snippet = esc(rec.body.slice(0, 40));
      }
      results.push({ slug: rec.slug, title: rec.title, snippet, score, inTitle });
    }
    results.sort((a, b) => {
      if (a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return results.map(({ slug, title, snippet, score }) => ({ slug, title, snippet, score }));
  }

  function handleTags() {
    const counts = new Map();
    for (const rec of pages.values()) {
      for (const t of rec.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([tag, count]) => ({ tag, count }));
  }

  function versionOf(rec, n) {
    const v = rec.versions.find((x) => x.version === n);
    if (!v) throw notFound(`version ${n} not found`);
    return v;
  }

  function parseVersionParam(value, name) {
    if (value === null || !/^\d+$/.test(value)) throw bad(`${name} must be a version number`);
    return Number(value);
  }

  async function handleApi(req, res, url) {
    const segs = url.pathname.slice('/api/'.length).split('/');
    while (segs.length && segs[segs.length - 1] === '') segs.pop();
    const method = req.method;
    const decode = (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw bad('malformed URL encoding');
      }
    };

    if (segs[0] === 'pages') {
      if (segs.length === 1) {
        if (method === 'GET') return sendJson(res, 200, handleList(url));
      } else if (segs.length === 2) {
        const slug = decode(segs[1]);
        checkSlug(slug);
        if (method === 'GET') return sendJson(res, 200, pageView(getPageOr404(slug)));
        if (method === 'PUT') {
          const v = validatePage(await readJson(req));
          const { status, rec } = putPage(slug, v);
          return sendJson(res, status, publicPage(rec));
        }
        if (method === 'DELETE') {
          if (!pages.has(slug)) throw notFound(`page "${slug}" not found`);
          pages.delete(slug);
          fs.rmSync(fileFor(slug), { force: true });
          res.writeHead(204);
          return res.end();
        }
      } else if (segs.length === 3 && segs[2] === 'history' && method === 'GET') {
        const rec = getPageOr404(decode(segs[1]));
        return sendJson(
          res,
          200,
          rec.versions
            .slice()
            .reverse()
            .map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt })),
        );
      } else if (segs.length === 4 && segs[2] === 'versions' && method === 'GET') {
        const rec = getPageOr404(decode(segs[1]));
        const v = versionOf(rec, parseVersionParam(segs[3], 'version'));
        return sendJson(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
      } else if (segs.length === 3 && segs[2] === 'revert' && method === 'POST') {
        const rec = getPageOr404(decode(segs[1]));
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || !Number.isInteger(input.version)) {
          throw bad('version must be an integer');
        }
        const v = versionOf(rec, input.version);
        commitVersion(rec, { title: v.title, body: v.body, tags: v.tags.slice() });
        return sendJson(res, 200, publicPage(rec));
      } else if (segs.length === 3 && segs[2] === 'diff' && method === 'GET') {
        const rec = getPageOr404(decode(segs[1]));
        const from = parseVersionParam(url.searchParams.get('from'), 'from');
        const to = parseVersionParam(url.searchParams.get('to'), 'to');
        const a = versionOf(rec, from);
        const b = versionOf(rec, to);
        return sendJson(res, 200, { from, to, lines: lineDiff(splitLines(a.body), splitLines(b.body)) });
      }
    } else if (segs.length === 1 && segs[0] === 'search' && method === 'GET') {
      return sendJson(res, 200, handleSearch(url));
    } else if (segs.length === 1 && segs[0] === 'render' && method === 'POST') {
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || typeof input.markdown !== 'string') {
        throw bad('markdown must be a string');
      }
      const opts = { headingIds: true, wikiLinks: { exists: existsFn } };
      return sendJson(res, 200, { html: render(input.markdown, opts), toc: toc(input.markdown) });
    } else if (segs.length === 1 && segs[0] === 'tags' && method === 'GET') {
      return sendJson(res, 200, handleTags());
    } else if (segs.length === 1 && segs[0] === 'export' && method === 'GET') {
      const list = [...pages.values()]
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .map((r) => ({ slug: r.slug, title: r.title, body: r.body, tags: r.tags, version: r.version }));
      return sendJson(res, 200, { pages: list });
    } else if (segs.length === 1 && segs[0] === 'import' && method === 'POST') {
      const input = await readJson(req);
      if (!input || typeof input !== 'object' || !Array.isArray(input.pages)) {
        throw bad('pages must be an array');
      }
      const items = input.pages.map((p) => {
        if (!p || typeof p !== 'object') throw bad('each page must be an object');
        const slug = checkSlug(p.slug);
        const v = validatePage({ title: p.title, body: p.body, tags: p.tags });
        return { slug, v };
      });
      for (const { slug, v } of items) putPage(slug, v);
      return sendJson(res, 200, { imported: items.length });
    }
    throw notFound('no such route');
  }

  function serveStatic(res, rel) {
    if (rel.includes('..') || rel.includes('\\') || rel.startsWith('/') || rel === '') {
      throw notFound('no such file');
    }
    const full = path.join(STATIC_DIR, rel);
    if (!full.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw notFound('no such file');
    }
    const data = fs.readFileSync(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'content-length': data.length,
    });
    res.end(data);
  }

  function wikiPage(res, rawSlug) {
    let slug;
    try {
      slug = decodeURIComponent(rawSlug);
    } catch {
      slug = '';
    }
    const rec = SLUG_RE.test(slug) ? pages.get(slug) : undefined;
    if (!rec) {
      return sendHtml(
        res,
        404,
        `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Not found</title></head>` +
          `<body><h1>Page not found</h1></body></html>\n`,
      );
    }
    const view = pageView(rec);
    const doc =
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${esc(rec.title)}</title>\n</head>\n<body>\n<article>\n` +
      `<h1>${esc(rec.title)}</h1>\n${view.html}</article>\n</body>\n</html>\n`;
    return sendHtml(res, 200, doc);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      return serveStatic(res, p.slice('/static/'.length));
    }
    if (req.method === 'GET' && p.startsWith('/wiki/')) {
      return wikiPage(res, p.slice('/wiki/'.length));
    }
    if (p === '/api' || p.startsWith('/api/')) {
      return handleApi(req, res, url);
    }
    throw notFound('no such route');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, err);
    });
  });
  return server;
}
