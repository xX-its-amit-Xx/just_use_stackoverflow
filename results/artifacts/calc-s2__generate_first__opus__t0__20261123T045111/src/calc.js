// Safe scientific calculator engine (no eval / Function).

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;

// ---------------------------------------------------------------- tokenizer
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isNameStart(ch) { return /[A-Za-z_]/.test(ch); }
function isNameChar(ch) { return /[A-Za-z0-9_]/.test(ch); }

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      let j = i + 2;
      while (j < n && /[0-9A-Fa-f]/.test(src[j])) j++;
      if (j === i + 2) throw new CalcError('Invalid hexadecimal literal', start);
      tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 16), pos: start, end: j });
      i = j; continue;
    }
    if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      let j = i + 2;
      while (j < n && (src[j] === '0' || src[j] === '1')) j++;
      if (j === i + 2) throw new CalcError('Invalid binary literal', start);
      if (j < n && isDigit(src[j])) throw new CalcError('Invalid binary literal', j);
      tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 2), pos: start, end: j });
      i = j; continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < n && isDigit(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k] ?? '')) {
          while (k < n && isDigit(src[k])) k++;
          j = k;
        }
      }
      if (src[j] === '.') throw new CalcError('Invalid number literal', j);
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), pos: start, end: j });
      i = j; continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < n && isNameChar(src[j])) j++;
      tokens.push({ type: 'name', value: src.slice(i, j), pos: start, end: j });
      i = j; continue;
    }
    if ('+-*/%^!(),='.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: start, end: i + 1 });
      i++; continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, start);
  }
  tokens.push({ type: 'eof', value: null, pos: n, end: n });
  return tokens;
}

// ---------------------------------------------------------------- parser
class Parser {
  constructor(tokens, start = 0) {
    this.tokens = tokens;
    this.i = start;
  }
  peek(o = 0) { return this.tokens[Math.min(this.i + o, this.tokens.length - 1)]; }
  next() { const t = this.peek(); if (t.type !== 'eof') this.i++; return t; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  fail(t) {
    if (t.type === 'eof') throw new CalcError('Unexpected end of input', t.pos);
    throw new CalcError(`Unexpected token '${t.value}'`, t.pos);
  }
  expectOp(v) {
    const t = this.peek();
    if (t.type === 'op' && t.value === v) return this.next();
    if (t.type === 'eof') throw new CalcError(`Expected '${v}' but reached end of input`, t.pos);
    throw new CalcError(`Expected '${v}' but found '${t.value}'`, t.pos);
  }
  parseFull() {
    const node = this.parseAdditive();
    const t = this.peek();
    if (t.type !== 'eof') this.fail(t);
    return node;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      const right = this.parseMultiplicative();
      left = { type: 'bin', op: op.value, left, right, pos: op.pos };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseImplicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next();
      const right = this.parseImplicit();
      left = { type: 'bin', op: op.value, left, right, pos: op.pos };
    }
    return left;
  }
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const prev = this.tokens[this.i - 1];
      const t = this.peek();
      const prevOk = prev && (prev.type === 'num' || (prev.type === 'op' && prev.value === ')'));
      if (!prevOk) break;
      const nextOk = t.type === 'name' || (t.type === 'op' && t.value === '(') ||
        (t.type === 'num' && prev.type === 'op');
      if (!nextOk) break;
      const right = this.parsePower();
      left = { type: 'bin', op: '*', left, right, pos: t.pos };
    }
    return left;
  }
  parseUnary() {
    if (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      const operand = this.parseUnary();
      return op.value === '-' ? { type: 'neg', operand, pos: op.pos } : operand;
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      const op = this.next();
      const exp = this.parseUnary();
      return { type: 'bin', op: '^', left: base, right: exp, pos: op.pos };
    }
    return base;
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.isOp('!')) {
      const op = this.next();
      node = { type: 'fact', operand: node, pos: op.pos };
    }
    return node;
  }
  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { type: 'num', value: t.value, pos: t.pos }; }
    if (t.type === 'name') {
      this.next();
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (this.isOp(')')) {
          this.next();
        } else {
          for (;;) {
            args.push(this.parseAdditive());
            if (this.isOp(',')) { this.next(); continue; }
            this.expectOp(')');
            break;
          }
        }
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const inner = this.parseAdditive();
      this.expectOp(')');
      return inner;
    }
    this.fail(t);
  }
}

