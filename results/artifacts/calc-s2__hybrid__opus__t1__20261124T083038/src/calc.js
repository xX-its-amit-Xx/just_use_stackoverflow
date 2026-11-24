// calc-s2: safe scientific calculator engine (no eval / Function).

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------- Tokenizer ----------
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const isDigit = (ch) => ch >= '0' && ch <= '9';
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    const start = i;
    if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      let j = i + 2;
      while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      if (j === i + 2) throw new CalcError('Invalid hexadecimal literal', start);
      toks.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 16), pos: start, end: j });
      i = j; continue;
    }
    if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      let j = i + 2;
      while (j < n && (src[j] === '0' || src[j] === '1')) j++;
      if (j === i + 2) throw new CalcError('Invalid binary literal', start);
      toks.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 2), pos: start, end: j });
      i = j; continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && isDigit(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (k < n && isDigit(src[k])) {
          while (k < n && isDigit(src[k])) k++;
          j = k;
        }
      }
      toks.push({ type: 'num', value: Number(src.slice(i, j)), pos: start, end: j });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ type: 'name', value: src.slice(i, j), pos: start, end: j });
      i = j; continue;
    }
    if ('+-*/%^!(),='.includes(ch)) {
      toks.push({ type: 'op', value: ch, pos: start, end: i + 1 });
      i++; continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, start);
  }
  toks.push({ type: 'eof', value: '', pos: n, end: n });
  return toks;
}

// ---------- Parser ----------
class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek() { return this.toks[this.i]; }
  prev() { return this.toks[this.i - 1]; }
  next() { return this.toks[this.i++]; }
  isOp(v, t = this.peek()) { return t.type === 'op' && t.value === v; }
  fail(t = this.peek()) {
    if (t.type === 'eof') throw new CalcError('Unexpected end of input', t.pos);
    throw new CalcError(`Unexpected token '${t.value}'`, t.pos);
  }
  expect(v) {
    const t = this.peek();
    if (!this.isOp(v, t)) {
      if (t.type === 'eof') throw new CalcError(`Expected '${v}' but reached end of input`, t.pos);
      throw new CalcError(`Expected '${v}' but found '${t.value}'`, t.pos);
    }
    return this.next();
  }
  parseAll() {
    const e = this.additive();
    if (this.peek().type !== 'eof') this.fail();
    return e;
  }
  additive() {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      const right = this.multiplicative();
      left = { k: 'bin', op: op.value, l: left, r: right, pos: op.pos };
    }
    return left;
  }
  multiplicative() {
    let left = this.implicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next();
      const right = this.implicit();
      left = { k: 'bin', op: op.value, l: left, r: right, pos: op.pos };
    }
    return left;
  }
  implicit() {
    let left = this.unary();
    for (;;) {
      const p = this.prev();
      const t = this.peek();
      const afterNum = p.type === 'num';
      const afterParen = p.type === 'op' && p.value === ')';
      if (!(afterNum || afterParen)) break;
      const startsFactor = t.type === 'name' || this.isOp('(', t) || (afterParen && t.type === 'num');
      if (!startsFactor) break;
      const right = this.power();
      left = { k: 'bin', op: '*', l: left, r: right, pos: t.pos };
    }
    return left;
  }
  unary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next();
      const arg = this.unary();
      return op.value === '-' ? { k: 'neg', a: arg, pos: op.pos } : arg;
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('^')) {
      const op = this.next();
      const exp = this.unary(); // right-assoc, allows unary sign
      return { k: 'bin', op: '^', l: base, r: exp, pos: op.pos };
    }
    return base;
  }
  postfix() {
    let e = this.primary();
    while (this.isOp('!')) {
      const op = this.next();
      e = { k: 'fact', a: e, pos: op.pos };
    }
    return e;
  }
  primary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { k: 'num', v: t.value, pos: t.pos }; }
    if (t.type === 'name') {
      this.next();
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.additive());
          while (this.isOp(',')) { this.next(); args.push(this.additive()); }
        }
        this.expect(')');
        return { k: 'call', name: t.value, args, pos: t.pos };
      }
      return { k: 'var', name: t.value, pos: t.pos };
    }
    if (this.isOp('(')) {
      this.next();
      const e = this.additive();
      this.expect(')');
      return e;
    }
    this.fail(t);
  }
}

// ---------- Built-ins ----------
const DEG = Math.PI / 180;
function snap(x) { return Math.abs(x) < 1e-12 ? 0 : x; }

