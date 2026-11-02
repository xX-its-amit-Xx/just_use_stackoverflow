export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------- tokenizer ----------
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: i }); i += m[0].length;
    } else if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: i }); i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'name', v: m[0], pos: i }); i += m[0].length;
    } else if ('+-*/%^!(),='.includes(ch)) {
      toks.push({ t: ch, pos: i }); i++;
    } else {
      toks.push({ t: 'bad', pos: i }); i++;
    }
  }
  toks.push({ t: 'eof', pos: src.length });
  return toks;
}

// ---------- parser ----------
class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  fail(tok = this.peek()) {
    throw new CalcError(tok.t === 'eof' ? 'Unexpected end of input' : `Unexpected token at position ${tok.pos}`, tok.pos);
  }
  expect(t) { if (this.peek().t !== t) this.fail(); return this.next(); }
  parseAll() { const n = this.expr(); if (this.peek().t !== 'eof') this.fail(); return n; }
  expr() {
    let l = this.term();
    while (this.peek().t === '+' || this.peek().t === '-') {
      const o = this.next();
      l = { k: 'bin', op: o.t, l, r: this.term(), pos: o.pos };
    }
    return l;
  }
  term() {
    let l = this.implicit();
    while (['*', '/', '%'].includes(this.peek().t)) {
      const o = this.next();
      l = { k: 'bin', op: o.t, l, r: this.implicit(), pos: o.pos };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    for (;;) {
      const p = this.peek();
      const prev = this.toks[this.i - 1];
      const leftOk = prev.t === 'num' || prev.t === ')';
      if (leftOk && (p.t === 'name' || p.t === '(')) {
        l = { k: 'bin', op: '*', l, r: this.power(), pos: p.pos };
      } else if (prev.t === 'num' && p.t === 'num') {
        this.fail();
      } else return l;
    }
  }
  unary() {
    const p = this.peek();
    if (p.t === '-' || p.t === '+') {
      this.next();
      const a = this.unary();
      return p.t === '-' ? { k: 'neg', a, pos: p.pos } : a;
    }
    return this.power();
  }
  power() {
    const b = this.postfix();
    if (this.peek().t === '^') {
      const o = this.next();
      return { k: 'bin', op: '^', l: b, r: this.unary(), pos: o.pos };
    }
    return b;
  }
  postfix() {
    let n = this.primary();
    while (this.peek().t === '!') { const o = this.next(); n = { k: 'fact', a: n, pos: o.pos }; }
    return n;
  }
  primary() {
    const t = this.peek();
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v, pos: t.pos }; }
    if (t.t === '(') {
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (t.t === 'name') {
      this.next();
      if (this.peek().t === '(') {
        this.next();
        const args = [];
        if (this.peek().t !== ')') {
          args.push(this.expr());
          while (this.peek().t === ',') { this.next(); args.push(this.expr()); }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'id', name: t.v, pos: t.pos };
    }
    this.fail(t);
  }
}