// ---------------------------------------------------------------- math helpers
function check(value, pos, what = 'Result') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalcError(`${what} is not a finite number`, pos);
  }
  return value;
}

function snap(x) { return Math.abs(x) < 1e-12 ? 0 : x; }

function degSin(d) {
  let r = d % 360; if (r < 0) r += 360;
  if (r === 0 || r === 180) return 0;
  if (r === 90) return 1;
  if (r === 270) return -1;
  if (r === 30 || r === 150) return 0.5;
  if (r === 210 || r === 330) return -0.5;
  return snap(Math.sin(r * Math.PI / 180));
}
function degCos(d) { return degSin(d + 90); }

function factorial(x, pos) {
  if (!Number.isInteger(x) || x < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (x > 170) throw new CalcError('Factorial argument too large', pos);
  let r = 1;
  for (let i = 2; i <= x; i++) r *= i;
  return r;
}

function nroot(x, n, pos) {
  if (n === 0) throw new CalcError('nroot: n must not be zero', pos);
  let neg = false;
  if (x < 0) {
    if (!Number.isInteger(n) || Math.abs(n) % 2 !== 1) throw new CalcError('nroot: negative radicand requires odd integer n', pos);
    neg = true;
  }
  const a = Math.abs(x);
  let r = Math.pow(a, 1 / n);
  const rr = Math.round(r);
  if (Number.isInteger(n) && rr !== 0 && Math.pow(rr, n) === a) r = rr;
  return neg ? -r : r;
}

function makeBuiltins(calc) {
  const toRad = (x) => (calc.angleMode === 'deg' ? x * Math.PI / 180 : x);
  const fromRad = (x) => (calc.angleMode === 'deg' ? x * 180 / Math.PI : x);
  const dom = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };
  const one = (fn) => ({ min: 1, max: 1, fn });
  const two = (fn) => ({ min: 2, max: 2, fn });
  const vari = (fn) => ({ min: 1, max: Infinity, fn });
  return {
    sin: one(([x]) => (calc.angleMode === 'deg' ? degSin(x) : snap(Math.sin(x)))),
    cos: one(([x]) => (calc.angleMode === 'deg' ? degCos(x) : snap(Math.cos(x)))),
    tan: one(([x], pos) => {
      if (calc.angleMode === 'deg') {
        const c = degCos(x);
        dom(c !== 0, 'tan: undefined for this angle', pos);
        const s = degSin(x);
        if (Math.abs(s) === Math.abs(c)) return s / c;
        return snap(Math.tan(toRad(x)));
      }
      return snap(Math.tan(x));
    }),
    asin: one(([x], pos) => { dom(x >= -1 && x <= 1, 'asin: argument out of domain [-1, 1]', pos); return fromRad(Math.asin(x)); }),
    acos: one(([x], pos) => { dom(x >= -1 && x <= 1, 'acos: argument out of domain [-1, 1]', pos); return fromRad(Math.acos(x)); }),
    atan: one(([x]) => fromRad(Math.atan(x))),
    sinh: one(([x]) => Math.sinh(x)),
    cosh: one(([x]) => Math.cosh(x)),
    tanh: one(([x]) => Math.tanh(x)),
    sqrt: one(([x], pos) => { dom(x >= 0, 'sqrt: argument must be non-negative', pos); return Math.sqrt(x); }),
    cbrt: one(([x]) => Math.cbrt(x)),
    abs: one(([x]) => Math.abs(x)),
    ln: one(([x], pos) => { dom(x > 0, 'ln: argument must be positive', pos); return Math.log(x); }),
    log: one(([x], pos) => { dom(x > 0, 'log: argument must be positive', pos); return Math.log10(x); }),
    log2: one(([x], pos) => { dom(x > 0, 'log2: argument must be positive', pos); return Math.log2(x); }),
    exp: one(([x]) => Math.exp(x)),
    floor: one(([x]) => Math.floor(x)),
    ceil: one(([x]) => Math.ceil(x)),
    round: one(([x]) => Math.sign(x) * Math.round(Math.abs(x))),
    sign: one(([x]) => Math.sign(x)),
    atan2: two(([y, x]) => fromRad(Math.atan2(y, x))),
    pow: two(([x, y], pos) => {
      dom(!(x === 0 && y < 0), 'pow: division by zero', pos);
      return Math.pow(x, y);
    }),
    nroot: two(([x, n], pos) => nroot(x, n, pos)),
    logb: two(([x, b], pos) => {
      dom(x > 0, 'logb: argument must be positive', pos);
      dom(b > 0 && b !== 1, 'logb: base must be positive and not 1', pos);
      return Math.log(x) / Math.log(b);
    }),
    min: vari((a) => Math.min(...a)),
    max: vari((a) => Math.max(...a)),
    sum: vari((a) => a.reduce((s, v) => s + v, 0)),
    avg: vari((a) => a.reduce((s, v) => s + v, 0) / a.length),
    hypot: vari((a) => Math.hypot(...a)),
  };
}

