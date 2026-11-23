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
const MAX_DEPTH = 100;

// ---------------- Tokenizer ----------------
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
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        let j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(src[j])) j++;
        if (j === i + 2) throw new CalcError('Invalid hexadecimal literal', start);
        if (j < n && isNameChar(src[j])) throw new CalcError('Invalid hexadecimal literal', j);
        tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 16), pos: start });
        i = j; continue;
      }
      if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        let j = i + 2;
        while (j < n && (src[j] === '0' || src[j] === '1')) j++;
        if (j === i + 2) throw new CalcError('Invalid binary literal', start);
        if (j < n && isDigit(src[j])) throw new CalcError('Invalid binary literal', j);
        tokens.push({ type: 'num', value: parseInt(src.slice(i + 2, j), 2), pos: start });
        i = j; continue;
      }
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && isDigit(src[j])) j++; }
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
    throw new CalcError(`Unexpected character '${ch}'`, start);
  }
  tokens.push({ type: 'eof', value: null, pos: n });
  return tokens;
}

// ---------------- Parser ----------------
class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(o = 0) { return this.t[this.i + o]; }
  next() { return this.t[this.i++]; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  fail(tok) {
    if (tok.type === 'eof') throw new CalcError('Unexpected end of input', tok.pos);
    throw new CalcError(`Unexpected token '${tok.value}'`, tok.pos);
  }
  expectOp(v) {
    const tok = this.peek();
    if (tok.type !== 'op' || tok.value !== v) this.fail(tok);
    return this.next();
  }
  parseFull() {
    const node = this.parseExpr();
    if (this.peek().type !== 'eof') this.fail(this.peek());
    return node;
  }
  parseExpr() { // + -
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      const right = this.parseMul();
      left = { type: 'bin', op: op.value, left, right, pos: op.pos };
    }
    return left;
  }
  parseMul() { // * / %
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
      const prev = this.t[this.i - 1];
      const tok = this.peek();
      const prevOk = prev && (prev.type === 'num' || (prev.type === 'op' && prev.value === ')'));
      const nextOk = tok.type === 'name' || (tok.type === 'op' && tok.value === '(');
      if (!prevOk || !nextOk) break;
      const right = this.parsePower();
      left = { type: 'bin', op: '*', left, right, pos: tok.pos };
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
      const exp = this.parseUnary(); // right-assoc, allows unary sign
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
    const tok = this.peek();
    if (tok.type === 'num') { this.next(); return { type: 'num', value: tok.value, pos: tok.pos }; }
    if (tok.type === 'name') {
      this.next();
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.isOp(',')) { this.next(); args.push(this.parseExpr()); }
        }
        this.expectOp(')');
        return { type: 'call', name: tok.value, args, pos: tok.pos };
      }
      return { type: 'var', name: tok.value, pos: tok.pos };
    }
    if (tok.type === 'op' && tok.value === '(') {
      this.next();
      const inner = this.parseExpr();
      this.expectOp(')');
      return inner;
    }
    this.fail(tok);
  }
}

// ---------------- Built-ins ----------------
const DEG = Math.PI / 180;

