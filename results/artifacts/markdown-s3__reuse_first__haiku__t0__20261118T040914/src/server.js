// HTTP server for markdown-s3. Standard library only.
// Storage: one JSON file per page under <dataDir>/pages/<slug>.json holding the full version history.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, wikiLinkTargets } from './markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw bad('slug must match ^[a-z0-9][a-z0-9_-]*$');
  }
  return slug;
}

function normTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    throw bad('tags must be an array of strings');
  }
  const set = new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0));
  return [...set].sort();
}

function sameTags(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function parseVersionNumber(s) {
  if (!/^\d+$/.test(s)) throw bad('version must be a positive integer');
  return Number(s);
}

function parsePageInput(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('request body must be a JSON object');
  if (typeof b.title !== 'string' || b.title.trim().length === 0 || b.title.trim().length > 200) {
    throw bad('title must be a non-empty string of at most 200 characters');
  }
  if (b.body !== undefined && typeof b.body !== 'string') throw bad('body must be a string');
  return {
    title: b.title.trim(),
    body: b.body ?? '',
    tags: normTags(b.tags),
  };
}

function parseBaseVersion(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 0) throw bad('baseVersion must be a non-negative integer');
  return v;
}

function splitLines(s) {
  return s === '' ? [] : s.split('\n');
}

// Minimal LCS-based line diff. Within each changed run, '-' lines precede '+' lines.
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const out = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (const t of dels) out.push({ op: '-', text: t });
    for (const t of adds) out.push({ op: '+', text: t });
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      dels.push(a[i++]);
    } else {
      adds.push(b[j++]);
    }
  }
  while (i < n) dels.push(a[i++]);
  while (j < m) adds.push(b[j++]);
  flush();
  return out;
}

function countOccurrences(hay, needle) {
  let count = 0;
  let pos = hay.indexOf(needle);
  while (pos >= 0) {
    count++;
    pos = hay.indexOf(needle, pos + needle.length);
  }
  return count;
}

// ---------- storage ----------

