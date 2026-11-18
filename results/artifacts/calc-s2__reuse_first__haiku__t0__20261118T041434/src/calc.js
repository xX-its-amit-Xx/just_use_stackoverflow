// Scientific calculator engine (no eval / Function).
//
// The tokenizer follows the token-stream design of expr-eval (MIT License,
// Copyright (c) 2015 Matthew Crumley): positional tokens {type, value, index},
// 0x / 0b radix integers and identifier scanning. See THIRD_PARTY_NOTICES.md.
// The grammar, evaluator and calculator semantics are implemented for SPEC.md.

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
const MAX_CALL_DEPTH = 100;
const MAX_FACTORIAL = 170;
const DEG = Math.PI / 180;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIADIC = 'variadic';

// ---------------------------------------------------------------- helpers

const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isAlnum = (c) => isAlpha(c) || isDigit(c);

function checkMode(mode, position) {
  if (mode !== 'rad' && mode !== 'deg') {
    throw new CalcError(`Invalid angle mode '${mode}' (use 'rad' or 'deg')`, position);
  }
  return mode;
}

function checkFinite(value, position) {
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not a finite number (domain error or overflow)', position);
  }
  return value;
}

// ---------------------------------------------------------------- lexer

// Returns an array of tokens {type, value, index}. Types: num, name, op, eof, error.
// A lexical error yields an 'error' token (value = message) which the parser
// reports only when it actually reaches it, so earlier syntax errors win.
function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  const push = (type, value, index) => toks.push({ type, value, index });

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const p = src[i + 1];
      if (c === '0' && p !== undefined && 'xXbB'.includes(p)) {
        // radix integer: 0x1F, 0b101
        const hex = p === 'x' || p === 'X';
        const digit = hex ? /[0-9a-fA-F]/ : /[01]/;
        let j = i + 2;
        while (j < n && digit.test(src[j])) j++;
        if (j === i + 2) {
          push('error', `Expected ${hex ? 'hexadecimal' : 'binary'} digits after '0${p}'`, start);
          return toks;
        }
        push('num', parseInt(src.slice(i + 2, j), hex ? 16 : 2), start);
        i = j;
        continue;
      }
      // decimal: digits [. digits] [(e|E) [+-] digits]
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < n && isDigit(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) {
          while (k < n && isDigit(src[k])) k++;
          j = k;
        }
      }
      push('num', Number(src.slice(i, j)), start);
      i = j;
      continue;
    }

    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlnum(src[j])) j++;
      push('name', src.slice(i, j), start);
      i = j;
      continue;
    }

    if ('+-*/%^!(),='.includes(c)) {
      push('op', c, start);
      i++;
      continue;
    }

    push('error', `Unexpected character '${c}'`, start);
    return toks;
  }
  push('eof', null, n);
  return toks;
}

// ---------------------------------------------------------------- built-ins

const BUILTINS = new Map();
const def = (name, arity, fn) => BUILTINS.set(name, { arity, fn });
const one = (name, f) => def(name, 1, ([x]) => f(x));

const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
const reduceDeg = (x) => ((x % 360) + 360) % 360;
const SIN_Q = [0, 1, 0, -1];
const COS_Q = [1, 0, -1, 0];

// Exact values at multiples of 90 degrees; otherwise plain trig with snapping.
function degSin(x) {
  const r = reduceDeg(x);
  if (Number.isInteger(r / 90)) return SIN_Q[r / 90];
  return snap(Math.sin(r * DEG));
}
function degCos(x) {
  const r = reduceDeg(x);
  if (Number.isInteger(r / 90)) return COS_Q[r / 90];
  return snap(Math.cos(r * DEG));
}
function degTan(x) {
  const r = reduceDeg(x);
  if (Number.isInteger(r / 90)) return (r / 90) % 2 === 0 ? 0 : NaN; // tan(90) undefined
  return Math.tan(r * DEG);
}
const toDeg = (rad) => (rad * 180) / Math.PI;

// round half away from zero: round(-2.5) = -3
function roundHalfAway(x) {
  const a = Math.abs(x);
  let r = Math.floor(a);
  if (a - r >= 0.5) r += 1;
  return x < 0 ? -r : r;
}

// n-th root; negative x only with odd integer n.
function nroot(x, n) {
  if (!Number.isInteger(n) || n === 0) return NaN;
  if (x < 0) {
    if (Math.abs(n % 2) !== 1) return NaN;
    return -Math.pow(-x, 1 / n);
  }
  return Math.pow(x, 1 / n);
}

