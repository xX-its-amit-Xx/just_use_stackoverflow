// Safe scientific calculator engine. No eval / Function: input is tokenized,
// parsed into an AST by a recursive-descent parser and evaluated by a tree walker.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: 2 * Math.PI });
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CALL_DEPTH = 100;
const MAX_FACTORIAL = 170;

// ---------------------------------------------------------------- tokenizer

const isDigit = (c) => c >= '0' && c <= '9' && c.length === 1;
const isHexDigit = (c) => c.length === 1 && /[0-9a-fA-F]/.test(c);
const isBinDigit = (c) => c === '0' || c === '1';
const isAlpha = (c) => c.length === 1 && /[A-Za-z_]/.test(c);
const isAlnum = (c) => isAlpha(c) || isDigit(c);
const isSpace = (c) => c.length === 1 && /\s/.test(c);
const OPERATOR_CHARS = '+-*/%^!(),=';

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    const start = i;
    const next = src[i + 1] ?? '';
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      if (ch === '0' && (next === 'x' || next === 'X') && isHexDigit(src[i + 2] ?? '')) {
        i += 2;
        const s = i;
        while (i < n && isHexDigit(src[i])) i++;
        toks.push({ type: 'num', value: parseInt(src.slice(s, i), 16), pos: start, end: i });
        continue;
      }
      if (ch === '0' && (next === 'b' || next === 'B') && isBinDigit(src[i + 2] ?? '')) {
        i += 2;
        const s = i;
        while (i < n && isBinDigit(src[i])) i++;
        toks.push({ type: 'num', value: parseInt(src.slice(s, i), 2), pos: start, end: i });
        continue;
      }
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j] ?? '')) {
          i = j;
          while (i < n && isDigit(src[i])) i++;
        }
      }
      toks.push({ type: 'num', value: Number(src.slice(start, i)), pos: start, end: i });
      continue;
    }
    if (isAlpha(ch)) {
      while (i < n && isAlnum(src[i])) i++;
      toks.push({ type: 'name', value: src.slice(start, i), pos: start, end: i });
      continue;
    }
    i++;
    if (OPERATOR_CHARS.includes(ch)) {
      toks.push({ type: 'op', value: ch, pos: start, end: i });
    } else {
      // Unknown character: reported by the parser when (and if) it is reached.
      toks.push({ type: 'bad', value: ch, pos: start, end: i });
    }
  }
  toks.push({ type: 'eof', value: '', pos: n, end: n });
  return toks;
}

