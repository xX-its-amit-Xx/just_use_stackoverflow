// calc-s2 — safe scientific calculator engine (no eval / Function).
// Tokenizer scanning routines (isRadixInteger / isNumber / isName / isWhitespace)
// adapted from expr-eval (https://github.com/silentmatt/expr-eval, MIT,
// Copyright (c) 2015 Matthew Crumley). See THIRD_PARTY_NOTICES.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

// ---------------------------------------------------------------- tokenizer
// Token: { type: 'num'|'name'|'op'|'eof', value, pos }
class TokenStream {
  constructor(expression) {
    this.expression = expression;
    this.pos = 0;
    this.current = null;
  }

  tokenize() {
    const out = [];
    for (;;) {
      const t = this.next();
      out.push(t);
      if (t.type === 'eof') return out;
    }
  }

  newToken(type, value, pos) {
    return { type, value, pos: pos != null ? pos : this.pos };
  }

  next() {
    this.isWhitespace();
    if (this.pos >= this.expression.length) return this.newToken('eof', 'EOF');
    if (this.isRadixInteger() || this.isNumber() || this.isOperator() || this.isName()) {
      return this.current;
    }
    throw new CalcError('Unknown character "' + this.expression.charAt(this.pos) + '"', this.pos);
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

  isOperator() {
    const c = this.expression.charAt(this.pos);
    if ('+-*/%^!(),='.includes(c)) {
      this.current = this.newToken('op', c);
      this.pos++;
      return true;
    }
    return false;
  }

  isName() {
    const startPos = this.pos;
    let i = startPos;
    const ex = this.expression;
    const first = ex.charAt(i);
    if (!/[A-Za-z_]/.test(first)) return false;
    i++;
    while (i < ex.length && /[A-Za-z0-9_]/.test(ex.charAt(i))) i++;
    const str = ex.substring(startPos, i);
    this.current = this.newToken('name', str, startPos);
    this.pos = i;
    return true;
  }

  isRadixInteger() {
    let pos = this.pos;
    const ex = this.expression;
    if (pos >= ex.length - 2 || ex.charAt(pos) !== '0') return false;
    ++pos;
    let radix;
    let validDigit;
    const p = ex.charAt(pos);
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
    while (pos < ex.length) {
      if (validDigit.test(ex.charAt(pos))) {
        pos++;
        valid = true;
      } else {
        break;
      }
    }
    if (valid) {
      this.current = this.newToken('num', parseInt(ex.substring(startPos, pos), radix), this.pos);
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
    const ex = this.expression;
    while (pos < ex.length) {
      c = ex.charAt(pos);
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
    if (valid && (c === 'e' || c === 'E') && pos < ex.length) {
      pos++;
      let acceptSign = true;
      let validExponent = false;
      while (pos < ex.length) {
        c = ex.charAt(pos);
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
      this.current = this.newToken('num', parseFloat(ex.substring(startPos, pos)), startPos);
      this.pos = pos;
    } else {
      this.pos = startPos;
    }
    return valid;
  }
}

function tokenize(input) {
  return new TokenStream(input).tokenize();
}

// ------------------------------------------------------------------- parser
// AST nodes: {k:'num',v,pos} {k:'var',name,pos} {k:'call',name,args,pos}
//            {k:'un',op,a,pos} {k:'bin',op,a,b,pos} {k:'fact',a,pos}
class Parser {
  constructor(tokens, start = 0, end = tokens.length - 1) {
    this.t = tokens;
    this.i = start;
    this.end = end; // index of the token treated as EOF
  }
  peek() {
    return this.i >= this.end ? { type: 'eof', value: 'EOF', pos: this.t[this.end].pos } : this.t[this.i];
  }
  prev() { return this.i > 0 ? this.t[this.i - 1] : null; }
  isOp(v) { const p = this.peek(); return p.type === 'op' && p.value === v; }
  fail(tok) {
    tok = tok || this.peek();
    if (tok.type === 'eof') throw new CalcError('Unexpected end of input', tok.pos);
    throw new CalcError('Unexpected token "' + tok.value + '"', tok.pos);
  }
  expect(v) {
    if (!this.isOp(v)) {
      const p = this.peek();
      if (p.type === 'eof') throw new CalcError('Expected "' + v + '" but reached end of input', p.pos);
      throw new CalcError('Expected "' + v + '" but found "' + p.value + '"', p.pos);
    }
    return this.t[this.i++];
  }
  parseAll() {
    const node = this.additive();
    if (this.peek().type !== 'eof') this.fail();
    return node;
  }
  additive() {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.t[this.i++];
      const b = this.multiplicative();
      a = { k: 'bin', op: op.value, a, b, pos: op.pos };
    }
    return a;
  }
  multiplicative() {
    let a = this.implicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.t[this.i++];
      const b = this.implicit();
      a = { k: 'bin', op: op.value, a, b, pos: op.pos };
    }
    return a;
  }
  canImplicit() {
    const pr = this.prev();
    if (!pr) return false;
    const prevOk = pr.type === 'num' || (pr.type === 'op' && (pr.value === ')' || pr.value === '!'));
    if (!prevOk) return false;
    const p = this.peek();
    return p.type === 'name' || (p.type === 'op' && p.value === '(') || (p.type === 'num' && pr.type !== 'num');
  }
  implicit() {
    let a = this.unary();
    while (this.canImplicit()) {
      const pos = this.peek().pos;
      const b = this.power();
      a = { k: 'bin', op: '*', a, b, pos };
    }
    return a;
  }
  unary() {
    if (this.isOp('+') || this.isOp('-')) {
      const op = this.t[this.i++];
      const a = this.unary();
      return { k: 'un', op: op.value, a, pos: op.pos };
    }
    return this.power();
  }
  power() {
    const base = this.postfix();
    if (this.isOp('^')) {
      const op = this.t[this.i++];
      const exp = this.exponent();
      return { k: 'bin', op: '^', a: base, b: exp, pos: op.pos };
    }
    return base;
  }
  exponent() {
    if (this.isOp('+') || this.isOp('-')) {
      const op = this.t[this.i++];
      const a = this.exponent();
      return { k: 'un', op: op.value, a, pos: op.pos };
    }
    return this.power();
  }
  postfix() {
    let a = this.primary();
    while (this.isOp('!')) {
      const op = this.t[this.i++];
      a = { k: 'fact', a, pos: op.pos };
    }
    return a;
  }
  primary() {
    const p = this.peek();
    if (p.type === 'num') {
      this.i++;
      return { k: 'num', v: p.value, pos: p.pos };
    }
    if (p.type === 'name') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.additive());
          while (this.isOp(',')) {
            this.i++;
            args.push(this.additive());
          }
        }
        this.expect(')');
        return { k: 'call', name: p.value, args, pos: p.pos };
      }
      return { k: 'var', name: p.value, pos: p.pos };
    }
    if (p.type === 'op' && p.value === '(') {
      this.i++;
      const e = this.additive();
      this.expect(')');
      return e;
    }
    this.fail(p);
  }
}

