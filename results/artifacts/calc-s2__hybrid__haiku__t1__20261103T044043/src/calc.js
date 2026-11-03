// Safe scientific calculator engine. No eval / Function: input is tokenized,
// parsed by a recursive-descent parser into an AST, and the AST is evaluated.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const ONE_ARG = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'sqrt', 'cbrt', 'abs', 'ln', 'log', 'log2', 'exp', 'floor', 'ceil', 'round', 'sign']);
const TWO_ARG = new Set(['atan2', 'pow', 'nroot', 'logb']);
const VARIADIC = new Set(['min', 'max', 'sum', 'avg', 'hypot']);
const BUILTINS = new Set([...ONE_ARG, ...TWO_ARG, ...VARIADIC]);
const MAX_DEPTH = 100;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPS = '+-*/%^!(),=';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function bad(pos, text, msg) {
  return { type: 'bad', value: text, text, pos, msg };
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      if (ch === '0' && /[xXbB]/.test(src[i + 1] || '')) {
        const hex = /[xX]/.test(src[i + 1]);
        const digitRe = hex ? /[0-9a-fA-F]/ : /[01]/;
        let j = i + 2;
        while (j < src.length && digitRe.test(src[j])) j++;
        if (j === i + 2) {
          toks.push(bad(i, src.slice(i, i + 2), 'Invalid number literal'));
          break;
        }
        const value = parseInt(src.slice(i + 2, j), hex ? 16 : 2);
        toks.push({ type: 'num', value, pos: i, text: src.slice(i, j) });
        i = j;
        continue;
      }
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      toks.push({ type: 'num', value: Number(m[0]), pos: i, text: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      NAME_RE.lastIndex = i;
      const m = NAME_RE.exec(src);
      toks.push({ type: 'name', value: m[0], pos: i, text: m[0] });
      i += m[0].length;
      continue;
    }
    if (OPS.includes(ch)) {
      toks.push({ type: 'op', value: ch, pos: i, text: ch });
      i++;
      continue;
    }
    toks.push(bad(i, ch, `Unexpected character '${ch}'`));
    break;
  }
  toks.push({ type: 'eof', value: '', pos: src.length, text: '' });
  return toks;
}

const isOp = (tok, v) => tok.type === 'op' && tok.value === v;

function syntaxError(tok) {
  if (tok.type === 'eof') return new CalcError('Unexpected end of input', tok.pos);
  if (tok.type === 'bad') return new CalcError(tok.msg, tok.pos);
  return new CalcError(`Unexpected token '${tok.text}'`, tok.pos);
}

// Grammar (low -> high precedence):
//   additive  := mul (('+'|'-') mul)*
//   mul       := implicit (('*'|'/'|'%') implicit)*
//   implicit  := unary (implicit-rhs)*     [prev token number or ')', next name or '(']
//   unary     := ('+'|'-') unary | power
//   power     := postfix ('^' powOperand)?   powOperand := ('+'|'-') powOperand | power
//   postfix   := primary '!'*
//   primary   := number | name | name '(' args ')' | '(' additive ')'
class Parser {
  constructor(toks) {
    this.toks = toks;
    this.i = 0;
    this.prev = null;
  }

  peek() { return this.toks[this.i]; }

  advance() {
    const t = this.toks[this.i];
    if (t.type !== 'eof') this.i++;
    this.prev = t;
    return t;
  }

  expectOp(v) {
    const t = this.peek();
    if (!isOp(t, v)) throw syntaxError(t);
    return this.advance();
  }

  expectEnd() {
    const t = this.peek();
    if (t.type !== 'eof') throw syntaxError(t);
  }

