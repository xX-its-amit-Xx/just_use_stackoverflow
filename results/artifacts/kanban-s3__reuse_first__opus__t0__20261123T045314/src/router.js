// Vendored & adapted from:
//   regexparam@3.0.0 `parse` (MIT, Luke Edwards) https://github.com/lukeed/regexparam
//   trouter@4.0.0 `Trouter` (MIT, Luke Edwards) https://github.com/lukeed/trouter
// Adaptations: merged into one file, dropped the `inject`/`use`/middleware-chaining
// features, `find` returns the FIRST matching route (handler + params) and also
// reports whether the path matched any route for another method.
// See src/THIRD_PARTY_NOTICES.md for the license text.

/** regexparam.parse (unchanged logic) */
export function parse(input, loose) {
  if (input instanceof RegExp) return { keys: false, pattern: input };
  var c, o, tmp, ext, keys = [], pattern = '', arr = input.split('/');
  arr[0] || arr.shift();

  while (tmp = arr.shift()) {
    c = tmp[0];
    if (c === '*') {
      keys.push(c);
      pattern += tmp[1] === '?' ? '(?:/(.*))?' : '/(.*)';
    } else if (c === ':') {
      o = tmp.indexOf('?', 1);
      ext = tmp.indexOf('.', 1);
      keys.push(tmp.substring(1, !!~o ? o : !!~ext ? ext : tmp.length));
      pattern += !!~o && !~ext ? '(?:/([^/]+?))?' : '/([^/]+?)';
      if (!!~ext) pattern += (!!~o ? '?' : '') + '\\' + tmp.substring(ext);
    } else {
      pattern += '/' + tmp;
    }
  }

  return {
    keys: keys,
    pattern: new RegExp('^' + pattern + (loose ? '(?=$|\/)' : '\/?$'), 'i'),
  };
}

export class Router {
  constructor() {
    this.routes = [];
    for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      this[m.toLowerCase()] = this.add.bind(this, m);
    }
  }

  add(method, route, handler, opts = {}) {
    const { keys, pattern } = parse(route);
    this.routes.push({ keys, pattern, method, handler, opts });
    return this;
  }

  find(method, url) {
    if (method === 'HEAD') method = 'GET';
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(url);
      if (m === null) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      for (let j = 0; j < r.keys.length;) params[r.keys[j]] = decodeURIComponent(m[++j]);
      return { handler: r.handler, opts: r.opts, params, pathMatched };
    }
    return { handler: null, opts: {}, params: {}, pathMatched };
  }
}
