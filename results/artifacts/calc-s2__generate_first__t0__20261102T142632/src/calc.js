export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    let m;
    const rest = s.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start }); i += m[0].length;
    } else if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start }); i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: start }); i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'name', v: m[0], pos: start }); i += m[0].length;
    } else if ('+-*/%^!(),='.includes(ch)) {
      toks.push({ t: ch, pos: start }); i++;
    } else {
      throw new CalcError(`Unexpected character '${ch}'`, start);
    }
  }
  toks.push({ t: 'eof', pos: s.length });
  return toks;
}

// Built-in function table
const fin = (x, pos) => {
  if (!Number.isFinite(x)) throw new CalcError('Result is not finite', pos);
  return x;
};
const dom = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

function makeBuiltins(getMode) {
  const deg = () => getMode() === 'deg';
  const snap = (x) => (deg() && Math.abs(x) < 1e-12 ? 0 : x);
  const toRad = (x) => (deg() ? x * Math.PI / 180 : x);
  const fromRad = (x) => (deg() ? x * 180 / Math.PI : x);
  const one = (f) => ({ min: 1, max: 1, f });
  return {
    sin: one((x) => snap(Math.sin(toRad(x)))),
    cos: one((x) => snap(Math.cos(toRad(x)))),
    tan: one((x) => snap(Math.tan(toRad(x)))),
    asin: one((x, p) => { dom(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); }),
    acos: one((x, p) => { dom(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); }),
    atan: one((x) => fromRad(Math.atan(x))),
    sinh: one(Math.sinh), cosh: one(Math.cosh), tanh: one(Math.tanh),
    sqrt: one((x, p) => { dom(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); }),
    cbrt: one(Math.cbrt),
    abs: one(Math.abs),
    ln: one((x, p) => { dom(x > 0, 'ln domain error', p); return Math.log(x); }),
    log: one((x, p) => { dom(x > 0, 'log domain error', p); return Math.log10(x); }),
    log2: one((x, p) => { dom(x > 0, 'log2 domain error', p); return Math.log2(x); }),
    exp: one(Math.exp),
    floor: one(Math.floor), ceil: one(Math.ceil),
    round: one((x) => Math.sign(x) * Math.round(Math.abs(x))),
    sign: one(Math.sign),
    atan2: { min: 2, max: 2, f: (y, x) => fromRad(Math.atan2(y, x)) },
    pow: { min: 2, max: 2, f: (x, y) => Math.pow(x, y) },
    nroot: { min: 2, max: 2, f: (x, n, p) => {
      dom(n !== 0, 'nroot: zero degree', p);
      if (x < 0) {
        dom(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot: even root of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    } },
    logb: { min: 2, max: 2, f: (x, b, p) => {
      dom(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    } },
    min: { min: 1, max: Infinity, f: (...a) => Math.min(...a) },
    max: { min: 1, max: Infinity, f: (...a) => Math.max(...a) },
    sum: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) },
    avg: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) / a.length },
    hypot: { min: 1, max: Infinity, f: (...a) => Math.hypot(...a) },
  };
}

class Parser {
  constructor(toks, startIdx = 0) { this.toks = toks; this.i = startIdx; }
  get cur() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  fail(tok = this.cur) {
    throw new CalcError(tok.t === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.t === 'num' || tok.t === 'name' ? tok.v : tok.t}'`, tok.pos);
  }
  expect(t) { if (this.cur.t !== t) this.fail(); return this.next(); }

