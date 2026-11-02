// Tokenizer/recursive-descent parser structure adapted from
// https://github.com/celaldrg/calculator (MIT, (c) 2026 Celalettin Durgaç): src/tokenizer.js, src/parser.js.
// See PROVENANCE.json and THIRD_PARTY_NOTICES.md. Extended for S2 spec (statements, user functions, etc).

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NUMBER_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPS = '+-*/%^!(),=';

function matchAt(re, s, i) { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : null; }

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = matchAt(NUMBER_RE, input, i);
    if (num) {
      let value;
      if (/^0[xX]/.test(num)) value = parseInt(num.slice(2), 16);
      else if (/^0[bB]/.test(num)) value = parseInt(num.slice(2), 2);
      else value = Number(num);
      tokens.push({ type: 'num', value, pos: i });
      i += num.length; continue;
    }
    const id = matchAt(IDENT_RE, input, i);
    if (id) { tokens.push({ type: 'name', name: id, pos: i }); i += id.length; continue; }
    if (OPS.includes(ch)) { tokens.push({ type: 'op', op: ch, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  return tokens;
}

class Parser {
  constructor(tokens, len, start = 0) { this.t = tokens; this.i = start; this.len = len; }
  peek() { return this.t[this.i]; }
  isOp(...ops) { const k = this.peek(); return !!k && k.type === 'op' && ops.includes(k.op); }
  fail(tok = this.peek()) {
    throw new CalcError(tok ? `Unexpected token at ${tok.pos}` : 'Unexpected end of input', tok ? tok.pos : this.len);
  }
  parseExpression() {
    let left = this.parseTerm();
    while (this.isOp('+', '-')) {
      const k = this.t[this.i++];
      left = { type: 'bin', op: k.op, left, right: this.parseTerm(), pos: k.pos };
    }
    return left;
  }
  parseTerm() {
    let left = this.parseImplicit();
    while (this.isOp('*', '/', '%')) {
      const k = this.t[this.i++];
      left = { type: 'bin', op: k.op, left, right: this.parseImplicit(), pos: k.pos };
    }
    return left;
  }
  startsImplicit() {
    const k = this.peek();
    const prev = this.t[this.i - 1];
    if (!k || !prev) return false;
    const prevOk = prev.type === 'num' || (prev.type === 'op' && prev.op === ')');
    if (!prevOk) return false;
    return k.type === 'name' || (k.type === 'op' && k.op === '(');
  }
  parseImplicit() {
    let left = this.parseUnary();
    while (this.startsImplicit()) {
      const pos = this.peek().pos;
      left = { type: 'bin', op: '*', left, right: this.parseUnary(), pos };
    }
    return left;
  }
  parseUnary() {
    if (this.isOp('+', '-')) {
      const k = this.t[this.i++];
      const arg = this.parseUnary();
      return k.op === '-' ? { type: 'neg', arg, pos: k.pos } : arg;
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (!this.isOp('^')) return base;
    const k = this.t[this.i++];
    return { type: 'bin', op: '^', left: base, right: this.parseUnary(), pos: k.pos };
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.isOp('!')) { const k = this.t[this.i++]; node = { type: 'fact', arg: node, pos: k.pos }; }
    return node;
  }
  parsePrimary() {
    const k = this.peek();
    if (!k) this.fail();
    this.i++;
    if (k.type === 'num') return { type: 'num', value: k.value, pos: k.pos };
    if (k.type === 'name') {
      if (this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.isOp(',')) { this.i++; continue; }
            break;
          }
        }
        this.expectClose();
        return { type: 'call', name: k.name, args, pos: k.pos };
      }
      return { type: 'var', name: k.name, pos: k.pos };
    }
    if (k.type === 'op' && k.op === '(') {
      const inner = this.parseExpression();
      this.expectClose();
      return inner;
    }
    return this.fail(k);
  }
  expectClose() {
    if (this.isOp(')')) { this.i++; return; }
    this.fail();
  }
}

function parseTokens(tokens, start, len) {
  const p = new Parser(tokens, len, start);
  const tree = p.parseExpression();
  if (p.peek()) p.fail();
  return tree;
}