// ----------------------------------------------------------------- builtins
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEG = Math.PI / 180;
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

function makeBuiltins(calc) {
  const deg = () => calc.angleMode === 'deg';
  const toRad = (x) => (deg() ? x * DEG : x);
  const fromRad = (x) => (deg() ? x / DEG : x);
  const trigIn = (fn) => (x) => {
    if (deg()) {
      const r = x % 360;
      return snap(fn(r * DEG));
    }
    return snap(fn(x));
  };
  return {
    sin: [1, trigIn(Math.sin)],
    cos: [1, trigIn(Math.cos)],
    tan: [1, (x) => {
      if (deg()) {
        const r = x % 180;
        if (Math.abs(r) === 90) throw new CalcError('Domain error: tan undefined');
        return snap(Math.tan(r * DEG));
      }
      return snap(Math.tan(x));
    }],
    asin: [1, (x) => fromRad(Math.asin(x))],
    acos: [1, (x) => fromRad(Math.acos(x))],
    atan: [1, (x) => fromRad(Math.atan(x))],
    atan2: [2, (y, x) => fromRad(Math.atan2(y, x))],
    sinh: [1, Math.sinh],
    cosh: [1, Math.cosh],
    tanh: [1, Math.tanh],
    sqrt: [1, (x) => { if (x < 0) throw new CalcError('Domain error: sqrt of negative number'); return Math.sqrt(x); }],
    cbrt: [1, Math.cbrt],
    abs: [1, Math.abs],
    ln: [1, (x) => { if (x <= 0) throw new CalcError('Domain error: ln of non-positive number'); return Math.log(x); }],
    log: [1, (x) => { if (x <= 0) throw new CalcError('Domain error: log of non-positive number'); return Math.log10(x); }],
    log2: [1, (x) => { if (x <= 0) throw new CalcError('Domain error: log2 of non-positive number'); return Math.log2(x); }],
    exp: [1, Math.exp],
    floor: [1, Math.floor],
    ceil: [1, Math.ceil],
    round: [1, (x) => (x < 0 ? -Math.round(-x) : Math.round(x))],
    sign: [1, Math.sign],
    pow: [2, (x, y) => Math.pow(x, y)],
    nroot: [2, (x, n) => {
      if (n === 0) throw new CalcError('Domain error: zeroth root');
      if (x < 0) {
        if (Number.isInteger(n) && Math.abs(n) % 2 === 1) return -Math.pow(-x, 1 / n);
        throw new CalcError('Domain error: even or non-integer root of negative number');
      }
      if (n === 3) return Math.cbrt(x);
      if (n === 2) return Math.sqrt(x);
      const r = Math.pow(x, 1 / n);
      const rr = Math.round(r);
      return Math.pow(rr, n) === x ? rr : r;
    }],
    logb: [2, (x, b) => {
      if (x <= 0 || b <= 0 || b === 1) throw new CalcError('Domain error: invalid logarithm');
      return Math.log(x) / Math.log(b);
    }],
    min: [-1, (...a) => Math.min(...a)],
    max: [-1, (...a) => Math.max(...a)],
    sum: [-1, (...a) => a.reduce((s, v) => s + v, 0)],
    avg: [-1, (...a) => a.reduce((s, v) => s + v, 0) / a.length],
    hypot: [-1, (...a) => Math.hypot(...a)],
  };
}

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function finite(v, pos) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CalcError(Number.isNaN(v) ? 'Domain error' : 'Result is not finite (overflow)', pos);
  }
  return v;
}

