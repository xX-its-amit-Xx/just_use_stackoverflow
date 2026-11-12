// Safe scientific calculator engine: tokenizer (adapted from expr-eval, see
// PROVENANCE.json) + hand-written recursive-descent parser + AST evaluator.
// No eval / Function is used anywhere.
import { TokenStream } from './token-stream.js';
import { TNUMBER, TOP, TNAME, TPAREN, TCOMMA, TEOF } from './token.js';
import { CalcError } from './errors.js';

export { CalcError };

const CONSTANTS = new Map([['pi', Math.PI], ['e', Math.E], ['tau', 2 * Math.PI]]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;
const MAX_FACTORIAL = 170;
const VARIADIC = Symbol('variadic');
const DEG_SNAP = 1e-12;

const snap = (x) => (Math.abs(x) < DEG_SNAP ? 0 : x);
const fromRad = (r, deg) => (deg ? (r * 180) / Math.PI : r);
const toRad = (x, deg) => (deg ? (x * Math.PI) / 180 : x);

// name -> { arity: number | VARIADIC, fn(args, deg) }
const BUILTINS = new Map(Object.entries({
  sin: { arity: 1, fn: ([x], deg) => (deg ? snap(Math.sin(toRad(x, true))) : Math.sin(x)) },
  cos: { arity: 1, fn: ([x], deg) => (deg ? snap(Math.cos(toRad(x, true))) : Math.cos(x)) },
  tan: { arity: 1, fn: ([x], deg) => (deg ? snap(Math.tan(toRad(x, true))) : Math.tan(x)) },
  asin: { arity: 1, fn: ([x], deg) => fromRad(Math.asin(x), deg) },
  acos: { arity: 1, fn: ([x], deg) => fromRad(Math.acos(x), deg) },
  atan: { arity: 1, fn: ([x], deg) => fromRad(Math.atan(x), deg) },
  sinh: { arity: 1, fn: ([x]) => Math.sinh(x) },
  cosh: { arity: 1, fn: ([x]) => Math.cosh(x) },
  tanh: { arity: 1, fn: ([x]) => Math.tanh(x) },
  sqrt: { arity: 1, fn: ([x]) => Math.sqrt(x) },
  cbrt: { arity: 1, fn: ([x]) => Math.cbrt(x) },
  abs: { arity: 1, fn: ([x]) => Math.abs(x) },
  ln: { arity: 1, fn: ([x]) => Math.log(x) },
  log: { arity: 1, fn: ([x]) => Math.log10(x) },
  log2: { arity: 1, fn: ([x]) => Math.log2(x) },
  exp: { arity: 1, fn: ([x]) => Math.exp(x) },
  floor: { arity: 1, fn: ([x]) => Math.floor(x) },
  ceil: { arity: 1, fn: ([x]) => Math.ceil(x) },
  // half away from zero: round(-2.5) = -3
  round: { arity: 1, fn: ([x]) => Math.sign(x) * Math.round(Math.abs(x)) },
  sign: { arity: 1, fn: ([x]) => Math.sign(x) },
  atan2: { arity: 2, fn: ([y, x], deg) => fromRad(Math.atan2(y, x), deg) },
  pow: { arity: 2, fn: ([x, y]) => Math.pow(x, y) },
  nroot: {
    arity: 2,
    fn: ([x, n]) => {
      if (x < 0 && Number.isInteger(n) && n % 2 !== 0) return -Math.pow(-x, 1 / n);
      return Math.pow(x, 1 / n);
    },
  },
  logb: { arity: 2, fn: ([x, b]) => Math.log(x) / Math.log(b) },
  min: { arity: VARIADIC, fn: (a) => Math.min(...a) },
  max: { arity: VARIADIC, fn: (a) => Math.max(...a) },
  sum: { arity: VARIADIC, fn: (a) => a.reduce((s, x) => s + x, 0) },
  avg: { arity: VARIADIC, fn: (a) => a.reduce((s, x) => s + x, 0) / a.length },
  hypot: { arity: VARIADIC, fn: (a) => Math.hypot(...a) },
}));

function tokenize(input) {
  const ts = new TokenStream(input);
  const tokens = [];
  for (;;) {
    const t = ts.next();
    tokens.push(t);
    if (t.type === TEOF) return tokens;
  }
}

const isOp = (t, v) => t.type === TOP && t.value === v;
const isPunct = (t, v) => t.type === TPAREN && t.value === v;
const describe = (t) => (t.type === TEOF ? 'end of input' : `'${t.value}'`);

// Recursive-descent parser. Precedence (low -> high):
//   +,- ; *,/,% ; implicit multiplication ; unary +,- ; ^ (right assoc) ; postfix !
class Parser {
  constructor(tokens, start = 0) {
    this.t = tokens;
    this.i = start;
  }

  peek() {
    return this.t[this.i];
  }

  advance() {
    const tok = this.t[this.i];
    if (tok.type !== TEOF) this.i++;
    return tok;
  }

  fail(tok) {
    throw new CalcError(`Syntax error: unexpected ${describe(tok)}`, tok.index);
  }

  expectEnd() {
    if (this.peek().type !== TEOF) this.fail(this.peek());
  }

  expression() {
    let left = this.multiplicative();
    while (this.peek().type === TOP && (isOp(this.peek(), '+') || isOp(this.peek(), '-'))) {
      const op = this.advance();
      left = { k: 'bin', op: op.value, l: left, r: this.multiplicative(), pos: op.index };
    }
    return left;
  }

  multiplicative() {
    let left = this.implicit();
    while (this.peek().type === TOP && ['*', '/', '%'].some((o) => isOp(this.peek(), o))) {
      const op = this.advance();
      left = { k: 'bin', op: op.value, l: left, r: this.implicit(), pos: op.index };
    }
    return left;
  }

  // Implicit multiplication: a number, ')' or '!' immediately followed (whitespace allowed)
  // by a name or '('. Binds tighter than explicit * / %, so 6/2(1+2) = 1.
  implicit() {
    let left = this.unary();
    for (;;) {
      const prev = this.t[this.i - 1];
      const prevOk = prev && (prev.type === TNUMBER || isPunct(prev, ')') || isOp(prev, '!'));
      const next = this.peek();
      const nextOk = next.type === TNAME || isPunct(next, '(');
      if (!prevOk || !nextOk) return left;
      left = { k: 'bin', op: '*', l: left, r: this.unary(), pos: next.index };
    }
  }

  unary() {
    if (isOp(this.peek(), '-') || isOp(this.peek(), '+')) {
      const op = this.advance();
      return { k: 'un', op: op.value, arg: this.unary(), pos: op.index };
    }
    return this.power();
  }

  power() {
    const base = this.postfix();
    if (isOp(this.peek(), '^')) {
      const op = this.advance();
      return { k: 'bin', op: '^', l: base, r: this.signedPower(), pos: op.index };
    }
    return base;
  }

  // Exponent may carry a unary sign: 2^-1 = 0.5
  signedPower() {
    if (isOp(this.peek(), '-') || isOp(this.peek(), '+')) {
      const op = this.advance();
      return { k: 'un', op: op.value, arg: this.signedPower(), pos: op.index };
    }
    return this.power();
  }

  postfix() {
    let v = this.primary();
    while (isOp(this.peek(), '!')) {
      const op = this.advance();
      v = { k: 'fact', arg: v, pos: op.index };
    }
    return v;
  }

  primary() {
    const tok = this.peek();
    if (tok.type === TNUMBER) {
      this.advance();
      return { k: 'num', v: tok.value, pos: tok.index };
    }
    if (isPunct(tok, '(')) {
      this.advance();
      const inner = this.expression();
      if (!isPunct(this.peek(), ')')) this.fail(this.peek());
      this.advance();
      return inner;
    }
    if (tok.type === TNAME) {
      this.advance();
      if (isPunct(this.peek(), '(')) {
        this.advance();
        const args = [];
        if (isPunct(this.peek(), ')')) {
          this.advance();
        } else {
          for (;;) {
            args.push(this.expression());
            const s = this.peek();
            if (s.type === TCOMMA) {
              this.advance();
            } else if (isPunct(s, ')')) {
              this.advance();
              break;
            } else {
              this.fail(s);
            }
          }
        }
        return { k: 'call', name: tok.value, args, pos: tok.index };
      }
      return { k: 'var', name: tok.value, pos: tok.index };
    }
    return this.fail(tok);
  }
}

// Matches `name(p1, p2, ...) =` at the start of the token list, else null.
function matchDefinition(tokens) {
  if (tokens[0].type !== TNAME || !isPunct(tokens[1], '(')) return null;
  if (isPunct(tokens[2], ')') && isOp(tokens[3], '=')) {
    throw new CalcError('A function needs at least one parameter', tokens[2].index);
  }
  const params = [];
  let i = 2;
  for (;;) {
    if (tokens[i].type !== TNAME) return null;
    params.push(tokens[i].value);
    i++;
    if (tokens[i].type === TCOMMA) {
      i++;
    } else {
      break;
    }
  }
  if (!isPunct(tokens[i], ')') || !isOp(tokens[i + 1], '=')) return null;
  return { name: tokens[0].value, params, bodyStart: i + 2 };
}

function parseStatement(input) {
  const tokens = tokenize(input);
  if (tokens[0].type === TEOF) throw new CalcError('Empty expression', 0);

  const def = matchDefinition(tokens);
  if (def) {
    if (BUILTINS.has(def.name)) {
      throw new CalcError(`Cannot redefine built-in function '${def.name}'`, 0);
    }
    const seen = new Set();
    for (let i = 2; tokens[i].type === TNAME || tokens[i].type === TCOMMA; i++) {
      if (tokens[i].type === TNAME) {
        if (seen.has(tokens[i].value)) {
          throw new CalcError(`Duplicate parameter '${tokens[i].value}'`, tokens[i].index);
        }
        seen.add(tokens[i].value);
      }
    }
    const p = new Parser(tokens, def.bodyStart);
    const body = p.expression();
    p.expectEnd();
    return { kind: 'def', name: def.name, params: def.params, body };
  }

  if (tokens[0].type === TNAME && isOp(tokens[1], '=')) {
    const name = tokens[0].value;
    if (CONSTANTS.has(name) || name === 'ans') {
      throw new CalcError(`Cannot assign to '${name}'`, 0);
    }
    const p = new Parser(tokens, 2);
    const body = p.expression();
    p.expectEnd();
    return { kind: 'assign', name, body };
  }

  const p = new Parser(tokens, 0);
  const body = p.expression();
  p.expectEnd();
  return { kind: 'expr', body };
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let mode = 'rad';
  let hist = [];

  const checkFinite = (v, pos) => {
    if (!Number.isFinite(v)) {
      throw new CalcError('Math domain error or overflow (result is not finite)', pos);
    }
    return v;
  };

  const lookupVar = (node, scope) => {
    const { name, pos } = node;
    if (scope && scope.has(name)) return scope.get(name);
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    if (CONSTANTS.has(name)) return CONSTANTS.get(name);
    throw new CalcError(`Undefined variable '${name}'`, pos);
  };

  const evalNode = (node, scope, depth) => {
    switch (node.k) {
      case 'num':
        return node.v;
      case 'var':
        return lookupVar(node, scope);
      case 'un': {
        const v = evalNode(node.arg, scope, depth);
        return node.op === '-' ? -v : v;
      }
      case 'fact': {
        const v = evalNode(node.arg, scope, depth);
        if (!Number.isInteger(v) || v < 0) {
          throw new CalcError('Factorial requires a non-negative integer', node.pos);
        }
        if (v > MAX_FACTORIAL) {
          throw new CalcError(`Factorial argument exceeds ${MAX_FACTORIAL}`, node.pos);
        }
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const l = evalNode(node.l, scope, depth);
        const r = evalNode(node.r, scope, depth);
        let v;
        switch (node.op) {
          case '+': v = l + r; break;
          case '-': v = l - r; break;
          case '*': v = l * r; break;
          case '/':
            if (r === 0) throw new CalcError('Division by zero', node.pos);
            v = l / r;
            break;
          case '%':
            if (r === 0) throw new CalcError('Remainder by zero', node.pos);
            v = l % r;
            break;
          case '^': v = Math.pow(l, r); break;
          default: throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
        }
        return checkFinite(v, node.pos);
      }
      case 'call': {
        const args = node.args.map((a) => evalNode(a, scope, depth));
        if (BUILTINS.has(node.name)) {
          const b = BUILTINS.get(node.name);
          if (b.arity === VARIADIC) {
            if (args.length < 1) throw new CalcError(`${node.name} expects at least 1 argument`, node.pos);
          } else if (args.length !== b.arity) {
            throw new CalcError(`${node.name} expects ${b.arity} argument(s), got ${args.length}`, node.pos);
          }
          return checkFinite(b.fn(args, mode === 'deg'), node.pos);
        }
        if (funcs.has(node.name)) {
          const f = funcs.get(node.name);
          if (args.length !== f.params.length) {
            throw new CalcError(`${node.name} expects ${f.params.length} argument(s), got ${args.length}`, node.pos);
          }
          if (depth + 1 > MAX_DEPTH) {
            throw new CalcError('Maximum call depth exceeded (recursive definition?)', node.pos);
          }
          const frame = new Map();
          f.params.forEach((p, i) => frame.set(p, args[i]));
          return evalNode(f.body, frame, depth + 1);
        }
        throw new CalcError(`Unknown function '${node.name}'`, node.pos);
      }
      default:
        throw new CalcError('Internal error: unknown node', 0);
    }
  };

  const c = {};

  c.setAngleMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode '${m}' (use 'rad' or 'deg')`, 0);
    mode = m;
  };
  c.getAngleMode = () => mode;

  c.evaluate = (input) => {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const stmt = parseStatement(input);
    let result;
    if (stmt.kind === 'def') {
      funcs.set(stmt.name, { params: stmt.params, body: stmt.body });
      result = `${stmt.name}(${stmt.params.join(',')})`;
    } else {
      const value = evalNode(stmt.body, null, 0);
      if (stmt.kind === 'assign') vars.set(stmt.name, value);
      ans = value;
      result = value;
    }
    hist.push({ input, result });
    return result;
  };

  c.getVariable = (name) => {
    if (name === 'ans') return ans;
    return vars.get(name);
  };

  c.setVariable = (name, value) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
    if (CONSTANTS.has(name) || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Value must be a finite number', 0);
    vars.set(name, value);
  };

  // User variables (excluding ans), sorted by name. Used by the REPL's :vars.
  c.variables = () =>
    [...vars.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  c.history = () => hist.map((h) => ({ input: h.input, result: h.result }));

  c.clear = () => {
    vars.clear();
    funcs.clear();
    ans = 0;
    hist = [];
  };

  c.format = (value) => String(Number(value.toPrecision(precision)));

  c.setAngleMode(angleMode);
  return c;
}
