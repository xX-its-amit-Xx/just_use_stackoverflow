// Scientific calculator engine (safe: no eval / Function).
// Number / radix-integer lexing adapted from expr-eval (MIT, (c) 2015 Matthew Crumley),
// https://github.com/silentmatt/expr-eval/blob/master/src/token-stream.js
// See THIRD_PARTY_NOTICES.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------- lexer

// Adapted from expr-eval TokenStream.prototype.isRadixInteger
function lexRadixInteger(expr, start) {
  let pos = start;
  if (pos >= expr.length - 2 || expr.charAt(pos) !== '0') return null;
  ++pos;
  let radix, validDigit;
  const ch = expr.charAt(pos);
  if (ch === 'x' || ch === 'X') {
    radix = 16; validDigit = /^[0-9a-f]$/i; ++pos;
  } else if (ch === 'b' || ch === 'B') {
    radix = 2; validDigit = /^[01]$/; ++pos;
  } else {
    return null;
  }
  let valid = false;
  const digitsStart = pos;
  while (pos < expr.length && validDigit.test(expr.charAt(pos))) { pos++; valid = true; }
  if (!valid) return null;
  return { value: parseInt(expr.substring(digitsStart, pos), radix), end: pos };
}

// Adapted from expr-eval TokenStream.prototype.isNumber
function lexNumber(expr, start) {
  let valid = false;
  let pos = start;
  let resetPos = pos;
  let foundDot = false;
  let foundDigits = false;
  let c = '';
  while (pos < expr.length) {
    c = expr.charAt(pos);
    if ((c >= '0' && c <= '9') || (!foundDot && c === '.')) {
      if (c === '.') foundDot = true; else foundDigits = true;
      pos++;
      valid = foundDigits;
    } else {
      break;
    }
  }
  if (valid) resetPos = pos;
  if (valid && pos < expr.length && (c === 'e' || c === 'E')) {
    pos++;
    let acceptSign = true;
    let validExponent = false;
    while (pos < expr.length) {
      c = expr.charAt(pos);
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
  if (!valid) return null;
  return { value: parseFloat(expr.substring(start, pos)), end: pos };
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const r = lexRadixInteger(input, i) || lexNumber(input, i);
      if (!r) throw new CalcError(`Unexpected character '${ch}'`, i);
      tokens.push({ type: 'num', value: r.value, pos: i, end: r.end });
      i = r.end;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ type: 'name', value: input.slice(i, j), pos: i, end: j });
      i = j;
      continue;
    }
    if ('+-*/%^!(),='.includes(ch)) {
      tokens.push({ type: ch, value: ch, pos: i, end: i + 1 });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: input.length, end: input.length });
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  fail(tok) {
    tok = tok || this.peek();
    if (tok.type === 'eof') throw new CalcError('Unexpected end of input', tok.pos);
    throw new CalcError(`Unexpected token '${tok.value}'`, tok.pos);
  }
  expect(type) {
    const t = this.peek();
    if (t.type !== type) this.fail(t);
    return this.next();
  }
  parseFull() {
    const node = this.parseAdditive();
    if (this.peek().type !== 'eof') this.fail();
    return node;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.next();
      const right = this.parseMultiplicative();
      left = { type: 'bin', op: op.type, left, right, pos: op.pos };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseImplicit();
    while (['*', '/', '%'].includes(this.peek().type)) {
      const op = this.next();
      const right = this.parseImplicit();
      left = { type: 'bin', op: op.type, left, right, pos: op.pos };
    }
    return left;
  }
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const prev = this.tokens[this.i - 1];
      const t = this.peek();
      const prevOk = prev && (prev.type === 'num' || prev.type === ')');
      const nextOk = t.type === 'name' || t.type === '(' || (prev && prev.type === ')' && t.type === 'num');
      if (!prevOk || !nextOk) break;
      const right = this.parseUnary();
      left = { type: 'bin', op: '*', left, right, pos: t.pos };
    }
    return left;
  }
  parseUnary() {
    const t = this.peek();
    if (t.type === '+' || t.type === '-') {
      this.next();
      const operand = this.parseUnary();
      return { type: 'neg', negate: t.type === '-', operand, pos: t.pos };
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.peek().type === '^') {
      const op = this.next();
      const exp = this.parseUnary();
      return { type: 'bin', op: '^', left: base, right: exp, pos: op.pos };
    }
    return base;
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.peek().type === '!') {
      const op = this.next();
      node = { type: 'fact', operand: node, pos: op.pos };
    }
    return node;
  }
  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { type: 'num', value: t.value, pos: t.pos };
    }
    if (t.type === 'name') {
      this.next();
      if (this.peek().type === '(') {
        this.next();
        const args = [];
        if (this.peek().type === ')') { this.next(); return { type: 'call', name: t.value, args, pos: t.pos }; }
        for (;;) {
          args.push(this.parseAdditive());
          if (this.peek().type === ',') { this.next(); continue; }
          this.expect(')');
          break;
        }
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'var', name: t.value, pos: t.pos };
    }
    if (t.type === '(') {
      this.next();
      const inner = this.parseAdditive();
      this.expect(')');
      return inner;
    }
    this.fail(t);
  }
}

