// Recursive-descent structure and sticky-regex tokenizing approach adapted from
// celaldrg/calculator (MIT) — see src/THIRD_PARTY_NOTICES.md. Remainder is new code.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NUMBER_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const MAX_DEPTH = 100;

function matchAt(re, s, i) { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : null; }

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = matchAt(NUMBER_RE, input, i);
    if (num) {
      tokens.push({ type: 'num', value: Number(num), pos: i });
      i += num.length;
      continue;
    }
    const name = matchAt(NAME_RE, input, i);
    if (name) { tokens.push({ type: 'name', name, pos: i }); i += name.length; continue; }
    if ('+-*/%^!(),='.includes(ch)) { tokens.push({ type: ch, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', pos: input.length });
  return tokens;
}

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  fail(tok = this.peek()) {
    throw new CalcError(tok.type === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.type === 'num' ? tok.value : tok.name ?? tok.type}'`, tok.pos);
  }
  expect(type) { const t = this.peek(); if (t.type !== type) this.fail(t); return this.next(); }

  parseAll() { const n = this.parseExpr(); if (this.peek().type !== 'eof') this.fail(); return n; }

  parseExpr() {
    let left = this.parseTerm();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.next();
      left = { k: 'bin', op: op.type, pos: op.pos, l: left, r: this.parseTerm() };
    }
    return left;
  }

  parseTerm() {
    let left = this.parseImplicit();
    while (['*', '/', '%'].includes(this.peek().type)) {
      const op = this.next();
      left = { k: 'bin', op: op.type, pos: op.pos, l: left, r: this.parseImplicit() };
    }
    return left;
  }

  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const nt = this.peek();
      const prev = this.t[this.i - 1];
      const leftOk = prev.type === 'num' || prev.type === ')' ||
        (prev.type === 'name' && Object.hasOwn(CONSTANTS, prev.name));
      if (leftOk && (nt.type === 'name' || nt.type === '(')) {
        left = { k: 'bin', op: '*', pos: nt.pos, l: left, r: this.parsePower() };
      } else return left;
    }
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === '+' || t.type === '-') {
      this.next();
      const arg = this.parseUnary();
      return t.type === '-' ? { k: 'neg', pos: t.pos, a: arg } : arg;
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (t.type === '^') {
      this.next();
      return { k: 'bin', op: '^', pos: t.pos, l: base, r: this.parseUnary() };
    }
    return base;
  }

  parsePostfix() {
    let n = this.parsePrimary();
    while (this.peek().type === '!') { const t = this.next(); n = { k: 'fact', pos: t.pos, a: n }; }
    return n;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { k: 'num', v: t.value }; }
    if (t.type === '(') { this.next(); const e = this.parseExpr(); this.expect(')'); return e; }
    if (t.type === 'name') {
      this.next();
      if (this.peek().type === '(' && !Object.hasOwn(CONSTANTS, t.name)) {
        this.next();
        const args = [];
        if (this.peek().type !== ')') {
          args.push(this.parseExpr());
          while (this.peek().type === ',') { this.next(); args.push(this.parseExpr()); }
        }
        this.expect(')');
        return { k: 'call', name: t.name, pos: t.pos, args };
      }
      return { k: 'var', name: t.name, pos: t.pos };
    }
    return this.fail(t);
  }
}

const roundHalfAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;
  const scopes = [];

  function setAngleMode(m) {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  }
  setAngleMode(angleMode);

  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const dom = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

  const f1 = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x, p) => {
      if (mode === 'deg' && Math.abs(Math.cos(toRad(x))) < 1e-12) throw new CalcError('tan undefined', p);
      return snap(Math.tan(toRad(x)));
    },
    asin: (x, p) => { dom(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { dom(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { dom(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); },
    cbrt: Math.cbrt, abs: Math.abs,
    ln: (x, p) => { dom(x > 0, 'ln domain error', p); return Math.log(x); },
    log: (x, p) => { dom(x > 0, 'log domain error', p); return Math.log10(x); },
    log2: (x, p) => { dom(x > 0, 'log2 domain error', p); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: roundHalfAway, sign: Math.sign,
  };
  const f2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y, p) => powr(x, y, p),
    nroot: (x, n, p) => {
      dom(n !== 0, 'nroot: zero degree', p);
      if (x < 0) {
        dom(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot: even root of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      dom(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    },
  };
  const fv = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => Object.hasOwn(f1, n) || Object.hasOwn(f2, n) || Object.hasOwn(fv, n);

  function powr(x, y, pos) {
    dom(!(x === 0 && y < 0), 'Division by zero', pos);
    const r = Math.pow(x, y);
    dom(!Number.isNaN(r), 'Invalid power', pos);
    return r;
  }
  const fin = (v, pos) => { if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos); return v; };

  function lookup(name) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      // only the innermost call scope is visible (params), then globals
      return scopes[i].has(name) ? scopes[i].get(name) : undefined;
    }
    return undefined;
  }

  function ev(n) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.a);
      case 'var': {
        const loc = lookup(n.name);
        if (loc !== undefined) return loc;
        if (Object.hasOwn(CONSTANTS, n.name)) return CONSTANTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw new CalcError(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'fact': {
        const v = ev(n.a);
        dom(Number.isInteger(v) && v >= 0 && v <= 170, 'Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = ev(n.l), b = ev(n.r);
        switch (n.op) {
          case '+': return fin(a + b, n.pos);
          case '-': return fin(a - b, n.pos);
          case '*': return fin(a * b, n.pos);
          case '/': dom(b !== 0, 'Division by zero', n.pos); return fin(a / b, n.pos);
          case '%': dom(b !== 0, 'Division by zero', n.pos); return fin(a % b, n.pos);
          case '^': return fin(powr(a, b, n.pos), n.pos);
        }
        break;
      }
      case 'call': return fin(call(n), n.pos);
    }
    throw new CalcError('Internal error', n.pos);
  }

  function call(n) {
    const { name, pos } = n;
    const uf = funcs.get(name);
    if (uf) {
      dom(n.args.length === uf.params.length, `Function '${name}' expects ${uf.params.length} argument(s)`, pos);
      const args = n.args.map(ev);
      dom(depth < MAX_DEPTH, 'Maximum call depth exceeded (recursion)', pos);
      const scope = new Map(uf.params.map((p, i) => [p, args[i]]));
      scopes.push(scope); depth++;
      try { return ev(uf.body); } finally { scopes.pop(); depth--; }
    }
    if (isBuiltin(name)) {
      const args = n.args.map(ev);
      const ar = (k) => dom(args.length === k, `Function '${name}' expects ${k} argument(s)`, pos);
      if (Object.hasOwn(f1, name)) { ar(1); return f1[name](args[0], pos); }
      if (Object.hasOwn(f2, name)) { ar(2); return f2[name](args[0], args[1], pos); }
      dom(args.length >= 1, `Function '${name}' expects at least 1 argument`, pos);
      return fv[name](args);
    }
    if (vars.has(name) || lookup(name) !== undefined) { // implicit multiplication: x(2)
      dom(n.args.length === 1, `Function '${name}' is not defined`, pos);
      return ev({ k: 'bin', op: '*', pos, l: { k: 'var', name, pos }, r: n.args[0] });
    }
    throw new CalcError(`Undefined function '${name}'`, pos);
  }

  function reserved(name, pos) {
    dom(!Object.hasOwn(CONSTANTS, name) && name !== 'ans', `Cannot assign to constant '${name}'`, pos);
  }

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    const t0 = tokens[0], t1 = tokens[1];
    if (t0.type === 'name' && t1.type === '=') {
      reserved(t0.name, t0.pos);
      dom(!isBuiltin(t0.name), `Cannot assign to built-in function '${t0.name}'`, t0.pos);
      const p = new Parser(tokens); p.i = 2;
      const v = ev(p.parseAll());
      vars.set(t0.name, v); ans = v;
      return v;
    }
    if (t0.type === 'name' && t1.type === '(') {
      // function definition?  name ( ident {, ident} ) =
      let j = 2; const params = []; let ok = true;
      for (;;) {
        const t = tokens[j];
        if (t.type !== 'name') { ok = false; break; }
        params.push(t); j++;
        if (tokens[j].type === ',') { j++; continue; }
        if (tokens[j].type === ')') { j++; break; }
        ok = false; break;
      }
      if (ok && tokens[j].type === '=') {
        reserved(t0.name, t0.pos);
        dom(!isBuiltin(t0.name), `Cannot redefine built-in function '${t0.name}'`, t0.pos);
        const seen = new Set();
        for (const q of params) {
          dom(!seen.has(q.name), `Duplicate parameter '${q.name}'`, q.pos);
          seen.add(q.name);
        }
        const p = new Parser(tokens); p.i = j + 1;
        const body = p.parseAll();
        funcs.set(t0.name, { params: params.map((q) => q.name), body });
        return `${t0.name}(${params.map((q) => q.name).join(',')})`;
      }
    }
    const v = ev(new Parser(tokens).parseAll());
    ans = v;
    return v;
  }

  const c = {
    evaluate(input) {
      depth = 0; scopes.length = 0;
      const result = run(input);
      hist.push({ input, result });
      return result;
    },
    setAngleMode,
    getAngleMode: () => mode,
    getVariable: (name) => vars.get(name),
    setVariable(name, value) {
      dom(typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'Invalid variable name', 0);
      reserved(name, 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
    _vars: () => vars,
  };
  return c;
}
