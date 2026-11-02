export class CalcError extends Error {
  constructor(message, position = 0) { super(message); this.name = 'CalcError'; this.position = position; }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);
const F1 = {
  sin: 'trig', cos: 'trig', tan: 'trig', asin: 'atrig', acos: 'atrig', atan: 'atrig',
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  sqrt: (x) => { if (x < 0) throw new Error('sqrt of negative number'); return Math.sqrt(x); },
  ln: (x) => { if (x <= 0) throw new Error('ln domain error'); return Math.log(x); },
  log: (x) => { if (x <= 0) throw new Error('log domain error'); return Math.log10(x); },
  log2: (x) => { if (x <= 0) throw new Error('log2 domain error'); return Math.log2(x); },
  round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
};
const F2 = {
  atan2: 'atan2', pow: (x, y) => Math.pow(x, y),
  nroot: (x, n) => {
    if (n === 0) throw new Error('nroot with n = 0');
    if (x < 0) {
      if (!Number.isInteger(n) || Math.abs(n % 2) !== 1) throw new Error('even root of negative number');
      return -Math.pow(-x, 1 / n);
    }
    return Math.pow(x, 1 / n);
  },
  logb: (x, b) => {
    if (x <= 0 || b <= 0) throw new Error('logb domain error');
    if (b === 1) throw new Error('division by zero');
    return Math.log(x) / Math.log(b);
  },
};
const FV = {
  min: (a) => Math.min(...a), max: (a) => Math.max(...a),
  sum: (a) => a.reduce((s, v) => s + v, 0), avg: (a) => a.reduce((s, v) => s + v, 0) / a.length,
  hypot: (a) => Math.hypot(...a),
};
const isBuiltin = (n) => n in F1 || n in F2 || n in FV;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function tokenize(s) {
  const t = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = s.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) t.push({ k: 'num', v: parseInt(m[0].slice(2), 16), p: i, end: i + m[0].length });
    else if ((m = /^0[bB][01]+/.exec(rest))) t.push({ k: 'num', v: parseInt(m[0].slice(2), 2), p: i, end: i + m[0].length });
    else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) t.push({ k: 'num', v: Number(m[0]), p: i, end: i + m[0].length });
    else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) t.push({ k: 'id', v: m[0], p: i, end: i + m[0].length });
    else if ('+-*/%^!(),='.includes(c)) { t.push({ k: 'op', v: c, p: i, end: i + 1 }); m = [c]; }
    else throw new CalcError(`Unexpected character '${c}'`, i);
    i += m[0].length;
  }
  t.push({ k: 'eof', p: s.length });
  return t;
}

