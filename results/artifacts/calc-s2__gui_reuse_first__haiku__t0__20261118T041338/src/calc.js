// Safe scientific calculator engine (no eval / Function).
// Pipeline: tokenize -> recursive-descent parse to AST -> evaluate AST.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = new Map([
  ['pi', Math.PI],
  ['e', Math.E],
  ['tau', 2 * Math.PI],
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;
const MAX_FACTORIAL = 170;

// ---------------------------------------------------------------- built-ins
const d2r = (x) => (x * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;
const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
const ang = (r, deg) => (deg ? r2d(r) : r);

// fn(args, deg, err) -> number; `err(msg)` returns a CalcError to throw.
const BUILTINS = new Map();
const def = (name, min, max, fn) => BUILTINS.set(name, { min, max, fn });

def('sin', 1, 1, ([x], deg) => (deg ? snap(Math.sin(d2r(x))) : Math.sin(x)));
def('cos', 1, 1, ([x], deg) => (deg ? snap(Math.cos(d2r(x))) : Math.cos(x)));
def('tan', 1, 1, ([x], deg) => (deg ? snap(Math.tan(d2r(x))) : Math.tan(x)));
def('asin', 1, 1, ([x], deg, err) => {
  if (Math.abs(x) > 1) throw err('asin domain error: |x| must be <= 1');
  return ang(Math.asin(x), deg);
});
def('acos', 1, 1, ([x], deg, err) => {
  if (Math.abs(x) > 1) throw err('acos domain error: |x| must be <= 1');
  return ang(Math.acos(x), deg);
});
def('atan', 1, 1, ([x], deg) => ang(Math.atan(x), deg));
def('sinh', 1, 1, ([x]) => Math.sinh(x));
def('cosh', 1, 1, ([x]) => Math.cosh(x));
def('tanh', 1, 1, ([x]) => Math.tanh(x));
def('sqrt', 1, 1, ([x], _deg, err) => {
  if (x < 0) throw err('sqrt of a negative number');
  return Math.sqrt(x);
});
def('cbrt', 1, 1, ([x]) => Math.cbrt(x));
def('abs', 1, 1, ([x]) => Math.abs(x));
def('ln', 1, 1, ([x], _deg, err) => {
  if (x <= 0) throw err('ln domain error: argument must be > 0');
  return Math.log(x);
});
def('log', 1, 1, ([x], _deg, err) => {
  if (x <= 0) throw err('log domain error: argument must be > 0');
  return Math.log10(x);
});
def('log2', 1, 1, ([x], _deg, err) => {
  if (x <= 0) throw err('log2 domain error: argument must be > 0');
  return Math.log2(x);
});
def('exp', 1, 1, ([x]) => Math.exp(x));
def('floor', 1, 1, ([x]) => Math.floor(x));
def('ceil', 1, 1, ([x]) => Math.ceil(x));
def('round', 1, 1, ([x]) => Math.sign(x) * Math.round(Math.abs(x))); // half away from zero
def('sign', 1, 1, ([x]) => Math.sign(x));
def('atan2', 2, 2, ([y, x], deg) => ang(Math.atan2(y, x), deg));
def('pow', 2, 2, ([x, y]) => Math.pow(x, y));
def('nroot', 2, 2, ([x, n], _deg, err) => {
  if (!Number.isInteger(n) || n === 0) throw err('nroot degree must be a non-zero integer');
  if (x < 0) {
    if (n % 2 === 0) throw err('even root of a negative number');
    return -Math.pow(-x, 1 / n);
  }
  return Math.pow(x, 1 / n);
});
def('logb', 2, 2, ([x, b], _deg, err) => {
  if (x <= 0) throw err('logb domain error: argument must be > 0');
  if (b <= 0 || b === 1) throw err('logb base must be > 0 and not 1');
  return Math.log(x) / Math.log(b);
});
def('min', 1, Infinity, (a) => Math.min(...a));
def('max', 1, Infinity, (a) => Math.max(...a));
def('sum', 1, Infinity, (a) => a.reduce((s, v) => s + v, 0));
def('avg', 1, Infinity, (a) => a.reduce((s, v) => s + v, 0) / a.length);
def('hypot', 1, Infinity, (a) => Math.hypot(...a));

// ---------------------------------------------------------------- tokenizer
const NUM_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_TOK_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const PUNCT = '+-*/%^!=(),';

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      if (m) {
        toks.push({ type: 'num', text: m[0], pos: i });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      NAME_TOK_RE.lastIndex = i;
      const m = NAME_TOK_RE.exec(src);
      toks.push({ type: 'name', text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (PUNCT.includes(ch)) {
      toks.push({ type: ch, text: ch, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  toks.push({ type: 'end', text: '', pos: src.length });
  return toks;
}

function parseNumber(text) {
  if (/^0[xX]/.test(text)) return parseInt(text.slice(2), 16);
  if (/^0[bB]/.test(text)) return parseInt(text.slice(2), 2);
  return Number(text);
}

// ---------------------------------------------------------------- parser
class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
    this.last = null; // last consumed token (used for implicit multiplication)
  }

  peek(k = 0) {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  next() {
    const t = this.peek();
    if (t.type !== 'end') this.i++;
    this.last = t;
    return t;
  }

  unexpected(t, expected) {
    const suffix = expected ? `, expected ${expected}` : '';
    if (t.type === 'end') {
      return new CalcError(expected ? `Unexpected end of input${suffix}` : 'Unexpected end of input', t.pos);
    }
    return new CalcError(`Unexpected token '${t.text}'${suffix}`, t.pos);
  }

  expect(type, expected) {
    const t = this.peek();
    if (t.type !== type) throw this.unexpected(t, expected);
    return this.next();
  }

  expectEnd() {
    const t = this.peek();
    if (t.type !== 'end') throw this.unexpected(t);
  }

  parseStatement() {
    const t0 = this.peek();
    const t1 = this.peek(1);
    if (t0.type === 'name' && t1.type === '(') {
      let j = this.i + 1;
      while (this.toks[j].type !== ')' && this.toks[j].type !== 'end') j++;
      if (this.toks[j].type === ')' && this.toks[j + 1].type === '=') {
        return this.parseDefinition();
      }
    }
    if (t0.type === 'name' && t1.type === '=') {
      if (CONSTANTS.has(t0.text) || t0.text === 'ans') {
        throw new CalcError(`Cannot assign to '${t0.text}'`, t0.pos);
      }
      this.next();
      this.next();
      const expr = this.parseExpr();
      this.expectEnd();
      return { kind: 'assign', name: t0.text, expr };
    }
    const expr = this.parseExpr();
    this.expectEnd();
    return { kind: 'expr', expr };
  }

  parseDefinition() {
    const nameTok = this.next();
    this.next(); // '('
    if (BUILTINS.has(nameTok.text)) {
      throw new CalcError(`Cannot redefine built-in function '${nameTok.text}'`, nameTok.pos);
    }
    if (this.peek().type === ')') {
      throw new CalcError('Function definition needs at least one parameter', this.peek().pos);
    }
    const params = [];
    const seen = new Set();
    for (;;) {
      const p = this.expect('name', 'parameter name');
      if (seen.has(p.text)) throw new CalcError(`Duplicate parameter '${p.text}'`, p.pos);
      seen.add(p.text);
      params.push(p.text);
      if (this.peek().type !== ',') break;
      this.next();
    }
    this.expect(')', "')'");
    this.expect('=', "'='");
    const body = this.parseExpr();
    this.expectEnd();
    return { kind: 'def', name: nameTok.text, params, body };
  }

  // expr := mul (('+'|'-') mul)*
  parseExpr() {
    let l = this.parseMul();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const t = this.next();
      const r = this.parseMul();
      l = { t: 'bin', op: t.type, l, r, pos: t.pos };
    }
    return l;
  }

  // mul := unary (('*'|'/'|'%') unary)*
  parseMul() {
    let l = this.parseUnary();
    while (['*', '/', '%'].includes(this.peek().type)) {
      const t = this.next();
      const r = this.parseUnary();
      l = { t: 'bin', op: t.type, l, r, pos: t.pos };
    }
    return l;
  }

  // unary := ('+'|'-') unary | implicit
  parseUnary() {
    const t = this.peek();
    if (t.type === '+' || t.type === '-') {
      this.next();
      return { t: 'un', op: t.type, arg: this.parseUnary(), pos: t.pos };
    }
    return this.parseImplicit();
  }

  // implicit := pow (pow)*  where a number or ')' is directly followed by a name or '('
  parseImplicit() {
    let l = this.parsePow();
    for (;;) {
      const p = this.peek();
      const afterValue = this.last && (this.last.type === 'num' || this.last.type === ')');
      if (!afterValue || (p.type !== 'name' && p.type !== '(')) break;
      const r = this.parsePow();
      l = { t: 'bin', op: '*', l, r, pos: l.pos };
    }
    return l;
  }

  // pow := postfix ('^' powExponent)?   (right-associative)
  parsePow() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (t.type === '^') {
      this.next();
      const exp = this.parsePowExponent();
      return { t: 'bin', op: '^', l: base, r: exp, pos: t.pos };
    }
    return base;
  }

  parsePowExponent() {
    const t = this.peek();
    if (t.type === '+' || t.type === '-') {
      this.next();
      return { t: 'un', op: t.type, arg: this.parsePowExponent(), pos: t.pos };
    }
    return this.parsePow();
  }

  // postfix := primary '!'*
  parsePostfix() {
    let e = this.parsePrimary();
    while (this.peek().type === '!') {
      const t = this.next();
      e = { t: 'fact', arg: e, pos: t.pos };
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      const v = parseNumber(t.text);
      if (!Number.isFinite(v)) throw new CalcError('Number out of range', t.pos);
      return { t: 'num', v, pos: t.pos };
    }
    if (t.type === 'name') {
      this.next();
      if (this.peek().type !== '(') return { t: 'var', name: t.text, pos: t.pos };
      this.next();
      const args = [];
      if (this.peek().type !== ')') {
        for (;;) {
          args.push(this.parseExpr());
          if (this.peek().type !== ',') break;
          this.next();
        }
      }
      this.expect(')', "')'");
      const b = BUILTINS.get(t.text);
      if (b && (args.length < b.min || args.length > b.max)) {
        const want = b.min === b.max ? `${b.min}` : `at least ${b.min}`;
        throw new CalcError(`${t.text} expects ${want} argument(s), got ${args.length}`, t.pos);
      }
      return { t: 'call', name: t.text, args, pos: t.pos };
    }
    if (t.type === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect(')', "')'");
      return e;
    }
    throw this.unexpected(t);
  }
}

// ---------------------------------------------------------------- evaluator
function fail(frame, pos, msg) {
  // Errors raised inside a user function body are reported at the outermost call site.
  return new CalcError(msg, frame.callPos ?? pos);
}

function checkFinite(v, frame, pos) {
  if (Number.isNaN(v)) throw fail(frame, pos, 'Result is undefined (NaN)');
  if (!Number.isFinite(v)) throw fail(frame, pos, 'Overflow: result is not finite');
  return v;
}

function factorial(v, err) {
  if (!Number.isInteger(v) || v < 0) throw err('factorial requires a non-negative integer');
  if (v > MAX_FACTORIAL) throw err(`factorial argument must be <= ${MAX_FACTORIAL}`);
  let r = 1;
  for (let i = 2; i <= v; i++) r *= i;
  return r;
}

function lookupVar(node, frame, st) {
  const name = node.name;
  if (frame.params && frame.params.has(name)) return frame.params.get(name);
  if (name === 'ans') return st.ans;
  if (st.vars.has(name)) return st.vars.get(name);
  if (CONSTANTS.has(name)) return CONSTANTS.get(name);
  throw fail(frame, node.pos, `Undefined variable '${name}'`);
}

function evalNode(node, frame, st) {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'var':
      return lookupVar(node, frame, st);
    case 'un': {
      const v = evalNode(node.arg, frame, st);
      return node.op === '-' ? -v : v;
    }
    case 'bin': {
      const l = evalNode(node.l, frame, st);
      const r = evalNode(node.r, frame, st);
      let v;
      switch (node.op) {
        case '+': v = l + r; break;
        case '-': v = l - r; break;
        case '*': v = l * r; break;
        case '/':
          if (r === 0) throw fail(frame, node.pos, 'Division by zero');
          v = l / r;
          break;
        case '%':
          if (r === 0) throw fail(frame, node.pos, 'Division by zero');
          v = l % r;
          break;
        case '^': v = Math.pow(l, r); break;
        default: throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
      }
      return checkFinite(v, frame, node.pos);
    }
    case 'fact': {
      const v = evalNode(node.arg, frame, st);
      return checkFinite(factorial(v, (m) => fail(frame, node.pos, m)), frame, node.pos);
    }
    case 'call':
      return evalCall(node, frame, st);
    default:
      throw new CalcError('Internal error: unknown node', node.pos);
  }
}

function evalCall(node, frame, st) {
  const args = node.args.map((a) => evalNode(a, frame, st));
  const b = BUILTINS.get(node.name);
  if (b) {
    const v = b.fn(args, st.deg, (m) => fail(frame, node.pos, m));
    return checkFinite(v, frame, node.pos);
  }
  const f = st.funcs.get(node.name);
  if (!f) throw fail(frame, node.pos, `Unknown function '${node.name}'`);
  if (args.length !== f.params.length) {
    throw fail(frame, node.pos, `${node.name} expects ${f.params.length} argument(s), got ${args.length}`);
  }
  const depth = frame.depth + 1;
  if (depth > MAX_DEPTH) throw fail(frame, node.pos, 'Maximum call depth exceeded (recursion?)');
  const params = new Map(f.params.map((p, i) => [p, args[i]]));
  const callFrame = { params, depth, callPos: frame.callPos ?? node.pos };
  return evalNode(f.body, callFrame, st);
}

// ---------------------------------------------------------------- public API
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') {
    throw new CalcError(`Invalid angle mode '${angleMode}'`, 0);
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 100) {
    throw new CalcError('precision must be an integer between 1 and 100', 0);
  }

  const st = {
    deg: angleMode === 'deg',
    precision,
    vars: new Map(),
    funcs: new Map(),
    ans: 0,
    hist: [],
  };
  const TOP = { params: null, depth: 0, callPos: null };

  return {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const stmt = new Parser(input).parseStatement();
      let result;
      switch (stmt.kind) {
        case 'expr': {
          result = evalNode(stmt.expr, TOP, st);
          st.ans = result;
          break;
        }
        case 'assign': {
          const v = evalNode(stmt.expr, TOP, st);
          st.vars.set(stmt.name, v);
          st.ans = v;
          result = v;
          break;
        }
        case 'def': {
          st.funcs.set(stmt.name, { params: stmt.params, body: stmt.body });
          result = `${stmt.name}(${stmt.params.join(',')})`;
          break;
        }
        default:
          throw new CalcError('Internal error: unknown statement', 0);
      }
      st.hist.push({ input: input.trim(), result });
      return result;
    },

    setAngleMode(mode) {
      if (mode !== 'rad' && mode !== 'deg') throw new CalcError(`Invalid angle mode '${mode}'`, 0);
      st.deg = mode === 'deg';
    },

    getAngleMode() {
      return st.deg ? 'deg' : 'rad';
    },

    getVariable(name) {
      if (name === 'ans') return st.ans;
      return st.vars.get(name);
    },

    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new CalcError(`Invalid variable name '${name}'`, 0);
      }
      if (CONSTANTS.has(name) || name === 'ans') {
        throw new CalcError(`Cannot assign to '${name}'`, 0);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      st.vars.set(name, value);
    },

    // Extra helper (used by the REPL): user variables only, excluding ans, sorted by name.
    variables() {
      return [...st.vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    },

    history() {
      return st.hist.map((h) => ({ input: h.input, result: h.result }));
    },

    clear() {
      st.vars = new Map();
      st.funcs = new Map();
      st.ans = 0;
      st.hist = [];
    },

    format(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Cannot format a non-finite value', 0);
      }
      return String(Number(value.toPrecision(st.precision)));
    },
  };
}
