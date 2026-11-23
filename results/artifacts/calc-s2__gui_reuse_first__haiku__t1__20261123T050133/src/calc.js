// Scientific calculator engine (no eval / Function).
//
// Tokenizer number/identifier scanning and position tracking are adapted from
// silentmatt/expr-eval src/token-stream.js (MIT; see THIRD_PARTY_NOTICES.md and
// PROVENANCE.json). The grammar, evaluator, statements and error model are
// written for the calc-s2 spec.

const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: 2 * Math.PI });

const FN1 = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'sqrt', 'cbrt', 'abs', 'ln', 'log', 'log2', 'exp', 'floor', 'ceil', 'round', 'sign',
]);
const FN2 = new Set(['atan2', 'pow', 'nroot', 'logb']);
const FNV = new Set(['min', 'max', 'sum', 'avg', 'hypot']);
const BUILTINS = new Set([...FN1, ...FN2, ...FNV]);

const MAX_CALL_DEPTH = 100;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

// ---------------------------------------------------------------- tokenizer

function isDigit(c) {
  return c >= '0' && c <= '9';
}

function isNameStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isNameChar(c) {
  return isNameStart(c) || isDigit(c);
}

const PUNCT = new Set(['+', '-', '*', '/', '%', '^', '!', '(', ')', ',', '=']);

// Token: { t, v, p } where t is 'num' | 'name' | 'eof' | 'bad' or the punctuation itself.
function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;

    // Radix integers: 0x1F, 0b101 (lowercase prefix, per spec).
    if (c === '0' && (s[i + 1] === 'x' || s[i + 1] === 'b')) {
      const isHex = s[i + 1] === 'x';
      let j = i + 2;
      while (j < s.length && (isHex ? /[0-9A-Fa-f]/ : /[01]/).test(s[j])) j++;
      if (j > i + 2) {
        toks.push({ t: 'num', v: parseInt(s.slice(i + 2, j), isHex ? 16 : 2), p: start });
        i = j;
        continue;
      }
    }

    // Decimal numbers: 12, 3.5, .5, 1e-3, 2.5E+4. An exponent without digits is not consumed.
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) {
      let j = i;
      let seenDot = false;
      while (j < s.length) {
        const d = s[j];
        if (isDigit(d)) j++;
        else if (d === '.' && !seenDot) { seenDot = true; j++; }
        else break;
      }
      let end = j;
      if (s[j] === 'e' || s[j] === 'E') {
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        if (k < s.length && isDigit(s[k])) {
          while (k < s.length && isDigit(s[k])) k++;
          end = k;
        }
      }
      toks.push({ t: 'num', v: parseFloat(s.slice(i, end)), p: start });
      i = end;
      continue;
    }

    if (isNameStart(c)) {
      let j = i + 1;
      while (j < s.length && isNameChar(s[j])) j++;
      toks.push({ t: 'name', v: s.slice(i, j), p: start });
      i = j;
      continue;
    }

    if (PUNCT.has(c)) {
      toks.push({ t: c, v: c, p: start });
    } else {
      // Unknown character: recorded and reported by the parser when it is reached.
      toks.push({ t: 'bad', v: c, p: start });
    }
    i++;
  }
  toks.push({ t: 'eof', v: '', p: s.length });
  return toks;
}

// ------------------------------------------------------------------- parser

function describe(tok) {
  switch (tok.t) {
    case 'eof': return 'Unexpected end of input';
    case 'bad': return `Unexpected character '${tok.v}'`;
    case 'num': return `Unexpected number '${tok.v}'`;
    case 'name': return `Unexpected name '${tok.v}'`;
    default: return `Unexpected '${tok.t}'`;
  }
}

