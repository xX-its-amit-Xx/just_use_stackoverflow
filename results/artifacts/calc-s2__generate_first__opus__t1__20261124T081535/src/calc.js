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
function isNameStart(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'; }
function isNameChar(ch) { return isNameStart(ch) || isDigit(ch); }

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    const start = i;
    if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      let j = i + 2;
      while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      if (j === i + 2 || (j < n && isNameChar(src[j]))) {
        tokens.push({ type: 'invalid', pos: j < n ? j : start, message: 'Invalid hexadecimal literal' });
        return finish(tokens, n);
      }
      tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 16), pos: start });
      i = j; continue;
    }
    if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      let j = i + 2;
      while (j < n && (src[j] === '0' || src[j] === '1')) j++;
      if (j === i + 2 || (j < n && isNameChar(src[j]))) {
        tokens.push({ type: 'invalid', pos: j < n ? j : start, message: 'Invalid binary literal' });
        return finish(tokens, n);
      }
      tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 2), pos: start });
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
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), pos: start });
      i = j; continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < n && isNameChar(src[j])) j++;
      tokens.push({ type: 'name', value: src.slice(i, j), pos: start });
      i = j; continue;
    }
    if ('+-*/%^!(),='.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: start });
      i++; continue;
    }
    tokens.push({ type: 'invalid', pos: start, message: `Unexpected character '${ch}'` });
    return finish(tokens, n);
  }
  return finish(tokens, n);
}
function finish(tokens, n) {
  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

// ------------------------------------------------------------------- parser
class Parser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  isOp(v, t = this.peek()) { return t.type === 'op' && t.value === v; }
  fail(t = this.peek()) {
    if (t.type === 'invalid') throw new CalcError(t.message, t.pos);
    if (t.type === 'eof') throw new CalcError('Unexpected end of input', t.pos);
    const text = t.type === 'num' ? 'number' : `'${t.value}'`;
    throw new CalcError(`Unexpected token ${text}`, t.pos);
  }
  expectOp(v) {
    const t = this.peek();
    if (!this.isOp(v, t)) {
      if (t.type === 'invalid') this.fail(t);
      if (t.type === 'eof') throw new CalcError(`Expected '${v}' but reached end of input`, t.pos);
      throw new CalcError(`Expected '${v}'`, t.pos);
    }
    return this.next();
  }
  parseExpressionToEnd() {
    const node = this.parseAdditive();
    if (this.peek().type !== 'eof') this.fail();
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
  lastTokenAllowsImplicit() {
    const prev = this.tokens[this.i - 1];
    return prev && (prev.type === 'num' || (prev.type === 'op' && prev.value === ')'));
  }
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if ((t.type === 'name' || this.isOp('(', t)) && this.lastTokenAllowsImplicit()) {
        const right = this.parseUnary();
        left = { type: 'bin', op: '*', left, right, pos: t.pos };
      } else break;
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
        if (!this.isOp(')')) {
          args.push(this.parseAdditive());
          while (this.isOp(',')) { this.next(); args.push(this.parseAdditive()); }
        }
        this.expectOp(')');
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (this.isOp('(')) {
      this.next();
      const inner = this.parseAdditive();
      this.expectOp(')');
      return inner;
    }
    this.fail(t);
  }
}

// ---------------------------------------------------------------- built-ins
const TRIG_EPS = 1e-12;
function snap(x) { return Math.abs(x) < TRIG_EPS ? 0 : x; }

