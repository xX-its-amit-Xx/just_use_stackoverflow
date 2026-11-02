export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] || ''))) {
      let m;
      const rest = s.slice(i);
      if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start }); i += m[0].length;
      } else if ((m = /^0[bB][01]+/.exec(rest))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start }); i += m[0].length;
      } else {
        m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
        toks.push({ t: 'num', v: Number(m[0]), pos: start }); i += m[0].length;
      }
    } else if (isAlpha(c)) {
      let j = i + 1;
      while (j < s.length && (isAlpha(s[j]) || isDigit(s[j]))) j++;
      toks.push({ t: 'name', v: s.slice(i, j), pos: start }); i = j;
    } else if ('+-*/%^!(),='.includes(c)) {
      toks.push({ t: c, pos: start }); i++;
    } else {
      throw new CalcError(`Unexpected character '${c}'`, i);
    }
  }
  toks.push({ t: 'eof', pos: s.length });
  return toks;
}

const FACT_MAX = 170;
function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0 || n > FACT_MAX) throw new CalcError('Invalid factorial argument', pos);
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const fail = (tok = toks[p]) => {
    throw new CalcError(tok.t === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.t === 'num' ? tok.v : tok.t === 'name' ? tok.v : tok.t}'`, tok.pos);
  };
  const expect = (t) => { if (peek().t !== t) fail(); return toks[p++]; };

  function additive() {
    let l = multiplicative();
    while (peek().t === '+' || peek().t === '-') {
      const op = toks[p++];
      l = { k: 'bin', op: op.t, l, r: multiplicative(), pos: op.pos };
    }
    return l;
  }
  function multiplicative() {
    let l = implicit();
    while (peek().t === '*' || peek().t === '/' || peek().t === '%') {
      const op = toks[p++];
      l = { k: 'bin', op: op.t, l, r: implicit(), pos: op.pos };
    }
    return l;
  }
  function implicit() {
    let l = unary();
    for (;;) {
      const nx = peek(), prev = toks[p - 1];
      if ((nx.t === 'name' || nx.t === '(') && prev && (prev.t === 'num' || prev.t === ')')) {
        l = { k: 'bin', op: '*', l, r: power(), pos: nx.pos };
      } else break;
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t.t === '-' || t.t === '+') {
      p++;
      const a = unary();
      return t.t === '-' ? { k: 'neg', a, pos: t.pos } : a;
    }
    return power();
  }
  function power() {
    const base = postfix();
    if (peek().t === '^') {
      const op = toks[p++];
      return { k: 'bin', op: '^', l: base, r: expo(), pos: op.pos };
    }
    return base;
  }
  function expo() {
    const t = peek();
    if (t.t === '-' || t.t === '+') {
      p++;
      const a = expo();
      return t.t === '-' ? { k: 'neg', a, pos: t.pos } : a;
    }
    return power();
  }
  function postfix() {
    let a = primary();
    while (peek().t === '!') { const t = toks[p++]; a = { k: 'fact', a, pos: t.pos }; }
    return a;
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { p++; return { k: 'num', v: t.v, pos: t.pos }; }
    if (t.t === 'name') {
      p++;
      if (peek().t === '(') {
        p++;
        const args = [];
        if (peek().t !== ')') {
          args.push(additive());
          while (peek().t === ',') { p++; args.push(additive()); }
        }
        expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === '(') {
      p++;
      const e = additive();
      expect(')');
      return e;
    }
    fail();
  }
  return { additive, expectEof: () => { if (peek().t !== 'eof') fail(); }, pos: () => p, peek, toks };
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = angleMode;
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;
  const checkMode = (m) => { if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0); };
  checkMode(mode);

  const fin = (v, pos) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Math error: result is not finite', pos);
    return v;
  };
  const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const need = (cond, pos, msg = 'Domain error') => { if (!cond) throw new CalcError(msg, pos); };

  const B1 = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, pos) => { need(x >= -1 && x <= 1, pos); return fromRad(Math.asin(x)); },
    acos: (x, pos) => { need(x >= -1 && x <= 1, pos); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, pos) => { need(x >= 0, pos); return Math.sqrt(x); },
    cbrt: Math.cbrt,
    abs: Math.abs,
    ln: (x, pos) => { need(x > 0, pos); return Math.log(x); },
    log: (x, pos) => { need(x > 0, pos); return Math.log10(x); },
    log2: (x, pos) => { need(x > 0, pos); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  const B2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, pos) => {
      need(n !== 0, pos);
      if (x < 0) { need(Number.isInteger(n) && Math.abs(n % 2) === 1, pos); return -Math.pow(-x, 1 / n); }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, pos) => { need(x > 0 && b > 0 && b !== 1, pos); return Math.log(x) / Math.log(b); },
  };
  const BV = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in B1 || n in B2 || n in BV;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function ev(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (has(CONSTS, n.name)) return CONSTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw new CalcError(`Undefined variable: ${n.name}`, n.pos);
      }
      case 'neg': return -ev(n.a, scope);
      case 'fact': return factorial(ev(n.a, scope), n.pos);
      case 'bin': {
        const a = ev(n.l, scope), b = ev(n.r, scope);
        switch (n.op) {
          case '+': return fin(a + b, n.pos);
          case '-': return fin(a - b, n.pos);
          case '*': return fin(a * b, n.pos);
          case '/': need(b !== 0, n.pos, 'Division by zero'); return fin(a / b, n.pos);
          case '%': need(b !== 0, n.pos, 'Division by zero'); return fin(a % b, n.pos);
          case '^': return fin(Math.pow(a, b), n.pos);
        }
        break;
      }
      case 'call': return call(n, scope);
    }
    throw new CalcError('Internal error', n.pos);
  }

  function call(n, scope) {
    const name = n.name;
    const argc = n.args.length;
    if (has(B1, name) || has(B2, name) || has(BV, name)) {
      const args = n.args.map((a) => ev(a, scope));
      let r;
      if (has(B1, name)) { need(argc === 1, n.pos, `${name} expects 1 argument`); r = B1[name](args[0], n.pos); }
      else if (has(B2, name)) { need(argc === 2, n.pos, `${name} expects 2 arguments`); r = B2[name](args[0], args[1], n.pos); }
      else { need(argc >= 1, n.pos, `${name} expects at least 1 argument`); r = BV[name](args); }
      return fin(r, n.pos);
    }
    const f = funcs.get(name);
    if (!f) throw new CalcError(`Undefined function: ${name}`, n.pos);
    need(argc === f.params.length, n.pos, `${name} expects ${f.params.length} arguments`);
    const args = n.args.map((a) => ev(a, scope));
    if (depth >= 100) throw new CalcError('Maximum call depth exceeded', n.pos);
    const local = new Map();
    f.params.forEach((pn, i) => local.set(pn, args[i]));
    depth++;
    try { return fin(ev(f.body, local), n.pos); } finally { depth--; }
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    const ps = parse(toks);
    let result;
    // function definition?
    if (toks[0].t === 'name' && toks[1].t === '(') {
      let i = 2;
      const params = [];
      let ok = true;
      if (toks[i].t === 'name') {
        params.push(toks[i++]);
        while (toks[i].t === ',' && toks[i + 1].t === 'name') { i++; params.push(toks[i++]); }
      } else ok = false;
      if (ok && toks[i].t === ')' && toks[i + 1].t === '=') {
        const name = toks[0].v;
        if (isBuiltin(name) || has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot redefine '${name}'`, toks[0].pos);
        const names = new Set();
        for (const pt of params) {
          if (names.has(pt.v)) throw new CalcError(`Duplicate parameter '${pt.v}'`, pt.pos);
          names.add(pt.v);
        }
        for (let k = 0; k < i + 2; k++) ps.peek(), void 0;
        // advance parser past the header
        const hdr = i + 2;
        const sub = parse(toks.slice(hdr));
        const body = sub.additive();
        sub.expectEof();
        funcs.set(name, { params: params.map((x) => x.v), body });
        result = `${name}(${params.map((x) => x.v).join(',')})`;
        hist.push({ input, result });
        return result;
      }
    }
    if (toks[0].t === 'name' && toks[1].t === '=') {
      const name = toks[0].v;
      if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, toks[0].pos);
      const sub = parse(toks.slice(2));
      // positions are absolute already since tokens keep pos
      const body = sub.additive();
      sub.expectEof();
      const v = fin(ev(body, null), 0);
      vars.set(name, v);
      ans = v;
      hist.push({ input, result: v });
      return v;
    }
    const tree = ps.additive();
    ps.expectEof();
    result = fin(ev(tree, null), 0);
    ans = result;
    hist.push({ input, result });
    return result;
  }

  return {
    evaluate,
    setAngleMode(m) { checkMode(m); mode = m; },
    getAngleMode: () => mode,
    getVariable: (n) => (n === 'ans' ? ans : vars.get(n)),
    setVariable(n, v) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || has(CONSTS, n) || n === 'ans') throw new CalcError(`Invalid variable name: ${n}`, 0);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Invalid value', 0);
      vars.set(n, v);
    },
    variables: () => [...vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(v) {
      const r = Number(v.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
  };
}
