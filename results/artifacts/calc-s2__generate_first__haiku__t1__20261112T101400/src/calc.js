// Scientific calculator engine: tokenizer, recursive-descent parser and
// tree-walking evaluator. No eval / Function; everything is interpreted.

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
const MAX_CALL_DEPTH = 100;

// ---------------------------------------------------------------- tokenizer

function isOpTok(tok, v) {
  return tok.t === 'op' && tok.v === v;
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function tokenize(src) {
  const toks = [];
  const n = src.length;
  const radixRe = /0(?:[xX]([0-9a-fA-F]+)|[bB]([01]+))/y;
  const decRe = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const nameRe = /[A-Za-z_][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      radixRe.lastIndex = i;
      let m = radixRe.exec(src);
      if (m) {
        const v = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 2);
        if (!Number.isFinite(v)) throw new CalcError('Number out of range', i);
        toks.push({ t: 'num', v, pos: i });
        i += m[0].length;
        continue;
      }
      decRe.lastIndex = i;
      m = decRe.exec(src);
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw new CalcError('Number out of range', i);
      toks.push({ t: 'num', v, pos: i });
      i += m[0].length;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      nameRe.lastIndex = i;
      const m = nameRe.exec(src);
      toks.push({ t: 'name', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^!(),='.includes(c)) {
      toks.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}'`, i);
  }
  toks.push({ t: 'eof', pos: n });
  return toks;
}

// ------------------------------------------------------------------- parser

class Parser {
  constructor(toks, end) {
    this.toks = toks;
    this.i = 0;
    this.end = end;
  }

  peek() { return this.toks[this.i]; }

  advance() {
    const t = this.toks[this.i];
    if (t.t !== 'eof') this.i++;
    return t;
  }

  isOp(v, tok = this.peek()) { return tok.t === 'op' && tok.v === v; }

  fail(tok = this.peek()) {
    let what;
    if (tok.t === 'eof') what = 'end of input';
    else if (tok.t === 'num') what = 'number';
    else what = `'${tok.v}'`;
    throw new CalcError(`Syntax error: unexpected ${what}`, tok.pos);
  }

  prevIsOperand() {
    if (this.i === 0) return false;
    const p = this.toks[this.i - 1];
    return p.t === 'num' || this.isOp(')', p);
  }

  parseTop() {
    const e = this.parseAdd();
    if (this.peek().t !== 'eof') this.fail();
    return e;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.advance();
      const right = this.parseMul();
      left = { t: 'bin', op: op.v, a: left, b: right, pos: op.pos };
    }
    return left;
  }

  parseMul() {
    let left = this.parseImplicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.advance();
      const right = this.parseImplicit();
      left = { t: 'bin', op: op.v, a: left, b: right, pos: op.pos };
    }
    return left;
  }

  parseImplicit() {
    let left = this.parseUnary();
    while (this.prevIsOperand() && (this.peek().t === 'name' || this.isOp('('))) {
      const pos = this.peek().pos;
      const right = this.parseUnary();
      left = { t: 'bin', op: '*', a: left, b: right, pos };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('+') || this.isOp('-')) {
      const op = this.advance();
      const a = this.parseUnary();
      return { t: 'un', op: op.v, a, pos: op.pos };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      const op = this.advance();
      const exp = this.parseUnary(); // right-assoc; exponent may carry a sign
      return { t: 'bin', op: '^', a: base, b: exp, pos: op.pos };
    }
    return base;
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (this.isOp('!')) {
      const op = this.advance();
      node = { t: 'fact', a: node, pos: op.pos };
    }
    return node;
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.t === 'num') {
      this.advance();
      return { t: 'num', v: tok.v, pos: tok.pos };
    }
    if (tok.t === 'name') {
      this.advance();
      if (this.isOp('(')) {
        this.advance();
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.parseAdd());
          while (this.isOp(',')) {
            this.advance();
            args.push(this.parseAdd());
          }
        }
        if (!this.isOp(')')) this.fail();
        this.advance();
        return { t: 'call', name: tok.v, args, pos: tok.pos };
      }
      return { t: 'var', name: tok.v, pos: tok.pos };
    }
    if (this.isOp('(')) {
      this.advance();
      const e = this.parseAdd();
      if (!this.isOp(')')) this.fail();
      this.advance();
      return e;
    }
    this.fail(tok);
    return null; // unreachable
  }
}

