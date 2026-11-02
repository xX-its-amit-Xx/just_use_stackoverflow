// calc-s2: safe scientific calculator engine (no eval / Function).
// Hand-written tokenizer + recursive-descent parser + AST evaluator.
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
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    let m;
    const rest = src.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start }); i += m[0].length;
    } else if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start }); i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: start }); i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'name', v: m[0], pos: start }); i += m[0].length;
    } else if ('+-*/%^!(),='.includes(ch)) {
      toks.push({ t: 'op', v: ch, pos: start }); i++;
    } else {
      throw new CalcError(`Unexpected character '${ch}' at position ${i}`, i);
    }
  }
  toks.push({ t: 'eof', v: '', pos: n });
  return toks;
}

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  get cur() { return this.toks[this.i]; }
  isOp(v) { const c = this.cur; return c.t === 'op' && c.v === v; }
  fail(tok = this.cur) {
    if (tok.t === 'eof') throw new CalcError('Unexpected end of input', tok.pos);
    throw new CalcError(`Unexpected token '${tok.v}' at position ${tok.pos}`, tok.pos);
  }
  expectOp(v) { if (!this.isOp(v)) this.fail(); return this.toks[this.i++]; }
  parseAll() {
    const e = this.add();
    if (this.cur.t !== 'eof') this.fail();
    return e;
  }
  add() {
    let l = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.toks[this.i++];
      l = { k: 'bin', op: op.v, l, r: this.mul(), pos: op.pos };
    }
    return l;
  }
  mul() {
    let l = this.implicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.toks[this.i++];
      l = { k: 'bin', op: op.v, l, r: this.implicit(), pos: op.pos };
    }
    return l;
  }
  implicit() {
    let l = this.unary();
    for (;;) {
      const prev = this.toks[this.i - 1];
      const c = this.cur;
      const leftOk = prev.t === 'num' || (prev.t === 'op' && prev.v === ')');
      if (leftOk && (c.t === 'name' || (c.t === 'op' && c.v === '('))) {
        l = { k: 'bin', op: '*', l, r: this.unary(), pos: c.pos };
      } else break;
    }
    return l;
  }
  unary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.toks[this.i++];
      const arg = this.unary();
      return op.v === '-' ? { k: 'neg', arg, pos: op.pos } : arg;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('^')) {
      const op = this.toks[this.i++];
      const exp = this.powerExp();
      return { k: 'bin', op: '^', l: base, r: exp, pos: op.pos };
    }
    return base;
  }
  powerExp() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.toks[this.i++];
      const arg = this.powerExp();
      return op.v === '-' ? { k: 'neg', arg, pos: op.pos } : arg;
    }
    return this.power();
  }
  postfix() {
    let e = this.primary();
    while (this.isOp('!')) {
      const op = this.toks[this.i++];
      e = { k: 'fact', arg: e, pos: op.pos };
    }
    return e;
  }
  primary() {
    const c = this.cur;
    if (c.t === 'num') { this.i++; return { k: 'num', v: c.v, pos: c.pos }; }
    if (c.t === 'name') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.add());
          while (this.isOp(',')) { this.i++; args.push(this.add()); }
        }
        this.expectOp(')');
        return { k: 'call', name: c.v, args, pos: c.pos };
      }
      return { k: 'var', name: c.v, pos: c.pos };
    }
    if (this.isOp('(')) {
      this.i++;
      const e = this.add();
      this.expectOp(')');
      return e;
    }
    this.fail();
  }
}

