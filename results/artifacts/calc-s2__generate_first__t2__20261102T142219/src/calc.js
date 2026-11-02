export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const isDigit = (c) => c >= '0' && c <= '9';
const isIdStart = (c) => /[A-Za-z_]/.test(c);
const isId = (c) => /[A-Za-z0-9_]/.test(c);

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] || ''))) {
      let m;
      if ((m = /^0[xX][0-9a-fA-F]+/.exec(s.slice(i)))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start, end: i + m[0].length });
        i += m[0].length;
      } else if ((m = /^0[bB][01]+/.exec(s.slice(i)))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start, end: i + m[0].length });
        i += m[0].length;
      } else {
        m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        const v = Number(m[0]);
        if (!Number.isFinite(v)) throw new CalcError('Number too large', start);
        toks.push({ t: 'num', v, pos: start, end: i + m[0].length });
        i += m[0].length;
      }
      if (i < s.length && s[i] === '.' && false) i++;
      continue;
    }
    if (isIdStart(c)) {
      while (i < s.length && isId(s[i])) i++;
      toks.push({ t: 'name', v: s.slice(start, i), pos: start, end: i });
      continue;
    }
    if ('+-*/%^!(),='.includes(c)) {
      toks.push({ t: c, pos: start, end: i + 1 });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}'`, start);
  }
  toks.push({ t: 'eof', pos: s.length, end: s.length });
  return toks;
}

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  get cur() { return this.toks[this.i]; }
  get prev() { return this.toks[this.i - 1]; }
  fail(tok = this.cur) {
    throw new CalcError(tok.t === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.v ?? tok.t}'`, tok.pos);
  }
  expect(t) { if (this.cur.t !== t) this.fail(); return this.toks[this.i++]; }
  parseAll() {
    const n = this.add();
    if (this.cur.t !== 'eof') this.fail();
    return n;
  }
  add() {
    let l = this.mul();
    while (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.cur; this.i++;
      l = { k: 'bin', op: op.t, l, r: this.mul(), pos: op.pos };
    }
    return l;
  }
  mul() {
    let l = this.implicit();
    while (['*', '/', '%'].includes(this.cur.t)) {
      const op = this.cur; this.i++;
      l = { k: 'bin', op: op.t, l, r: this.implicit(), pos: op.pos };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    for (;;) {
      const p = this.prev, c = this.cur;
      if ((p.t === 'num' || p.t === ')') && (c.t === 'name' || c.t === '(')) {
        l = { k: 'bin', op: '*', l, r: this.power(), pos: c.pos };
      } else break;
    }
    return l;
  }
  unary() {
    if (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.cur; this.i++;
      const a = this.unary();
      return op.t === '-' ? { k: 'neg', a, pos: op.pos } : a;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.cur.t === '^') {
      const op = this.cur; this.i++;
      return { k: 'bin', op: '^', l: base, r: this.powExp(), pos: op.pos };
    }
    return base;
  }
  powExp() {
    if (this.cur.t === '+' || this.cur.t === '-') {
      const op = this.cur; this.i++;
      const a = this.powExp();
      return op.t === '-' ? { k: 'neg', a, pos: op.pos } : a;
    }
    return this.power();
  }
  postfix() {
    let n = this.primary();
    while (this.cur.t === '!') {
      n = { k: 'fact', a: n, pos: this.cur.pos }; this.i++;
    }
    return n;
  }
  primary() {
    const t = this.cur;
    if (t.t === 'num') { this.i++; return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      this.i++;
      if (this.cur.t === '(') {
        this.i++;
        const args = [];
        if (this.cur.t === ')') this.fail();
        for (;;) {
          args.push(this.add());
          if (this.cur.t === ',') { this.i++; continue; }
          break;
        }
        this.expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (t.t === '(') {
      this.i++;
      const n = this.add();
      this.expect(')');
      return n;
    }
    this.fail();
  }
}

const rad = (x) => x;
function fin(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
  return v;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = angleMode;
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;
  if (mode !== 'rad' && mode !== 'deg') throw new CalcError('Invalid angle mode', 0);

  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);
  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);

  const dom = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

  const b1 = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, p) => { dom(Math.abs(x) <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { dom(Math.abs(x) <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); },
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
  const b2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      dom(n !== 0, 'nroot: zero degree', p);
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
  const bv = {
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in b1 || n in b2 || n in bv;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function ev(n, env) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.a, env);
      case 'var': {
        if (env && env.has(n.name)) return env.get(n.name);
        if (has(CONSTS, n.name)) return CONSTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw new CalcError(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'fact': {
        const v = ev(n.a, env);
        if (!Number.isInteger(v) || v < 0 || v > 170) throw new CalcError('Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = ev(n.l, env), b = ev(n.r, env);
        switch (n.op) {
          case '+': return fin(a + b, n.pos);
          case '-': return fin(a - b, n.pos);
          case '*': return fin(a * b, n.pos);
          case '/': if (b === 0) throw new CalcError('Division by zero', n.pos); return fin(a / b, n.pos);
          case '%': if (b === 0) throw new CalcError('Division by zero', n.pos); return fin(a % b, n.pos);
          case '^': return fin(Math.pow(a, b), n.pos);
        }
        break;
      }
      case 'call': return call(n, env);
    }
    throw new CalcError('Internal error', 0);
  }

  function call(n, env) {
    const { name, args, pos } = n;
    if (has(b1, name) || has(b2, name) || has(bv, name)) {
      const vals = args.map((a) => ev(a, env));
      let r;
      if (has(b1, name)) {
        if (vals.length !== 1) throw new CalcError(`${name} expects 1 argument`, pos);
        r = b1[name](vals[0], pos);
      } else if (has(b2, name)) {
        if (vals.length !== 2) throw new CalcError(`${name} expects 2 arguments`, pos);
        r = b2[name](vals[0], vals[1], pos);
      } else {
        if (vals.length < 1) throw new CalcError(`${name} expects at least 1 argument`, pos);
        r = bv[name](vals);
      }
      return fin(r, pos);
    }
    const f = funcs.get(name);
    if (!f) throw new CalcError(`Undefined function '${name}'`, pos);
    if (args.length !== f.params.length) throw new CalcError(`${name} expects ${f.params.length} argument(s)`, pos);
    const vals = args.map((a) => ev(a, env));
    if (depth >= 100) throw new CalcError('Maximum call depth exceeded', pos);
    const e2 = new Map();
    f.params.forEach((p, i) => e2.set(p, vals[i]));
    depth++;
    try { return ev(f.body, e2); } finally { depth--; }
  }

  const c = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      depth = 0;
      const toks = tokenize(input);
      if (toks.length === 1) throw new CalcError('Empty input', 0);
      // function definition
      if (toks[0].t === 'name' && toks[1].t === '(') {
        let j = 2, ok = true;
        const params = [];
        if (toks[j].t === ')') ok = false;
        else {
          for (;;) {
            if (toks[j].t !== 'name') { ok = false; break; }
            params.push(toks[j]); j++;
            if (toks[j].t === ',') { j++; continue; }
            break;
          }
          if (ok && (toks[j].t !== ')' || toks[j + 1].t !== '=')) ok = false;
        }
        if (ok) {
          const name = toks[0].v;
          if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, toks[0].pos);
          if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot define function '${name}'`, toks[0].pos);
          const seen = new Set();
          for (const p of params) {
            if (seen.has(p.v)) throw new CalcError(`Duplicate parameter '${p.v}'`, p.pos);
            seen.add(p.v);
          }
          const parser = new Parser(toks);
          parser.i = j + 2;
          const body = parser.parseAll();
          funcs.set(name, { params: params.map((p) => p.v), body });
          const sig = `${name}(${params.map((p) => p.v).join(',')})`;
          hist.push({ input, result: sig });
          return sig;
        }
      }
      let result;
      if (toks[0].t === 'name' && toks[1].t === '=') {
        const name = toks[0].v;
        if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, toks[0].pos);
        const parser = new Parser(toks);
        parser.i = 2;
        const v = ev(parser.parseAll(), null);
        vars.set(name, v);
        result = v;
      } else {
        result = ev(new Parser(toks).parseAll(), null);
      }
      ans = result;
      hist.push({ input, result });
      return result;
    },
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError('Invalid angle mode', 0);
      mode = m;
    },
    getAngleMode: () => mode,
    getVariable: (name) => (name === 'ans' ? ans : has(CONSTS, name) ? CONSTS[name] : vars.get(name)),
    setVariable(name, value) {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CalcError('Invalid variable name', 0);
      if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number') throw new CalcError('Value must be a number', 0);
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