  parseExpr() {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (isOp(t, '+') || isOp(t, '-')) {
        this.advance();
        left = { type: 'bin', op: t.value, left, right: this.parseMul(), pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseMul() {
    let left = this.parseImplicit();
    for (;;) {
      const t = this.peek();
      if (isOp(t, '*') || isOp(t, '/') || isOp(t, '%')) {
        this.advance();
        left = { type: 'bin', op: t.value, left, right: this.parseImplicit(), pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prevOk = this.prev && (this.prev.type === 'num' || isOp(this.prev, ')'));
      if (prevOk && (t.type === 'name' || isOp(t, '('))) {
        left = { type: 'bin', op: '*', left, right: this.parseUnary(), pos: t.pos };
      } else {
        return left;
      }
    }
  }

  parseUnary() {
    const t = this.peek();
    if (isOp(t, '-') || isOp(t, '+')) {
      this.advance();
      return { type: 'un', op: t.value, arg: this.parseUnary(), pos: t.pos };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (isOp(t, '^')) {
      this.advance();
      return { type: 'bin', op: '^', left: base, right: this.parsePowOperand(), pos: t.pos };
    }
    return base;
  }

  parsePowOperand() {
    const t = this.peek();
    if (isOp(t, '-') || isOp(t, '+')) {
      this.advance();
      return { type: 'un', op: t.value, arg: this.parsePowOperand(), pos: t.pos };
    }
    return this.parsePower();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (isOp(this.peek(), '!')) {
      const t = this.advance();
      node = { type: 'fact', arg: node, pos: t.pos };
    }
    return node;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.advance();
      return { type: 'num', value: t.value, pos: t.pos };
    }
    if (t.type === 'name') {
      this.advance();
      if (isOp(this.peek(), '(')) {
        this.advance();
        const args = [];
        if (!isOp(this.peek(), ')')) {
          args.push(this.parseExpr());
          while (isOp(this.peek(), ',')) {
            this.advance();
            args.push(this.parseExpr());
          }
        }
        this.expectOp(')');
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'name', name: t.value, pos: t.pos };
    }
    if (isOp(t, '(')) {
      this.advance();
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    throw syntaxError(t);
  }
}

// Statement shapes: assignment, function definition, or expression.
function parseStatement(src) {
  const toks = tokenize(src);
  const tk = (j) => toks[Math.min(j, toks.length - 1)];
  const t0 = toks[0];

  if (t0.type === 'name' && isOp(tk(1), '=')) {
    const p = new Parser(toks);
    p.i = 2;
    const expr = p.parseExpr();
    p.expectEnd();
    return { kind: 'assign', name: t0.value, pos: t0.pos, expr };
  }

  if (t0.type === 'name' && isOp(tk(1), '(')) {
    let j = 2;
    const params = [];
    let ok = true;
    if (isOp(tk(j), ')')) {
      if (isOp(tk(j + 1), '=')) {
        throw new CalcError('Function definition requires at least one parameter', t0.pos);
      }
      ok = false;
    } else {
      for (;;) {
        const t = tk(j);
        if (t.type !== 'name') { ok = false; break; }
        params.push(t);
        j++;
        if (isOp(tk(j), ',')) { j++; continue; }
        if (isOp(tk(j), ')')) { j++; break; }
        ok = false;
        break;
      }
    }
    if (ok && isOp(tk(j), '=')) {
      const seen = new Set();
      for (const p of params) {
        if (seen.has(p.value)) throw new CalcError(`Duplicate parameter '${p.value}'`, p.pos);
        seen.add(p.value);
      }
      const p = new Parser(toks);
      p.i = j + 1;
      const body = p.parseExpr();
      p.expectEnd();
      return { kind: 'def', name: t0.value, pos: t0.pos, params: params.map((t) => t.value), body };
    }
  }

  const p = new Parser(toks);
  const expr = p.parseExpr();
  p.expectEnd();
  return { kind: 'expr', expr };
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') {
    throw new CalcError(`Invalid angle mode: ${angleMode}`, 0);
  }
  let mode = angleMode;
  const vars = new Map();
  const funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  const fin = (v, pos) => {
    if (!Number.isFinite(v)) throw new CalcError('Result is not a finite number', pos);
    return v;
  };
  const domain = (msg, pos) => new CalcError(`Domain error: ${msg}`, pos);
  const deg = () => mode === 'deg';
  const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  const normDeg = (x) => ((x % 360) + 360) % 360;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  function sinDeg(x) {
    const r = normDeg(x);
    if (r === 0 || r === 180) return 0;
    if (r === 90) return 1;
    if (r === 270) return -1;
    return snap(Math.sin((x * Math.PI) / 180));
  }

  function cosDeg(x) {
    const r = normDeg(x);
    if (r === 90 || r === 270) return 0;
    if (r === 0) return 1;
    if (r === 180) return -1;
    return snap(Math.cos((x * Math.PI) / 180));
  }

  function tanDeg(x, pos) {
    const r = normDeg(x);
    if (r === 0 || r === 180) return 0;
    if (r === 90 || r === 270) throw domain('tan is undefined at this angle', pos);
    return snap(Math.tan((x * Math.PI) / 180));
  }

  function callBuiltin(name, args, pos) {
    const need = ONE_ARG.has(name) ? 1 : TWO_ARG.has(name) ? 2 : null;
    if (need !== null && args.length !== need) {
      throw new CalcError(`${name} expects ${need} argument${need > 1 ? 's' : ''}, got ${args.length}`, pos);
    }
    if (VARIADIC.has(name) && args.length < 1) {
      throw new CalcError(`${name} expects at least 1 argument`, pos);
    }
    const [a, b] = args;
    let r;
    switch (name) {
      case 'sin': r = deg() ? sinDeg(a) : Math.sin(a); break;
      case 'cos': r = deg() ? cosDeg(a) : Math.cos(a); break;
      case 'tan': r = deg() ? tanDeg(a, pos) : Math.tan(a); break;
      case 'asin':
        if (Math.abs(a) > 1) throw domain('asin argument outside [-1, 1]', pos);
        r = deg() ? toDeg(Math.asin(a)) : Math.asin(a);
        break;
      case 'acos':
        if (Math.abs(a) > 1) throw domain('acos argument outside [-1, 1]', pos);
        r = deg() ? toDeg(Math.acos(a)) : Math.acos(a);
        break;
      case 'atan': r = deg() ? toDeg(Math.atan(a)) : Math.atan(a); break;
      case 'sinh': r = Math.sinh(a); break;
      case 'cosh': r = Math.cosh(a); break;
      case 'tanh': r = Math.tanh(a); break;
      case 'sqrt':
        if (a < 0) throw domain('sqrt of negative number', pos);
        r = Math.sqrt(a);
        break;
      case 'cbrt': r = Math.cbrt(a); break;
      case 'abs': r = Math.abs(a); break;
      case 'ln':
        if (a <= 0) throw domain('ln requires a positive argument', pos);
        r = Math.log(a);
        break;
      case 'log':
        if (a <= 0) throw domain('log requires a positive argument', pos);
        r = Math.log10(a);
        break;
      case 'log2':
        if (a <= 0) throw domain('log2 requires a positive argument', pos);
        r = Math.log2(a);
        break;
      case 'exp': r = Math.exp(a); break;
      case 'floor': r = Math.floor(a); break;
      case 'ceil': r = Math.ceil(a); break;
      case 'round': r = Math.sign(a) * Math.round(Math.abs(a)); break; // half away from zero
      case 'sign': r = Math.sign(a); break;
      case 'atan2': r = deg() ? toDeg(Math.atan2(a, b)) : Math.atan2(a, b); break;
      case 'pow': r = Math.pow(a, b); break;
      case 'nroot':
        if (b === 0) throw domain('zero root index', pos);
        if (a < 0) {
          if (Number.isInteger(b) && Math.abs(b) % 2 === 1) {
            r = -Math.pow(-a, 1 / b);
          } else {
            throw domain('even root of negative number', pos);
          }
        } else {
          r = Math.pow(a, 1 / b);
        }
        break;
      case 'logb':
        if (a <= 0 || b <= 0 || b === 1) throw domain('logb requires x > 0, base > 0, base != 1', pos);
        if (b === 10) r = Math.log10(a);
        else if (b === 2) r = Math.log2(a);
        else r = Math.log(a) / Math.log(b);
        break;
      case 'min': r = Math.min(...args); break;
      case 'max': r = Math.max(...args); break;
      case 'sum': r = args.reduce((s, x) => s + x, 0); break;
      case 'avg': r = args.reduce((s, x) => s + x, 0) / args.length; break;
      case 'hypot': r = Math.hypot(...args); break;
      default:
        throw new CalcError(`Unknown function '${name}'`, pos);
    }
    return fin(r, pos);
  }

  function callUser(name, fn, args, pos) {
    if (args.length !== fn.params.length) {
      throw new CalcError(`${name} expects ${fn.params.length} argument${fn.params.length > 1 ? 's' : ''}, got ${args.length}`, pos);
    }
    depth++;
    try {
      if (depth > MAX_DEPTH) throw new CalcError('Maximum recursion depth exceeded', pos);
      const frame = new Map();
      fn.params.forEach((p, i) => frame.set(p, args[i]));
      return evalNode(fn.body, frame);
    } finally {
      depth--;
    }
  }

  function callFunction(name, args, pos) {
    if (BUILTINS.has(name)) return callBuiltin(name, args, pos);
    if (funcs.has(name)) return callUser(name, funcs.get(name), args, pos);
    throw new CalcError(`Unknown function '${name}'`, pos);
  }

  function lookup(name, pos, frame) {
    if (frame && frame.has(name)) return frame.get(name);
    if (hasOwn(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function binop(op, l, r, pos) {
    switch (op) {
      case '+': return fin(l + r, pos);
      case '-': return fin(l - r, pos);
      case '*': return fin(l * r, pos);
      case '/':
        if (r === 0) throw new CalcError('Division by zero', pos);
        return fin(l / r, pos);
      case '%':
        if (r === 0) throw new CalcError('Remainder by zero', pos);
        return fin(l % r, pos);
      case '^': return fin(Math.pow(l, r), pos);
      default: throw new CalcError(`Unknown operator '${op}'`, pos);
    }
  }

  function factorial(v, pos) {
    if (!Number.isInteger(v) || v < 0) {
      throw new CalcError('Factorial requires a non-negative integer', pos);
    }
    if (v > 170) throw new CalcError('Factorial overflow (n must be <= 170)', pos);
    let r = 1;
    for (let i = 2; i <= v; i++) r *= i;
    return r;
  }

  function evalNode(node, frame) {
    switch (node.type) {
      case 'num': return fin(node.value, node.pos);
      case 'name': return lookup(node.name, node.pos, frame);
      case 'un': {
        const v = evalNode(node.arg, frame);
        return node.op === '-' ? -v : v;
      }
      case 'bin': {
        const l = evalNode(node.left, frame);
        const r = evalNode(node.right, frame);
        return binop(node.op, l, r, node.pos);
      }
      case 'fact': return factorial(evalNode(node.arg, frame), node.pos);
      case 'call': {
        const args = node.args.map((a) => evalNode(a, frame));
        return callFunction(node.name, args, node.pos);
      }
      default:
        throw new CalcError('Internal error: unknown node', node.pos);
    }
  }

  function checkName(name, pos) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CalcError(`Invalid name '${name}'`, pos);
  }

  const calc = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const src = input;
      const stmt = parseStatement(src);
      let result;
      if (stmt.kind === 'assign') {
        if (hasOwn(CONSTANTS, stmt.name) || stmt.name === 'ans') {
          throw new CalcError(`Cannot assign to '${stmt.name}'`, stmt.pos);
        }
        const value = evalNode(stmt.expr, null);
        vars.set(stmt.name, value);
        ans = value;
        result = value;
      } else if (stmt.kind === 'def') {
        if (BUILTINS.has(stmt.name) || hasOwn(CONSTANTS, stmt.name)) {
          throw new CalcError(`Cannot redefine built-in '${stmt.name}'`, stmt.pos);
        }
        funcs.set(stmt.name, { params: stmt.params, body: stmt.body });
        result = `${stmt.name}(${stmt.params.join(',')})`;
      } else {
        result = evalNode(stmt.expr, null);
        ans = result;
      }
      hist.push({ input: src.trim(), result });
      return result;
    },

    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
      mode = m;
    },

    getAngleMode() {
      return mode;
    },

    getVariable(name) {
      if (name === 'ans') return ans;
      return vars.has(name) ? vars.get(name) : undefined;
    },

    setVariable(name, value) {
      checkName(name, 0);
      if (hasOwn(CONSTANTS, name) || name === 'ans') {
        throw new CalcError(`Cannot assign to '${name}'`, 0);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      vars.set(name, value);
    },

    // User variables (excluding ans), sorted by name. Used by the REPL's :vars.
    variables() {
      return [...vars.keys()].sort().map((name) => ({ name, value: vars.get(name) }));
    },

    history() {
      return hist.map((h) => ({ input: h.input, result: h.result }));
    },

    clear() {
      vars.clear();
      funcs.clear();
      ans = 0;
      hist = [];
    },

    format(value) {
      return String(Number(value.toPrecision(precision)));
    },
  };
  return calc;
}
