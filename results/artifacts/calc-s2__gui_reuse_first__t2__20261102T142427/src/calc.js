// calc-s2: safe scientific calculator engine (written from scratch; no eval).
export class CalcError extends Error {
  constructor(message, position = 0) { super(message); this.name = 'CalcError'; this.position = position; }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;

function tokenize(s) {
  const toks = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    let m;
    const rest = s.slice(i);
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) { toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: start }); i += m[0].length; }
    else if ((m = /^0[bB][01]+/.exec(rest))) { toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: start }); i += m[0].length; }
    else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { toks.push({ t: 'num', v: Number(m[0]), pos: start }); i += m[0].length; }
    else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) { toks.push({ t: 'name', v: m[0], pos: start }); i += m[0].length; }
    else if ('+-*/%^!(),='.includes(ch)) { toks.push({ t: 'op', v: ch, pos: start }); i++; }
    else throw new CalcError(`Unexpected character '${ch}' at position ${i}`, i);
  }
  toks.push({ t: 'end', pos: s.length });
  return toks;
}

// ---- parser -> AST ----
function parseExpr(toks, from, len) {
  let p = from;
  const peek = () => toks[p];
  const isOp = (v) => toks[p].t === 'op' && toks[p].v === v;
  const fail = (tok = toks[p]) => {
    const what = tok.t === 'end' ? 'end of input' : `'${tok.v}'`;
    throw new CalcError(`Unexpected ${what} at position ${tok.pos}`, tok.pos);
  };
  const expect = (v) => { if (!isOp(v)) fail(); p++; };

  function additive() {
    let l = mul();
    while (isOp('+') || isOp('-')) { const o = toks[p++]; l = { k: 'bin', op: o.v, l, r: mul(), pos: o.pos }; }
    return l;
  }
  function mul() {
    let l = implicit();
    while (isOp('*') || isOp('/') || isOp('%')) { const o = toks[p++]; l = { k: 'bin', op: o.v, l, r: implicit(), pos: o.pos }; }
    return l;
  }
  function implicit() {
    let l = unary();
    for (;;) {
      const prev = toks[p - 1], t = toks[p];
      const after = prev.t === 'num' || (prev.t === 'op' && prev.v === ')');
      if (after && (t.t === 'name' || (t.t === 'op' && t.v === '('))) {
        l = { k: 'bin', op: '*', l, r: unary(), pos: t.pos };
      } else return l;
    }
  }
  function unary() {
    if (isOp('-') || isOp('+')) { const o = toks[p++]; return { k: 'un', op: o.v, e: unary(), pos: o.pos }; }
    return power();
  }
  function power() {
    const b = postfix();
    if (isOp('^')) { const o = toks[p++]; return { k: 'bin', op: '^', l: b, r: powExp(), pos: o.pos }; }
    return b;
  }
  function powExp() {
    if (isOp('-') || isOp('+')) { const o = toks[p++]; return { k: 'un', op: o.v, e: powExp(), pos: o.pos }; }
    return power();
  }
  function postfix() {
    let e = primary();
    while (isOp('!')) { const o = toks[p++]; e = { k: 'fact', e, pos: o.pos }; }
    return e;
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      p++;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) { args.push(additive()); while (isOp(',')) { p++; args.push(additive()); } }
        expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (isOp('(')) { p++; const e = additive(); expect(')'); return e; }
    return fail();
  }
  const ast = additive();
  if (toks[p].t !== 'end') fail();
  return ast;
}