def('sin', 1, ([x], m) => (m === 'deg' ? degSin(x) : Math.sin(x)));
def('cos', 1, ([x], m) => (m === 'deg' ? degCos(x) : Math.cos(x)));
def('tan', 1, ([x], m) => (m === 'deg' ? degTan(x) : Math.tan(x)));
def('asin', 1, ([x], m) => (m === 'deg' ? toDeg(Math.asin(x)) : Math.asin(x)));
def('acos', 1, ([x], m) => (m === 'deg' ? toDeg(Math.acos(x)) : Math.acos(x)));
def('atan', 1, ([x], m) => (m === 'deg' ? toDeg(Math.atan(x)) : Math.atan(x)));
one('sinh', Math.sinh);
one('cosh', Math.cosh);
one('tanh', Math.tanh);
one('sqrt', Math.sqrt);
one('cbrt', Math.cbrt);
one('abs', Math.abs);
one('ln', Math.log);
one('log', Math.log10);
one('log2', Math.log2);
one('exp', Math.exp);
one('floor', Math.floor);
one('ceil', Math.ceil);
one('round', roundHalfAway);
one('sign', Math.sign);
def('atan2', 2, ([y, x], m) => (m === 'deg' ? toDeg(Math.atan2(y, x)) : Math.atan2(y, x)));
def('pow', 2, ([x, y]) => x ** y);
def('nroot', 2, ([x, n]) => nroot(x, n));
def('logb', 2, ([x, b]) => Math.log(x) / Math.log(b));
def('min', VARIADIC, (args) => Math.min(...args));
def('max', VARIADIC, (args) => Math.max(...args));
def('sum', VARIADIC, (args) => args.reduce((s, v) => s + v, 0));
def('avg', VARIADIC, (args) => args.reduce((s, v) => s + v, 0) / args.length);
def('hypot', VARIADIC, (args) => Math.hypot(...args));

function checkArity(name, arity, count, position) {
  if (arity === VARIADIC) {
    if (count < 1) throw new CalcError(`'${name}' expects at least 1 argument`, position);
    return;
  }
  if (count !== arity) {
    throw new CalcError(`'${name}' expects ${arity} argument(s), got ${count}`, position);
  }
}

// ---------------------------------------------------------------- parser

function fail(tok, msg) {
  if (tok.type === 'error') throw new CalcError(tok.value, tok.index);
  let text = msg;
  if (!text) {
    if (tok.type === 'eof') text = 'Unexpected end of input';
    else if (tok.type === 'num') text = 'Unexpected number';
    else text = `Unexpected '${tok.value}'`;
  }
  throw new CalcError(text, tok.index);
}

