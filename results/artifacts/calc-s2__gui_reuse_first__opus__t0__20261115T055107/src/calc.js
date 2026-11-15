// calc-s2: safe scientific calculator engine (no eval / Function).
// The tokenizer's scanning routines (whitespace, radix integers, decimal
// numbers with exponents, names) are adapted from silentmatt/expr-eval
// src/token-stream.js (MIT, Copyright (c) 2015 Matthew Crumley).
// See THIRD_PARTY_NOTICES.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// Tokenizer (adapted from expr-eval TokenStream)
// ---------------------------------------------------------------------------

class TokenStream {
  constructor(expression) {
    this.expression = expression;
    this.pos = 0;
    this.current = null;
  }

  newToken(type, value, pos) {
    return { type, value, pos: pos != null ? pos : this.pos };
  }

  next() {
    if (this.pos >= this.expression.length) {
      return this.newToken('eof', 'EOF');
    }
    if (this.isWhitespace()) {
      return this.next();
    } else if (this.isRadixInteger() || this.isNumber() || this.isPunct() || this.isName()) {
      return this.current;
    }
    throw new CalcError('Unknown character "' + this.expression.charAt(this.pos) + '"', this.pos);
  }

  isPunct() {
    const c = this.expression.charAt(this.pos);
    if ('+-*/%^!(),='.includes(c)) {
      this.current = this.newToken(c, c);
      this.pos++;
      return true;
    }
    return false;
  }

  isName() {
    const startPos = this.pos;
    let i = startPos;
    for (; i < this.expression.length; i++) {
      const c = this.expression.charAt(i);
      const isLetter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
      if (isLetter || c === '_') continue;
      if (i > startPos && c >= '0' && c <= '9') continue;
      break;
    }
    if (i > startPos) {
      const str = this.expression.substring(startPos, i);
      this.current = this.newToken('name', str, startPos);
      this.pos = i;
      return true;
    }
    return false;
  }

  isWhitespace() {
    let r = false;
    let c = this.expression.charAt(this.pos);
    while (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      r = true;
      this.pos++;
      if (this.pos >= this.expression.length) break;
      c = this.expression.charAt(this.pos);
    }
    return r;
  }

  isRadixInteger() {
    let pos = this.pos;
    if (pos >= this.expression.length - 2 || this.expression.charAt(pos) !== '0') {
      return false;
    }
    ++pos;
    let radix;
    let validDigit;
    const p = this.expression.charAt(pos);
    if (p === 'x' || p === 'X') {
      radix = 16;
      validDigit = /^[0-9a-f]$/i;
      ++pos;
    } else if (p === 'b' || p === 'B') {
      radix = 2;
      validDigit = /^[01]$/;
      ++pos;
    } else {
      return false;
    }
    let valid = false;
    const startPos = pos;
    while (pos < this.expression.length) {
      const c = this.expression.charAt(pos);
      if (validDigit.test(c)) {
        pos++;
        valid = true;
      } else {
        break;
      }
    }
    if (valid) {
      this.current = this.newToken('num', parseInt(this.expression.substring(startPos, pos), radix), this.pos);
      this.pos = pos;
    }
    return valid;
  }

  isNumber() {
    let valid = false;
    let pos = this.pos;
    const startPos = pos;
    let resetPos = pos;
    let foundDot = false;
    let foundDigits = false;
    let c;

    while (pos < this.expression.length) {
      c = this.expression.charAt(pos);
      if ((c >= '0' && c <= '9') || (!foundDot && c === '.')) {
        if (c === '.') foundDot = true;
        else foundDigits = true;
        pos++;
        valid = foundDigits;
      } else {
        break;
      }
    }
    if (valid) resetPos = pos;

    if (valid && (c === 'e' || c === 'E') && pos < this.expression.length) {
      pos++;
      let acceptSign = true;
      let validExponent = false;
      while (pos < this.expression.length) {
        c = this.expression.charAt(pos);
        if (acceptSign && (c === '+' || c === '-')) {
          acceptSign = false;
        } else if (c >= '0' && c <= '9') {
          validExponent = true;
          acceptSign = false;
        } else {
          break;
        }
        pos++;
      }
      if (!validExponent) pos = resetPos;
    }

    if (valid) {
      this.current = this.newToken('num', parseFloat(this.expression.substring(startPos, pos)), startPos);
      this.pos = pos;
    } else {
      this.pos = startPos;
    }
    return valid;
  }
}