class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
  }

  peek(k = 0) {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  take() {
    const t = this.peek();
    if (t.t !== 'eof') this.i++;
    return t;
  }

  fail(tok, msg) {
    throw new CalcError(msg ?? describe(tok), tok.p);
  }

  expectEof() {
    const t = this.peek();
    if (t.t !== 'eof') this.fail(t);
  }

  // Statement := name '=' expr | name '(' params ')' '=' expr | expr
  parseStatement() {
    const t0 = this.peek(0);
    const t1 = this.peek(1);
    if (t0.t === 'name' && t1.t === '=') {
      if (t0.v === 'ans' || Object.hasOwn(CONSTANTS, t0.v)) {
        throw new CalcError(`Cannot assign to '${t0.v}'`, t0.p);
      }
      this.i += 2;
      const expr = this.parseAdd();
      this.expectEof();
      return { kind: 'assign', name: t0.v, expr };
    }
    if (t0.t === 'name' && t1.t === '(' && this.isFuncDefStart()) {
      return this.parseFuncDef();
    }
    const expr = this.parseAdd();
    this.expectEof();
    return { kind: 'expr', expr };
  }

  isFuncDefStart() {
    let k = 2;
    if (this.peek(k).t === ')') return this.peek(k + 1).t === '=';
    for (;;) {
      if (this.peek(k).t !== 'name') return false;
      k++;
      if (this.peek(k).t === ',') { k++; continue; }
      if (this.peek(k).t === ')') return this.peek(k + 1).t === '=';
      return false;
    }
  }

  parseFuncDef() {
    const nameTok = this.take();
    this.take(); // '('
    const params = [];
    if (this.peek().t !== ')') {
      for (;;) {
        const p = this.take();
        if (params.some((x) => x.v === p.v)) {
          throw new CalcError(`Duplicate parameter '${p.v}'`, p.p);
        }
        params.push(p);
        if (this.peek().t === ',') { this.take(); continue; }
        break;
      }
    }
    this.take(); // ')'
    if (params.length === 0) {
      throw new CalcError(`Function '${nameTok.v}' needs at least one parameter`, nameTok.p);
    }
    if (BUILTINS.has(nameTok.v)) {
      throw new CalcError(`Cannot redefine built-in function '${nameTok.v}'`, nameTok.p);
    }
    this.take(); // '='
    const body = this.parseAdd();
    this.expectEof();
    return { kind: 'def', name: nameTok.v, params: params.map((p) => p.v), body };
  }

  // additive: + - (lowest)
  parseAdd() {
    let left = this.parseMul();
    while (this.peek().t === '+' || this.peek().t === '-') {
      const op = this.take();
      const right = this.parseMul();
      left = { type: 'bin', op: op.t, l: left, r: right, p: op.p };
    }
    return left;
  }

  // * / %  (left-assoc); operands are implicit-multiplication chains
  parseMul() {
    let left = this.parseImplicit();
    while (this.peek().t === '*' || this.peek().t === '/' || this.peek().t === '%') {
      const op = this.take();
      const right = this.parseImplicit();
      left = { type: 'bin', op: op.t, l: left, r: right, p: op.p };
    }
    return left;
  }

  // Implicit multiplication: a number or ')' directly followed by a name or '('.
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const prev = this.toks[this.i - 1];
      const next = this.peek();
      if (!prev || (prev.t !== 'num' && prev.t !== ')')) break;
      if (next.t !== 'name' && next.t !== '(') break;
      const right = this.parseUnary();
      left = { type: 'bin', op: '*', l: left, r: right, p: next.p };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.t === '-' || t.t === '+') {
      this.take();
      const a = this.parseUnary();
      return { type: 'un', op: t.t, a, p: t.p };
    }
    return this.parsePow();
  }

  // power: right-associative; exponent may carry a unary sign.
  parsePow() {
    const base = this.parsePostfix();
    if (this.peek().t === '^') {
      const op = this.take();
      const exp = this.parseUnary();
      return { type: 'bin', op: '^', l: base, r: exp, p: op.p };
    }
    return base;
  }

  parsePostfix() {
    let e = this.parsePrimary();
    while (this.peek().t === '!') {
      const b = this.take();
      e = { type: 'fact', a: e, p: b.p };
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.t === 'num') {
      this.take();
      return { type: 'num', v: t.v, p: t.p };
    }
    if (t.t === '(') {
      this.take();
      const e = this.parseAdd();
      const c = this.peek();
      if (c.t !== ')') this.fail(c);
      this.take();
      return e;
    }
    if (t.t === 'name') {
      this.take();
      if (this.peek().t === '(') {
        this.take();
        const args = [];
        if (this.peek().t !== ')') {
          args.push(this.parseAdd());
          while (this.peek().t === ',') {
            this.take();
            args.push(this.parseAdd());
          }
        }
        const c = this.peek();
        if (c.t !== ')') this.fail(c);
        this.take();
        return { type: 'call', name: t.v, args, p: t.p };
      }
      return { type: 'var', name: t.v, p: t.p };
    }
    return this.fail(t);
  }
}