function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v) => toks[i].k === 'op' && toks[i].v === v;
  const fail = (tok = toks[i]) => {
    throw new CalcError(tok.k === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.v}'`, tok.p);
  };
  const expect = (v) => { if (!isOp(v)) fail(); i++; };

  function additive() {
    let l = multiplicative();
    while (isOp('+') || isOp('-')) {
      const t = toks[i++];
      l = { t: 'bin', op: t.v, l, r: multiplicative(), p: t.p };
    }
    return l;
  }
  function multiplicative() {
    let l = implicit();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const t = toks[i++];
      l = { t: 'bin', op: t.v, l, r: implicit(), p: t.p };
    }
    return l;
  }
  function implicit() {
    let l = unary();
    for (;;) {
      const prev = toks[i - 1];
      const p = peek();
      const ok = (prev.k === 'num' || (prev.k === 'op' && prev.v === ')')) && (p.k === 'id' || (p.k === 'op' && p.v === '('));
      if (!ok) return l;
      l = { t: 'bin', op: '*', l, r: unary(), p: p.p };
    }
  }
  function unary() {
    if (isOp('-') || isOp('+')) {
      const t = toks[i++];
      const a = unary();
      return t.v === '-' ? { t: 'neg', a } : a;
    }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp('^')) {
      const t = toks[i++];
      return { t: 'bin', op: '^', l: base, r: powExponent(), p: t.p };
    }
    return base;
  }
  function powExponent() {
    if (isOp('-') || isOp('+')) {
      const t = toks[i++];
      const a = powExponent();
      return t.v === '-' ? { t: 'neg', a } : a;
    }
    return power();
  }
  function postfix() {
    let a = primary();
    while (isOp('!')) { const t = toks[i++]; a = { t: 'fact', a, p: t.p }; }
    return a;
  }
  function primary() {
    const t = toks[i];
    if (t.k === 'num') { i++; return { t: 'num', v: t.v }; }
    if (t.k === 'id') {
      i++;
      if (isOp('(')) {
        i++;
        const args = [];
        if (!isOp(')')) {
          args.push(additive());
          while (isOp(',')) { i++; args.push(additive()); }
        }
        expect(')');
        return { t: 'call', name: t.v, args, p: t.p };
      }
      return { t: 'var', name: t.v, p: t.p };
    }
    if (t.k === 'op' && t.v === '(') {
      i++;
      const e = additive();
      expect(')');
      return e;
    }
    return fail();
  }
  return {
    expr() { const e = additive(); if (toks[i].k !== 'eof') fail(); return e; },
    setPos(n) { i = n; },
  };
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode;
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  const setMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  };
  setMode(angleMode);

  const check = (v, p) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Result is not finite', p);
    return v;
  };

  function callBuiltin(name, a, p) {
    const deg = mode === 'deg';
    let r;
    try {
      if (has(F1, name)) {
        if (a.length !== 1) throw new CalcError(`${name} expects 1 argument`, p);
        const f = F1[name], x = a[0];
        if (f === 'trig') {
          r = Math[name](deg ? (x * Math.PI) / 180 : x);
          if (deg) r = snap(r);
        } else if (f === 'atrig') {
          if ((name === 'asin' || name === 'acos') && Math.abs(x) > 1) throw new Error(`${name} domain error`);
          r = Math[name](x);
          if (deg) r = (r * 180) / Math.PI;
        } else r = f(x);
      } else if (has(F2, name)) {
        if (a.length !== 2) throw new CalcError(`${name} expects 2 arguments`, p);
        if (F2[name] === 'atan2') {
          r = Math.atan2(a[0], a[1]);
          if (deg) r = (r * 180) / Math.PI;
        } else r = F2[name](a[0], a[1]);
      } else {
        if (a.length < 1) throw new CalcError(`${name} expects at least 1 argument`, p);
        r = FV[name](a);
      }
    } catch (e) {
      if (e instanceof CalcError) throw e;
      throw new CalcError(e.message, p);
    }
    return check(r, p);
  }

  function ev(n, scope, depth) {
    switch (n.t) {
      case 'num': return n.v;
      case 'neg': return -ev(n.a, scope, depth);
      case 'var': {
        if (scope && has(scope, n.name)) return scope[n.name];
        if (has(CONSTS, n.name)) return CONSTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw new CalcError(`Undefined variable: ${n.name}`, n.p);
      }
      case 'fact': {
        const x = ev(n.a, scope, depth);
        if (!Number.isInteger(x) || x < 0 || x > 170) throw new CalcError('Invalid factorial operand', n.p);
        let r = 1;
        for (let k = 2; k <= x; k++) r *= k;
        return r;
      }
      case 'bin': {
        const a = ev(n.l, scope, depth), b = ev(n.r, scope, depth);
        switch (n.op) {
          case '+': return check(a + b, n.p);
          case '-': return check(a - b, n.p);
          case '*': return check(a * b, n.p);
          case '/': if (b === 0) throw new CalcError('Division by zero', n.p); return check(a / b, n.p);
          case '%': if (b === 0) throw new CalcError('Division by zero', n.p); return check(a % b, n.p);
          case '^': return check(Math.pow(a, b), n.p);
        }
        break;
      }
      case 'call': {
        if (funcs.has(n.name)) {
          const f = funcs.get(n.name);
          const args = n.args.map((x) => ev(x, scope, depth));
          if (args.length !== f.params.length) throw new CalcError(`${n.name} expects ${f.params.length} arguments`, n.p);
          if (depth + 1 > 100) throw new CalcError('Maximum call depth exceeded', n.p);
          const sc = {};
          f.params.forEach((p, k) => { sc[p] = args[k]; });
          return check(ev(f.body, sc, depth + 1), n.p);
        }
        if (isBuiltin(n.name)) return callBuiltin(n.name, n.args.map((x) => ev(x, scope, depth)), n.p);
        throw new CalcError(`Unknown function: ${n.name}`, n.p);
      }
    }
    throw new CalcError('Internal error', 0);
  }

  const reserved = (name) => name === 'ans' || has(CONSTS, name);

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    if (toks[0].k === 'eof') throw new CalcError('Empty input', 0);
    const ps = parse(toks);
    const isEq = (k) => toks[k] && toks[k].k === 'op' && toks[k].v === '=';
    if (toks[0].k === 'id' && isEq(1)) {
      const name = toks[0].v;
      if (reserved(name)) throw new CalcError(`Cannot assign to ${name}`, 0);
      ps.setPos(2);
      const v = ev(ps.expr(), null, 0);
      vars.set(name, v);
      ans = v;
      return v;
    }
    if (toks[0].k === 'id' && toks[1].k === 'op' && toks[1].v === '(') {
      let k = 2;
      const params = [];
      let okSig = true;
      if (toks[k].k === 'id') {
        params.push(toks[k++]);
        while (toks[k].k === 'op' && toks[k].v === ',' && toks[k + 1].k === 'id') { params.push(toks[k + 1]); k += 2; }
      } else okSig = false;
      if (okSig && toks[k].k === 'op' && toks[k].v === ')' && isEq(k + 1)) {
        const name = toks[0].v;
        if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in function ${name}`, 0);
        if (reserved(name)) throw new CalcError(`Cannot define function named ${name}`, 0);
        const seen = new Set();
        for (const p of params) {
          if (seen.has(p.v)) throw new CalcError(`Duplicate parameter ${p.v}`, p.p);
          seen.add(p.v);
        }
        ps.setPos(k + 2);
        const body = ps.expr();
        funcs.set(name, { params: params.map((p) => p.v), body });
        return `${name}(${params.map((p) => p.v).join(',')})`;
      }
    }
    // reject stray '=' with a precise position
    const v = ev(ps.expr(), null, 0);
    ans = v;
    return v;
  }

  const c = {
    evaluate(input) {
      const r = run(input);
      hist.push({ input, result: r });
      return r;
    },
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable: (name) => (has(CONSTS, name) ? CONSTS[name] : name === 'ans' ? ans : vars.get(name)),
    setVariable(name, value) {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CalcError(`Invalid name: ${name}`, 0);
      if (reserved(name)) throw new CalcError(`Cannot assign to ${name}`, 0);
      if (typeof value !== 'number') throw new CalcError('Value must be a number', 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
    _vars: () => vars,
  };
  return c;
}
