export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const fail = (m, p) => { throw new CalcError(m, p); };

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    let m;
    const rest = s.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start, end: start + m[0].length });
      i += m[0].length;
    } else if ((m = /^0[bB][01]+/.exec(rest))) {
      toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start, end: start + m[0].length });
      i += m[0].length;
    } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ t: 'num', v: Number(m[0]), pos: start, end: start + m[0].length });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ t: 'name', v: m[0], pos: start, end: start + m[0].length });
      i += m[0].length;
    } else if ('+-*/%^!(),='.includes(c)) {
      toks.push({ t: c, pos: start, end: start + 1 });
      i++;
    } else fail(`Unexpected character '${c}'`, i);
  }
  toks.push({ t: 'eof', pos: s.length, end: s.length });
  return toks;
}

function fact(n, pos) {
  if (!Number.isInteger(n) || n < 0) fail('Factorial requires a non-negative integer', pos);
  if (n > 170) fail('Factorial too large', pos);
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function parse(toks, input) {
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const unexpected = (tk) => fail(tk.t === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tk.t === 'num' ? input.slice(tk.pos, tk.end) : tk.v ?? tk.t}'`, tk.pos);
  const expect = (t) => { const tk = peek(); if (tk.t !== t) unexpected(tk); return next(); };

  function expr() { return add(); }
  function add() {
    let l = mul();
    while (peek().t === '+' || peek().t === '-') {
      const op = next();
      l = { k: 'bin', op: op.t, l, r: mul(), pos: op.pos };
    }
    return l;
  }
  function mul() {
    let l = implicit();
    while (['*', '/', '%'].includes(peek().t)) {
      const op = next();
      l = { k: 'bin', op: op.t, l, r: implicit(), pos: op.pos };
    }
    return l;
  }
  function implicit() {
    let l = unary();
    for (;;) {
      const tk = peek();
      const prev = toks[i - 1];
      if ((tk.t === 'name' || tk.t === '(') && (prev.t === 'num' || prev.t === ')')) {
        l = { k: 'bin', op: '*', l, r: power(), pos: tk.pos };
      } else break;
    }
    return l;
  }
  function unary() {
    const tk = peek();
    if (tk.t === '-' || tk.t === '+') {
      next();
      const o = unary();
      return tk.t === '-' ? { k: 'neg', o } : o;
    }
    return power();
  }
  function power() {
    const base = postfix();
    if (peek().t === '^') {
      const op = next();
      return { k: 'bin', op: '^', l: base, r: powExp(), pos: op.pos };
    }
    return base;
  }
  function powExp() {
    const tk = peek();
    if (tk.t === '-' || tk.t === '+') {
      next();
      const o = powExp();
      return tk.t === '-' ? { k: 'neg', o } : o;
    }
    return power();
  }
  function postfix() {
    let a = atom();
    while (peek().t === '!') {
      const op = next();
      a = { k: 'fact', o: a, pos: op.pos };
    }
    return a;
  }
  function atom() {
    const tk = next();
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (tk.t === 'name') {
      if (peek().t === '(') {
        next();
        const args = [];
        if (peek().t !== ')') {
          args.push(expr());
          while (peek().t === ',') { next(); args.push(expr()); }
        }
        expect(')');
        return { k: 'call', name: tk.v, args, pos: tk.pos };
      }
      return { k: 'var', name: tk.v, pos: tk.pos };
    }
    unexpected(tk);
  }
  return { expr, peek, done: () => { const tk = peek(); if (tk.t !== 'eof') unexpected(tk); }, setPos: (n) => { i = n; } };
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  function setAngleMode(m) {
    if (m !== 'rad' && m !== 'deg') fail(`Invalid angle mode '${m}'`, 0);
    mode = m;
  }
  setAngleMode(angleMode);

  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

  const domain = (cond, msg, pos) => { if (!cond) fail(msg, pos); };
  const B1 = {
    sin: (x) => snap(Math.sin(toRad(x))) ,
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, p) => { domain(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { domain(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { domain(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); },
    cbrt: Math.cbrt, abs: Math.abs,
    ln: (x, p) => { domain(x > 0, 'ln domain error', p); return Math.log(x); },
    log: (x, p) => { domain(x > 0, 'log domain error', p); return Math.log10(x); },
    log2: (x, p) => { domain(x > 0, 'log2 domain error', p); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  const B2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      domain(n !== 0, 'nroot: zero degree', p);
      if (x < 0) {
        domain(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot: even root of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      domain(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
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
  const isBuiltin = (n) => n in B1 && Object.hasOwn(B1, n) || Object.hasOwn(B2, n) || Object.hasOwn(BV, n);

  const fin = (v, pos) => { if (!Number.isFinite(v)) fail('Result is not a finite number', pos); return v; };

  function ev(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.o, scope);
      case 'fact': return fact(ev(n.o, scope), n.pos);
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (n.name === 'ans') return ans;
        if (Object.hasOwn(CONSTS, n.name)) return CONSTS[n.name];
        if (vars.has(n.name)) return vars.get(n.name);
        return fail(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'bin': {
        const a = ev(n.l, scope);
        const b = ev(n.r, scope);
        let r;
        switch (n.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': if (b === 0) fail('Division by zero', n.pos); r = a / b; break;
          case '%': if (b === 0) fail('Division by zero', n.pos); r = a % b; break;
          case '^': r = Math.pow(a, b); break;
        }
        return fin(r, n.pos);
      }
      case 'call': {
        const args = n.args.map((a) => ev(a, scope));
        const name = n.name;
        const arity = (k) => { if (args.length !== k) fail(`${name} expects ${k} argument(s), got ${args.length}`, n.pos); };
        if (Object.hasOwn(B1, name)) { arity(1); return fin(B1[name](args[0], n.pos), n.pos); }
        if (Object.hasOwn(B2, name)) { arity(2); return fin(B2[name](args[0], args[1], n.pos), n.pos); }
        if (Object.hasOwn(BV, name)) {
          if (args.length < 1) fail(`${name} expects at least 1 argument`, n.pos);
          return fin(BV[name](args), n.pos);
        }
        const f = funcs.get(name);
        if (!f) return fail(`Undefined function '${name}'`, n.pos);
        if (args.length !== f.params.length) fail(`${name} expects ${f.params.length} argument(s), got ${args.length}`, n.pos);
        if (depth >= 100) fail('Maximum call depth exceeded', n.pos);
        const sc = new Map();
        f.params.forEach((p, k) => sc.set(p, args[k]));
        depth++;
        try { return fin(ev(f.body, sc), n.pos); } finally { depth--; }
      }
    }
  }

  function evaluate(input) {
    if (typeof input !== 'string') fail('Input must be a string', 0);
    const toks = tokenize(input);
    const p = parse(toks, input);
    // function definition
    if (toks[0].t === 'name' && toks[1].t === '(') {
      let j = 2;
      const params = [];
      let ok = true;
      if (toks[j].t === ')') ok = false;
      while (ok) {
        if (toks[j].t !== 'name') { ok = false; break; }
        params.push(toks[j]); j++;
        if (toks[j].t === ',') { j++; continue; }
        if (toks[j].t === ')' && toks[j + 1].t === '=') break;
        ok = false;
      }
      if (ok) {
        const name = toks[0].v;
        if (isBuiltin(name)) fail(`Cannot redefine built-in function '${name}'`, toks[0].pos);
        const seen = new Set();
        for (const pt of params) {
          if (seen.has(pt.v)) fail(`Duplicate parameter '${pt.v}'`, pt.pos);
          seen.add(pt.v);
          if (Object.hasOwn(CONSTS, pt.v) || pt.v === 'ans') fail(`Invalid parameter '${pt.v}'`, pt.pos);
        }
        p.setPos(j + 2);
        const body = p.expr();
        p.done();
        funcs.set(name, { params: params.map((t) => t.v), body });
        const sig = `${name}(${params.map((t) => t.v).join(',')})`;
        hist.push({ input, result: sig });
        return sig;
      }
    }
    let target = null;
    if (toks[0].t === 'name' && toks[1].t === '=') {
      target = toks[0];
      if (Object.hasOwn(CONSTS, target.v) || target.v === 'ans') fail(`Cannot assign to '${target.v}'`, target.pos);
      p.setPos(2);
    }
    const tree = p.expr();
    p.done();
    depth = 0;
    const v = ev(tree, null);
    if (target) vars.set(target.v, v);
    ans = v;
    hist.push({ input, result: v });
    return v;
  }

  return {
    evaluate,
    setAngleMode,
    getAngleMode: () => mode,
    getVariable: (n) => (n === 'ans' ? ans : vars.get(n)),
    setVariable(n, v) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) fail(`Invalid name '${n}'`, 0);
      if (Object.hasOwn(CONSTS, n) || n === 'ans') fail(`Cannot assign to '${n}'`, 0);
      if (typeof v !== 'number') fail('Value must be a number', 0);
      vars.set(n, v);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
    _vars: vars,
  };
}