// --------------------------------------------------------------- evaluation

function factorial(v, p) {
  if (!Number.isInteger(v) || v < 0) {
    throw new CalcError('Factorial requires a non-negative integer', p);
  }
  if (v > 170) throw new CalcError('Factorial argument too large (max 170)', p);
  let r = 1;
  for (let k = 2; k <= v; k++) r *= k;
  return r;
}

function finite(v, p) {
  if (!Number.isFinite(v)) {
    throw new CalcError('Result is not a finite number', p);
  }
  return v;
}

function validateMode(mode, position = 0) {
  if (mode !== 'rad' && mode !== 'deg') {
    throw new CalcError(`Invalid angle mode '${mode}' (expected 'rad' or 'deg')`, position);
  }
  return mode;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = validateMode(angleMode);
  let ans = 0;
  const vars = new Map();
  const userFns = new Map();
  let hist = [];
  let depth = 0;

  function applyBuiltin(name, args, p) {
    const deg = mode === 'deg';
    const toRad = (x) => (deg ? (x * Math.PI) / 180 : x);
    const fromRad = (y) => (deg ? (y * 180) / Math.PI : y);
    const snap = (v) => (deg && Math.abs(v) < 1e-12 ? 0 : v);
    const need = (cond, msg) => { if (!cond) throw new CalcError(msg, p); };
    const arityErr = () => new CalcError(`Wrong number of arguments for '${name}'`, p);

    if (FN1.has(name) && args.length !== 1) throw arityErr();
    if (FN2.has(name) && args.length !== 2) throw arityErr();
    if (FNV.has(name) && args.length < 1) throw arityErr();

    const [a = 0, b = 0] = args;
    let r;
    switch (name) {
      case 'sin': r = snap(Math.sin(toRad(a))); break;
      case 'cos': r = snap(Math.cos(toRad(a))); break;
      case 'tan': r = snap(Math.tan(toRad(a))); break;
      case 'asin':
        need(a >= -1 && a <= 1, `asin domain error: ${a} is outside [-1, 1]`);
        r = fromRad(Math.asin(a)); break;
      case 'acos':
        need(a >= -1 && a <= 1, `acos domain error: ${a} is outside [-1, 1]`);
        r = fromRad(Math.acos(a)); break;
      case 'atan': r = fromRad(Math.atan(a)); break;
      case 'sinh': r = Math.sinh(a); break;
      case 'cosh': r = Math.cosh(a); break;
      case 'tanh': r = Math.tanh(a); break;
      case 'sqrt':
        need(a >= 0, 'sqrt of a negative number');
        r = Math.sqrt(a); break;
      case 'cbrt': r = Math.cbrt(a); break;
      case 'abs': r = Math.abs(a); break;
      case 'ln':
        need(a > 0, 'ln requires a positive argument');
        r = Math.log(a); break;
      case 'log':
        need(a > 0, 'log requires a positive argument');
        r = Math.log10(a); break;
      case 'log2':
        need(a > 0, 'log2 requires a positive argument');
        r = Math.log2(a); break;
      case 'exp': r = Math.exp(a); break;
      case 'floor': r = Math.floor(a); break;
      case 'ceil': r = Math.ceil(a); break;
      case 'round': r = Math.sign(a) * Math.round(Math.abs(a)); break; // half away from zero
      case 'sign': r = Math.sign(a); break;
      case 'atan2': r = fromRad(Math.atan2(a, b)); break;
      case 'pow': r = Math.pow(a, b); break;
      case 'nroot':
        need(b !== 0, 'nroot degree must not be zero');
        if (a < 0) {
          need(Number.isInteger(b) && Math.abs(b % 2) === 1,
            'nroot of a negative number needs an odd integer degree');
          r = -Math.pow(-a, 1 / b);
        } else {
          r = Math.pow(a, 1 / b);
        }
        break;
      case 'logb':
        need(a > 0 && b > 0 && b !== 1, 'logb requires a > 0 and a base > 0 other than 1');
        r = Math.log(a) / Math.log(b); break;
      case 'min': r = Math.min(...args); break;
      case 'max': r = Math.max(...args); break;
      case 'sum': r = args.reduce((s, x) => s + x, 0); break;
      case 'avg': r = args.reduce((s, x) => s + x, 0) / args.length; break;
      case 'hypot': r = Math.hypot(...args); break;
      default: throw new CalcError(`Unknown function '${name}'`, p);
    }
    return finite(r, p);
  }

  function lookupVar(name, scope, p) {
    if (scope && Object.hasOwn(scope, name)) return scope[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name];
    throw new CalcError(`Undefined variable '${name}'`, p);
  }

  function ev(node, scope) {
    switch (node.type) {
      case 'num':
        return finite(node.v, node.p);
      case 'var':
        return lookupVar(node.name, scope, node.p);
      case 'un': {
        const v = ev(node.a, scope);
        return node.op === '-' ? -v : v;
      }
      case 'fact':
        return factorial(ev(node.a, scope), node.p);
      case 'bin': {
        const l = ev(node.l, scope);
        const r = ev(node.r, scope);
        let v;
        switch (node.op) {
          case '+': v = l + r; break;
          case '-': v = l - r; break;
          case '*': v = l * r; break;
          case '/':
            if (r === 0) throw new CalcError('Division by zero', node.p);
            v = l / r; break;
          case '%':
            if (r === 0) throw new CalcError('Remainder by zero', node.p);
            v = l % r; break;
          case '^': v = Math.pow(l, r); break;
          default: throw new CalcError(`Unknown operator '${node.op}'`, node.p);
        }
        return finite(v, node.p);
      }
      case 'call': {
        const args = node.args.map((a) => ev(a, scope));
        if (BUILTINS.has(node.name)) return applyBuiltin(node.name, args, node.p);
        const fn = userFns.get(node.name);
        if (!fn) throw new CalcError(`Unknown function '${node.name}'`, node.p);
        if (args.length !== fn.params.length) {
          throw new CalcError(
            `Function '${node.name}' expects ${fn.params.length} argument(s), got ${args.length}`,
            node.p);
        }
        if (depth + 1 > MAX_CALL_DEPTH) {
          throw new CalcError('Maximum recursion depth exceeded', node.p);
        }
        const inner = Object.create(null);
        fn.params.forEach((name, idx) => { inner[name] = args[idx]; });
        depth++;
        try {
          return finite(ev(fn.body, inner), node.p);
        } finally {
          depth--;
        }
      }
      default:
        throw new CalcError('Internal error: unknown node', 0);
    }
  }

  const calc = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const stmt = new Parser(input).parseStatement();
      let result;
      if (stmt.kind === 'def') {
        userFns.set(stmt.name, { params: stmt.params, body: stmt.body });
        result = `${stmt.name}(${stmt.params.join(',')})`;
      } else if (stmt.kind === 'assign') {
        const v = ev(stmt.expr, null);
        vars.set(stmt.name, v);
        ans = v;
        result = v;
      } else {
        result = ev(stmt.expr, null);
        ans = result;
      }
      hist.push({ input, result });
      return result;
    },

    setAngleMode(m) {
      mode = validateMode(m);
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
      if (name === 'ans' || Object.hasOwn(CONSTANTS, name)) {
        throw new CalcError(`Cannot assign to '${name}'`, 0);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      vars.set(name, value);
    },

    // Extra helpers used by the REPL.
    variables() {
      const out = {};
      for (const [k, v] of vars) out[k] = v;
      return out;
    },

    history() {
      return hist.map((h) => ({ ...h }));
    },

    clear() {
      vars.clear();
      userFns.clear();
      ans = 0;
      hist = [];
    },

    format(value) {
      if (value === 0) return '0';
      return String(Number(value.toPrecision(precision)));
    },
  };
  return calc;
}
