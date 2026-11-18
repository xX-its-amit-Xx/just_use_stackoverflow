// HTTP plumbing: body parsing, auth, dispatch, JSON responses, static UI files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { loadData, saveData } from './store.js';
import { matchRoute } from './router.js';
import { HttpError, badRequest, unauthorized, notFound, isPlainObject } from './util.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createServer({ dataFile } = {}) {
  const db = loadData(dataFile);
  const api = createApi(db);
  const save = () => saveData(dataFile, db);

  return http.createServer((req, res) => {
    dispatch(req, res, api, save).catch((err) => {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error(err);
        send(res, 500, { error: 'internal', message: 'internal server error' });
      }
    });
  });
}

async function dispatch(req, res, api, save) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && (pathname === '/' || pathname === '/index.html')) return serveFile(res, 'index.html', req.method);
  if (isRead && pathname.startsWith('/static/')) return serveFile(res, pathname.slice('/static/'.length), req.method);

  const raw = await readBody(req);
  const match = matchRoute(api.routes, req.method, pathname);
  if (!match) throw notFound('no such route');
  const { route, params } = match;

  let user = null;
  let token = null;
  if (route.auth) {
    token = bearerToken(req.headers.authorization);
    user = token ? api.userForToken(token) : null;
    if (!user) throw unauthorized();
  }

  let body = {};
  if (route.json && raw.trim() !== '') {
    try {
      body = JSON.parse(raw);
    } catch {
      throw badRequest('request body is not valid JSON');
    }
    if (!isPlainObject(body)) throw badRequest('request body must be a JSON object');
  }

  const result = route.handler({ params, query: url.searchParams, body, user, token: token ?? null, api });
  if (!isRead) save();
  send(res, result.status, result.body);
}

function bearerToken(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(badRequest('request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function serveFile(res, rel, method) {
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw notFound();
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw notFound();
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': data.length,
  });
  res.end(method === 'HEAD' ? undefined : data);
}
