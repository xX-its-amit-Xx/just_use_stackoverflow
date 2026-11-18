import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, toc, slugify, esc } from './markdown.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

class HttpError extends Error {
  constructor(status, error, message, extra) { super(message); this.status = status; this.error = error; this.extra = extra; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);

function normTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw bad('tags must be an array of strings');
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}
function validateContent(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
  if (typeof b.title !== 'string' || !b.title.trim()) throw bad('title is required');
  if (b.title.length > 200) throw bad('title too long');
  if (typeof b.body !== 'string') throw bad('body must be a string');
  return { title: b.title, body: b.body, tags: normTags(b.tags) };
}
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ op: ' ', text: a[i] }); i++; j++; } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ op: '-', text: a[i++] }); } else ops.push({ op: '+', text: b[j++] });
  }
  const out = []; let k = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') { out.push(ops[k++]); continue; }
    const run = [];
    while (k < ops.length && ops[k].op !== ' ') run.push(ops[k++]);
    out.push(...run.filter((o) => o.op === '-'), ...run.filter((o) => o.op === '+'));
  }
  return out;
}
const splitLines = (s) => (s === '' ? [] : s.split('\n'));

export function createServer({ dataDir }) {
  const pagesDir = path.join(dataDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const store = new Map(); // slug -> {slug,title,body,tags,version,createdAt,updatedAt,history:[]}
  for (const f of fs.readdirSync(pagesDir)) {
    if (!f.endsWith('.json')) continue;
    try { const p = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')); store.set(p.slug, p); } catch { /* skip */ }
  }
  const persist = (p) => {
    const file = path.join(pagesDir, p.slug + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(p));
    fs.renameSync(file + '.tmp', file);
  };
  let lastTs = 0;
  const now = () => { let t = Date.now(); if (t <= lastTs) t = lastTs + 1; lastTs = t; return new Date(t).toISOString(); };
  const publicPage = (p) => ({ slug: p.slug, title: p.title, body: p.body, tags: p.tags, version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt });
  const wl = { exists: (s) => store.has(s) };
  const linksOf = (body) => {
    const set = new Set();
    render(body, { wikiLinks: { exists: (s) => { set.add(s); return true; } } });
    return [...set].sort();
  };

  function savePage(slug, c, baseVersion) {
    const p = store.get(slug);
    if (baseVersion !== undefined && baseVersion !== null) {
      if (!Number.isInteger(baseVersion)) throw bad('baseVersion must be an integer');
      const cur = p ? p.version : 0;
      if (baseVersion !== cur) throw new HttpError(409, 'conflict', 'version conflict', { currentVersion: cur });
    }
    const ts = now();
    if (!p) {
      const np = { slug, ...c, version: 1, createdAt: ts, updatedAt: ts, history: [{ version: 1, title: c.title, body: c.body, tags: c.tags, updatedAt: ts }] };
      store.set(slug, np); persist(np);
      return { status: 201, page: np };
    }
    if (p.title === c.title && p.body === c.body && JSON.stringify(p.tags) === JSON.stringify(c.tags)) return { status: 200, page: p };
    p.title = c.title; p.body = c.body; p.tags = c.tags; p.version++; p.updatedAt = ts;
    p.history.push({ version: p.version, title: c.title, body: c.body, tags: c.tags, updatedAt: ts });
    persist(p);
    return { status: 200, page: p };
  }
  const getPage = (slug) => { const p = store.get(slug); if (!p) throw notFound('page not found'); return p; };
  const getVersion = (p, n) => {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1) throw bad('invalid version');
    const h = p.history.find((x) => x.version === v);
    if (!h) throw notFound('version not found');
    return h;
  };
  const rendered = (p) => ({ html: render(p.body, { headingIds: true, wikiLinks: wl }), toc: toc(p.body) });

  function snippet(body, q) {
    const idx = body.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return esc(body.slice(0, 40));
    const s = Math.max(0, idx - 40), e = Math.min(body.length, idx + q.length + 40);
    return esc(body.slice(s, idx)) + '<mark>' + esc(body.slice(idx, idx + q.length)) + '</mark>' + esc(body.slice(idx + q.length, e));
  }
  const countOcc = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };

  function route(method, url, readBody) {
    const u = new URL(url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const q = u.searchParams;
    if (parts[0] === 'api') {
      if (parts[1] === 'pages' && parts.length === 2 && method === 'GET') {
        const tag = q.get('tag'); const sort = q.get('sort') || 'title';
        if (sort !== 'title' && sort !== 'updated') throw bad('invalid sort');
        let list = [...store.values()];
        if (tag) list = list.filter((p) => p.tags.includes(tag.toLowerCase()));
        if (sort === 'title') list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || (a.slug < b.slug ? -1 : 1));
        else list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : 1));
        return { json: list.map((p) => ({ slug: p.slug, title: p.title, tags: p.tags, version: p.version, updatedAt: p.updatedAt })) };
      }
      if (parts[1] === 'pages' && parts.length >= 3) {
        const slug = parts[2];
        if (parts.length === 3) {
          if (method === 'PUT') {
            if (!SLUG_RE.test(slug)) throw bad('invalid slug');
            const b = readBody();
            const c = validateContent(b);
            const r = savePage(slug, c, b.baseVersion);
            return { status: r.status, json: publicPage(r.page) };
          }
          if (method === 'GET') {
            const p = getPage(slug);
            const links = linksOf(p.body);
            const backlinks = [...store.values()].filter((o) => linksOf(o.body).includes(slug)).map((o) => o.slug).sort();
            return { json: { ...publicPage(p), ...rendered(p), backlinks, links } };
          }
          if (method === 'DELETE') {
            getPage(slug); store.delete(slug);
            try { fs.unlinkSync(path.join(pagesDir, slug + '.json')); } catch { /* ignore */ }
            return { status: 204 };
          }
        } else if (parts.length === 4 && parts[3] === 'history' && method === 'GET') {
          const p = getPage(slug);
          return { json: [...p.history].reverse().map((h) => ({ version: h.version, title: h.title, updatedAt: h.updatedAt })) };
        } else if (parts.length === 5 && parts[3] === 'versions' && method === 'GET') {
          const h = getVersion(getPage(slug), parts[4]);
          return { json: { version: h.version, title: h.title, body: h.body, tags: h.tags } };
        } else if (parts.length === 4 && parts[3] === 'revert' && method === 'POST') {
          const p = getPage(slug);
          const b = readBody();
          if (!b || typeof b !== 'object') throw bad('body must be an object');
          const h = getVersion(p, b.version);
          const ts = now();
          p.title = h.title; p.body = h.body; p.tags = [...h.tags]; p.version++; p.updatedAt = ts;
          p.history.push({ version: p.version, title: p.title, body: p.body, tags: p.tags, updatedAt: ts });
          persist(p);
          return { json: publicPage(p) };
        } else if (parts.length === 4 && parts[3] === 'diff' && method === 'GET') {
          const p = getPage(slug);
          const from = getVersion(p, q.get('from')), to = getVersion(p, q.get('to'));
          return { json: { from: from.version, to: to.version, lines: lcsDiff(splitLines(from.body), splitLines(to.body)) } };
        }
      }
      if (parts[1] === 'search' && parts.length === 2 && method === 'GET') {
        const raw = (q.get('q') || '').trim();
        if (!raw) throw bad('q is required');
        const ql = raw.toLowerCase();
        const res = [];
        for (const p of store.values()) {
          const t = p.title.toLowerCase(), b = p.body.toLowerCase();
          const score = countOcc(t, ql) + countOcc(b, ql);
          if (score > 0) res.push({ slug: p.slug, title: p.title, snippet: snippet(p.body, raw), score, tm: t.includes(ql) });
        }
        res.sort((a, b) => (b.tm - a.tm) || (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
        return { json: res.map(({ tm, ...r }) => r) };
      }
      if (parts[1] === 'render' && parts.length === 2 && method === 'POST') {
        const b = readBody();
        if (!b || typeof b.markdown !== 'string') throw bad('markdown must be a string');
        return { json: { html: render(b.markdown, { headingIds: true, wikiLinks: wl }), toc: toc(b.markdown) } };
      }
      if (parts[1] === 'tags' && parts.length === 2 && method === 'GET') {
        const m = new Map();
        for (const p of store.values()) for (const t of p.tags) m.set(t, (m.get(t) || 0) + 1);
        return { json: [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)) };
      }
      if (parts[1] === 'export' && parts.length === 2 && method === 'GET') {
        return { json: { pages: [...store.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1)).map((p) => ({ slug: p.slug, title: p.title, body: p.body, tags: p.tags, version: p.version })) } };
      }
      if (parts[1] === 'import' && parts.length === 2 && method === 'POST') {
        const b = readBody();
        if (!b || !Array.isArray(b.pages)) throw bad('pages must be an array');
        const items = b.pages.map((x) => {
          if (!x || typeof x !== 'object' || typeof x.slug !== 'string' || !SLUG_RE.test(x.slug)) throw bad('invalid slug in import');
          return { slug: x.slug, c: validateContent(x) };
        });
        for (const it of items) savePage(it.slug, it.c);
        return { json: { imported: items.length } };
      }
      throw notFound('route not found');
    }
    if (method === 'GET' && parts[0] === 'wiki' && parts.length === 2) {
      const p = store.get(parts[1]);
      if (!p) return { status: 404, html: `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>` };
      const { html } = rendered(p);
      return { html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title></head><body><article>\n${html}</article></body></html>` };
    }
    if (method === 'GET' && parts.length === 0) return { file: path.join(UI_DIR, 'index.html'), type: 'text/html; charset=utf-8' };
    if (method === 'GET' && parts[0] === 'static' && parts.length === 2 && /^[\w.-]+$/.test(parts[1]) && !parts[1].startsWith('.')) {
      const type = parts[1].endsWith('.js') ? 'text/javascript; charset=utf-8' : parts[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      return { file: path.join(UI_DIR, parts[1]), type };
    }
    throw notFound('route not found');
  }

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
      try {
        const readBody = () => {
          const t = Buffer.concat(chunks).toString('utf8');
          try { return JSON.parse(t); } catch { throw new HttpError(400, 'bad_json', 'invalid JSON body'); }
        };
        const r = route(req.method, req.url, readBody);
        if (r.file) {
          let data;
          try { data = fs.readFileSync(r.file); } catch { throw notFound(); }
          return send(200, r.type, data);
        }
        if (r.html !== undefined) return send(r.status || 200, 'text/html; charset=utf-8', r.html);
        if (r.status === 204) { res.writeHead(204); return res.end(); }
        return send(r.status || 200, 'application/json; charset=utf-8', JSON.stringify(r.json));
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, 'application/json; charset=utf-8', JSON.stringify({ error: e.error, message: e.message, ...(e.extra || {}) }));
        return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: 'internal', message: String(e && e.message) }));
      }
    });
  });
}