function tokenize(input) {
  const ts = new TokenStream(input);
  const tokens = [];
  for (;;) {
    const t = ts.next();
    tokens.push(t);
    if (t.type === 'eof') break;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent) -> AST
// ---------------------------------------------------------------------------

class Parser {
  constructor(tokens, start = 0, end = tokens.length - 1) {
    this.tokens = tokens;
    this.i = start;
    this.end = end; // index of terminating (eof) token
  }
  peek() { return this.tokens[Math.min(this.i, this.end)]; }
  prev() { return this.tokens[this.i - 1]; }
  advance() { const t = this.peek(); if (this.i < this.end) this.i++; return t; }
  atEnd() { return this.i >= this.end; }
  check(type) { return !this.atEnd() && this.peek().type === type; }
  tokPos(t) { return t.type === 'eof' ? t.pos : t.pos; }
  fail(t, msg) {
    const tok = t || this.peek();
    const isEnd = this.atEnd() && tok === this.peek();
    throw new CalcError(msg || (isEnd ? 'Unexpected end of input' : `Unexpected token "${tok.value}"`), tok.pos);
  }

  parseExpression() {
    const node = this.parseAdditive();
    return node;
  }

  parseAll() {
    const node = this.parseExpression();
    if (!this.atEnd()) this.fail();
    return node;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.check('+') || this.check('-')) {
      const op = this.advance();
      const right = this.parseMultiplicative();
      left = { type: 'bin', op: op.type, left, right, pos: op.pos };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseImplicit();
    while (this.check('*') || this.check('/') || this.check('%')) {
      const op = this.advance();
      const right = this.parseImplicit();
      left = { type: 'bin', op: op.type, left, right, pos: op.pos };
    }
    return left;
  }

  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const last = this.prev();
      const lastOk = last && (last.type === 'num' || last.type === ')');
      if (lastOk && (this.check('name') || this.check('('))) {
        const pos = this.peek().pos;
        const right = this.parseUnary();
        left = { type: 'bin', op: '*', left, right, pos };
      } else {
        break;
      }
    }
    return left;
  }

  parseUnary() {
    if (this.check('+') || this.check('-')) {
      const op = this.advance();
      const operand = this.parseUnary();
      return op.type === '-' ? { type: 'neg', operand, pos: op.pos } : operand;
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.check('^')) {
      const op = this.advance();
      const exp = this.parseUnary();
      return { type: 'bin', op: '^', left: base, right: exp, pos: op.pos };
    }
    return base;
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (this.check('!')) {
      const op = this.advance();
      node = { type: 'fact', operand: node, pos: op.pos };
    }
    return node;
  }

  parsePrimary() {
    if (this.atEnd()) this.fail();
    const t = this.peek();
    if (t.type === 'num') {
      this.advance();
      return { type: 'num', value: t.value, pos: t.pos };
    }
    if (t.type === 'name') {
      this.advance();
      if (this.check('(')) {
        this.advance();
        const args = [];
        if (this.check(')')) {
          this.advance();
        } else {
          for (;;) {
            args.push(this.parseExpression());
            if (this.check(',')) { this.advance(); continue; }
            if (this.check(')')) { this.advance(); break; }
            this.fail();
          }
        }
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (t.type === '(') {
      this.advance();
      const inner = this.parseExpression();
      if (!this.check(')')) this.fail();
      this.advance();
      return inner;
    }
    this.fail();
  }
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;
const DEG = Math.PI / 180;

function snap(x) { return Math.abs(x) < 1e-12 ? 0 : x; }

function roundHalfAway(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError(`Invalid angle mode "${angleMode}"`, 0);
  let mode = angleMode;
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];

  const domain = (cond, msg, pos) => { if (!cond) throw new CalcError(msg, pos); };

  const toRad = (x) => (mode === 'deg' ? x * DEG : x);
  const fromRad = (x) => (mode === 'deg' ? x / DEG : x);

  const builtins = {
    sin: [1, ([x]) => {
      if (mode === 'deg') {
        const m = ((x % 360) + 360) % 360;
        if (m === 0 || m === 180) return 0;
        if (m === 90) return 1;
        if (m === 270) return -1;
        if (m === 30 || m === 150) return 0.5;
        if (m === 210 || m === 330) return -0.5;
      }
      return snap(Math.sin(toRad(x)));
    }],
    cos: [1, ([x]) => {
      if (mode === 'deg') {
        const m = ((x % 360) + 360) % 360;
        if (m === 90 || m === 270) return 0;
        if (m === 0) return 1;
        if (m === 180) return -1;
        if (m === 60 || m === 300) return 0.5;
        if (m === 120 || m === 240) return -0.5;
      }
      return snap(Math.cos(toRad(x)));
    }],
    tan: [1, ([x], pos) => {
      if (mode === 'deg') {
        const m = ((x % 180) + 180) % 180;
        if (m === 0) return 0;
        if (m === 45) return 1;
        if (m === 135) return -1;
        domain(m !== 90, 'tan undefined', pos);
      }
      return snap(Math.tan(toRad(x)));
    }],
    asin: [1, ([x], pos) => { domain(x >= -1 && x <= 1, 'asin domain error', pos); return fromRad(Math.asin(x)); }],
    acos: [1, ([x], pos) => { domain(x >= -1 && x <= 1, 'acos domain error', pos); return fromRad(Math.acos(x)); }],
    atan: [1, ([x]) => fromRad(Math.atan(x))],
    atan2: [2, ([y, x]) => fromRad(Math.atan2(y, x))],
    sinh: [1, ([x]) => Math.sinh(x)],
    cosh: [1, ([x]) => Math.cosh(x)],
    tanh: [1, ([x]) => Math.tanh(x)],
    sqrt: [1, ([x], pos) => { domain(x >= 0, 'sqrt of negative number', pos); return Math.sqrt(x); }],
    cbrt: [1, ([x]) => Math.cbrt(x)],
    abs: [1, ([x]) => Math.abs(x)],
    ln: [1, ([x], pos) => { domain(x > 0, 'ln domain error', pos); return Math.log(x); }],
    log: [1, ([x], pos) => { domain(x > 0, 'log domain error', pos); return Math.log10(x); }],
    log2: [1, ([x], pos) => { domain(x > 0, 'log2 domain error', pos); return Math.log2(x); }],
    exp: [1, ([x]) => Math.exp(x)],
    floor: [1, ([x]) => Math.floor(x)],
    ceil: [1, ([x]) => Math.ceil(x)],
    round: [1, ([x]) => roundHalfAway(x)],
    sign: [1, ([x]) => Math.sign(x)],
    pow: [2, ([x, y], pos) => power(x, y, pos)],
    nroot: [2, ([x, n], pos) => {
      domain(n !== 0, 'nroot with zero degree', pos);
      if (x < 0) {
        domain(Number.isInteger(n) && Math.abs(n) % 2 === 1, 'nroot of negative number requires odd integer degree', pos);
        return -rootPos(-x, n);
      }
      return rootPos(x, n);
    }],
    logb: [2, ([x, b], pos) => {
      domain(x > 0 && b > 0 && b !== 1, 'logb domain error', pos);
      return Math.log(x) / Math.log(b);
    }],
    min: [-1, (a) => Math.min(...a)],
    max: [-1, (a) => Math.max(...a)],
    sum: [-1, (a) => a.reduce((s, v) => s + v, 0)],
    avg: [-1, (a) => a.reduce((s, v) => s + v, 0) / a.length],
    hypot: [-1, (a) => Math.hypot(...a)],
  };

  function rootPos(x, n) {
    if (n === 3) return Math.cbrt(x);
    if (n === 2) return Math.sqrt(x);
    const r = Math.pow(x, 1 / n);
    const rr = Math.round(r);
    if (rr !== r && Math.pow(rr, n) === x) return rr;
    return r;
  }

  function power(x, y, pos) {
    const r = Math.pow(x, y);
    if (x === 0 && y < 0) throw new CalcError('Division by zero', pos);
    return r;
  }

  function check(v, pos) {
    if (!Number.isFinite(v)) throw new CalcError(Number.isNaN(v) ? 'Domain error' : 'Overflow', pos);
    return v;
  }

  function lookup(name, scope, pos) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    throw new CalcError(`Undefined variable "${name}"`, pos);
  }

  function ev(node, scope, depth) {
    switch (node.type) {
      case 'num': return node.value;
      case 'var': return lookup(node.name, scope, node.pos);
      case 'neg': return -ev(node.operand, scope, depth);
      case 'fact': return factorial(ev(node.operand, scope, depth), node.pos);
      case 'bin': {
        const a = ev(node.left, scope, depth);
        const b = ev(node.right, scope, depth);
        switch (node.op) {
          case '+': return check(a + b, node.pos);
          case '-': return check(a - b, node.pos);
          case '*': return check(a * b, node.pos);
          case '/':
            if (b === 0) throw new CalcError('Division by zero', node.pos);
            return check(a / b, node.pos);
          case '%':
            if (b === 0) throw new CalcError('Remainder by zero', node.pos);
            return check(a % b, node.pos);
          case '^': return check(power(a, b, node.pos), node.pos);
        }
        throw new CalcError('Unknown operator', node.pos);
      }
      case 'call': {
        const name = node.name;
        if (Object.prototype.hasOwnProperty.call(builtins, name)) {
          const [arity, fn] = builtins[name];
          if (arity === -1 ? node.args.length < 1 : node.args.length !== arity) {
            throw new CalcError(`${name} expects ${arity === -1 ? 'at least 1 argument' : arity + ' argument' + (arity > 1 ? 's' : '')}, got ${node.args.length}`, node.pos);
          }
          const args = node.args.map((a) => ev(a, scope, depth));
          return check(fn(args, node.pos), node.pos);
        }
        if (funcs.has(name)) {
          const f = funcs.get(name);
          if (node.args.length !== f.params.length) {
            throw new CalcError(`${name} expects ${f.params.length} argument${f.params.length > 1 ? 's' : ''}, got ${node.args.length}`, node.pos);
          }
          if (depth + 1 > MAX_DEPTH) throw new CalcError(`Maximum recursion depth exceeded in ${name}`, node.pos);
          const args = node.args.map((a) => ev(a, scope, depth));
          const local = Object.create(null);
          f.params.forEach((p, i) => { local[p] = args[i]; });
          return check(ev(f.body, local, depth + 1), node.pos);
        }
        throw new CalcError(`Unknown function "${name}"`, node.pos);
      }
    }
    throw new CalcError('Invalid expression', 0);
  }

  function isReserved(name) {
    return Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans';
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    const eofIdx = tokens.length - 1;
    const eqIdx = tokens.findIndex((t) => t.type === '=');
    let result;

    if (eqIdx === -1) {
      const ast = new Parser(tokens).parseAll();
      result = check(ev(ast, null, 0), 0);
      ans = result;
    } else {
      // validate there is only one '=' (other '=' is a syntax error)
      const second = tokens.findIndex((t, i) => i > eqIdx && t.type === '=');
      const lhs = tokens.slice(0, eqIdx);
      if (lhs.length === 1 && lhs[0].type === 'name') {
        const name = lhs[0].value;
        if (second !== -1) throw new CalcError('Unexpected token "="', tokens[second].pos);
        if (isReserved(name)) throw new CalcError(`Cannot assign to "${name}"`, lhs[0].pos);
        const parser = new Parser(tokens, eqIdx + 1, eofIdx);
        const ast = parser.parseAll();
        result = check(ev(ast, null, 0), 0);
        vars.set(name, result);
        ans = result;
      } else if (lhs.length >= 4 && lhs[0].type === 'name' && lhs[1].type === '(' && lhs[lhs.length - 1].type === ')') {
        const name = lhs[0].value;
        const params = [];
        for (let i = 2; i < lhs.length - 1; i++) {
          const t = lhs[i];
          const expectName = (i - 2) % 2 === 0;
          if (expectName) {
            if (t.type !== 'name') throw new CalcError(`Unexpected token "${t.value}"`, t.pos);
            if (params.includes(t.value)) throw new CalcError(`Duplicate parameter "${t.value}"`, t.pos);
            if (Object.prototype.hasOwnProperty.call(CONSTANTS, t.value)) throw new CalcError(`Invalid parameter name "${t.value}"`, t.pos);
            params.push(t.value);
          } else if (t.type !== ',') {
            throw new CalcError(`Unexpected token "${t.value}"`, t.pos);
          }
        }
        if (lhs[lhs.length - 2].type !== 'name') throw new CalcError('Unexpected token ")"', lhs[lhs.length - 1].pos);
        if (Object.prototype.hasOwnProperty.call(builtins, name)) throw new CalcError(`Cannot redefine built-in function "${name}"`, lhs[0].pos);
        if (isReserved(name)) throw new CalcError(`Cannot define function "${name}"`, lhs[0].pos);
        if (second !== -1) throw new CalcError('Unexpected token "="', tokens[second].pos);
        const body = new Parser(tokens, eqIdx + 1, eofIdx).parseAll();
        funcs.set(name, { params, body });
        result = `${name}(${params.join(',')})`;
      } else {
        // Not a valid assignment target: report the first syntax problem.
        const parser = new Parser(tokens, 0, eqIdx);
        const ast = parser.parseExpression();
        void ast;
        if (!parser.atEnd()) parser.fail();
        throw new CalcError('Invalid assignment target', tokens[eqIdx].pos);
      }
    }
    hist.push({ input, result });
    return result;
  }

  function format(value) {
    if (typeof value !== 'number') return String(value);
    if (Object.is(value, -0)) return '0';
    const r = Number(value.toPrecision(precision));
    if (Object.is(r, -0)) return '0';
    return String(r);
  }

  return {
    evaluate,
    format,
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode "${m}"`, 0);
      mode = m;
    },
    getAngleMode() { return mode; },
    getVariable(name) {
      if (name === 'ans') return ans;
      return vars.has(name) ? vars.get(name) : undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name "${name}"`, 0);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) throw new CalcError(`Cannot assign to "${name}"`, 0);
      if (typeof value !== 'number' || Number.isNaN(value)) throw new CalcError('Value must be a number', 0);
      if (name === 'ans') { ans = value; return; }
      vars.set(name, value);
    },
    variables() { return new Map(vars); },
    history() { return hist.map((h) => ({ input: h.input, result: h.result })); },
    clear() {
      vars = new Map();
      funcs = new Map();
      ans = 0;
      hist = [];
    },
  };
}

export default createCalculator;