function factorial(x, pos) {
  if (!Number.isInteger(x) || x < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (x > 170) throw new CalcError('Factorial overflow (argument > 170)', pos);
  let r = 1;
  for (let k = 2; k <= x; k++) r *= k;
  return r;
}

function makeBuiltins(getMode) {
  const toRad = (x) => (getMode() === 'deg' ? x * Math.PI / 180 : x);
  const fromRad = (x) => (getMode() === 'deg' ? x * 180 / Math.PI : x);
  const degReduce = (x) => { let r = x % 360; if (r < 0) r += 360; return r; };
  const dom = (msg) => { throw new CalcError(msg); };
  const b = {
    sin: [1, (x) => {
      if (getMode() === 'deg') {
        const r = degReduce(x);
        if (r === 0 || r === 180) return 0;
        if (r === 90) return 1;
        if (r === 270) return -1;
        if (r === 30 || r === 150) return 0.5;
        if (r === 210 || r === 330) return -0.5;
      }
      return snap(Math.sin(toRad(x)));
    }],
    cos: [1, (x) => {
      if (getMode() === 'deg') {
        const r = degReduce(x);
        if (r === 90 || r === 270) return 0;
        if (r === 0) return 1;
        if (r === 180) return -1;
        if (r === 60 || r === 300) return 0.5;
        if (r === 120 || r === 240) return -0.5;
      }
      return snap(Math.cos(toRad(x)));
    }],
    tan: [1, (x) => {
      if (getMode() === 'deg') {
        const r = degReduce(x);
        if (r === 0 || r === 180) return 0;
        if (r === 90 || r === 270) dom('tan undefined at this angle');
        if (r === 45 || r === 225) return 1;
        if (r === 135 || r === 315) return -1;
      }
      return snap(Math.tan(toRad(x)));
    }],
    asin: [1, (x) => { if (x < -1 || x > 1) dom('asin argument out of domain [-1, 1]'); return fromRad(Math.asin(x)); }],
    acos: [1, (x) => { if (x < -1 || x > 1) dom('acos argument out of domain [-1, 1]'); return fromRad(Math.acos(x)); }],
    atan: [1, (x) => fromRad(Math.atan(x))],
    atan2: [2, (y, x) => fromRad(Math.atan2(y, x))],
    sinh: [1, Math.sinh],
    cosh: [1, Math.cosh],
    tanh: [1, Math.tanh],
    sqrt: [1, (x) => { if (x < 0) dom('sqrt of negative number'); return Math.sqrt(x); }],
    cbrt: [1, Math.cbrt],
    abs: [1, Math.abs],
    ln: [1, (x) => { if (x <= 0) dom('ln requires a positive argument'); return Math.log(x); }],
    log: [1, (x) => { if (x <= 0) dom('log requires a positive argument'); return Math.log10(x); }],
    log2: [1, (x) => { if (x <= 0) dom('log2 requires a positive argument'); return Math.log2(x); }],
    exp: [1, Math.exp],
    floor: [1, Math.floor],
    ceil: [1, Math.ceil],
    round: [1, (x) => (x < 0 ? -Math.round(-x) : Math.round(x))],
    sign: [1, Math.sign],
    pow: [2, (x, y) => power(x, y)],
    nroot: [2, (x, n) => {
      if (n === 0) dom('nroot with n = 0');
      if (x < 0) {
        if (Number.isInteger(n) && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);
        dom('nroot of negative number requires odd integer n');
      }
      return Math.pow(x, 1 / n);
    }],
    logb: [2, (x, base) => {
      if (x <= 0) dom('logb requires a positive argument');
      if (base <= 0 || base === 1) dom('logb requires a positive base other than 1');
      return Math.log(x) / Math.log(base);
    }],
    min: [-1, (...a) => Math.min(...a)],
    max: [-1, (...a) => Math.max(...a)],
    sum: [-1, (...a) => a.reduce((s, v) => s + v, 0)],
    avg: [-1, (...a) => a.reduce((s, v) => s + v, 0) / a.length],
    hypot: [-1, (...a) => Math.hypot(...a)],
  };
  return b;
}

function power(x, y) {
  if (x === 0 && y < 0) throw new CalcError('Division by zero');
  return Math.pow(x, y);
}

export const BUILTIN_NAMES = Object.freeze(Object.keys(makeBuiltins(() => 'rad')));

// --------------------------------------------------------------- calculator
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError(`Invalid angle mode '${angleMode}'`);
  if (!Number.isInteger(precision) || precision < 1 || precision > 100) {
    throw new CalcError('precision must be an integer between 1 and 100');
  }
  let mode = angleMode;
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  const builtins = makeBuiltins(() => mode);

  function check(v, pos) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Result is not a finite number', pos);
    return v;
  }

  function evalNode(node, scope, depth) {
    switch (node.type) {
      case 'num': return node.value;
      case 'var': {
        const name = node.name;
        if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
        if (name === 'ans') return ans;
        if (vars.has(name)) return vars.get(name);
        if (funcs.has(name) || Object.prototype.hasOwnProperty.call(builtins, name)) {
          throw new CalcError(`'${name}' is a function; call it with parentheses`, node.pos);
        }
        throw new CalcError(`Undefined variable '${name}'`, node.pos);
      }
      case 'neg': {
        const v = -evalNode(node.operand, scope, depth);
        return v === 0 ? 0 : v;
      }
      case 'fact': return check(factorial(evalNode(node.operand, scope, depth), node.pos), node.pos);
      case 'bin': {
        const a = evalNode(node.left, scope, depth);
        const b = evalNode(node.right, scope, depth);
        let r;
        switch (node.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': if (b === 0) throw new CalcError('Division by zero', node.pos); r = a / b; break;
          case '%': if (b === 0) throw new CalcError('Remainder by zero', node.pos); r = a % b; break;
          case '^':
            try { r = power(a, b); } catch (e) { e.position = node.pos; throw e; }
            break;
          default: throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
        }
        return check(r, node.pos);
      }
      case 'call': {
        const args = node.args.map((a) => evalNode(a, scope, depth));
        const name = node.name;
        if (funcs.has(name)) {
          const f = funcs.get(name);
          if (args.length !== f.params.length) {
            throw new CalcError(`Function '${name}' expects ${f.params.length} argument(s), got ${args.length}`, node.pos);
          }
          if (depth + 1 > MAX_DEPTH) throw new CalcError(`Maximum call depth exceeded (recursion in '${name}')`, node.pos);
          const local = Object.create(null);
          f.params.forEach((p, i) => { local[p] = args[i]; });
          return check(evalNode(f.body, local, depth + 1), node.pos);
        }
        if (Object.prototype.hasOwnProperty.call(builtins, name)) {
          const [arity, fn] = builtins[name];
          if (arity === -1) {
            if (args.length < 1) throw new CalcError(`Function '${name}' expects at least 1 argument`, node.pos);
          } else if (args.length !== arity) {
            throw new CalcError(`Function '${name}' expects ${arity} argument(s), got ${args.length}`, node.pos);
          }
          let r;
          try { r = fn(...args); } catch (e) {
            if (e instanceof CalcError) { e.position = node.pos; throw e; }
            throw e;
          }
          return check(r, node.pos);
        }
        throw new CalcError(`Undefined function '${name}'`, node.pos);
      }
      default: throw new CalcError('Invalid expression', node.pos ?? 0);
    }
  }

  function isReservedName(name) {
    return Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans';
  }

  function tryParseDefinition(tokens) {
    // name ( p1 , p2 ... ) =
    if (tokens[0].type !== 'name' || !(tokens[1].type === 'op' && tokens[1].value === '(')) return null;
    let i = 2;
    const params = [];
    for (;;) {
      const t = tokens[i];
      if (t.type !== 'name') return null;
      params.push(t);
      i++;
      const sep = tokens[i];
      if (sep.type === 'op' && sep.value === ',') { i++; continue; }
      if (sep.type === 'op' && sep.value === ')') { i++; break; }
      return null;
    }
    const eq = tokens[i];
    if (!(eq.type === 'op' && eq.value === '=')) return null;
    return { params, bodyStart: i + 1 };
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    if (tokens[0].type === 'eof') throw new CalcError('Empty input', 0);
    let result;

    const def = tryParseDefinition(tokens);
    if (def) {
      const nameTok = tokens[0];
      const name = nameTok.value;
      if (Object.prototype.hasOwnProperty.call(builtins, name)) {
        throw new CalcError(`Cannot redefine built-in function '${name}'`, nameTok.pos);
      }
      if (isReservedName(name)) throw new CalcError(`Cannot define function named '${name}'`, nameTok.pos);
      const seen = new Set();
      for (const p of def.params) {
        if (seen.has(p.value)) throw new CalcError(`Duplicate parameter '${p.value}'`, p.pos);
        seen.add(p.value);
      }
      const parser = new Parser(tokens);
      parser.i = def.bodyStart;
      const body = parser.parseExpressionToEnd();
      const params = def.params.map((p) => p.value);
      funcs.set(name, { params, body });
      result = `${name}(${params.join(',')})`;
    } else if (tokens[0].type === 'name' && tokens[1].type === 'op' && tokens[1].value === '=') {
      const nameTok = tokens[0];
      const parser = new Parser(tokens);
      parser.i = 2;
      const body = parser.parseExpressionToEnd();
      if (isReservedName(nameTok.value)) {
        throw new CalcError(`Cannot assign to '${nameTok.value}'`, nameTok.pos);
      }
      const v = check(evalNode(body, null, 0), nameTok.pos);
      vars.set(nameTok.value, v);
      ans = v;
      result = v;
    } else {
      const parser = new Parser(tokens);
      const body = parser.parseExpressionToEnd();
      const v = check(evalNode(body, null, 0), 0);
      ans = v;
      result = v;
    }
    hist.push({ input: input.trim(), result });
    return result;
  }

  return {
    evaluate,
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode '${m}'`, 0);
      mode = m;
    },
    getAngleMode() { return mode; },
    getVariable(name) {
      if (name === 'ans') return ans;
      return vars.has(name) ? vars.get(name) : undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
      if (isReservedName(name)) throw new CalcError(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Variable value must be a finite number', 0);
      vars.set(name, value);
    },
    variables() {
      return Object.fromEntries([...vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    },
    functions() {
      return [...funcs.entries()].map(([n, f]) => `${n}(${f.params.join(',')})`);
    },
    history() { return hist.map((h) => ({ input: h.input, result: h.result })); },
    clear() {
      vars = new Map();
      funcs = new Map();
      ans = 0;
      hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      const r = Number(value.toPrecision(precision));
      if (Object.is(r, -0) || r === 0) return '0';
      return String(r);
    },
  };
}
