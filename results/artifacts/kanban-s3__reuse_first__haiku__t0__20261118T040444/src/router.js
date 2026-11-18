// Minimal method + path-pattern router (":name" segments become params).

export function compileRoute(method, pattern, opts, handler) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return {
    method,
    re: new RegExp(`^${src}/?$`),
    keys,
    auth: opts.auth !== false,
    json: Boolean(opts.json),
    handler,
  };
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (!m) continue;
    const params = {};
    route.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });
    return { route, params };
  }
  return null;
}
