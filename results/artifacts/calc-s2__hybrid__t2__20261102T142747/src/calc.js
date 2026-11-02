export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = s.slice(i);
    let m;
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: i }); i += m[0].length; continue;
    }
    if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: i }); i += m[0].length; continue;
    }
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'id', v: m[0], pos: i }); i += m[0].length; continue;
    }
    if ('+-*/%^!(),='.includes(ch)) { toks.push({ t: ch, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  toks.push({ t: 'eof', pos: s.length });
  return toks;
}

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  get cur() { return this.toks[this.i]; }
  get prev() { return this.toks[this.i - 1]; }
  next() { return this.toks[this.i++]; }
  fail(tok = this.cur) {
    throw new CalcError(tok.t === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.t === 'num' ? tok.v : tok.t === 'id' ? tok.v : tok.t}'`, tok.pos);
  }
  expect(t) { if (this.cur.t !== t) this.fail(); return this.next(); }
  parseAll() {
    const n = this.add();
    if (this.cur.t !== 'eof') this.fail();
    return n;
  }
  add() {
    let l = this.mul();
    while (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.next();
      l = { k: 'bin', op: op.t, l, r: this.mul(), pos: op.pos };
    }
    return l;
  }
  mul() {
    let l = this.implicit();
    while (['*', '/', '%'].includes(this.cur.t)) {
      const op = this.next();
      l = { k: 'bin', op: op.t, l, r: this.implicit(), pos: op.pos };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    for (;;) {
      const c = this.cur;
      const pv = this.prev;
      const ok = (pv.t === 'num' || pv.t === ')') && (c.t === 'id' || c.t === '(' || c.t === 'num' && pv.t === ')');
      if (!ok) break;
      l = { k: 'bin', op: '*', l, r: this.unary(), pos: c.pos };
    }
    return l;
  }
  unary() {
    if (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.next();
      const a = this.unary();
      return op.t === '-' ? { k: 'neg', a, pos: op.pos } : a;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.cur.t === '^') {
      const op = this.next();
      const ex = this.unary();
      return { k: 'bin', op: '^', l: base, r: ex, pos: op.pos };
    }
    return base;
  }
  postfix() {
    let n = this.primary();
    while (this.cur.t === '!') { const t = this.next(); n = { k: 'fact', a: n, pos: t.pos }; }
    return n;
  }
  primary() {
    const t = this.cur;
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v, pos: t.pos }; }
    if (t.t === 'id') {
      this.next();
      if (this.cur.t === '(') {
        this.next();
        const args = [];
        if (this.cur.t !== ')') {
          args.push(this.add());
          while (this.cur.t === ',') { this.next(); args.push(this.add()); }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === '(') {
      this.next();
      const n = this.add();
      this.expect(')');
      return n;
    }
    this.fail();
  }
}

const D2R = Math.PI / 180;
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = angleMode;
  if (mode !== 'rad' && mode !== 'deg') throw new CalcError('Invalid angle mode', 0);
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];

  const dom = (c, msg, pos) => { if (!c) throw new CalcError(msg, pos); };
  const deg = () => mode === 'deg';

  const B1 = {
    sin: (x) => (deg() ? snap(Math.sin(x * D2R)) : Math.sin(x)),
    cos: (x) => (deg() ? snap(Math.cos(x * D2R)) : Math.cos(x)),
    tan: (x) => (deg() ? snap(Math.tan(x * D2R)) : Math.tan(x)),
    asin: (x, p) => { dom(x >= -1 && x <= 1, 'asin domain error', p); const r = Math.asin(x); return deg() ? r / D2R : r; },
    acos: (x, p) => { dom(x >= -1 && x <= 1, 'acos domain error', p); const r = Math.acos(x); return deg() ? r / D2R : r; },
    atan: (x) => { const r = Math.atan(x); return deg() ? r / D2R : r; },
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { dom(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); },
    cbrt: Math.cbrt, abs: Math.abs,
    ln: (x, p) => { dom(x > 0, 'ln domain error', p); return Math.log(x); },
    log: (x, p) => { dom(x > 0, 'log domain error', p); return Math.log10(x); },
    log2: (x, p) => { dom(x > 0, 'log2 domain error', p); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  const B2 = {
    atan2: (y, x) => { const r = Math.atan2(y, x); return deg() ? r / D2R : r; },
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      dom(n !== 0, 'nroot: zero root', p);
      if (x < 0) {
        dom(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      dom(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    },
  };
  const BV = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in B1 || n in B2 || n in BV;
  const has = (o, n) => Object.prototype.hasOwnProperty.call(o, n);

  const fin = (v, pos) => {
    if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
    return v;
  };

  let depth = 0;
  function ev(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.a, scope);
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (vars.has(n.name)) return vars.get(n.name);
        if (has(CONSTS, n.name)) return CONSTS[n.name];
        if (n.name === 'ans') return ans;
        throw new CalcError(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'fact': {
        const v = ev(n.a, scope);
        dom(Number.isInteger(v) && v >= 0 && v <= 170, 'Invalid factorial argument', n.pos);
        let r = 1; for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = ev(n.l, scope), b = ev(n.r, scope);
        switch (n.op) {
          case '+': return fin(a + b, n.pos);
          case '-': return fin(a - b, n.pos);
          case '*': return fin(a * b, n.pos);
          case '/': dom(b !== 0, 'Division by zero', n.pos); return fin(a / b, n.pos);
          case '%': dom(b !== 0, 'Remainder by zero', n.pos); return fin(a % b, n.pos);
          case '^': return fin(Math.pow(a, b), n.pos);
        }
        break;
      }
      case 'call': return call(n, scope);
    }
    throw new CalcError('Internal error', n.pos);
  }

  function call(n, scope) {
    const { name, pos } = n;
    const argc = n.args.length;
    if (funcs.has(name)) {
      const f = funcs.get(name);
      dom(argc === f.params.length, `Function '${name}' expects ${f.params.length} argument(s)`, pos);
      const args = n.args.map((a) => ev(a, scope));
      if (depth >= 100) throw new CalcError('Maximum call depth exceeded', pos);
      const sc = new Map();
      f.params.forEach((p, i) => sc.set(p, args[i]));
      depth++;
      try { return fin(ev(f.body, sc), pos); } finally { depth--; }
    }
    if (has(B1, name)) {
      dom(argc === 1, `Function '${name}' expects 1 argument`, pos);
      return fin(B1[name](ev(n.args[0], scope), pos), pos);
    }
    if (has(B2, name)) {
      dom(argc === 2, `Function '${name}' expects 2 arguments`, pos);
      const a = ev(n.args[0], scope), b = ev(n.args[1], scope);
      return fin(B2[name](a, b, pos), pos);
    }
    if (has(BV, name)) {
      dom(argc >= 1, `Function '${name}' expects at least 1 argument`, pos);
      return fin(BV[name](n.args.map((a) => ev(a, scope))), pos);
    }
    throw new CalcError(`Undefined function '${name}'`, pos);
  }

  function run(input) {
    const toks = tokenize(input);
    const T = (i) => toks[i] || toks[toks.length - 1];
    // function definition?
    if (T(0).t === 'id' && T(1).t === '(') {
      let j = 2;
      const params = [];
      let okDef = false;
      if (T(j).t === 'id') {
        params.push(T(j).v); j++;
        while (T(j).t === ',' && T(j + 1).t === 'id') { params.push(T(j + 1).v); j += 2; }
        okDef = T(j).t === ')' && T(j + 1).t === '=';
      }
      if (okDef) {
        const name = T(0).v;
        dom(!isBuiltin(name) && !has(CONSTS, name) && name !== 'ans', `Cannot redefine '${name}'`, T(0).pos);
        const seen = new Set();
        for (let k = 0; k < params.length; k++) {
          dom(!seen.has(params[k]), `Duplicate parameter '${params[k]}'`, T(2 + 2 * k).pos);
          seen.add(params[k]);
        }
        const p = new Parser(toks); p.i = j + 2;
        const body = p.parseAll();
        funcs.set(name, { params, body });
        return `${name}(${params.join(',')})`;
      }
    }
    if (T(0).t === 'id' && T(1).t === '=') {
      const name = T(0).v;
      dom(!has(CONSTS, name) && name !== 'ans', `Cannot assign to '${name}'`, T(0).pos);
      const p = new Parser(toks); p.i = 2;
      const v = ev(p.parseAll(), null);
      vars.set(name, v);
      ans = v;
      return v;
    }
    const v = ev(new Parser(toks).parseAll(), null);
    ans = v;
    return v;
  }

  const c = {
    evaluate(input) {
      depth = 0;
      const result = run(String(input));
      hist.push({ input, result });
      return result;
    },
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError('Invalid angle mode', 0);
      mode = m;
    },
    getAngleMode: () => mode,
    getVariable(name) {
      if (vars.has(name)) return vars.get(name);
      if (name === 'ans') return ans;
      if (has(CONSTS, name)) return CONSTS[name];
      return undefined;
    },
    setVariable(name, value) {
      dom(typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'Invalid variable name', 0);
      dom(!has(CONSTS, name) && name !== 'ans', `Cannot assign to '${name}'`, 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return r === 0 ? '0' : String(r);
    },
    _vars: () => vars,
  };
  return c;
}