// ---------------------------------------------------------------- helpers

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

function roundHalfAway(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function nroot(x, n, pos) {
  if (n === 0) throw new CalcError('Root degree must be non-zero', pos);
  let neg = false;
  if (x < 0) {
    if (Number.isInteger(n) && Math.abs(n) % 2 === 1) neg = true;
    else throw new CalcError('Domain error: even root of negative number', pos);
  }
  const ax = Math.abs(x);
  let r = Math.pow(ax, 1 / n);
  const rr = Math.round(r);
  if (Number.isInteger(n) && rr !== 0 && Math.pow(rr, n) === ax) r = rr;
  return neg ? -r : r;
}

// ---------------------------------------------------------------- calculator

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError(`Invalid angle mode '${angleMode}'`, 0);
  let mode = angleMode;
  let variables = new Map();
  let functions = new Map();
  let ans = 0;
  let hist = [];

  const toRad = (x) => (mode === 'deg' ? x * Math.PI / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? x * 180 / Math.PI : x);
  const snap = (x) => (mode === 'deg' && Math.abs(x) < 1e-12 ? 0 : x);
  const domain = (pos, msg = 'Domain error') => { throw new CalcError(msg, pos); };

  const unary = {
    sin: (x) => {
      if (mode === 'deg') { const m = ((x % 360) + 360) % 360; if (m === 30) return 0.5; if (m === 150) return 0.5; if (m === 210 || m === 330) return -0.5; }
      return snap(Math.sin(toRad(x)));
    },
    cos: (x) => {
      if (mode === 'deg') { const m = ((x % 360) + 360) % 360; if (m === 60 || m === 300) return 0.5; if (m === 120 || m === 240) return -0.5; }
      return snap(Math.cos(toRad(x)));
    },
    tan: (x, pos) => {
      if (mode === 'deg') {
        const m = ((x % 180) + 180) % 180;
        if (m === 90) domain(pos, 'Domain error: tan undefined');
        if (m === 45) return 1;
        if (m === 135) return -1;
      }
      return snap(Math.tan(toRad(x)));
    },
    asin: (x, pos) => { if (x < -1 || x > 1) domain(pos); return fromRad(Math.asin(x)); },
    acos: (x, pos) => { if (x < -1 || x > 1) domain(pos); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, pos) => { if (x < 0) domain(pos, 'Domain error: sqrt of negative number'); return Math.sqrt(x); },
    cbrt: Math.cbrt,
    abs: Math.abs,
    ln: (x, pos) => { if (x <= 0) domain(pos, 'Domain error: ln of non-positive number'); return Math.log(x); },
    log: (x, pos) => { if (x <= 0) domain(pos, 'Domain error: log of non-positive number'); return Math.log10(x); },
    log2: (x, pos) => { if (x <= 0) domain(pos, 'Domain error: log2 of non-positive number'); return Math.log2(x); },
    exp: Math.exp,
    floor: Math.floor, ceil: Math.ceil,
    round: roundHalfAway,
    sign: Math.sign,
  };
  const binary = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y, pos) => power(x, y, pos),
    nroot: (x, n, pos) => nroot(x, n, pos),
    logb: (x, b, pos) => {
      if (x <= 0 || b <= 0 || b === 1) domain(pos, 'Domain error: invalid logarithm');
      return Math.log(x) / Math.log(b);
    },
  };
  const variadic = {
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, v) => s + v, 0),
    avg: (a) => a.reduce((s, v) => s + v, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => Object.hasOwn(unary, n) || Object.hasOwn(binary, n) || Object.hasOwn(variadic, n);

  function power(x, y, pos) {
    const r = Math.pow(x, y);
    if (Number.isNaN(r)) domain(pos, 'Domain error: invalid power');
    return r;
  }

  function check(v, pos) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new CalcError(Number.isNaN(v) ? 'Domain error: result is not a number' : 'Overflow: result is not finite', pos);
    }
    return v;
  }

  function evalNode(node, scope, depth) {
    switch (node.type) {
      case 'num': return check(node.value, node.pos);
      case 'var': {
        const n = node.name;
        if (scope && scope.has(n)) return scope.get(n);
        if (Object.hasOwn(CONSTANTS, n)) return CONSTANTS[n];
        if (n === 'ans') return ans;
        if (variables.has(n)) return variables.get(n);
        throw new CalcError(`Undefined variable '${n}'`, node.pos);
      }
      case 'neg': {
        const v = evalNode(node.operand, scope, depth);
        return node.negate ? -v : v;
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
          case '%': if (b === 0) throw new CalcError('Division by zero', node.pos); r = a % b; break;
          case '^': r = power(a, b, node.pos); break;
        }
        return check(r, node.pos);
      }
      case 'call': return check(callFn(node, scope, depth), node.pos);
    }
    throw new CalcError('Internal error', node.pos);
  }

  function callFn(node, scope, depth) {
    const { name, pos } = node;
    const args = node.args.map((a) => evalNode(a, scope, depth));
    const arityErr = (exp) => { throw new CalcError(`Function '${name}' expects ${exp} argument(s), got ${args.length}`, pos); };
    if (functions.has(name)) {
      const f = functions.get(name);
      if (args.length !== f.params.length) arityErr(f.params.length);
      if (depth + 1 > 100) throw new CalcError(`Maximum recursion depth exceeded in '${name}'`, pos);
      const inner = new Map(f.params.map((p, k) => [p, args[k]]));
      return evalNode(f.body, inner, depth + 1);
    }
    if (Object.hasOwn(unary, name)) {
      if (args.length !== 1) arityErr(1);
      return unary[name](args[0], pos);
    }
    if (Object.hasOwn(binary, name)) {
      if (args.length !== 2) arityErr(2);
      return binary[name](args[0], args[1], pos);
    }
    if (Object.hasOwn(variadic, name)) {
      if (args.length < 1) arityErr('at least 1');
      return variadic[name](args);
    }
    throw new CalcError(`Unknown function '${name}'`, pos);
  }

  function isFuncDef(tokens) {
    if (tokens[0].type !== 'name' || tokens[1].type !== '(') return false;
    let k = 2;
    for (;;) {
      if (tokens[k].type !== 'name') return false;
      k++;
      if (tokens[k].type === ',') { k++; continue; }
      if (tokens[k].type === ')') { k++; break; }
      return false;
    }
    return tokens[k].type === '=' ? k : false;
  }

  function evaluate(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = tokenize(input);
    let result;
    const eqAt = isFuncDef(tokens);
    if (eqAt !== false) {
      const name = tokens[0].value;
      if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in function '${name}'`, tokens[0].pos);
      if (Object.hasOwn(CONSTANTS, name) || name === 'ans') throw new CalcError(`Cannot define function named '${name}'`, tokens[0].pos);
      const params = [];
      for (let k = 2; k < eqAt; k++) {
        const t = tokens[k];
        if (t.type !== 'name') continue;
        if (params.includes(t.value)) throw new CalcError(`Duplicate parameter '${t.value}'`, t.pos);
        params.push(t.value);
      }
      const p = new Parser(tokens);
      p.i = eqAt + 1;
      const body = p.parseFull();
      functions.set(name, { params, body });
      result = `${name}(${params.join(',')})`;
    } else if (tokens[0].type === 'name' && tokens[1].type === '=') {
      const name = tokens[0].value;
      if (Object.hasOwn(CONSTANTS, name)) throw new CalcError(`Cannot assign to constant '${name}'`, tokens[0].pos);
      if (name === 'ans') throw new CalcError("Cannot assign to 'ans'", tokens[0].pos);
      const p = new Parser(tokens);
      p.i = 2;
      const body = p.parseFull();
      result = evalNode(body, null, 0);
      variables.set(name, result);
      ans = result;
    } else {
      const body = new Parser(tokens).parseFull();
      result = evalNode(body, null, 0);
      ans = result;
    }
    hist.push({ input, result });
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
      return variables.has(name) ? variables.get(name) : undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError(`Invalid variable name '${name}'`, 0);
      if (Object.hasOwn(CONSTANTS, name)) throw new CalcError(`Cannot assign to constant '${name}'`, 0);
      if (name === 'ans') throw new CalcError("Cannot assign to 'ans'", 0);
      if (typeof value !== 'number') throw new CalcError('Variable value must be a number', 0);
      variables.set(name, value);
    },
    variables() { return new Map(variables); },
    history() { return hist.map((h) => ({ ...h })); },
    clear() {
      variables = new Map();
      functions = new Map();
      ans = 0;
      hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      const v = Number(value.toPrecision(precision));
      if (Object.is(v, -0) || v === 0) return '0';
      return String(v);
    },
  };
}