const MAX_DEPTH = 100;

// --------------------------------------------------------------- calculator
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError('Invalid angle mode: ' + angleMode, 0);
  const state = {
    angleMode,
    vars: new Map(),
    funcs: new Map(),
    ans: 0,
    hist: [],
    depth: 0,
  };
  const builtins = makeBuiltins(state);

  function lookup(name, pos, scope) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return state.ans;
    if (state.vars.has(name)) return state.vars.get(name);
    throw new CalcError('Undefined variable "' + name + '"', pos);
  }

  function ev(node, scope) {
    switch (node.k) {
      case 'num': return node.v;
      case 'var': return lookup(node.name, node.pos, scope);
      case 'un': {
        const a = ev(node.a, scope);
        return node.op === '-' ? -a : a;
      }
      case 'fact': return factorial(ev(node.a, scope), node.pos);
      case 'bin': {
        const a = ev(node.a, scope);
        const b = ev(node.b, scope);
        let r;
        switch (node.op) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/':
            if (b === 0) throw new CalcError('Division by zero', node.pos);
            r = a / b; break;
          case '%':
            if (b === 0) throw new CalcError('Remainder by zero', node.pos);
            r = a % b; break;
          case '^': r = Math.pow(a, b); break;
          default: throw new CalcError('Unknown operator ' + node.op, node.pos);
        }
        return finite(r, node.pos);
      }
      case 'call': return call(node, scope);
      default: throw new CalcError('Invalid expression', node.pos || 0);
    }
  }

  function call(node, scope) {
    const name = node.name;
    if (Object.prototype.hasOwnProperty.call(builtins, name)) {
      const [arity, fn] = builtins[name];
      const n = node.args.length;
      if (arity === -1 ? n < 1 : n !== arity) {
        throw new CalcError(`Function ${name} expects ${arity === -1 ? 'at least 1 argument' : arity + ' argument' + (arity === 1 ? '' : 's')}, got ${n}`, node.pos);
      }
      const args = node.args.map((a) => ev(a, scope));
      let r;
      try {
        r = fn(...args);
      } catch (e) {
        if (e instanceof CalcError) { e.position = node.pos; }
        throw e;
      }
      return finite(r, node.pos);
    }
    const uf = state.funcs.get(name);
    if (!uf) throw new CalcError('Undefined function "' + name + '"', node.pos);
    if (node.args.length !== uf.params.length) {
      throw new CalcError(`Function ${name} expects ${uf.params.length} argument${uf.params.length === 1 ? '' : 's'}, got ${node.args.length}`, node.pos);
    }
    const args = node.args.map((a) => ev(a, scope));
    if (state.depth >= MAX_DEPTH) throw new CalcError('Maximum recursion depth exceeded in "' + name + '"', node.pos);
    const local = Object.create(null);
    uf.params.forEach((p, i) => { local[p] = args[i]; });
    state.depth++;
    try {
      return finite(ev(uf.body, local), node.pos);
    } finally {
      state.depth--;
    }
  }

  function isOpTok(t, v) { return t && t.type === 'op' && t.value === v; }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    const eofTok = tokens[tokens.length - 1];
    if (tokens.length === 1) throw new CalcError('Empty expression', eofTok.pos);
    let result;
    state.depth = 0;

    // Function definition: name ( ... ) = body
    if (tokens[0].type === 'name' && isOpTok(tokens[1], '(')) {
      let j = 2;
      let depth = 1;
      while (j < tokens.length - 1 && depth > 0) {
        if (isOpTok(tokens[j], '(')) depth++;
        else if (isOpTok(tokens[j], ')')) depth--;
        j++;
      }
      if (depth === 0 && isOpTok(tokens[j], '=')) {
        const name = tokens[0].value;
        const close = j - 1;
        const params = [];
        let k = 2;
        if (k === close) throw new CalcError('Function definition requires at least one parameter', tokens[close].pos);
        for (;;) {
          const t = tokens[k];
          if (t.type !== 'name') throw new CalcError('Expected parameter name', t.pos);
          if (params.includes(t.value)) throw new CalcError('Duplicate parameter "' + t.value + '"', t.pos);
          params.push(t.value);
          k++;
          if (k === close) break;
          if (!isOpTok(tokens[k], ',')) throw new CalcError('Expected "," or ")"', tokens[k].pos);
          k++;
          if (k === close) throw new CalcError('Expected parameter name', tokens[k].pos);
        }
        if (Object.prototype.hasOwnProperty.call(builtins, name)) {
          throw new CalcError('Cannot redefine built-in function "' + name + '"', tokens[0].pos);
        }
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
          throw new CalcError('Cannot define function named "' + name + '"', tokens[0].pos);
        }
        const p = new Parser(tokens, j + 1);
        if (p.peek().type === 'eof') p.fail();
        const body = p.parseAll();
        checkNoEquals(tokens, j + 1);
        state.funcs.set(name, { params, body });
        result = `${name}(${params.join(',')})`;
        state.hist.push({ input, result });
        return result;
      }
    }

    // Assignment: name = expr
    if (tokens[0].type === 'name' && isOpTok(tokens[1], '=')) {
      const name = tokens[0].value;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) throw new CalcError('Cannot assign to constant "' + name + '"', tokens[0].pos);
      if (name === 'ans') throw new CalcError('Cannot assign to "ans"', tokens[0].pos);
      checkNoEquals(tokens, 2);
      const p = new Parser(tokens, 2);
      const node = p.parseAll();
      result = finite(ev(node, null), 0);
      state.vars.set(name, result);
    } else {
      checkNoEquals(tokens, 0);
      const node = new Parser(tokens, 0).parseAll();
      result = finite(ev(node, null), 0);
    }
    state.ans = result;
    state.hist.push({ input, result });
    return result;
  }

  // '=' is only valid at the statement level; a stray one is a syntax error.
  function checkNoEquals(tokens, from) {
    // Parse first so earlier syntax errors are reported first; parser stops at '='.
    for (let i = from; i < tokens.length; i++) {
      if (isOpTok(tokens[i], '=')) {
        // Let the parser report errors located before '='
        const p = new Parser(tokens, from, i);
        if (p.peek().type !== 'eof') p.parseAll();
        throw new CalcError('Unexpected "="', tokens[i].pos);
      }
    }
  }

  return {
    evaluate,
    setAngleMode(mode) {
      if (mode !== 'rad' && mode !== 'deg') throw new CalcError('Invalid angle mode: ' + mode, 0);
      state.angleMode = mode;
    },
    getAngleMode() { return state.angleMode; },
    getVariable(name) {
      if (name === 'ans') return state.ans;
      return state.vars.get(name);
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError('Invalid variable name', 0);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) throw new CalcError('Cannot assign to constant "' + name + '"', 0);
      if (name === 'ans') throw new CalcError('Cannot assign to "ans"', 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new CalcError('Variable value must be a finite number', 0);
      state.vars.set(name, value);
    },
    variables() {
      return [...state.vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    },
    history() { return state.hist.map((h) => ({ input: h.input, result: h.result })); },
    clear() {
      state.vars.clear();
      state.funcs.clear();
      state.ans = 0;
      state.hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      if (Object.is(value, -0) || value === 0) return '0';
      if (!Number.isFinite(value)) return String(value);
      const s = String(Number(value.toPrecision(precision)));
      return s === '-0' ? '0' : s;
    },
  };
}

export default createCalculator;
