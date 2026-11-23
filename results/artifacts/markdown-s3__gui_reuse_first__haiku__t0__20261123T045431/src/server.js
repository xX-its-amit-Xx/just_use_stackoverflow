// HTTP server for markdown-s3: JSON API, wiki pages and the editor UI.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, wikiLinkTargets } from "./markdown.js";
import { diffLines } from "./diff.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message) => new HttpError(400, "bad_request", message);
const notFound = (message = "not found") => new HttpError(404, "not_found", message);

// ---------------------------------------------------------------- validation

function checkSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw badRequest("slug must match ^[a-z0-9][a-z0-9_-]*$");
  }
  return slug;
}

function checkTitle(title) {
  if (typeof title !== "string" || title.trim() === "" || title.length > 200) {
    throw badRequest("title must be a non-empty string of at most 200 characters");
  }
  return title;
}

function checkBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body !== "string") throw badRequest("body must be a string");
  return body;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.trim() === "")) {
    throw badRequest("tags must be an array of non-empty strings");
  }
  return [...new Set(tags.map((t) => t.trim().toLowerCase()))].sort();
}

function checkVersionNumber(v, name) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return v;
}

function parseIntParam(value, name) {
  if (value === null || !/^\d+$/.test(value)) throw badRequest(`${name} must be an integer`);
  return Number(value);
}

// ---------------------------------------------------------------- store