// Grammar (lowest to highest precedence):
//   additive : mul (('+'|'-') mul)*
//   mul      : implicit (('*'|'/'|'%') implicit)*
//   implicit : unary (unary)*        -- when previous is number or ')' and next is name or '('
//   unary    : ('+'|'-') unary | power
//   power    : postfix ('^' exponent)?   exponent : ('+'|'-') exponent | power
//   postfix  : primary '!'*
//   primary  : number | name | name '(' args ')' | '(' expr ')'
class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
    this.last = null;
  }

  peek(k = 0) {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  next() {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    this.last = t;
    return t;
  }

  isOp(t, v) {
    return t.type === 'op' && t.value === v;
  }

  parseStatement() {
    const t0 = this.peek();
    const t1 = this.peek(1);
    let stmt;
    if (t0.type === 'name' && this.isOp(t1, '=')) {
      stmt = this.parseAssign();
    } else if (t0.type === 'name' && this.isOp(t1, '(') && this.isDefinition()) {
      stmt = this.parseDefinition();
    } else {
      stmt = { kind: 'expr', expr: this.parseExpr() };
    }
    const end = this.peek();
    if (end.type !== 'eof') fail(end);
    return stmt;
  }

  // Lookahead: name '(' ... ')' followed by '=' means a function definition.
  isDefinition() {
    let depth = 0;
    for (let k = this.i + 1; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.type === 'error' || t.type === 'eof') return false;
      if (this.isOp(t, '(')) depth++;
      else if (this.isOp(t, ')') && --depth === 0) {
        const after = this.toks[k + 1];
        return after !== undefined && this.isOp(after, '=');
      }
    }
    return false;
  }

  parseAssign() {
    const nameTok = this.next();
    this.next(); // '='
    if (nameTok.value === 'ans' || CONSTANTS.has(nameTok.value)) {
      throw new CalcError(`Cannot assign to '${nameTok.value}'`, nameTok.index);
    }
    let rhs;
    if (this.peek().type === 'name' && this.isOp(this.peek(1), '=')) {
      rhs = this.parseAssign(); // chained: a = b = 3
    } else {
      rhs = { kind: 'expr', expr: this.parseExpr() };
    }
    return { kind: 'assign', name: nameTok.value, expr: rhs, pos: nameTok.index };
  }

  parseDefinition() {
    const nameTok = this.next();
    this.next(); // '('
    if (BUILTINS.has(nameTok.value)) {
      throw new CalcError(`Cannot redefine built-in function '${nameTok.value}'`, nameTok.index);
    }
    const params = [];
    if (this.isOp(this.peek(), ')')) fail(this.peek(), 'Function needs at least one parameter');
    for (;;) {
      const p = this.next();
      if (p.type !== 'name') fail(p, 'Expected parameter name');
      if (params.includes(p.value)) {
        throw new CalcError(`Duplicate parameter '${p.value}'`, p.index);
      }
      params.push(p.value);
      const sep = this.next();
      if (this.isOp(sep, ')')) break;
      if (!this.isOp(sep, ',')) fail(sep, "Expected ',' or ')'");
    }
    this.next(); // '='
    const body = this.parseExpr();
    return { kind: 'define', name: nameTok.value, params, body, pos: nameTok.index };
  }

  parseExpr() {
    return this.parseAdditive();
  }

  parseAdditive() {
    let left = this.parseMul();
    while (this.isOp(this.peek(), '+') || this.isOp(this.peek(), '-')) {
      const op = this.next();
      const right = this.parseMul();
      left = { type: 'bin', op: op.value, l: left, r: right, pos: op.index };
    }
    return left;
  }

  parseMul() {
    let left = this.parseImplicit();
    while (['*', '/', '%'].some((o) => this.isOp(this.peek(), o))) {
      const op = this.next();
      const right = this.parseImplicit();
      left = { type: 'bin', op: op.value, l: left, r: right, pos: op.index };
    }
    return left;
  }

  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const prev = this.last;
      const t = this.peek();
      const prevOk = prev && (prev.type === 'num' || this.isOp(prev, ')'));
      const nextOk = t.type === 'name' || this.isOp(t, '(');
      if (!prevOk || !nextOk) break;
      const right = this.parseUnary();
      left = { type: 'bin', op: '*', l: left, r: right, pos: t.index };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (this.isOp(t, '+') || this.isOp(t, '-')) {
      this.next();
      const arg = this.parseUnary();
      return { type: t.value === '-' ? 'neg' : 'pos', arg, pos: t.index };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (this.isOp(t, '^')) {
      this.next();
      const exp = this.parseExponent();
      return { type: 'bin', op: '^', l: base, r: exp, pos: t.index };
    }
    return base;
  }

  parseExponent() {
    const t = this.peek();
    if (this.isOp(t, '+') || this.isOp(t, '-')) {
      this.next();
      const arg = this.parseExponent();
      return { type: t.value === '-' ? 'neg' : 'pos', arg, pos: t.index };
    }
    return this.parsePower();
  }

  parsePostfix() {
    let e = this.parsePrimary();
    while (this.isOp(this.peek(), '!')) {
      const t = this.next();
      e = { type: 'fact', arg: e, pos: t.index };
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { type: 'num', value: t.value, pos: t.index };
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
              continue;
            }
            break;
          }
        }
        const close = this.peek();
        if (!this.isOp(close, ')')) fail(close, "Expected ')'");
        this.next();
        return { type: 'call', name: t.value, args, pos: t.index };
      }
      return { type: 'var', name: t.value, pos: t.index };
    }
    if (this.isOp(t, '(')) {
      this.next();
      const e = this.parseExpr();
      const close = this.peek();
      if (!this.isOp(close, ')')) fail(close, "Expected ')'");
      this.next();
      return e;
    }
    return fail(t);
  }
}

