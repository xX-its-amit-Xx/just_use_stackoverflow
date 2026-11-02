// calc-s2: safe scientific calculator engine (no eval / Function).
// Written from scratch; recursive-descent structure only loosely informed by
// reviewing celaldrg/calculator (MIT) parser.js, whose semantics differ (see PROVENANCE.json).

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const MAX_DEPTH = 100;

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    let m;
    const rest = src.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: i }); i += m[0].length;
    } else if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: i }); i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'name', v: m[0], pos: i }); i += m[0].length;
    } else if ('+-*/%^!(),='.includes(ch)) {
      toks.push({ t: 'op', v: ch, pos: i }); i++;
    } else {
      throw new CalcError(`Unexpected character '${ch}'`, i);
    }
  }
  return toks;
}

class Parser {
  constructor(toks, len) { this.toks = toks; this.i = 0; this.len = len; }
  peek() { return this.toks[this.i]; }
  isOp(...ops) { const t = this.peek(); return !!t && t.t === 'op' && ops.includes(t.v); }
  fail(t = this.peek()) {
    throw new CalcError(t ? `Unexpected '${t.v}'` : 'Unexpected end of input', t ? t.pos : this.len);
  }
  expect(op) {
    if (!this.isOp(op)) this.fail();
    return this.toks[this.i++];
  }
  parseAll() {
    const n = this.expr();
    if (this.peek()) this.fail();
    return n;
  }
  expr() {
    let l = this.mul();
    while (this.isOp('+', '-')) {
      const o = this.toks[this.i++];
      l = { k: 'bin', op: o.v, pos: o.pos, l, r: this.mul() };
    }
    return l;
  }
  mul() {
    let l = this.implicit();
    while (this.isOp('*', '/', '%')) {
      const o = this.toks[this.i++];
      l = { k: 'bin', op: o.v, pos: o.pos, l, r: this.implicit() };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      const prev = this.toks[this.i - 1];
      if (!t) break;
      const startsOperand = t.t === 'name' || (t.t === 'op' && t.v === '(');
      const prevOk = prev.t === 'num' || (prev.t === 'op' && (prev.v === ')'));
      if (startsOperand && prevOk) {
        l = { k: 'bin', op: '*', pos: t.pos, l, r: this.unary() };
      } else break;
    }
    return l;
  }
  unary() {
    if (this.isOp('+', '-')) {
      const o = this.toks[this.i++];
      const a = this.unary();
      return o.v === '-' ? { k: 'neg', pos: o.pos, a } : a;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('^')) {
      const o = this.toks[this.i++];
      return { k: 'bin', op: '^', pos: o.pos, l: base, r: this.unary() };
    }
    return base;
  }
  postfix() {
    let n = this.primary();
    while (this.isOp('!')) {
      const o = this.toks[this.i++];
      n = { k: 'fact', pos: o.pos, a: n };
    }
    return n;
  }
  primary() {
    const t = this.peek();
    if (!t) this.fail();
    if (t.t === 'num') { this.i++; return { k: 'num', v: t.v, pos: t.pos }; }
    if (t.t === 'name') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) { this.i++; args.push(this.expr()); }
        }
        this.expect(')');
        return { k: 'call', name: t.v, pos: t.pos, args };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const n = this.expr();
      this.expect(')');
      return n;
    }
    this.fail(t);
  }
}