// ---------------------------------------------------------------- parser
// Grammar (high -> low precedence):
//   postfix  := primary '!'*
//   power    := postfix ('^' powerRhs)?        (right assoc)
//   powerRhs := ('+'|'-') powerRhs | power
//   unary    := ('+'|'-') unary | power
//   implicit := unary (IMPLICIT unary)*        (IMPLICIT: prev is num or ')', next is name or '(')
//   term     := implicit (('*'|'/'|'%') implicit)*
//   expr     := term (('+'|'-') term)*

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.i = 0;
    this.prev = null;
  }

  peek(k = 0) {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  next() {
    const t = this.toks[this.i];
    if (t.type !== 'eof') this.i++;
    this.prev = t;
    return t;
  }

  isOp(t, v) {
    return t.type === 'op' && t.value === v;
  }

  fail(tok) {
    const what = tok.type === 'eof' ? 'end of input' : `'${this.src.slice(tok.pos, tok.end)}'`;
    throw new CalcError(`Syntax error: unexpected ${what}`, tok.pos);
  }

  expectOp(v) {
    const t = this.peek();
    if (this.isOp(t, v)) return this.next();
    return this.fail(t);
  }

  expectEnd() {
    const t = this.peek();
    if (t.type !== 'eof') this.fail(t);
  }

  parseExpr() {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '+') || this.isOp(t, '-')) {
        this.next();
        const right = this.parseTerm();
        left = { type: 'bin', op: t.value, left, right, pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseTerm() {
    let left = this.parseImplicit();
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '*') || this.isOp(t, '/') || this.isOp(t, '%')) {
        this.next();
        const right = this.parseImplicit();
        left = { type: 'bin', op: t.value, left, right, pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prevOk = this.prev && (this.prev.type === 'num' || this.isOp(this.prev, ')'));
      const startOk = t.type === 'name' || this.isOp(t, '(');
      if (prevOk && startOk) {
        const right = this.parseUnary();
        left = { type: 'bin', op: '*', left, right, pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseUnary() {
    const t = this.peek();
    if (this.isOp(t, '+') || this.isOp(t, '-')) {
      this.next();
      const arg = this.parseUnary();
      return { type: 'unary', op: t.value, arg, pos: t.pos };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (this.isOp(t, '^')) {
      this.next();
      const exp = this.parsePowerRhs();
      return { type: 'bin', op: '^', left: base, right: exp, pos: t.pos };
    }
    return base;
  }

  parsePowerRhs() {
    const t = this.peek();
    if (this.isOp(t, '+') || this.isOp(t, '-')) {
      this.next();
      const arg = this.parsePowerRhs();
      return { type: 'unary', op: t.value, arg, pos: t.pos };
    }
    return this.parsePower();
  }

  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '!')) {
        this.next();
        e = { type: 'fact', arg: e, pos: t.pos };
      } else {
        return e;
      }
    }
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { type: 'num', value: t.value, pos: t.pos };
    }
    if (t.type === 'name') {
      this.next();
      if (this.isOp(this.peek(), '(')) {
        this.next();
        const args = [];
        if (!this.isOp(this.peek(), ')')) {
          for (;;) {
            args.push(this.parseExpr());
            if (this.isOp(this.peek(), ',')) {
              this.next();
            } else {
              break;
            }
          }
        }
        this.expectOp(')');
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (this.isOp(t, '(')) {
      this.next();
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    return this.fail(t);
  }
}

// ---------------------------------------------------------------- numeric helpers

const toDeg = (r) => (r * 180) / Math.PI;
const toRad = (d) => (d * Math.PI) / 180;
const mod4 = (q) => ((q % 4) + 4) % 4;

// Exact values at multiples of 90 degrees; NaN marks an undefined tangent.
const SIN_TABLE = [0, 1, 0, -1];
const COS_TABLE = [1, 0, -1, 0];
const TAN_TABLE = [0, NaN, 0, NaN];

function sinDeg(x) {
  const q = x / 90;
  return Number.isInteger(q) ? SIN_TABLE[mod4(q)] : Math.sin(toRad(x));
}
function cosDeg(x) {
  const q = x / 90;
  return Number.isInteger(q) ? COS_TABLE[mod4(q)] : Math.cos(toRad(x));
}
function tanDeg(x) {
  const q = x / 90;
  return Number.isInteger(q) ? TAN_TABLE[mod4(q)] : Math.tan(toRad(x));
}

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) {
    throw new CalcError('Factorial requires a non-negative integer', pos);
  }
  if (n > MAX_FACTORIAL) throw new CalcError('Factorial argument too large', pos);
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function checkFinite(r, pos) {
  if (Number.isNaN(r)) throw new CalcError('Domain error', pos);
  if (!Number.isFinite(r)) throw new CalcError('Overflow', pos);
  return r;
}

function binaryOp(op, l, r, pos) {
  let res;
  switch (op) {
    case '+': res = l + r; break;
    case '-': res = l - r; break;
    case '*': res = l * r; break;
    case '/':
      if (r === 0) throw new CalcError('Division by zero', pos);
      res = l / r;
      break;
    case '%':
      if (r === 0) throw new CalcError('Division by zero', pos);
      res = l % r;
      break;
    case '^': res = Math.pow(l, r); break;
    default: throw new CalcError(`Unknown operator ${op}`, pos);
  }
  return checkFinite(res, pos);
}

// ---------------------------------------------------------------- built-ins
// fn(args, ctx, pos) -> number (NaN / Infinity are turned into CalcError by the caller)

const ONE = 1;
const VARIADIC = Infinity;

function unary(fn) {
  return { min: ONE, max: ONE, fn: (a, ctx, pos) => fn(a[0], ctx, pos) };
}

function nroot(x, n) {
  if (!Number.isInteger(n) || n === 0) return NaN;
  const odd = Math.abs(n) % 2 === 1;
  if (x < 0 && !odd) return NaN;
  if (x === 0) return n > 0 ? 0 : Infinity;
  const ax = Math.abs(x);
  let r = Math.pow(ax, 1 / n);
  const rr = Math.round(r);
  if (Number.isInteger(rr) && rr !== 0 && Math.pow(rr, n) === ax) r = rr;
  return x < 0 ? -r : r;
}

function roundHalfAway(x) {
  const t = Math.trunc(x);
  return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t;
}

const BUILTINS = new Map([
  ['sin', unary((x, ctx) => (ctx.deg ? sinDeg(x) : Math.sin(x)))],
  ['cos', unary((x, ctx) => (ctx.deg ? cosDeg(x) : Math.cos(x)))],
  ['tan', unary((x, ctx) => (ctx.deg ? tanDeg(x) : Math.tan(x)))],
  ['asin', unary((x, ctx) => (ctx.deg ? toDeg(Math.asin(x)) : Math.asin(x)))],
  ['acos', unary((x, ctx) => (ctx.deg ? toDeg(Math.acos(x)) : Math.acos(x)))],
  ['atan', unary((x, ctx) => (ctx.deg ? toDeg(Math.atan(x)) : Math.atan(x)))],
  ['sinh', unary((x) => Math.sinh(x))],
  ['cosh', unary((x) => Math.cosh(x))],
  ['tanh', unary((x) => Math.tanh(x))],
  ['sqrt', unary((x) => (x < 0 ? NaN : Math.sqrt(x)))],
  ['cbrt', unary((x) => Math.cbrt(x))],
  ['abs', unary((x) => Math.abs(x))],
  ['ln', unary((x) => (x <= 0 ? NaN : Math.log(x)))],
  ['log', unary((x) => (x <= 0 ? NaN : Math.log10(x)))],
  ['log2', unary((x) => (x <= 0 ? NaN : Math.log2(x)))],
  ['exp', unary((x) => Math.exp(x))],
  ['floor', unary((x) => Math.floor(x))],
  ['ceil', unary((x) => Math.ceil(x))],
  ['round', unary((x) => roundHalfAway(x))],
  ['sign', unary((x) => Math.sign(x))],
  ['atan2', { min: 2, max: 2, fn: (a, ctx) => {
    const r = Math.atan2(a[0], a[1]);
    return ctx.deg ? toDeg(r) : r;
  } }],
  ['pow', { min: 2, max: 2, fn: (a) => Math.pow(a[0], a[1]) }],
  ['nroot', { min: 2, max: 2, fn: (a) => nroot(a[0], a[1]) }],
  ['logb', { min: 2, max: 2, fn: (a) => {
    const [x, b] = a;
    if (x <= 0 || b <= 0 || b === 1) return NaN;
    return Math.log(x) / Math.log(b);
  } }],
  ['min', { min: ONE, max: VARIADIC, fn: (a) => Math.min(...a) }],
  ['max', { min: ONE, max: VARIADIC, fn: (a) => Math.max(...a) }],
  ['sum', { min: ONE, max: VARIADIC, fn: (a) => a.reduce((s, v) => s + v, 0) }],
  ['avg', { min: ONE, max: VARIADIC, fn: (a) => a.reduce((s, v) => s + v, 0) / a.length }],
  ['hypot', { min: ONE, max: VARIADIC, fn: (a) => Math.hypot(...a) }],
]);

// ---------------------------------------------------------------- calculator

function validateMode(mode) {
  if (mode !== 'rad' && mode !== 'deg') {
    throw new CalcError(`Invalid angle mode: ${String(mode)}`, 0);
  }
  return mode;
}

function validatePrecision(p) {
  if (!Number.isInteger(p) || p < 1 || p > 100) {
    throw new CalcError(`Invalid precision: ${String(p)}`, 0);
  }
  return p;
}

function checkAssignable(name, pos) {
  if (Object.hasOwn(CONSTANTS, name)) {
    throw new CalcError(`Cannot assign to constant '${name}'`, pos);
  }
  if (name === 'ans') throw new CalcError(`Cannot assign to 'ans'`, pos);
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = validateMode(angleMode);
  const prec = validatePrecision(precision);

  let vars = new Map([['ans', 0]]);
  let funcs = new Map(); // name -> { params: string[], body: node }
  let hist = [];
  let depth = 0;

  function lookup(name, pos, frame) {
    if (frame && frame.has(name)) return frame.get(name);
    if (vars.has(name)) return vars.get(name);
    if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name];
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function callNode(node, frame) {
    const args = node.args.map((a) => evalNode(a, frame));
    const uf = funcs.get(node.name);
    if (uf) {
      if (args.length !== uf.params.length) {
        throw new CalcError(
          `${node.name} expects ${uf.params.length} argument(s), got ${args.length}`,
          node.pos,
        );
      }
      if (depth >= MAX_CALL_DEPTH) {
        throw new CalcError('Maximum call depth exceeded (recursion?)', node.pos);
      }
      const nf = new Map();
      uf.params.forEach((p, i) => nf.set(p, args[i]));
      depth++;
      try {
        return checkFinite(evalNode(uf.body, nf), node.pos);
      } finally {
        depth--;
      }
    }
    const b = BUILTINS.get(node.name);
    if (b) {
      if (args.length < b.min || args.length > b.max) {
        const expect = b.max === Infinity
          ? `at least ${b.min}`
          : b.min === b.max ? `${b.min}` : `${b.min}..${b.max}`;
        throw new CalcError(
          `${node.name} expects ${expect} argument(s), got ${args.length}`,
          node.pos,
        );
      }
      return checkFinite(b.fn(args, { deg: mode === 'deg' }, node.pos), node.pos);
    }
    throw new CalcError(`Unknown function '${node.name}'`, node.pos);
  }

  function evalNode(node, frame) {
    switch (node.type) {
      case 'num':
        if (!Number.isFinite(node.value)) throw new CalcError('Number out of range', node.pos);
        return node.value;
      case 'var':
        return lookup(node.name, node.pos, frame);
      case 'unary': {
        const v = evalNode(node.arg, frame);
        return node.op === '-' ? -v : v;
      }
      case 'fact':
        return factorial(evalNode(node.arg, frame), node.pos);
      case 'bin': {
        const l = evalNode(node.left, frame);
        const r = evalNode(node.right, frame);
        return binaryOp(node.op, l, r, node.pos);
      }
      case 'call':
        return callNode(node, frame);
      default:
        throw new CalcError(`Internal error: unknown node ${node.type}`, node.pos ?? 0);
    }
  }

  function record(input, result) {
    hist.push({ input, result });
  }

  const calc = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const text = input.trim();
      const p = new Parser(input);
      if (p.peek().type === 'eof') throw new CalcError('Syntax error: empty input', 0);

      const lhs = p.parseExpr();
      const t = p.peek();

      if (t.type === 'op' && t.value === '=') {
        p.next();
        if (lhs.type === 'var') {
          checkAssignable(lhs.name, lhs.pos);
          const rhs = p.parseExpr();
          p.expectEnd();
          const value = evalNode(rhs, null);
          vars.set(lhs.name, value);
          vars.set('ans', value);
          record(text, value);
          return value;
        }
        if (lhs.type === 'call' && lhs.args.every((a) => a.type === 'var')) {
          if (lhs.args.length === 0) {
            throw new CalcError('A function needs at least one parameter', lhs.pos);
          }
          if (BUILTINS.has(lhs.name)) {
            throw new CalcError(`Cannot redefine built-in function '${lhs.name}'`, lhs.pos);
          }
          const params = [];
          for (const a of lhs.args) {
            if (params.includes(a.name)) {
              throw new CalcError(`Duplicate parameter '${a.name}'`, a.pos);
            }
            params.push(a.name);
          }
          const body = p.parseExpr();
          p.expectEnd();
          funcs.set(lhs.name, { params, body });
          const sig = `${lhs.name}(${params.join(',')})`;
          record(text, sig);
          return sig;
        }
        throw new CalcError('Invalid assignment target', t.pos);
      }

      p.expectEnd();
      const value = evalNode(lhs, null);
      vars.set('ans', value);
      record(text, value);
      return value;
    },

    setAngleMode(m) {
      mode = validateMode(m);
    },

    getAngleMode() {
      return mode;
    },

    getVariable(name) {
      return vars.has(name) ? vars.get(name) : undefined;
    },

    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new CalcError(`Invalid variable name: ${String(name)}`, 0);
      }
      checkAssignable(name, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      vars.set(name, value);
    },

    // Extra helper (used by the REPL): user variables only, sorted by name, excluding ans.
    variables() {
      return [...vars.entries()]
        .filter(([k]) => k !== 'ans')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },

    history() {
      return hist.map((h) => ({ input: h.input, result: h.result }));
    },

    clear() {
      vars = new Map([['ans', 0]]);
      funcs = new Map();
      hist = [];
      depth = 0;
    },

    format(value) {
      return String(Number(value.toPrecision(prec)));
    },
  };

  return calc;
}