// ---------------------------------------------------------------- calculator

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = checkMode(angleMode, 0);
  if (!Number.isInteger(precision) || precision < 1 || precision > 100) {
    throw new CalcError(`Invalid precision '${precision}'`, 0);
  }
  const prec = precision;
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  // ov: error-position override (used inside user-function bodies, whose
  // positions refer to an earlier input, so errors are reported at the call site).
  function evalNode(node, locals, ov) {
    const pos = ov ?? node.pos;
    switch (node.type) {
      case 'num':
        return checkFinite(node.value, pos);
      case 'var':
        return lookup(node.name, locals, pos);
      case 'neg':
        return -evalNode(node.arg, locals, ov);
      case 'pos':
        return evalNode(node.arg, locals, ov);
      case 'fact': {
        const a = evalNode(node.arg, locals, ov);
        if (!Number.isInteger(a) || a < 0 || a > MAX_FACTORIAL) {
          throw new CalcError('Factorial requires an integer between 0 and 170', pos);
        }
        let r = 1;
        for (let k = 2; k <= a; k++) r *= k;
        return r;
      }
      case 'bin': {
        const a = evalNode(node.l, locals, ov);
        const b = evalNode(node.r, locals, ov);
        let v;
        switch (node.op) {
          case '+': v = a + b; break;
          case '-': v = a - b; break;
          case '*': v = a * b; break;
          case '/':
            if (b === 0) throw new CalcError('Division by zero', pos);
            v = a / b;
            break;
          case '%':
            if (b === 0) throw new CalcError('Remainder by zero', pos);
            v = a % b;
            break;
          case '^': v = a ** b; break;
          default: throw new CalcError(`Unknown operator '${node.op}'`, pos);
        }
        return checkFinite(v, pos);
      }
      case 'call': {
        const b = BUILTINS.get(node.name);
        const f = b ? null : funcs.get(node.name);
        if (!b && !f) throw new CalcError(`Unknown function '${node.name}'`, pos);
        // Arity is checked before any argument is evaluated.
        if (b) checkArity(node.name, b.arity, node.args.length, pos);
        else if (node.args.length !== f.params.length) {
          throw new CalcError(
            `'${node.name}' expects ${f.params.length} argument(s), got ${node.args.length}`,
            pos,
          );
        }
        const args = node.args.map((a) => evalNode(a, locals, ov));
        if (b) return checkFinite(b.fn(args, mode), pos);
        if (depth >= MAX_CALL_DEPTH) {
          throw new CalcError('Maximum call depth exceeded (recursion?)', pos);
        }
        const frame = new Map(f.params.map((p, k) => [p, args[k]]));
        depth++;
        try {
          return evalNode(f.body, frame, pos);
        } finally {
          depth--;
        }
      }
      default:
        throw new CalcError('Internal error: unknown node', pos);
    }
  }

  function lookup(name, locals, pos) {
    if (locals && locals.has(name)) return locals.get(name);
    if (name === 'ans') return ans;
    if (CONSTANTS.has(name)) return CONSTANTS.get(name);
    if (vars.has(name)) return vars.get(name);
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function valueOf(s) {
    if (s.kind === 'assign') return evalAssign(s);
    return evalNode(s.expr, null, null);
  }

  function evalAssign(node) {
    const v = valueOf(node.expr);
    vars.set(node.name, v);
    ans = v;
    return v;
  }

  function evaluateUnchecked(input) {
    const stmt = new Parser(input).parseStatement();
    const text = input.trim();
    let result;
    if (stmt.kind === 'define') {
      funcs.set(stmt.name, { params: stmt.params, body: stmt.body });
      result = `${stmt.name}(${stmt.params.join(',')})`;
    } else {
      result = valueOf(stmt);
      ans = result;
    }
    hist.push({ input: text, result });
    return result;
  }

  return {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      try {
        return evaluateUnchecked(input);
      } catch (e) {
        if (e instanceof RangeError) throw new CalcError('Expression is nested too deeply', 0);
        throw e;
      } finally {
        depth = 0;
      }
    },

    setAngleMode(m) {
      mode = checkMode(m, 0);
    },

    getAngleMode() {
      return mode;
    },

    getVariable(name) {
      if (name === 'ans') return ans;
      return vars.get(name);
    },

    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new CalcError(`Invalid variable name '${name}'`, 0);
      }
      if (name === 'ans' || CONSTANTS.has(name)) {
        throw new CalcError(`Cannot assign to '${name}'`, 0);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      vars.set(name, value);
    },

    history() {
      return hist.map((h) => ({ ...h }));
    },

    clear() {
      vars.clear();
      funcs.clear();
      ans = 0;
      hist = [];
    },

    format(value) {
      const r = Number(value.toPrecision(prec));
      return r === 0 ? '0' : String(r);
    },

    // Extra helper (not in SPEC): user variables sorted by name, excluding ans.
    listVariables() {
      return [...vars.keys()].sort().map((name) => [name, vars.get(name)]);
    },
  };
}