const isInt = Number.isInteger;
const need = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const setMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  };
  setMode(angleMode);
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];

  const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);
  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);
  const trig = (f) => (x) => snap(f(toRad(x)));

  const one = (f) => ({ min: 1, max: 1, f });
  const BUILTINS = {
    sin: one(trig(Math.sin)), cos: one(trig(Math.cos)), tan: one(trig(Math.tan)),
    asin: { min: 1, max: 1, f: (x, p) => { need(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); } },
    acos: { min: 1, max: 1, f: (x, p) => { need(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); } },
    atan: one((x) => fromRad(Math.atan(x))),
    sinh: one(Math.sinh), cosh: one(Math.cosh), tanh: one(Math.tanh),
    sqrt: { min: 1, max: 1, f: (x, p) => { need(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); } },
    cbrt: one(Math.cbrt), abs: one(Math.abs),
    ln: { min: 1, max: 1, f: (x, p) => { need(x > 0, 'ln domain error', p); return Math.log(x); } },
    log: { min: 1, max: 1, f: (x, p) => { need(x > 0, 'log domain error', p); return Math.log10(x); } },
    log2: { min: 1, max: 1, f: (x, p) => { need(x > 0, 'log2 domain error', p); return Math.log2(x); } },
    exp: one(Math.exp), floor: one(Math.floor), ceil: one(Math.ceil),
    round: one((x) => Math.sign(x) * Math.round(Math.abs(x))),
    sign: one(Math.sign),
    atan2: { min: 2, max: 2, f: (y, x) => fromRad(Math.atan2(y, x)) },
    pow: { min: 2, max: 2, f: (x, y) => Math.pow(x, y) },
    nroot: { min: 2, max: 2, f: (x, n, p) => {
      need(n !== 0, 'nroot: zero root', p);
      if (x < 0) {
        need(isInt(n) && Math.abs(n % 2) === 1, 'nroot: even root of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      return Math.pow(x, 1 / n);
    } },
    logb: { min: 2, max: 2, f: (x, b, p) => {
      need(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    } },
    min: { min: 1, max: Infinity, f: (...a) => Math.min(...a) },
    max: { min: 1, max: Infinity, f: (...a) => Math.max(...a) },
    sum: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) },
    avg: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) / a.length },
    hypot: { min: 1, max: Infinity, f: (...a) => Math.hypot(...a) },
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function checkFinite(v, pos) {
    need(typeof v === 'number' && Number.isFinite(v), 'Result is not a finite number', pos);
    return v;
  }

  function ev(node, scope, depth) {
    switch (node.type) {
      case 'num': return checkFinite(node.value, node.pos);
      case 'var': {
        const n = node.name;
        if (scope && scope.has(n)) return scope.get(n);
        if (n === 'ans') return ans;
        if (has(CONSTANTS, n)) return CONSTANTS[n];
        if (vars.has(n)) return vars.get(n);
        throw new CalcError(`Undefined variable: ${n}`, node.pos);
      }
      case 'neg': return -ev(node.arg, scope, depth);
      case 'fact': {
        const v = ev(node.arg, scope, depth);
        need(isInt(v) && v >= 0 && v <= 170, 'Invalid factorial argument', node.pos);
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = ev(node.left, scope, depth);
        const b = ev(node.right, scope, depth);
        let r;
        switch (node.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': need(b !== 0, 'Division by zero', node.pos); r = a / b; break;
          case '%': need(b !== 0, 'Division by zero', node.pos); r = a % b; break;
          case '^': r = Math.pow(a, b); break;
        }
        return checkFinite(r, node.pos);
      }
      case 'call': {
        const name = node.name;
        const user = funcs.get(name);
        const isBuiltin = has(BUILTINS, name);
        if (!user && !isBuiltin) throw new CalcError(`Unknown function: ${name}`, node.pos);
        if (user) {
          need(node.args.length === user.params.length, `Wrong number of arguments for ${name}`, node.pos);
          const args = node.args.map((a) => ev(a, scope, depth));
          need(depth + 1 <= 100, 'Maximum call depth exceeded (recursion)', node.pos);
          const s = new Map();
          user.params.forEach((p, i) => s.set(p, args[i]));
          return checkFinite(ev(user.body, s, depth + 1), node.pos);
        }
        const b = BUILTINS[name];
        need(node.args.length >= b.min && node.args.length <= b.max, `Wrong number of arguments for ${name}`, node.pos);
        const args = node.args.map((a) => ev(a, scope, depth));
        return checkFinite(b.f(...args, node.pos), node.pos);
      }
    }
    throw new CalcError('Internal error', node.pos);
  }

  function checkAssignable(name, pos) {
    need(!has(CONSTANTS, name), `Cannot assign to constant ${name}`, pos);
    need(name !== 'ans', 'Cannot assign to ans', pos);
  }

  function run(input) {
    const tokens = tokenize(input);
    const len = input.length;
    if (!tokens.length) throw new CalcError('Empty input', 0);
    const t0 = tokens[0], t1 = tokens[1];
    if (t0.type === 'name' && t1 && t1.type === 'op' && t1.op === '=') {
      checkAssignable(t0.name, t0.pos);
      const tree = parseTokens(tokens, 2, len);
      const v = checkFinite(ev(tree, null, 0), t0.pos);
      vars.set(t0.name, v);
      ans = v;
      return v;
    }
    if (t0.type === 'name' && t1 && t1.type === 'op' && t1.op === '(') {
      // look for "name ( params ) =" 
      let j = 2;
      const params = [];
      let ok = true;
      if (tokens[j] && tokens[j].type === 'op' && tokens[j].op === ')') ok = false;
      else {
        for (;;) {
          const p = tokens[j];
          if (!p || p.type !== 'name') { ok = false; break; }
          params.push(p);
          j++;
          const s = tokens[j];
          if (s && s.type === 'op' && s.op === ',') { j++; continue; }
          if (s && s.type === 'op' && s.op === ')') { j++; break; }
          ok = false; break;
        }
      }
      const eq = tokens[j];
      if (ok && eq && eq.type === 'op' && eq.op === '=') {
        checkAssignable(t0.name, t0.pos);
        need(!has(BUILTINS, t0.name), `Cannot redefine built-in function ${t0.name}`, t0.pos);
        const seen = new Set();
        for (const p of params) {
          need(!seen.has(p.name), `Duplicate parameter ${p.name}`, p.pos);
          seen.add(p.name);
        }
        const body = parseTokens(tokens, j + 1, len);
        funcs.set(t0.name, { params: params.map((p) => p.name), body });
        return `${t0.name}(${params.map((p) => p.name).join(',')})`;
      }
    }
    const tree = parseTokens(tokens, 0, len);
    const v = checkFinite(ev(tree, null, 0), 0);
    ans = v;
    return v;
  }

  const c = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const r = run(input);
      hist.push({ input, result: r });
      return r;
    },
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable: (n) => (vars.has(n) ? vars.get(n) : undefined),
    setVariable(name, value) {
      need(typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'Invalid variable name', 0);
      checkAssignable(name, 0);
      need(typeof value === 'number' && !Number.isNaN(value), 'Value must be a number', 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      const n = Number(value.toPrecision(precision));
      return Object.is(n, -0) ? '0' : String(n);
    },
    // internal helper for the REPL
    _vars: () => [...vars.entries()],
  };
  return c;
}