function factorial(x, pos) {
  if (!Number.isInteger(x) || x < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (x > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let i = 2; i <= x; i++) r *= i;
  return r;
}

function makeBuiltins(calc) {
  const deg = () => calc.mode === 'deg';
  const trig = (fn, name) => (x) => {
    if (!deg()) return fn(x);
    if (name === 'tan') {
      const m = ((x % 180) + 180) % 180;
      if (m === 90) return Infinity;
    }
    if (name === 'sin' || name === 'cos') {
      const m = ((x % 360) + 360) % 360;
      if (m % 90 === 0) {
        const q = m / 90;
        const s = [0, 1, 0, -1][q];
        const c = [1, 0, -1, 0][q];
        return name === 'sin' ? s : c;
      }
    }
    return snap(fn(x * DEG));
  };
  const inv = (fn) => (...a) => (deg() ? fn(...a) / DEG : fn(...a));
  const one = {
    sin: trig(Math.sin, 'sin'), cos: trig(Math.cos, 'cos'), tan: trig(Math.tan, 'tan'),
    asin: inv(Math.asin), acos: inv(Math.acos), atan: inv(Math.atan),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    ln: (x) => (x <= 0 ? NaN : Math.log(x)),
    log: (x) => (x <= 0 ? NaN : Math.log10(x)),
    log2: (x) => (x <= 0 ? NaN : Math.log2(x)),
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    sign: Math.sign,
  };
  const table = {};
  for (const [k, f] of Object.entries(one)) table[k] = { min: 1, max: 1, f };
  const nroot = (x, n) => {
    if (n === 0) return NaN;
    let r;
    if (x < 0) {
      if (!(Number.isInteger(n) && Math.abs(n) % 2 === 1)) return NaN;
      r = -Math.pow(-x, 1 / n);
    } else {
      r = Math.pow(x, 1 / n);
    }
    const rr = Math.round(r);
    if (rr !== r && Number.isInteger(n) && Math.pow(rr, n) === x) return rr;
    return r;
  };
  const logb = (x, b) => {
    if (x <= 0 || b <= 0 || b === 1) return NaN;
    if (b === 2) return Math.log2(x);
    if (b === 10) return Math.log10(x);
    const r = Math.log(x) / Math.log(b);
    const rr = Math.round(r);
    if (Math.abs(r - rr) < 1e-12 && Math.pow(b, rr) === x) return rr;
    return r;
  };
  Object.assign(table, {
    atan2: { min: 2, max: 2, f: inv(Math.atan2) },
    pow: { min: 2, max: 2, f: (x, y) => Math.pow(x, y) },
    nroot: { min: 2, max: 2, f: nroot },
    logb: { min: 2, max: 2, f: logb },
    min: { min: 1, max: Infinity, f: Math.min },
    max: { min: 1, max: Infinity, f: Math.max },
    sum: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) },
    avg: { min: 1, max: Infinity, f: (...a) => a.reduce((s, v) => s + v, 0) / a.length },
    hypot: { min: 1, max: Infinity, f: Math.hypot },
  });
  return table;
}

const BUILTIN_NAMES = new Set(Object.keys(makeBuiltins({ mode: 'rad' })));

function checkFinite(v, pos, what = 'Result') {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError(`${what} is not a finite number`, pos);
  return v;
}