const check = (v, pos) => {
  if (!Number.isFinite(v)) throw new CalcError('Result is not a finite number', pos);
  return v;
};

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode;
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  const setMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  };
  setMode(angleMode);

  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);
  const dom = (ok, pos, msg) => { if (!ok) throw new CalcError(msg, pos); };

  const B1 = {
    sin: (x) => snap0(Math.sin(toRad(x))),
    cos: (x) => snap0(Math.cos(toRad(x))),
    tan: (x) => snap0(Math.tan(toRad(x))),
    asin: (x, p) => { dom(x >= -1 && x <= 1, p, 'asin domain error'); return fromRad(Math.asin(x)); },
    acos: (x, p) => { dom(x >= -1 && x <= 1, p, 'acos domain error'); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { dom(x >= 0, p, 'sqrt of negative number'); return Math.sqrt(x); },
    cbrt: Math.cbrt,
    abs: Math.abs,
    ln: (x, p) => { dom(x > 0, p, 'ln domain error'); return Math.log(x); },
    log: (x, p) => { dom(x > 0, p, 'log domain error'); return Math.log10(x); },
    log2: (x, p) => { dom(x > 0, p, 'log2 domain error'); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  function snap0(x) { return mode === 'deg' ? snap(x) : x; }

  const B2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      dom(n !== 0, p, 'nroot with zero degree');
      if (x < 0) {
        dom(Number.isInteger(n) && Math.abs(n % 2) === 1, p, 'nroot of negative number');
        return n === 3 ? Math.cbrt(x) : -Math.pow(-x, 1 / n);
      }
      return n === 3 ? Math.cbrt(x) : Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      dom(x > 0 && b > 0 && b !== 1, p, 'logb domain error');
      return Math.log(x) / Math.log(b);
    },
  };
  const BV = {
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, v) => s + v, 0),
    avg: (a) => a.reduce((s, v) => s + v, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in B1 || n in B2 || n in BV;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function lookup(name, env, pos) {
    if (env && env.has(name)) return env.get(name);
    if (has(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function callFn(n, args) {
    const name = n.name;
    const pos = n.pos;
    if (has(B1, name)) {
      dom(args.length === 1, pos, `${name} expects 1 argument`);
      return check(B1[name](args[0], pos), pos);
    }
    if (has(B2, name)) {
      dom(args.length === 2, pos, `${name} expects 2 arguments`);
      return check(B2[name](args[0], args[1], pos), pos);
    }
    if (has(BV, name)) {
      dom(args.length >= 1, pos, `${name} expects at least 1 argument`);
      return check(BV[name](args), pos);
    }
    const f = funcs.get(name);
    if (!f) throw new CalcError(`Undefined function '${name}'`, pos);
    dom(args.length === f.params.length, pos, `${name} expects ${f.params.length} argument(s)`);
    if (depth >= MAX_DEPTH) throw new CalcError('Maximum call depth exceeded', pos);
    const env = new Map(f.params.map((p, i) => [p, args[i]]));
    depth++;
    try { return ev(f.body, env); } finally { depth--; }
  }

  function ev(n, env) {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': return lookup(n.name, env, n.pos);
      case 'neg': return -ev(n.a, env);
      case 'fact': {
        const v = ev(n.a, env);
        dom(Number.isInteger(v) && v >= 0 && v <= 170, n.pos, 'Invalid factorial argument');
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'call': return callFn(n, n.args.map((a) => ev(a, env)));
      case 'bin': {
        const a = ev(n.l, env);
        const b = ev(n.r, env);
        switch (n.op) {
          case '+': return check(a + b, n.pos);
          case '-': return check(a - b, n.pos);
          case '*': return check(a * b, n.pos);
          case '/': dom(b !== 0, n.pos, 'Division by zero'); return check(a / b, n.pos);
          case '%': dom(b !== 0, n.pos, 'Division by zero'); return check(a % b, n.pos);
          case '^': return check(Math.pow(a, b), n.pos);
        }
      }
    }
    throw new CalcError('Internal error', n.pos);
  }

  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    const p = new Parser(toks, input.length);
    // function definition?
    if (toks.length >= 3 && toks[0].t === 'name' && toks[1].t === 'op' && toks[1].v === '(') {
      let j = 2;
      const params = [];
      let ok = true;
      if (toks[j] && toks[j].t === 'op' && toks[j].v === ')') ok = false;
      else {
        for (;;) {
          if (toks[j] && toks[j].t === 'name') params.push(toks[j++]); else { ok = false; break; }
          if (toks[j] && toks[j].t === 'op' && toks[j].v === ',') { j++; continue; }
          break;
        }
        if (ok) ok = !!toks[j] && toks[j].t === 'op' && toks[j].v === ')' &&
          !!toks[j + 1] && toks[j + 1].t === 'op' && toks[j + 1].v === '=';
      }
      if (ok) {
        const name = toks[0].v;
        if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, toks[0].pos);
        if (has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot define '${name}'`, toks[0].pos);
        const seen = new Set();
        for (const pt of params) {
          if (seen.has(pt.v)) throw new CalcError(`Duplicate parameter '${pt.v}'`, pt.pos);
          if (has(CONSTANTS, pt.v) || pt.v === 'ans') throw new CalcError(`Invalid parameter '${pt.v}'`, pt.pos);
          seen.add(pt.v);
        }
        p.i = j + 2;
        const body = p.parseAll();
        funcs.set(name, { params: params.map((x) => x.v), body });
        const sig = `${name}(${params.map((x) => x.v).join(',')})`;
        hist.push({ input, result: sig });
        return sig;
      }
    }
    // assignment?
    if (toks.length >= 2 && toks[0].t === 'name' && toks[1].t === 'op' && toks[1].v === '=') {
      const name = toks[0].v;
      if (has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, toks[0].pos);
      p.i = 2;
      const v = ev(p.parseAll(), null);
      vars.set(name, v);
      ans = v;
      hist.push({ input, result: v });
      return v;
    }
    const v = ev(p.parseAll(), null);
    ans = v;
    hist.push({ input, result: v });
    return v;
  }

  return {
    evaluate,
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable(name) {
      if (has(CONSTANTS, name)) return CONSTANTS[name];
      if (name === 'ans') return ans;
      return vars.get(name);
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME.test(name)) throw new CalcError(`Invalid name '${name}'`, 0);
      if (has(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Invalid value', 0);
      vars.set(name, value);
    },
    variables: () => [...vars.entries()],
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
  };
}