function createStore(dataDir) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const fileFor = (slug) => path.join(pagesDir, `${slug}.json`);

  const load = (slug) => {
    if (!SLUG_RE.test(slug)) return null;
    try {
      return JSON.parse(fs.readFileSync(fileFor(slug), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const save = (rec) => {
    const f = fileFor(rec.slug);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, f);
  };
  const remove = (slug) => fs.unlinkSync(fileFor(slug));
  const all = () =>
    fs
      .readdirSync(pagesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => load(f.slice(0, -'.json'.length)))
      .filter(Boolean);
  const exists = (slug) => SLUG_RE.test(slug) && fs.existsSync(fileFor(slug));
  return { load, save, remove, all, exists };
}

const current = (rec) => rec.versions[rec.versions.length - 1];

function pageView(rec) {
  const v = current(rec);
  return {
    slug: rec.slug,
    title: v.title,
    body: v.body,
    tags: v.tags,
    version: v.version,
    createdAt: rec.createdAt,
    updatedAt: v.updatedAt,
  };
}

// ---------- server ----------

export function createServer({ dataDir }) {
  const store = createStore(dataDir);

  // Create or update a page. Returns { status, page }.
  function writePage(slug, input, baseVersion) {
    const rec = store.load(slug);
    const curVersion = rec ? current(rec).version : 0;
    if (baseVersion !== undefined && baseVersion !== curVersion) {
      throw new HttpError(409, 'conflict', 'page was modified; reload and retry', { currentVersion: curVersion });
    }
    const now = new Date().toISOString();
    if (!rec) {
      const created = {
        slug,
        createdAt: now,
        versions: [{ version: 1, title: input.title, body: input.body, tags: input.tags, updatedAt: now }],
      };
      store.save(created);
      return { status: 201, page: pageView(created) };
    }
    const cur = current(rec);
    if (cur.title === input.title && cur.body === input.body && sameTags(cur.tags, input.tags)) {
      return { status: 200, page: pageView(rec) };
    }
    rec.versions.push({
      version: cur.version + 1,
      title: input.title,
      body: input.body,
      tags: input.tags,
      updatedAt: now,
    });
    store.save(rec);
    return { status: 200, page: pageView(rec) };
  }

  function requirePage(slug) {
    checkSlug(slug);
    const rec = store.load(slug);
    if (!rec) throw notFound(`page '${slug}' not found`);
    return rec;
  }

  function renderBody(body) {
    return render(body, { headingIds: true, wikiLinks: { exists: (s) => store.exists(s) } });
  }

  function backlinksFor(slug) {
    return store
      .all()
      .filter((rec) => wikiLinkTargets(current(rec).body).includes(slug))
      .map((rec) => rec.slug)
      .sort();
  }

  function pageDetail(rec) {
    const v = pageView(rec);
    return {
      ...v,
      html: renderBody(v.body),
      toc: toc(v.body),
      backlinks: backlinksFor(rec.slug),
      links: wikiLinkTargets(v.body),
    };
  }

  function search(q) {
    const term = (q ?? '').trim();
    if (!term) throw bad('q must contain at least one character');
    const t = term.toLowerCase();
    const hits = [];
    for (const rec of store.all()) {
      const v = current(rec);
      const tl = v.title.toLowerCase();
      const bl = v.body.toLowerCase();
      const titleHit = tl.includes(t);
      const bodyIdx = bl.indexOf(t);
      if (!titleHit && bodyIdx < 0) continue;
      const score = countOccurrences(tl, t) + countOccurrences(bl, t);
      let snippet;
      if (bodyIdx >= 0) {
        const start = Math.max(0, bodyIdx - 40);
        const end = Math.min(v.body.length, bodyIdx + t.length + 40);
        snippet =
          escapeHtml(v.body.slice(start, bodyIdx)) +
          '<mark>' +
          escapeHtml(v.body.slice(bodyIdx, bodyIdx + t.length)) +
          '</mark>' +
          escapeHtml(v.body.slice(bodyIdx + t.length, end));
      } else {
        snippet = escapeHtml(v.body.slice(0, 40));
      }
      hits.push({ slug: rec.slug, title: v.title, snippet, score, titleHit });
    }
    hits.sort((a, b) => {
      if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return hits.map(({ titleHit, ...h }) => h);
  }

  function wikiHtmlDocument(title, html, status = 200) {
    return {
      status,
      html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="standalone">
<article class="wiki-page">
<h1 class="page-title">${escapeHtml(title)}</h1>
${html}
</article>
<p><a href="/">Back to wiki</a></p>
</body>
</html>
`,
    };
  }

  // ---------- route handlers: each returns { status, json } or { status, html } or { status, file } ----------
  const handlers = {
    listPages({ query }) {
      const tag = (query.get('tag') ?? '').trim().toLowerCase();
      const sort = query.get('sort') ?? 'title';
      if (sort !== 'title' && sort !== 'updated') throw bad('sort must be title or updated');
      let recs = store.all();
      if (tag) recs = recs.filter((r) => current(r).tags.includes(tag));
      const items = recs.map((r) => {
        const v = current(r);
        return { slug: r.slug, title: v.title, tags: v.tags, version: v.version, updatedAt: v.updatedAt };
      });
      if (sort === 'title') {
        items.sort((a, b) => {
          const x = a.title.toLowerCase();
          const y = b.title.toLowerCase();
          if (x !== y) return x < y ? -1 : 1;
          return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });
      } else {
        items.sort((a, b) => {
          if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
          return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });
      }
      return { status: 200, json: items };
    },

    getPage({ params }) {
      return { status: 200, json: pageDetail(requirePage(params[0])) };
    },

    async putPage({ params, readJson }) {
      const slug = checkSlug(params[0]);
      const b = await readJson();
      const input = parsePageInput(b);
      const baseVersion = parseBaseVersion(b.baseVersion);
      const { status, page } = writePage(slug, input, baseVersion);
      return { status, json: page };
    },

    deletePage({ params }) {
      const slug = checkSlug(params[0]);
      if (!store.load(slug)) throw notFound(`page '${slug}' not found`);
      store.remove(slug);
      return { status: 204 };
    },

    history({ params }) {
      const rec = requirePage(params[0]);
      const items = rec.versions
        .map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt }))
        .reverse();
      return { status: 200, json: items };
    },

    getVersion({ params }) {
      const rec = requirePage(params[0]);
      const n = parseVersionNumber(params[1]);
      const v = rec.versions[n - 1];
      if (!v) throw notFound(`version ${n} not found`);
      return { status: 200, json: { version: v.version, title: v.title, body: v.body, tags: v.tags } };
    },

    async revert({ params, readJson }) {
      const rec = requirePage(params[0]);
      const b = await readJson();
      if (!b || !Number.isInteger(b.version) || b.version < 1) throw bad('version must be a positive integer');
      const target = rec.versions[b.version - 1];
      if (!target) throw notFound(`version ${b.version} not found`);
      const cur = current(rec);
      const now = new Date().toISOString();
      rec.versions.push({
        version: cur.version + 1,
        title: target.title,
        body: target.body,
        tags: target.tags,
        updatedAt: now,
      });
      store.save(rec);
      return { status: 200, json: pageView(rec) };
    },

    diff({ params, query }) {
      const rec = requirePage(params[0]);
      const fromN = parseVersionNumber(query.get('from') ?? '');
      const toN = parseVersionNumber(query.get('to') ?? '');
      const from = rec.versions[fromN - 1];
      const to = rec.versions[toN - 1];
      if (!from) throw notFound(`version ${fromN} not found`);
      if (!to) throw notFound(`version ${toN} not found`);
      return {
        status: 200,
        json: { from: fromN, to: toN, lines: diffLines(splitLines(from.body), splitLines(to.body)) },
      };
    },

    search({ query }) {
      return { status: 200, json: search(query.get('q')) };
    },

    async renderApi({ readJson }) {
      const b = await readJson();
      if (!b || typeof b.markdown !== 'string') throw bad('markdown must be a string');
      return { status: 200, json: { html: renderBody(b.markdown), toc: toc(b.markdown) } };
    },

    tags() {
      const counts = new Map();
      for (const rec of store.all()) {
        for (const t of current(rec).tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const items = [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) }));
      return { status: 200, json: items };
    },

    exportAll() {
      const pages = store
        .all()
        .map((rec) => {
          const v = current(rec);
          return { slug: rec.slug, title: v.title, body: v.body, tags: v.tags, version: v.version };
        })
        .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return { status: 200, json: { pages } };
    },

    async importAll({ readJson }) {
      const b = await readJson();
      if (!b || !Array.isArray(b.pages)) throw bad('pages must be an array');
      // validate everything before writing anything
      const parsed = b.pages.map((p) => {
        if (!p || typeof p !== 'object') throw bad('each page must be an object');
        return { slug: checkSlug(p.slug), input: parsePageInput(p) };
      });
      for (const { slug, input } of parsed) writePage(slug, input, undefined);
      return { status: 200, json: { imported: parsed.length } };
    },

    getWikiPage({ params }) {
      const slug = params[0];
      const rec = SLUG_RE.test(slug) ? store.load(slug) : null;
      if (!rec) {
        return wikiHtmlDocument('Not found', '<p>No page with this slug.</p>', 404);
      }
      const d = pageDetail(rec);
      return wikiHtmlDocument(d.title, d.html);
    },

    index() {
      return { status: 200, file: path.join(PUBLIC_DIR, 'index.html') };
    },

    staticFile({ params }) {
      const base = path.join(PUBLIC_DIR, 'static');
      const file = path.resolve(base, params[0]);
      if (!file.startsWith(base + path.sep)) throw notFound();
      return { status: 200, file };
    },
  };

  const routes = [
    ['GET', /^\/api\/pages$/, 'listPages'],
    ['GET', /^\/api\/pages\/([^/]+)$/, 'getPage'],
    ['PUT', /^\/api\/pages\/([^/]+)$/, 'putPage'],
    ['DELETE', /^\/api\/pages\/([^/]+)$/, 'deletePage'],
    ['GET', /^\/api\/pages\/([^/]+)\/history$/, 'history'],
    ['GET', /^\/api\/pages\/([^/]+)\/versions\/([^/]+)$/, 'getVersion'],
    ['POST', /^\/api\/pages\/([^/]+)\/revert$/, 'revert'],
    ['GET', /^\/api\/pages\/([^/]+)\/diff$/, 'diff'],
    ['GET', /^\/api\/search$/, 'search'],
    ['POST', /^\/api\/render$/, 'renderApi'],
    ['GET', /^\/api\/tags$/, 'tags'],
    ['GET', /^\/api\/export$/, 'exportAll'],
    ['POST', /^\/api\/import$/, 'importAll'],
    ['GET', /^\/wiki\/([^/]+)$/, 'getWikiPage'],
    ['GET', /^\/static\/(.+)$/, 'staticFile'],
    ['GET', /^\/$/, 'index'],
  ];

  function sendJson(res, status, obj) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendError(res, err) {
    const status = err.status ?? 500;
    const payload = err.status
      ? { error: err.code, message: err.message, ...err.extra }
      : { error: 'internal', message: 'internal server error' };
    if (!err.status) console.error(err);
    sendJson(res, status, payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'too_large', 'request body too large'));
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) {
      return sendError(res, notFound(`no route for ${req.method} ${url.pathname}`));
    }
    const [, re, name] = route;
    const rawParams = url.pathname.match(re).slice(1);
    let params;
    try {
      params = rawParams.map((p) => decodeURIComponent(p));
    } catch {
      return sendError(res, bad('malformed URL encoding'));
    }
    let cachedBody;
    const readJson = async () => {
      if (cachedBody === undefined) {
        const text = await readBody(req);
        try {
          cachedBody = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
        }
      }
      return cachedBody;
    };
    try {
      const result = await handlers[name]({ params, query: url.searchParams, readJson });
      if (result.file) {
        const data = fs.readFileSync(result.file);
        res.writeHead(result.status, {
          'content-type': MIME[path.extname(result.file)] ?? 'application/octet-stream',
          'content-length': data.length,
        });
        return res.end(data);
      }
      if (result.html !== undefined) {
        res.writeHead(result.status, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(result.html),
        });
        return res.end(result.html);
      }
      if (result.status === 204) {
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, result.status, result.json);
    } catch (err) {
      if (err.code === 'ENOENT' && name === 'staticFile') return sendError(res, notFound());
      return sendError(res, err);
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });
}