  parseAll() {
    const e = this.additive();
    if (this.cur.t !== 'eof') this.fail();
    return e;
  }
  additive() {
    let l = this.mul();
    while (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.next();
      l = { k: 'bin', op: op.t, l, r: this.mul(), pos: op.pos };
    }
    return l;
  }
  mul() {
    let l = this.implicit();
    while (this.cur.t === '*' || this.cur.t === '/' || this.cur.t === '%') {
      const op = this.next();
      l = { k: 'bin', op: op.t, l, r: this.implicit(), pos: op.pos };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    while (true) {
      const prev = this.toks[this.i - 1];
      const c = this.cur;
      const ok = (c.t === 'name' || c.t === '(') &&
        (prev.t === 'num' || prev.t === ')' || prev.t === '!' ||
          (prev.t === 'name' && this.lastWasVarCall && c.t === '('));
      if (!ok) break;
      l = { k: 'bin', op: '*', l, r: this.power(), pos: c.pos };
    }
    return l;
  }
  unary() {
    if (this.cur.t === '-' || this.cur.t === '+') {
      const op = this.next();
      const e = this.unary();
      return op.t === '-' ? { k: 'neg', e, pos: op.pos } : e;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.cur.t === '^') {
      const op = this.next();
      return { k: 'bin', op: '^', l: base, r: this.expo(), pos: op.pos };
    }
    return base;
  }
  expo() {
    if (this.cur.t === '-' || this.cur.t === '+') {
      const op = this.next();
      const e = this.expo();
      return op.t === '-' ? { k: 'neg', e, pos: op.pos } : e;
    }
    return this.power();
  }
  postfix() {
    let e = this.primary();
    while (this.cur.t === '!') {
      const op = this.next();
      e = { k: 'fact', e, pos: op.pos };
    }
    return e;
  }
  primary() {
    const t = this.cur;
    this.lastWasVarCall = false;
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      this.next();
      if (this.cur.t === '(' && !(t.v in CONSTS) && !this.isVar(t.v)) {
        this.next();
        const args = [];
        if (this.cur.t !== ')') {
          args.push(this.additive());
          while (this.cur.t === ',') { this.next(); args.push(this.additive()); }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      // variable followed by '(' acts as implicit multiplication
      this.lastWasVarCall = true;
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === '(') {
      this.next();
      const e = this.additive();
      this.expect(')');
      return e;
    }
    this.fail();
  }
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;
  const builtins = makeBuiltins(() => mode);

  const checkMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
  };
  checkMode(angleMode);
  mode = angleMode;

  const isVar = (n) => vars.has(n) || n === 'ans';

  function lookup(name, scope, pos) {
    if (scope && scope.has(name)) return scope.get(name);
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    if (name in CONSTS) return CONSTS[name];
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function evalNode(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': return lookup(n.name, scope, n.pos);
      case 'neg': return -evalNode(n.e, scope);
      case 'fact': {
        const x = evalNode(n.e, scope);
        if (!Number.isInteger(x) || x < 0 || x > 170) throw new CalcError('Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= x; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = evalNode(n.l, scope);
        const b = evalNode(n.r, scope);
        let r;
        switch (n.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': if (b === 0) throw new CalcError('Division by zero', n.pos); r = a / b; break;
          case '%': if (b === 0) throw new CalcError('Remainder by zero', n.pos); r = a % b; break;
          case '^': r = Math.pow(a, b); break;
        }
        return fin(r, n.pos);
      }
      case 'call': return callFn(n, scope);
    }
    throw new CalcError('Bad node', 0);
  }

  function callFn(n, scope) {
    const uf = funcs.get(n.name);
    const bf = Object.hasOwn(builtins, n.name) ? builtins[n.name] : null;
    if (uf) {
      const args = n.args.map((a) => evalNode(a, scope));
      if (args.length !== uf.params.length) throw new CalcError(`Function '${n.name}' expects ${uf.params.length} argument(s)`, n.pos);
      if (depth >= MAX_DEPTH) throw new CalcError('Maximum call depth exceeded', n.pos);
      const sc = new Map(uf.params.map((p, i) => [p, args[i]]));
      depth++;
      try { return fin(evalNode(uf.body, sc), n.pos); } finally { depth--; }
    }
    if (bf) {
      const args = n.args.map((a) => evalNode(a, scope));
      if (args.length < bf.min || args.length > bf.max) throw new CalcError(`Wrong number of arguments for '${n.name}'`, n.pos);
      return fin(bf.f(...args, n.pos), n.pos);
    }
    throw new CalcError(`Unknown function '${n.name}'`, n.pos);
  }

  function parseExpr(toks, idx) {
    const p = new Parser(toks, idx);
    p.isVar = isVar;
    return p.parseAll();
  }

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    if (toks[0].t === 'eof') throw new CalcError('Empty input', 0);
    // function definition
    if (toks[0].t === 'name' && toks[1].t === '(') {
      let j = 2;
      const params = [];
      let ok = true;
      if (toks[j].t === ')') ok = false;
      else {
        while (true) {
          if (toks[j].t !== 'name') { ok = false; break; }
          params.push(toks[j]); j++;
          if (toks[j].t === ',') { j++; continue; }
          break;
        }
        if (ok) ok = toks[j].t === ')' && toks[j + 1].t === '=';
      }
      if (ok) {
        const name = toks[0].v;
        if (Object.hasOwn(builtins, name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, 0);
        if (name in CONSTS || name === 'ans') throw new CalcError(`Cannot define '${name}'`, 0);
        const seen = new Set();
        for (const p of params) {
          if (seen.has(p.v)) throw new CalcError(`Duplicate parameter '${p.v}'`, p.pos);
          seen.add(p.v);
        }
        const names = params.map((p) => p.v);
        // parameters are variables inside the body
        const p = new Parser(toks, j + 2);
        p.isVar = (n) => seen.has(n) || isVar(n);
        const body = p.parseAll();
        funcs.set(name, { params: names, body });
        return `${name}(${names.join(',')})`;
      }
    }
    // assignment
    if (toks[0].t === 'name' && toks[1].t === '=') {
      const name = toks[0].v;
      if (name in CONSTS) throw new CalcError(`Cannot assign to constant '${name}'`, 0);
      if (name === 'ans') throw new CalcError("Cannot assign to 'ans'", 0);
      const body = parseExpr(toks, 2);
      const v = evalNode(body, null);
      vars.set(name, v);
      ans = v;
      return v;
    }
    const v = evalNode(parseExpr(toks, 0), null);
    ans = v;
    return v;
  }

  const c = {
    evaluate(input) {
      depth = 0;
      const r = run(input);
      hist.push({ input, result: r });
      return r;
    },
    setAngleMode(m) { checkMode(m); mode = m; },
    getAngleMode() { return mode; },
    getVariable(name) {
      if (name === 'ans') return ans;
      if (vars.has(name)) return vars.get(name);
      if (Object.hasOwn(CONSTS, name)) return CONSTS[name];
      return undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
      if (Object.hasOwn(CONSTS, name)) throw new CalcError(`Cannot assign to constant '${name}'`, 0);
      if (typeof value !== 'number') throw new CalcError('Value must be a number', 0);
      if (name === 'ans') ans = value; else vars.set(name, value);
    },
    variables() { return [...vars.keys()]; },
    history() { return hist.map((h) => ({ ...h })); },
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return String(Object.is(r, -0) ? 0 : r);
    },
  };
  return c;
}