// ---------- Calculator ----------
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError(`Invalid angle mode '${angleMode}'`, 0);
  const state = { mode: angleMode };
  const builtins = makeBuiltins(state);
  let vars = new Map([['ans', 0]]);
  let funcs = new Map();
  let hist = [];

  function evalNode(node, scope, depth) {
    switch (node.k) {
      case 'num': return node.v;
      case 'var': {
        const nm = node.name;
        if (scope && Object.prototype.hasOwnProperty.call(scope, nm)) return scope[nm];
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, nm)) return CONSTANTS[nm];
        if (vars.has(nm)) return vars.get(nm);
        throw new CalcError(`Undefined variable '${nm}'`, node.pos);
      }
      case 'neg': return -evalNode(node.a, scope, depth);
      case 'fact': return factorial(evalNode(node.a, scope, depth), node.pos);
      case 'bin': {
        const a = evalNode(node.l, scope, depth);
        const b = evalNode(node.r, scope, depth);
        let r;
        switch (node.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/':
            if (b === 0) throw new CalcError('Division by zero', node.pos);
            r = a / b; break;
          case '%':
            if (b === 0) throw new CalcError('Remainder by zero', node.pos);
            r = a % b; break;
          case '^': r = Math.pow(a, b); break;
        }
        return checkFinite(r, node.pos);
      }
      case 'call': {
        const nm = node.name;
        const args = node.args.map((a) => evalNode(a, scope, depth));
        if (funcs.has(nm)) {
          const fn = funcs.get(nm);
          if (args.length !== fn.params.length) {
            throw new CalcError(`Function '${nm}' expects ${fn.params.length} argument(s), got ${args.length}`, node.pos);
          }
          if (depth + 1 > 100) throw new CalcError(`Maximum call depth exceeded in '${nm}' (recursion)`, node.pos);
          const sc = Object.create(null);
          fn.params.forEach((p, i) => { sc[p] = args[i]; });
          return checkFinite(evalNode(fn.body, sc, depth + 1), node.pos);
        }
        if (Object.prototype.hasOwnProperty.call(builtins, nm)) {
          const b = builtins[nm];
          if (args.length < b.min || args.length > b.max) {
            const exp = b.max === Infinity ? `at least ${b.min}` : `${b.min}`;
            throw new CalcError(`Function '${nm}' expects ${exp} argument(s), got ${args.length}`, node.pos);
          }
          return checkFinite(b.f(...args), node.pos, `Result of ${nm}`);
        }
        throw new CalcError(`Unknown function '${nm}'`, node.pos);
      }
    }
    throw new CalcError('Internal error', node.pos ?? 0);
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const toks = tokenize(input);
    if (toks[0].type === 'eof') throw new CalcError('Empty input', toks[0].pos);
    const isOp = (t, v) => t && t.type === 'op' && t.value === v;

    // Function definition: name ( p1, p2, ... ) = body
    if (toks[0].type === 'name' && isOp(toks[1], '(')) {
      let j = 2;
      const params = [];
      let ok = true;
      if (toks[j].type !== 'name') ok = false;
      while (ok) {
        if (toks[j].type !== 'name') { ok = false; break; }
        params.push(toks[j]);
        j++;
        if (isOp(toks[j], ',')) { j++; continue; }
        if (isOp(toks[j], ')')) { j++; break; }
        ok = false;
      }
      if (ok && isOp(toks[j], '=')) {
        const name = toks[0].value;
        if (BUILTIN_NAMES.has(name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, toks[0].pos);
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
          throw new CalcError(`Cannot define function named '${name}'`, toks[0].pos);
        }
        const seen = new Set();
        for (const p of params) {
          if (seen.has(p.value)) throw new CalcError(`Duplicate parameter '${p.value}'`, p.pos);
          seen.add(p.value);
        }
        const bodyToks = toks.slice(j + 1);
        const parser = new Parser(bodyToks);
        if (bodyToks[0].type === 'eof') throw new CalcError('Missing function body', bodyToks[0].pos);
        const body = parser.parseAll();
        funcs.set(name, { params: params.map((p) => p.value), body });
        const sig = `${name}(${params.map((p) => p.value).join(',')})`;
        hist.push({ input, result: sig });
        return sig;
      }
    }

    // Assignment: name = expr
    if (toks[0].type === 'name' && isOp(toks[1], '=')) {
      const name = toks[0].value;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
        throw new CalcError(`Cannot assign to '${name}'`, toks[0].pos);
      }
      const rest = toks.slice(2);
      if (rest[0].type === 'eof') throw new CalcError('Missing expression after =', rest[0].pos);
      const ast = new Parser(rest).parseAll();
      const v = checkFinite(evalNode(ast, null, 0), toks[0].pos);
      vars.set(name, v);
      vars.set('ans', v);
      hist.push({ input, result: v });
      return v;
    }

    const ast = new Parser(toks).parseAll();
    const v = checkFinite(evalNode(ast, null, 0), 0);
    vars.set('ans', v);
    hist.push({ input, result: v });
    return v;
  }

  return {
    evaluate,
    setAngleMode(mode) {
      if (mode !== 'rad' && mode !== 'deg') throw new CalcError(`Invalid angle mode '${mode}'`, 0);
      state.mode = mode;
    },
    getAngleMode() { return state.mode; },
    getVariable(name) {
      if (vars.has(name)) return vars.get(name);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      return undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) throw new CalcError(`Cannot assign to constant '${name}'`, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Value must be a finite number', 0);
      vars.set(name, value);
    },
    userVariables() {
      return [...vars.entries()].filter(([k]) => k !== 'ans').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
    history() { return hist.map((h) => ({ ...h })); },
    clear() {
      vars = new Map([['ans', 0]]);
      funcs = new Map();
      hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      const s = String(Number(value.toPrecision(precision)));
      return s === '-0' ? '0' : s;
    },
  };
}