// ---------- builtins ----------
const fin = (x, pos) => {
  if (!Number.isFinite(x)) throw new CalcError('Result is not finite', pos);
  return x;
};
const dom = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  const checkMode = (m) => { if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0); };
  checkMode(angleMode);
  mode = angleMode;

  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

  const one = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, p) => { dom(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { dom(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
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
  const two = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      dom(n !== 0, 'nroot with zero degree', p);
      if (x < 0) {
        dom(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot of negative number', p);
        return -nroot(-x, n);
      }
      return nroot(x, n);
    },
    logb: (x, b, p) => {
      dom(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    },
  };
  function nroot(x, n) {
    if (n === 3) return Math.cbrt(x);
    const r = Math.pow(x, 1 / n);
    const rr = Math.round(r);
    return Math.pow(rr, n) === x ? rr : r;
  }
  const multi = {
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, v) => s + v, 0),
    avg: (a) => a.reduce((s, v) => s + v, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in one || n in two || n in multi;
  const has = (o, n) => Object.prototype.hasOwnProperty.call(o, n);

  function callBuiltin(name, args, pos) {
    if (has(one, name)) {
      dom(args.length === 1, `${name} expects 1 argument`, pos);
      return one[name](args[0], pos);
    }
    if (has(two, name)) {
      dom(args.length === 2, `${name} expects 2 arguments`, pos);
      return two[name](args[0], args[1], pos);
    }
    dom(args.length >= 1, `${name} expects at least 1 argument`, pos);
    return multi[name](args);
  }

  function ev(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.a, scope);
      case 'id': {
        const nm = n.name;
        if (scope && has(scope, nm)) return scope[nm];
        if (has(CONSTANTS, nm)) return CONSTANTS[nm];
        if (nm === 'ans') return ans;
        if (vars.has(nm)) return vars.get(nm);
        throw new CalcError(`Undefined variable: ${nm}`, n.pos);
      }
      case 'fact': {
        const v = ev(n.a, scope);
        dom(Number.isInteger(v) && v >= 0 && v <= 170, 'Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = ev(n.l, scope);
        const b = ev(n.r, scope);
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
      case 'call': {
        if (funcs.has(n.name)) {
          const f = funcs.get(n.name);
          const args = n.args.map((x) => ev(x, scope));
          dom(args.length === f.params.length, `${n.name} expects ${f.params.length} argument(s)`, n.pos);
          if (depth >= 100) throw new CalcError('Maximum call depth exceeded', n.pos);
          const sc = {};
          f.params.forEach((p, i) => { sc[p] = args[i]; });
          depth++;
          try { return fin(ev(f.body, sc), n.pos); } finally { depth--; }
        }
        if (isBuiltin(n.name)) {
          const args = n.args.map((x) => ev(x, scope));
          return fin(callBuiltin(n.name, args, n.pos), n.pos);
        }
        throw new CalcError(`Unknown function: ${n.name}`, n.pos);
      }
    }
    throw new CalcError('Internal error', n.pos);
  }

  function run(input) {
    const toks = tokenize(input);
    const T = (k) => toks[k] && toks[k].t;
    // function definition
    if (T(0) === 'name' && T(1) === '(') {
      let k = 2;
      const params = [];
      let ok = T(k) === 'name';
      while (ok) {
        params.push(toks[k].v); k++;
        if (T(k) === ',') { k++; ok = T(k) === 'name'; if (!ok) k = -1; } else break;
      }
      if (k > 0 && T(k) === ')' && T(k + 1) === '=') {
        const name = toks[0].v;
        if (isBuiltin(name) || has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot define function ${name}`, 0);
        const seen = new Set();
        params.forEach((p, idx) => {
          if (seen.has(p)) throw new CalcError(`Duplicate parameter ${p}`, toks[2 + idx * 2].pos);
          seen.add(p);
        });
        const p = new Parser(toks); p.i = k + 2;
        const body = p.parseAll();
        funcs.set(name, { params, body });
        return `${name}(${params.join(',')})`;
      }
    }
    if (T(0) === 'name' && T(1) === '=') {
      const name = toks[0].v;
      if (has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot assign to ${name}`, 0);
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

  return {
    evaluate(input) {
      depth = 0;
      const r = run(String(input));
      hist.push({ input, result: r });
      return r;
    },
    setAngleMode(m) { checkMode(m); mode = m; },
    getAngleMode() { return mode; },
    getVariable(name) { return vars.get(name); },
    setVariable(name, value) {
      if (!NAME_RE.test(name)) throw new CalcError(`Invalid name: ${name}`, 0);
      if (has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot assign to ${name}`, 0);
      vars.set(name, value);
    },
    history() { return hist.map((h) => ({ ...h })); },
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(value) {
      const n = Number(value.toPrecision(precision));
      return Object.is(n, -0) ? '0' : String(n);
    },
    _vars: vars,
  };
}