// ------------------------------------------------------------- calculator

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') {
    throw new CalcError(`Invalid angle mode: ${angleMode}`, 0);
  }
  let mode = angleMode;
  const vars = new Map();
  const userFns = new Map();
  let historyList = [];
  let depth = 0;
  vars.set('ans', 0);

  const deg = () => mode === 'deg';
  const toRad = (x) => (deg() ? (x * Math.PI) / 180 : x);
  const fromRad = (r) => (deg() ? (r * 180) / Math.PI : r);
  const snap = (v) => (deg() && Math.abs(v) < 1e-12 ? 0 : v);
  const domain = (msg, at) => new CalcError(msg, at);

  // Built-in functions: {min, max, f(args, at)}
  const BUILTINS = new Map();
  const def1 = (name, f) => BUILTINS.set(name, { min: 1, max: 1, f: ([x], at) => f(x, at) });
  const def2 = (name, f) => BUILTINS.set(name, { min: 2, max: 2, f: ([x, y], at) => f(x, y, at) });
  const defVar = (name, f) => BUILTINS.set(name, { min: 1, max: Infinity, f });

  def1('sin', (x) => snap(Math.sin(toRad(x))));
  def1('cos', (x) => snap(Math.cos(toRad(x))));
  def1('tan', (x) => snap(Math.tan(toRad(x))));
  def1('asin', (x, at) => {
    if (x < -1 || x > 1) throw domain('asin domain error', at);
    return fromRad(Math.asin(x));
  });
  def1('acos', (x, at) => {
    if (x < -1 || x > 1) throw domain('acos domain error', at);
    return fromRad(Math.acos(x));
  });
  def1('atan', (x) => fromRad(Math.atan(x)));
  def1('sinh', (x) => Math.sinh(x));
  def1('cosh', (x) => Math.cosh(x));
  def1('tanh', (x) => Math.tanh(x));
  def1('sqrt', (x, at) => {
    if (x < 0) throw domain('sqrt of negative number', at);
    return Math.sqrt(x);
  });
  def1('cbrt', (x) => Math.cbrt(x));
  def1('abs', (x) => Math.abs(x));
  def1('ln', (x, at) => {
    if (x <= 0) throw domain('ln domain error', at);
    return Math.log(x);
  });
  def1('log', (x, at) => {
    if (x <= 0) throw domain('log domain error', at);
    return Math.log10(x);
  });
  def1('log2', (x, at) => {
    if (x <= 0) throw domain('log2 domain error', at);
    return Math.log2(x);
  });
  def1('exp', (x) => Math.exp(x));
  def1('floor', (x) => Math.floor(x));
  def1('ceil', (x) => Math.ceil(x));
  def1('round', (x) => {
    // half away from zero
    const a = Math.abs(x);
    let f = Math.floor(a);
    if (a - f >= 0.5) f += 1;
    return Math.sign(x) * f;
  });
  def1('sign', (x) => Math.sign(x));

  def2('atan2', (y, x) => fromRad(Math.atan2(y, x)));
  def2('pow', (x, y, at) => power(x, y, at));
  def2('nroot', (x, n, at) => {
    if (n === 0 || !Number.isFinite(n)) throw domain('nroot: invalid root index', at);
    if (x < 0) {
      if (Number.isInteger(n) && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);
      throw domain('nroot: negative base needs odd integer index', at);
    }
    return Math.pow(x, 1 / n);
  });
  def2('logb', (x, b, at) => {
    if (x <= 0 || b <= 0 || b === 1) throw domain('logb domain error', at);
    return Math.log(x) / Math.log(b);
  });

  defVar('min', (args) => Math.min(...args));
  defVar('max', (args) => Math.max(...args));
  defVar('sum', (args) => args.reduce((s, v) => s + v, 0));
  defVar('avg', (args) => args.reduce((s, v) => s + v, 0) / args.length);
  defVar('hypot', (args) => Math.hypot(...args));

  // -------------------------------------------------------- evaluation

  function errPos(node, env) {
    return env.override !== null ? env.override : node.pos;
  }

  function checkFinite(v, at) {
    if (!Number.isFinite(v)) throw new CalcError('Result is not finite (overflow)', at);
    return v;
  }

  function power(a, b, at) {
    if (a === 0 && b < 0) throw new CalcError('Division by zero', at);
    return checkFinite(Math.pow(a, b), at);
  }

  function factorial(v, at) {
    if (!Number.isInteger(v) || v < 0) {
      throw new CalcError('Factorial requires a non-negative integer', at);
    }
    if (v > 170) throw new CalcError('Factorial overflow (n > 170)', at);
    let r = 1;
    for (let k = 2; k <= v; k++) r *= k;
    return r;
  }

  function binop(op, a, b, at) {
    switch (op) {
      case '+': return checkFinite(a + b, at);
      case '-': return checkFinite(a - b, at);
      case '*': return checkFinite(a * b, at);
      case '/':
        if (b === 0) throw new CalcError('Division by zero', at);
        return checkFinite(a / b, at);
      case '%':
        if (b === 0) throw new CalcError('Division by zero', at);
        return checkFinite(a % b, at);
      case '^': return power(a, b, at);
      default: throw new CalcError(`Unknown operator ${op}`, at);
    }
  }

  function lookupVar(node, env) {
    if (env.locals && env.locals.has(node.name)) return env.locals.get(node.name);
    if (vars.has(node.name)) return vars.get(node.name);
    if (CONSTANTS.has(node.name)) return CONSTANTS.get(node.name);
    throw new CalcError(`Unknown variable: ${node.name}`, errPos(node, env));
  }

  let callDepth = 0;

  function evalCall(node, env) {
    const at = errPos(node, env);
    const b = BUILTINS.get(node.name);
    if (b) {
      const n = node.args.length;
      if (n < b.min || n > b.max) {
        const expected = b.max === Infinity ? `at least ${b.min}` : `${b.min}`;
        throw new CalcError(`${node.name} expects ${expected} argument(s), got ${n}`, at);
      }
      const args = node.args.map((a) => ev(a, env));
      return checkFinite(b.f(args, at), at);
    }
    const f = userFns.get(node.name);
    if (!f) throw new CalcError(`Unknown function: ${node.name}`, at);
    if (node.args.length !== f.params.length) {
      throw new CalcError(
        `${node.name} expects ${f.params.length} argument(s), got ${node.args.length}`,
        at,
      );
    }
    const args = node.args.map((a) => ev(a, env));
    const locals = new Map();
    f.params.forEach((p, k) => locals.set(p, args[k]));
    callDepth++;
    try {
      if (callDepth > MAX_CALL_DEPTH) {
        throw new CalcError('Maximum call depth exceeded (recursion?)', at);
      }
      return ev(f.body, { locals, override: at });
    } finally {
      callDepth--;
    }
  }

  function ev(node, env) {
    switch (node.t) {
      case 'num':
        return node.v;
      case 'var':
        return lookupVar(node, env);
      case 'un': {
        const a = ev(node.a, env);
        return node.op === '-' ? -a : +a;
      }
      case 'bin': {
        const a = ev(node.a, env);
        const b = ev(node.b, env);
        return binop(node.op, a, b, errPos(node, env));
      }
      case 'fact':
        return factorial(ev(node.a, env), errPos(node, env));
      case 'call':
        return evalCall(node, env);
      default:
        throw new CalcError('Internal error: unknown node', errPos(node, env));
    }
  }

  const GLOBAL_ENV = { locals: null, override: null };

  function checkAssignableName(tok) {
    if (CONSTANTS.has(tok.v)) {
      throw new CalcError(`Cannot assign to constant: ${tok.v}`, tok.pos);
    }
    if (tok.v === 'ans') throw new CalcError('Cannot assign to ans', tok.pos);
  }

  function defineFunction(toks, src) {
    const p = new Parser(toks, src.length);
    const nameTok = p.advance();
    if (BUILTINS.has(nameTok.v)) {
      throw new CalcError(`Cannot redefine built-in function: ${nameTok.v}`, nameTok.pos);
    }
    p.advance(); // '('
    const params = [];
    if (p.isOp(')')) {
      throw new CalcError('Function definition needs at least one parameter', p.peek().pos);
    }
    for (;;) {
      const t = p.peek();
      if (t.t !== 'name') p.fail(t);
      p.advance();
      if (params.includes(t.v)) {
        throw new CalcError(`Duplicate parameter: ${t.v}`, t.pos);
      }
      params.push(t.v);
      if (p.isOp(',')) { p.advance(); continue; }
      break;
    }
    if (!p.isOp(')')) p.fail();
    p.advance();
    if (!p.isOp('=')) p.fail();
    p.advance();
    const body = p.parseTop();
    userFns.set(nameTok.v, { params, body });
    return `${nameTok.v}(${params.join(',')})`;
  }

  const calc = {
    evaluate(input) {
      const src = String(input);
      const toks = tokenize(src);
      const text = src.trim();
      let result;
      if (toks[0].t === 'name' && toks[1].t === 'op' && toks[1].v === '=') {
        checkAssignableName(toks[0]);
        const p = new Parser(toks, src.length);
        p.i = 2;
        const expr = p.parseTop();
        const value = ev(expr, GLOBAL_ENV);
        vars.set(toks[0].v, value);
        vars.set('ans', value);
        result = value;
      } else if (toks[0].t === 'name' && isOpTok(toks[1], '(') && toks.some((t) => isOpTok(t, '='))) {
        result = defineFunction(toks, src);
      } else {
        const expr = new Parser(toks, src.length).parseTop();
        const value = ev(expr, GLOBAL_ENV);
        vars.set('ans', value);
        result = value;
      }
      historyList.push({ input: text, result });
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
      if (!vars.has(name)) return undefined;
      return vars.get(name);
    },

    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new CalcError(`Invalid variable name: ${name}`, 0);
      }
      if (CONSTANTS.has(name) || name === 'ans') {
        throw new CalcError(`Cannot assign to ${name}`, 0);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('Variable value must be a finite number', 0);
      }
      vars.set(name, value);
    },

    // User variables only (excludes ans), sorted by name.
    variables() {
      return [...vars.keys()]
        .filter((k) => k !== 'ans')
        .sort()
        .map((name) => ({ name, value: vars.get(name) }));
    },

    history() {
      return historyList.map((h) => ({ input: h.input, result: h.result }));
    },

    clear() {
      vars.clear();
      vars.set('ans', 0);
      userFns.clear();
      historyList = [];
    },

    format(value) {
      if (Object.is(value, -0)) return '0';
      return String(Number(value.toPrecision(precision)));
    },
  };

  return calc;
}