function createStore(dataDir) {
  const pagesDir = path.join(dataDir, "pages");
  fs.mkdirSync(pagesDir, { recursive: true });
  const fileOf = (slug) => path.join(pagesDir, `${slug}.json`);

  // A stored page: { slug, createdAt, versions: [{ version, title, body, tags, updatedAt }] }
  function load(slug) {
    const file = fileOf(slug);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function save(record) {
    const file = fileOf(record.slug);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  }

  function remove(slug) {
    const file = fileOf(slug);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  function allSlugs() {
    return fs
      .readdirSync(pagesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((s) => SLUG_RE.test(s));
  }

  return { load, save, remove, allSlugs, exists: (slug) => SLUG_RE.test(slug) && fs.existsSync(fileOf(slug)) };
}

const current = (record) => record.versions[record.versions.length - 1];

function pageView(record) {
  const cur = current(record);
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

const sameContent = (a, b) =>
  a.title === b.title && a.body === b.body && a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);

// Write a new version (or create the page) unless the content is unchanged.
// Returns { record, created, changed }.
function applyPut(store, slug, { title, body, tags }, now) {
  const existing = store.load(slug);
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
  const cur = current(existing);
  if (sameContent(cur, next)) return { record: existing, created: false, changed: false };
  existing.versions.push({ version: cur.version + 1, ...next, updatedAt: now });
  store.save(existing);
  return { record: existing, created: false, changed: true };
}

function parsePutInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("body must be a JSON object");
  return {
    title: checkTitle(input.title),
    body: checkBody(input.body),
    tags: normalizeTags(input.tags),
  };
}

// ---------------------------------------------------------------- search

const countOccurrences = (haystack, needle) => {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
};

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function search(store, q) {
  const lq = q.toLowerCase();
  const results = [];
  for (const slug of store.allSlugs()) {
    const record = store.load(slug);
    if (!record) continue;
    const { title, body } = current(record);
    const lt = title.toLowerCase();
    const lb = body.toLowerCase();
    const titleMatch = lt.includes(lq);
    const bodyIdx = lb.indexOf(lq);
    if (!titleMatch && bodyIdx === -1) continue;
    let snippet;
    if (bodyIdx !== -1) {
      const start = Math.max(0, bodyIdx - 40);
      const end = Math.min(body.length, bodyIdx + q.length + 40);
      snippet =
        escapeHtml(body.slice(start, bodyIdx)) +
        "<mark>" +
        escapeHtml(body.slice(bodyIdx, bodyIdx + q.length)) +
        "</mark>" +
        escapeHtml(body.slice(bodyIdx + q.length, end));
    } else {
      snippet = escapeHtml(body.slice(0, 80));
    }
    results.push({
      slug,
      title,
      snippet,
      score: countOccurrences((lt + lb), lq),
      titleMatch,
    });
  }
  results.sort(
    (a, b) =>
      Number(b.titleMatch) - Number(a.titleMatch) ||
      b.score - a.score ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  );
  return results.map(({ titleMatch, ...r }) => r);
}

// ---------------------------------------------------------------- page rendering

function wikiResolver(store) {
  return { exists: (slug) => store.exists(slug) };
}

function pageDetail(store, record) {
  const view = pageView(record);
  const { html, toc, links } = analyze(view.body, { wikiLinks: wikiResolver(store) });
  const backlinks = [];
  for (const slug of store.allSlugs()) {
    if (slug === record.slug) continue;
    const other = store.load(slug);
    if (other && wikiLinkTargets(current(other).body).includes(record.slug)) backlinks.push(slug);
  }
  // Self-links count as links too, per the spec's wording.
  if (links.includes(record.slug) && !backlinks.includes(record.slug)) backlinks.push(record.slug);
  backlinks.sort();
  return { ...view, html, toc, backlinks, links };
}

function renderPageDocument(store, record) {
  const view = pageView(record);
  const { html } = analyze(view.body, { wikiLinks: wikiResolver(store) });
  return (
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
    `<title>${escapeHtml(view.title)}</title>\n` +
    "<link rel=\"stylesheet\" href=\"/static/app.css\">\n" +
    "</head>\n<body class=\"standalone\">\n" +
    `<h1 class="page-title">${escapeHtml(view.title)}</h1>\n` +
    html +
    "</body>\n</html>\n"
  );
}

// ---------------------------------------------------------------- HTTP plumbing

function send(res, status, payload, type = "application/json; charset=utf-8") {
  const body = type.startsWith("application/json") ? JSON.stringify(payload) : payload;
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  const payload = { error: err.code || "internal", message: err.message, ...err.extra };
  send(res, status, payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(badRequest("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("invalid JSON body");
  }
}

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    throw notFound("no such asset");
  }
  const type = STATIC_TYPES[path.extname(file)] || "application/octet-stream";
  send(res, 200, fs.readFileSync(file), type);
}

// ---------------------------------------------------------------- routes

async function route(req, res, store) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const method = req.method;
  const q = url.searchParams;
  const now = () => new Date().toISOString();

  if (method === "GET" && parts.length === 0) return serveStatic(res, "index.html");
  if (method === "GET" && parts[0] === "static" && parts.length >= 2) return serveStatic(res, parts.slice(1).join("/"));

  if (parts[0] === "wiki" && parts.length === 2 && method === "GET") {
    const slug = checkSlug(parts[1]);
    const record = store.load(slug);
    if (!record) {
      return send(res, 404, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Page not found</h1></body></html>`, "text/html; charset=utf-8");
    }
    return send(res, 200, renderPageDocument(store, record), "text/html; charset=utf-8");
  }

  if (parts[0] !== "api") throw notFound("no such route");

  // /api/render, /api/tags, /api/export, /api/import, /api/search
  if (parts.length === 2) {
    const name = parts[1];
    if (name === "render" && method === "POST") {
      const input = await readJson(req);
      if (!input || typeof input.markdown !== "string") throw badRequest("markdown must be a string");
      const { html, toc } = analyze(input.markdown, { wikiLinks: wikiResolver(store) });
      return send(res, 200, { html, toc });
    }
    if (name === "tags" && method === "GET") {
      const counts = new Map();
      for (const slug of store.allSlugs()) {
        const record = store.load(slug);
        if (!record) continue;
        for (const t of current(record).tags) counts.set(t, (counts.get(t) || 0) + 1);
      }
      const list = [...counts.keys()].sort().map((tag) => ({ tag, count: counts.get(tag) }));
      return send(res, 200, list);
    }
    if (name === "export" && method === "GET") {
      const pages = store.allSlugs().map((s) => store.load(s)).filter(Boolean).map((r) => {
        const v = pageView(r);
        return { slug: v.slug, title: v.title, body: v.body, tags: v.tags, version: v.version };
      });
      pages.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      return send(res, 200, { pages });
    }
    if (name === "import" && method === "POST") {
      const input = await readJson(req);
      if (!input || !Array.isArray(input.pages)) throw badRequest("pages must be an array");
      // Validate everything before writing anything.
      const items = input.pages.map((p) => {
        if (!p || typeof p !== "object") throw badRequest("each page must be an object");
        return { slug: checkSlug(p.slug), ...parsePutInput(p) };
      });
      for (const item of items) applyPut(store, item.slug, item, now());
      return send(res, 200, { imported: items.length });
    }
    if (name === "search" && method === "GET") {
      const raw = q.get("q");
      const term = raw === null ? "" : raw.trim();
      if (term === "") throw badRequest("q must contain at least one character");
      return send(res, 200, search(store, term));
    }
    if (name === "pages" && method === "GET") {
      const tag = q.get("tag");
      const sort = q.get("sort") || "title";
      if (sort !== "title" && sort !== "updated") throw badRequest("sort must be title or updated");
      let list = store.allSlugs().map((s) => store.load(s)).filter(Boolean).map((r) => {
        const v = pageView(r);
        return { slug: v.slug, title: v.title, tags: v.tags, version: v.version, updatedAt: v.updatedAt };
      });
      if (tag) list = list.filter((p) => p.tags.includes(tag.trim().toLowerCase()));
      if (sort === "title") {
        list.sort((a, b) => {
          const x = a.title.toLowerCase();
          const y = b.title.toLowerCase();
          return x < y ? -1 : x > y ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });
      } else {
        list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      }
      return send(res, 200, list);
    }
  }

  // /api/pages/:slug[/...]
  if (parts[1] !== "pages" || parts.length < 3) throw notFound("no such route");
  const slug = checkSlug(parts[2]);
  const sub = parts.slice(3);

  if (sub.length === 0) {
    if (method === "GET") {
      const record = store.load(slug);
      if (!record) throw notFound(`page '${slug}' not found`);
      return send(res, 200, pageDetail(store, record));
    }
    if (method === "PUT") {
      const input = await readJson(req);
      const fields = parsePutInput(input);
      const base = input.baseVersion;
      const existing = store.load(slug);
      const curVersion = existing ? current(existing).version : 0;
      if (base !== undefined && base !== null) {
        checkVersionNumber(base, "baseVersion");
        if (base !== curVersion) {
          throw new HttpError(409, "conflict", `base version ${base} is not current (current is ${curVersion})`, {
            currentVersion: curVersion,
          });
        }
      }
      const { record, created } = applyPut(store, slug, fields, now());
      return send(res, created ? 201 : 200, pageView(record));
    }
    if (method === "DELETE") {
      if (!store.remove(slug)) throw notFound(`page '${slug}' not found`);
      res.writeHead(204);
      return res.end();
    }
    throw notFound("no such route");
  }

  const record = store.load(slug);
  if (!record) throw notFound(`page '${slug}' not found`);

  if (sub.length === 1 && sub[0] === "history" && method === "GET") {
    const list = [...record.versions].reverse().map((v) => ({ version: v.version, title: v.title, updatedAt: v.updatedAt }));
    return send(res, 200, list);
  }

  if (sub.length === 2 && sub[0] === "versions" && method === "GET") {
    const n = parseIntParam(sub[1], "version");
    const v = record.versions.find((x) => x.version === n);
    if (!v) throw notFound(`version ${n} not found`);
    return send(res, 200, { version: v.version, title: v.title, body: v.body, tags: v.tags });
  }

  if (sub.length === 1 && sub[0] === "revert" && method === "POST") {
    const input = await readJson(req);
    const n = checkVersionNumber(input && input.version, "version");
    const v = record.versions.find((x) => x.version === n);
    if (!v) throw notFound(`version ${n} not found`);
    const cur = current(record);
    record.versions.push({
      version: cur.version + 1,
      title: v.title,
      body: v.body,
      tags: [...v.tags],
      updatedAt: now(),
    });
    store.save(record);
    return send(res, 200, pageView(record));
  }

  if (sub.length === 1 && sub[0] === "diff" && method === "GET") {
    const from = parseIntParam(q.get("from"), "from");
    const to = parseIntParam(q.get("to"), "to");
    const a = record.versions.find((x) => x.version === from);
    const b = record.versions.find((x) => x.version === to);
    if (!a) throw notFound(`version ${from} not found`);
    if (!b) throw notFound(`version ${to} not found`);
    return send(res, 200, { from, to, lines: diffLines(a.body, b.body) });
  }

  throw notFound("no such route");
}

// ---------------------------------------------------------------- public API

export function createServer({ dataDir }) {
  const store = createStore(dataDir);
  return http.createServer((req, res) => {
    route(req, res, store).catch((err) => {
      if (!(err instanceof HttpError)) {
        console.error(err);
        err = new HttpError(500, "internal", "internal server error");
      }
      if (res.headersSent) return res.end();
      sendError(res, err);
    });
  });
}