// ---- built-ins ----
const fin = (x, pos) => { if (!Number.isFinite(x)) throw new CalcError('Result is not finite', pos); return x; };
const dom = (c, msg, pos) => { if (!c) throw new CalcError(msg, pos); };

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial too large', pos);
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const setMode = (m) => { if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0); mode = m; };
  setMode(angleMode);
  let vars = new Map(), funcs = new Map(), hist = [], ans = 0;
  const toRad = (x) => (mode === 'deg' ? x * Math.PI / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? x * 180 / Math.PI : x);
  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

  const B1 = {
    sin: (x) => snap(Math.sin(toRad(x))), cos: (x) => snap(Math.cos(toRad(x))), tan: (x) => snap(Math.tan(toRad(x))),
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
  const B2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      dom(n !== 0, 'nroot: zero degree', p);
      if (x < 0) { dom(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot of negative number', p); return -Math.pow(-x, 1 / n); }
      return Math.pow(x, 1 / n);
    },
    logb: (x, b, p) => {
      dom(x > 0 && b > 0, 'logb domain error', p); dom(b !== 1, 'logb base 1', p);
      return Math.log(x) / Math.log(b);
    },
  };
  const BV = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0), avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in B1 || n in B2 || n in BV;
  const has = (o, n) => Object.prototype.hasOwnProperty.call(o, n);

  function evalNode(n, scope, depth) {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (vars.has(n.name)) return vars.get(n.name);
        if (n.name === 'ans') return ans;
        if (has(CONSTS, n.name)) return CONSTS[n.name];
        throw new CalcError(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'un': { const v = evalNode(n.e, scope, depth); return n.op === '-' ? -v : v; }
      case 'fact': return factorial(evalNode(n.e, scope, depth), n.pos);
      case 'bin': {
        const a = evalNode(n.l, scope, depth), b = evalNode(n.r, scope, depth);
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
        const name = n.name;
        if (funcs.has(name) && !isBuiltin(name)) {
          const f = funcs.get(name);
          if (n.args.length !== f.params.length) throw new CalcError(`${name} expects ${f.params.length} argument(s)`, n.pos);
          const vals = n.args.map((a) => evalNode(a, scope, depth));
          if (depth + 1 > MAX_DEPTH) throw new CalcError('Maximum call depth exceeded', n.pos);
          const sc = new Map(); f.params.forEach((q, i) => sc.set(q, vals[i]));
          return fin(evalNode(f.body, sc, depth + 1), n.pos);
        }
        if (!isBuiltin(name)) throw new CalcError(`Unknown function '${name}'`, n.pos);
        const vals = n.args.map((a) => evalNode(a, scope, depth));
        let r;
        if (has(B1, name)) { if (vals.length !== 1) throw new CalcError(`${name} expects 1 argument`, n.pos); r = B1[name](vals[0], n.pos); }
        else if (has(B2, name)) { if (vals.length !== 2) throw new CalcError(`${name} expects 2 arguments`, n.pos); r = B2[name](vals[0], vals[1], n.pos); }
        else { if (vals.length < 1) throw new CalcError(`${name} expects at least 1 argument`, n.pos); r = BV[name](vals); }
        return fin(r, n.pos);
      }
    }
    throw new CalcError('Internal error', 0);
  }

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    if (toks[0].t === 'end') throw new CalcError('Empty input', 0);
    // function definition: name ( params ) = ...
    if (toks[0].t === 'name' && toks[1].t === 'op' && toks[1].v === '(') {
      let j = 2; const params = []; let ok = true;
      if (toks[j].t === 'op' && toks[j].v === ')') ok = false;
      else {
        for (;;) {
          if (toks[j].t !== 'name') { ok = false; break; }
          params.push(toks[j]); j++;
          if (toks[j].t === 'op' && toks[j].v === ',') { j++; continue; }
          break;
        }
        if (ok && !(toks[j].t === 'op' && toks[j].v === ')')) ok = false;
        if (ok) { j++; if (!(toks[j].t === 'op' && toks[j].v === '=')) ok = false; }
      }
      if (ok) {
        const name = toks[0].v;
        if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, 0);
        if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot define function named '${name}'`, 0);
        const seen = new Set();
        for (const q of params) { if (seen.has(q.v)) throw new CalcError(`Duplicate parameter '${q.v}'`, q.pos); seen.add(q.v); }
        const body = parseExpr(toks, j + 1);
        funcs.set(name, { params: params.map((q) => q.v), body });
        return `${name}(${params.map((q) => q.v).join(',')})`;
      }
    }
    if (toks[0].t === 'name' && toks[1].t === 'op' && toks[1].v === '=') {
      const name = toks[0].v;
      if (has(CONSTS, name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
      const v = evalNode(parseExpr(toks, 2), null, 0);
      vars.set(name, v); ans = v; return v;
    }
    const v = evalNode(parseExpr(toks, 0), null, 0);
    ans = v; return v;
  }

  const c = {
    evaluate(input) { const r = run(input); hist.push({ input, result: r }); return r; },
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable: (n) => vars.get(n),
    setVariable(n, v) {
      if (typeof n !== 'string' || !NAME_RE.test(n) || has(CONSTS, n) || n === 'ans') throw new CalcError(`Invalid variable name '${n}'`, 0);
      if (typeof v !== 'number') throw new CalcError('Value must be a number', 0);
      vars.set(n, v);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars = new Map(); funcs = new Map(); hist = []; ans = 0; },
    format(value) { const r = Number(value.toPrecision(precision)); return Object.is(r, -0) ? '0' : String(r); },
  };
  c._vars = () => vars;
  return c;
}