// ---------------------------------------------------------------- calculator
function validateMode(mode) {
  if (mode !== 'rad' && mode !== 'deg') throw new CalcError(`Invalid angle mode '${mode}'`, 0);
  return mode;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  const state = {
    angleMode: validateMode(angleMode),
    vars: new Map(),
    funcs: new Map(),
    ans: 0,
    hist: [],
  };
  const builtins = makeBuiltins(state);

  function evalNode(node, scope, depth) {
    switch (node.type) {
      case 'num': return node.value;
      case 'var': {
        const name = node.name;
        if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
        if (name === 'ans') return state.ans;
        if (state.vars.has(name)) return state.vars.get(name);
        if (Object.prototype.hasOwnProperty.call(builtins, name) || state.funcs.has(name)) {
          throw new CalcError(`'${name}' is a function and must be called`, node.pos);
        }
        throw new CalcError(`Undefined variable '${name}'`, node.pos);
      }
      case 'neg': return -evalNode(node.operand, scope, depth);
      case 'fact': return check(factorial(evalNode(node.operand, scope, depth), node.pos), node.pos);
      case 'bin': {
        const a = evalNode(node.left, scope, depth);
        const b = evalNode(node.right, scope, depth);
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
          case '^':
            if (a === 0 && b < 0) throw new CalcError('Division by zero', node.pos);
            r = Math.pow(a, b); break;
          default: throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
        }
        return check(r, node.pos);
      }
      case 'call': {
        const name = node.name;
        const user = state.funcs.get(name);
        if (user) {
          if (node.args.length !== user.params.length) {
            throw new CalcError(`${name} expects ${user.params.length} argument(s), got ${node.args.length}`, node.pos);
          }
          if (depth + 1 > MAX_DEPTH) throw new CalcError(`Maximum call depth exceeded in '${name}' (recursion?)`, node.pos);
          const args = node.args.map((a) => evalNode(a, scope, depth));
          const newScope = Object.create(null);
          user.params.forEach((p, i) => { newScope[p] = args[i]; });
          return check(evalNode(user.body, newScope, depth + 1), node.pos);
        }
        const b = Object.prototype.hasOwnProperty.call(builtins, name) ? builtins[name] : null;
        if (!b) throw new CalcError(`Unknown function '${name}'`, node.pos);
        const n = node.args.length;
        if (n < b.min || n > b.max) {
          const exp = b.max === Infinity ? `at least ${b.min}` : `${b.min}`;
          throw new CalcError(`${name} expects ${exp} argument(s), got ${n}`, node.pos);
        }
        const args = node.args.map((a) => evalNode(a, scope, depth));
        return check(b.fn(args, node.pos), node.pos);
      }
      default:
        throw new CalcError('Invalid expression', node.pos ?? 0);
    }
  }

  function normalize(v) { return Object.is(v, -0) ? 0 : v; }

  function assertAssignable(name, pos) {
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) throw new CalcError(`Cannot assign to constant '${name}'`, pos);
    if (name === 'ans') throw new CalcError("Cannot assign to 'ans'", pos);
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    if (tokens[0].type === 'eof') throw new CalcError('Empty input', tokens[0].pos);

    // Assignment: name = expr
    if (tokens[0].type === 'name' && tokens[1].type === 'op' && tokens[1].value === '=') {
      const name = tokens[0].value;
      const body = new Parser(tokens, 2).parseFull();
      assertAssignable(name, tokens[0].pos);
      const value = normalize(check(evalNode(body, null, 0), tokens[1].pos));
      state.vars.set(name, value);
      state.ans = value;
      state.hist.push({ input, result: value });
      return value;
    }

    // Function definition: name(p1, ...) = expr
    if (tokens[0].type === 'name' && tokens[1].type === 'op' && tokens[1].value === '(') {
      const eqIdx = tokens.findIndex((t) => t.type === 'op' && t.value === '=');
      if (eqIdx !== -1) {
        const name = tokens[0].value;
        const params = [];
        let i = 2;
        if (tokens[i].type === 'op' && tokens[i].value === ')') {
          throw new CalcError('Function definition requires at least one parameter', tokens[i].pos);
        }
        for (;;) {
          const t = tokens[i];
          if (t.type !== 'name') {
            if (t.type === 'eof') throw new CalcError('Unexpected end of input', t.pos);
            throw new CalcError(`Expected parameter name but found '${t.value}'`, t.pos);
          }
          if (params.includes(t.value)) throw new CalcError(`Duplicate parameter '${t.value}'`, t.pos);
          params.push(t.value);
          i++;
          const sep = tokens[i];
          if (sep.type === 'op' && sep.value === ',') { i++; continue; }
          if (sep.type === 'op' && sep.value === ')') { i++; break; }
          if (sep.type === 'eof') throw new CalcError('Unexpected end of input', sep.pos);
          throw new CalcError(`Unexpected token '${sep.value}'`, sep.pos);
        }
        const eq = tokens[i];
        if (!(eq.type === 'op' && eq.value === '=')) {
          if (eq.type === 'eof') throw new CalcError('Unexpected end of input', eq.pos);
          throw new CalcError(`Unexpected token '${eq.value}'`, eq.pos);
        }
        const body = new Parser(tokens, i + 1).parseFull();
        if (Object.prototype.hasOwnProperty.call(builtins, name)) {
          throw new CalcError(`Cannot redefine built-in function '${name}'`, tokens[0].pos);
        }
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
          throw new CalcError(`Cannot define function named '${name}'`, tokens[0].pos);
        }
        state.funcs.set(name, { params, body });
        const sig = `${name}(${params.join(',')})`;
        state.hist.push({ input, result: sig });
        return sig;
      }
    }

    const ast = new Parser(tokens, 0).parseFull();
    const value = normalize(check(evalNode(ast, null, 0), 0));
    state.ans = value;
    state.hist.push({ input, result: value });
    return value;
  }

  return {
    evaluate,
    setAngleMode(mode) { state.angleMode = validateMode(mode); },
    getAngleMode() { return state.angleMode; },
    getVariable(name) {
      if (name === 'ans') return state.ans;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      return state.vars.has(name) ? state.vars.get(name) : undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
      assertAssignable(name, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Variable value must be a finite number', 0);
      state.vars.set(name, normalize(value));
    },
    variables() {
      return [...state.vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    },
    history() { return state.hist.map((h) => ({ input: h.input, result: h.result })); },
    clear() {
      state.vars.clear();
      state.funcs.clear();
      state.ans = 0;
      state.hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      if (!Number.isFinite(value)) return String(value);
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
  };
}