function factorial(x, pos) {
  if (!Number.isInteger(x) || x < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (x > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let k = 2; k <= x; k++) r *= k;
  return r;
}

function snap(v) { return Math.abs(v) < 1e-12 ? 0 : v; }

function degTrig(name, x) {
  let r = x % 360;
  if (r < 0) r += 360;
  if (r % 90 === 0) {
    const q = r / 90; // 0..3
    if (name === 'sin') return [0, 1, 0, -1][q];
    if (name === 'cos') return [1, 0, -1, 0][q];
    if (q % 2 === 1) return NaN; // tan undefined
    return 0;
  }
  if (r === 30 || r === 150) { if (name === 'sin') return 0.5; }
  if (r === 210 || r === 330) { if (name === 'sin') return -0.5; }
  if (r === 60 || r === 300) { if (name === 'cos') return 0.5; }
  if (r === 120 || r === 240) { if (name === 'cos') return -0.5; }
  if (name === 'tan' && (r === 45 || r === 225)) return 1;
  if (name === 'tan' && (r === 135 || r === 315)) return -1;
  return snap(Math[name](r * DEG));
}

function domain(msg, pos) { throw new CalcError(msg, pos); }

function makeBuiltins(getMode) {
  const deg = () => getMode() === 'deg';
  const trig = (name) => (pos, x) => (deg() ? degTrig(name, x) : Math[name](x));
  const inv = (name, check) => (pos, x) => {
    if (check && (x < -1 || x > 1)) domain(`${name} argument out of domain`, pos);
    const r = Math[name](x);
    return deg() ? r / DEG : r;
  };
  const one = (f) => ({ min: 1, max: 1, f });
  return {
    sin: one(trig('sin')), cos: one(trig('cos')), tan: one(trig('tan')),
    asin: one(inv('asin', true)), acos: one(inv('acos', true)), atan: one(inv('atan', false)),
    sinh: one((p, x) => Math.sinh(x)), cosh: one((p, x) => Math.cosh(x)), tanh: one((p, x) => Math.tanh(x)),
    sqrt: one((p, x) => (x < 0 ? domain('sqrt of negative number', p) : Math.sqrt(x))),
    cbrt: one((p, x) => Math.cbrt(x)),
    abs: one((p, x) => Math.abs(x)),
    ln: one((p, x) => (x <= 0 ? domain('ln domain error', p) : Math.log(x))),
    log: one((p, x) => (x <= 0 ? domain('log domain error', p) : Math.log10(x))),
    log2: one((p, x) => (x <= 0 ? domain('log2 domain error', p) : Math.log2(x))),
    exp: one((p, x) => Math.exp(x)),
    floor: one((p, x) => Math.floor(x)),
    ceil: one((p, x) => Math.ceil(x)),
    round: one((p, x) => Math.sign(x) * Math.round(Math.abs(x))),
    sign: one((p, x) => Math.sign(x)),
    atan2: { min: 2, max: 2, f: (p, y, x) => { const r = Math.atan2(y, x); return deg() ? r / DEG : r; } },
    pow: { min: 2, max: 2, f: (p, x, y) => Math.pow(x, y) },
    nroot: { min: 2, max: 2, f: (p, x, n) => {
      if (n === 0) domain('nroot with zero degree', p);
      if (x < 0) {
        if (Number.isInteger(n) && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);
        domain('nroot of negative number requires odd integer degree', p);
      }
      const r = Math.pow(x, 1 / n);
      const rr = Math.round(r);
      return Math.pow(rr, n) === x ? rr : r;
    } },
    logb: { min: 2, max: 2, f: (p, x, b) => {
      if (x <= 0 || b <= 0 || b === 1) domain('logb domain error', p);
      return Math.log(x) / Math.log(b);
    } },
    min: { min: 1, max: Infinity, f: (p, ...a) => Math.min(...a) },
    max: { min: 1, max: Infinity, f: (p, ...a) => Math.max(...a) },
    sum: { min: 1, max: Infinity, f: (p, ...a) => a.reduce((s, v) => s + v, 0) },
    avg: { min: 1, max: Infinity, f: (p, ...a) => a.reduce((s, v) => s + v, 0) / a.length },
    hypot: { min: 1, max: Infinity, f: (p, ...a) => Math.hypot(...a) },
  };
}

function checkFinite(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError(Number.isNaN(v) ? 'Domain error' : 'Overflow: result is not finite', pos);
  return v;
}

// ---------------- Calculator ----------------
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError(`Invalid angle mode '${angleMode}'`, 0);
  let mode = angleMode;
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  const builtins = makeBuiltins(() => mode);

  function lookupVar(name, pos, scope) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    if (Object.prototype.hasOwnProperty.call(builtins, name) || funcs.has(name)) {
      throw new CalcError(`'${name}' is a function`, pos);
    }
    throw new CalcError(`Undefined variable '${name}'`, pos);
  }

  function ev(node, scope, depth) {
    switch (node.type) {
      case 'num': return node.value;
      case 'var': return lookupVar(node.name, node.pos, scope);
      case 'neg': return -ev(node.operand, scope, depth);
      case 'fact': return factorial(ev(node.operand, scope, depth), node.pos);
      case 'bin': {
        const a = ev(node.left, scope, depth);
        const b = ev(node.right, scope, depth);
        let r;
        switch (node.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': if (b === 0) throw new CalcError('Division by zero', node.pos); r = a / b; break;
          case '%': if (b === 0) throw new CalcError('Remainder by zero', node.pos); r = a % b; break;
          case '^': r = Math.pow(a, b); break;
        }
        return checkFinite(r, node.pos);
      }
      case 'call': {
        const args = node.args.map((a) => ev(a, scope, depth));
        const b = Object.prototype.hasOwnProperty.call(builtins, node.name) ? builtins[node.name] : null;
        if (b) {
          if (args.length < b.min || args.length > b.max) {
            throw new CalcError(`Wrong number of arguments for ${node.name}`, node.pos);
          }
          return checkFinite(b.f(node.pos, ...args), node.pos);
        }
        const uf = funcs.get(node.name);
        if (!uf) throw new CalcError(`Unknown function '${node.name}'`, node.pos);
        if (args.length !== uf.params.length) {
          throw new CalcError(`Wrong number of arguments for ${node.name}: expected ${uf.params.length}`, node.pos);
        }
        if (depth + 1 > MAX_DEPTH) throw new CalcError(`Recursion limit exceeded in ${node.name}`, node.pos);
        const inner = Object.create(null);
        uf.params.forEach((p, k) => { inner[p] = args[k]; });
        return checkFinite(ev(uf.body, inner, depth + 1), node.pos);
      }
    }
    throw new CalcError('Invalid expression', node.pos ?? 0);
  }

  function isReserved(name) {
    return Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans';
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    if (tokens[0].type === 'eof') throw new CalcError('Empty input', tokens[0].pos);

    // Function definition: name ( p, ... ) = expr
    if (tokens[0].type === 'name' && tokens[1].type === 'op' && tokens[1].value === '(') {
      let j = 2;
      const params = [];
      let ok = true;
      for (;;) {
        const t = tokens[j];
        if (t.type !== 'name') { ok = false; break; }
        params.push(t);
        j++;
        const s = tokens[j];
        if (s.type === 'op' && s.value === ',') { j++; continue; }
        if (s.type === 'op' && s.value === ')') { j++; break; }
        ok = false; break;
      }
      if (ok && tokens[j].type === 'op' && tokens[j].value === '=') {
        const name = tokens[0].value;
        if (Object.prototype.hasOwnProperty.call(builtins, name)) {
          throw new CalcError(`Cannot redefine built-in function '${name}'`, tokens[0].pos);
        }
        if (isReserved(name)) throw new CalcError(`Cannot define function named '${name}'`, tokens[0].pos);
        const seen = new Set();
        for (const p of params) {
          if (seen.has(p.value)) throw new CalcError(`Duplicate parameter '${p.value}'`, p.pos);
          if (isReserved(p.value)) throw new CalcError(`Invalid parameter name '${p.value}'`, p.pos);
          seen.add(p.value);
        }
        const parser = new Parser(tokens);
        parser.i = j + 1;
        const body = parser.parseFull();
        const names = params.map((p) => p.value);
        funcs.set(name, { params: names, body });
        const sig = `${name}(${names.join(',')})`;
        hist.push({ input, result: sig });
        return sig;
      }
    }

    // Assignment: name = expr
    if (tokens[0].type === 'name' && tokens[1].type === 'op' && tokens[1].value === '=') {
      const name = tokens[0].value;
      if (isReserved(name)) throw new CalcError(`Cannot assign to '${name}'`, tokens[0].pos);
      if (Object.prototype.hasOwnProperty.call(builtins, name)) {
        throw new CalcError(`Cannot assign to built-in function '${name}'`, tokens[0].pos);
      }
      const parser = new Parser(tokens);
      parser.i = 2;
      const body = parser.parseFull();
      const v = checkFinite(ev(body, null, 0), tokens[0].pos);
      vars.set(name, v);
      ans = v;
      hist.push({ input, result: v });
      return v;
    }

    const ast = new Parser(tokens).parseFull();
    const v = checkFinite(ev(ast, null, 0), 0);
    ans = v;
    hist.push({ input, result: v });
    return v;
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
      if (isReserved(name)) throw new CalcError(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Variable value must be a finite number', 0);
      vars.set(name, value);
    },
    variables() {
      return [...vars.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, vars.get(k)]);
    },
    history() { return hist.map((h) => ({ input: h.input, result: h.result })); },
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      if (typeof value !== 'number') return String(value);
      const r = Number(value.toPrecision(precision));
      if (Object.is(r, -0) || r === 0) return '0';
      return String(r);
    },
  };
}