function chk(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
  return v;
}
function domain(cond, msg, pos) { if (!cond) throw new CalcError(`Domain error: ${msg}`, pos); }
const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial too large', pos);
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];

  function setMode(m) {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  }
  setMode(angleMode);

  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);

  const f1 = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, p) => { domain(x >= -1 && x <= 1, 'asin', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { domain(x >= -1 && x <= 1, 'acos', p); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { domain(x >= 0, 'sqrt of negative', p); return Math.sqrt(x); },
    cbrt: Math.cbrt, abs: Math.abs,
    ln: (x, p) => { domain(x > 0, 'ln requires positive argument', p); return Math.log(x); },
    log: (x, p) => { domain(x > 0, 'log requires positive argument', p); return Math.log10(x); },
    log2: (x, p) => { domain(x > 0, 'log2 requires positive argument', p); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  const f2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      domain(n !== 0, 'nroot with n = 0', p);
      if (x < 0) {
        domain(Number.isInteger(n) && Math.abs(n % 2) === 1, 'even root of negative', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      domain(x > 0 && b > 0 && b !== 1, 'logb', p);
      return Math.log(x) / Math.log(b);
    },
  };
  const fv = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, v) => s + v, 0),
    avg: (a) => a.reduce((s, v) => s + v, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in f1 && Object.hasOwn(f1, n) || Object.hasOwn(f2, n) || Object.hasOwn(fv, n);

  function ev(node, scope, depth) {
    switch (node.k) {
      case 'num': return node.v;
      case 'var': {
        if (scope && scope.has(node.name)) return scope.get(node.name);
        if (node.name === 'ans') return ans;
        if (Object.hasOwn(CONSTANTS, node.name)) return CONSTANTS[node.name];
        if (vars.has(node.name)) return vars.get(node.name);
        throw new CalcError(`Undefined variable '${node.name}'`, node.pos);
      }
      case 'neg': return -ev(node.arg, scope, depth);
      case 'fact': return factorial(ev(node.arg, scope, depth), node.pos);
      case 'bin': {
        const a = ev(node.l, scope, depth);
        const b = ev(node.r, scope, depth);
        switch (node.op) {
          case '+': return chk(a + b, node.pos);
          case '-': return chk(a - b, node.pos);
          case '*': return chk(a * b, node.pos);
          case '/': if (b === 0) throw new CalcError('Division by zero', node.pos); return chk(a / b, node.pos);
          case '%': if (b === 0) throw new CalcError('Division by zero', node.pos); return chk(a % b, node.pos);
          case '^': return chk(Math.pow(a, b), node.pos);
        }
        throw new CalcError('Bad operator', node.pos);
      }
      case 'call': return call(node, scope, depth);
    }
    throw new CalcError('Bad node', node.pos);
  }

  function call(node, scope, depth) {
    const { name, pos } = node;
    const arity = (n) => {
      if (node.args.length !== n) throw new CalcError(`${name} expects ${n} argument(s), got ${node.args.length}`, pos);
    };
    if (funcs.has(name)) {
      const fn = funcs.get(name);
      arity(fn.params.length);
      const args = node.args.map((a) => ev(a, scope, depth));
      if (depth + 1 > MAX_DEPTH) throw new CalcError('Maximum call depth exceeded (recursion)', pos);
      const sc = new Map();
      fn.params.forEach((p, i) => sc.set(p, args[i]));
      return chk(ev(fn.body, sc, depth + 1), pos);
    }
    const args = () => node.args.map((a) => ev(a, scope, depth));
    if (Object.hasOwn(f1, name)) { arity(1); return chk(f1[name](args()[0], pos), pos); }
    if (Object.hasOwn(f2, name)) { arity(2); const a = args(); return chk(f2[name](a[0], a[1], pos), pos); }
    if (Object.hasOwn(fv, name)) {
      if (node.args.length < 1) throw new CalcError(`${name} expects at least 1 argument`, pos);
      return chk(fv[name](args()), pos);
    }
    throw new CalcError(`Undefined function '${name}'`, pos);
  }

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    const p = new Parser(toks);
    const t0 = toks[0];
    // function definition: name ( params ) =
    if (t0.t === 'name' && toks[1].t === 'op' && toks[1].v === '(') {
      let j = 2;
      const params = [];
      let isDef = false;
      if (toks[j].t === 'name') {
        while (toks[j].t === 'name') {
          params.push(toks[j]);
          j++;
          if (toks[j].t === 'op' && toks[j].v === ',') j++; else break;
        }
        if (toks[j].t === 'op' && toks[j].v === ')' && toks[j + 1].t === 'op' && toks[j + 1].v === '=') isDef = true;
      }
      if (isDef) {
        if (isBuiltin(t0.v) || Object.hasOwn(CONSTANTS, t0.v) || t0.v === 'ans') {
          throw new CalcError(`Cannot redefine '${t0.v}'`, t0.pos);
        }
        const seen = new Set();
        for (const q of params) {
          if (seen.has(q.v)) throw new CalcError(`Duplicate parameter '${q.v}'`, q.pos);
          seen.add(q.v);
        }
        p.i = j + 2;
        const body = p.parseAll();
        const names = params.map((q) => q.v);
        funcs.set(t0.v, { params: names, body });
        return { value: `${t0.v}(${names.join(',')})`, setAns: false };
      }
    }
    if (t0.t === 'name' && toks[1].t === 'op' && toks[1].v === '=') {
      if (Object.hasOwn(CONSTANTS, t0.v) || t0.v === 'ans') {
        throw new CalcError(`Cannot assign to '${t0.v}'`, t0.pos);
      }
      p.i = 2;
      const expr = p.parseAll();
      const v = chk(ev(expr, null, 0), t0.pos);
      vars.set(t0.v, v);
      return { value: v, setAns: true };
    }
    const expr = p.parseAll();
    return { value: chk(ev(expr, null, 0), 0), setAns: true };
  }

  const c = {
    evaluate(input) {
      const { value, setAns } = run(input);
      if (setAns) ans = value;
      hist.push({ input, result: value });
      return value;
    },
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable: (name) => (name === 'ans' ? ans : vars.get(name) ?? (Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined)),
    setVariable(name, value) {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CalcError(`Invalid name '${name}'`, 0);
      if (Object.hasOwn(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number') throw new CalcError('Value must be a number', 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
    // names of user variables (for REPL)
    _userVars: () => [...vars.keys()],
  };
  return c;
}
