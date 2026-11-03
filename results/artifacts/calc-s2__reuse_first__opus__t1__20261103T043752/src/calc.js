// calc-s2: safe scientific calculator engine (no eval / Function).
// Tokenizer scanning routines (isRadixInteger, isNumber, isName, isWhitespace)
// adapted from expr-eval 2.0.2 (MIT, (c) 2015 Matthew Crumley) - see THIRD_PARTY_NOTICES.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

// ---------------------------------------------------------------- tokenizer
// Token types
const T_NUM = 'number', T_NAME = 'name', T_OP = 'op', T_EOF = 'eof';

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
    this.isWhitespace();
    if (this.pos >= this.expression.length) {
      return this.newToken(T_EOF, 'EOF');
    }
    if (this.isRadixInteger() || this.isNumber() || this.isOperator() || this.isName()) {
      return this.current;
    }
    throw new CalcError('Unexpected character "' + this.expression.charAt(this.pos) + '"', this.pos);
  }

  all() {
    const out = [];
    for (;;) {
      const t = this.next();
      out.push(t);
      if (t.type === T_EOF) return out;
    }
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
      this.current = this.newToken(T_OP, c);
      this.pos++;
      return true;
    }
    return false;
  }

  isName() {
    const startPos = this.pos;
    let i = startPos;
    const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
    if (!isLetter(this.expression.charAt(i))) return false;
    for (i++; i < this.expression.length; i++) {
      const c = this.expression.charAt(i);
      if (!isLetter(c) && !(c >= '0' && c <= '9')) break;
    }
    const str = this.expression.substring(startPos, i);
    this.current = this.newToken(T_NAME, str);
    this.pos = i;
    return true;
  }

  isRadixInteger() {
    let pos = this.pos;
    if (pos >= this.expression.length - 2 || this.expression.charAt(pos) !== '0') return false;
    ++pos;
    let radix, validDigit;
    const ch = this.expression.charAt(pos);
    if (ch === 'x' || ch === 'X') {
      radix = 16; validDigit = /^[0-9a-f]$/i; ++pos;
    } else if (ch === 'b' || ch === 'B') {
      radix = 2; validDigit = /^[01]$/; ++pos;
    } else {
      return false;
    }
    let valid = false;
    const startPos = pos;
    while (pos < this.expression.length) {
      if (validDigit.test(this.expression.charAt(pos))) { pos++; valid = true; } else break;
    }
    if (valid) {
      this.current = this.newToken(T_NUM, parseInt(this.expression.substring(startPos, pos), radix));
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
        if (c === '.') foundDot = true; else foundDigits = true;
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
      this.current = this.newToken(T_NUM, parseFloat(this.expression.substring(startPos, pos)));
      this.pos = pos;
    } else {
      this.pos = resetPos;
    }
    return valid;
  }
}

// ---------------------------------------------------------------- parser
// AST nodes: {k:'num',v,pos} {k:'var',name,pos} {k:'call',name,args,pos}
//            {k:'un',op,a,pos} {k:'bin',op,a,b,pos} {k:'fact',a,pos}
class Parser {
  constructor(tokens, start = 0) {
    this.t = tokens;
    this.i = start;
  }
  peek() { return this.t[this.i]; }
  isOp(v, tok = this.peek()) { return tok.type === T_OP && tok.value === v; }
  fail(tok = this.peek()) {
    if (tok.type === T_EOF) throw new CalcError('Unexpected end of input', tok.pos);
    throw new CalcError('Unexpected token "' + tok.value + '"', tok.pos);
  }
  expect(v) {
    const tok = this.peek();
    if (!this.isOp(v, tok)) {
      if (tok.type === T_EOF) throw new CalcError(`Expected "${v}" but reached end of input`, tok.pos);
      throw new CalcError(`Expected "${v}" but found "${tok.value}"`, tok.pos);
    }
    this.i++;
    return tok;
  }
  parseAll() {
    const node = this.additive();
    if (this.peek().type !== T_EOF) this.fail();
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
  implicit() {
    let a = this.unary();
    for (;;) {
      const prev = this.t[this.i - 1];
      const prevOk = prev.type === T_NUM || this.isOp(')', prev);
      const nxt = this.peek();
      if (prevOk && (nxt.type === T_NAME || this.isOp('(', nxt))) {
        const b = this.unary();
        a = { k: 'bin', op: '*', a, b, pos: nxt.pos };
      } else {
        return a;
      }
    }
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
      const exp = this.unary();
      return { k: 'bin', op: '^', a: base, b: exp, pos: op.pos };
    }
    return base;
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
    const tok = this.peek();
    if (tok.type === T_NUM) {
      this.i++;
      return { k: 'num', v: tok.value, pos: tok.pos };
    }
    if (tok.type === T_NAME) {
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
        return { k: 'call', name: tok.value, args, pos: tok.pos };
      }
      return { k: 'var', name: tok.value, pos: tok.pos };
    }
    if (this.isOp('(')) {
      this.i++;
      const e = this.additive();
      this.expect(')');
      return e;
    }
    this.fail(tok);
  }
}

// ---------------------------------------------------------------- built-ins
const DEG = Math.PI / 180;
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

function factorial(n, pos) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('Factorial requires a non-negative integer', pos);
  if (n > 170) throw new CalcError('Factorial overflow', pos);
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function nroot(x, n, pos) {
  if (n === 0) throw new CalcError('nroot: n must not be zero', pos);
  let r;
  if (x < 0) {
    if (!(Number.isInteger(n) && Math.abs(n) % 2 === 1)) throw new CalcError('nroot: domain error', pos);
    r = -Math.pow(-x, 1 / n);
  } else {
    r = Math.pow(x, 1 / n);
  }
  if (Number.isInteger(n) && n > 0) {
    const rr = Math.round(r);
    if (Math.pow(rr, n) === x) return rr;
  }
  return r;
}

function makeBuiltins(calc) {
  const domain = (name, pos) => { throw new CalcError(`${name}: domain error`, pos); };
  const deg = () => calc.getAngleMode() === 'deg';
  const toRad = (x) => (deg() ? x * DEG : x);
  const fromRad = (x) => (deg() ? x / DEG : x);
  const mod = (x, m) => ((x % m) + m) % m;
  const one = (f) => ({ min: 1, max: 1, f });
  const two = (f) => ({ min: 2, max: 2, f });
  const vari = (f) => ({ min: 1, max: Infinity, f });
  return {
    sin: one((x) => {
      if (deg() && mod(x, 180) === 0) return 0;
      return snap(Math.sin(toRad(x)));
    }),
    cos: one((x) => {
      if (deg() && mod(x - 90, 180) === 0) return 0;
      return snap(Math.cos(toRad(x)));
    }),
    tan: one((x, pos) => {
      if (deg()) {
        if (mod(x, 180) === 0) return 0;
        if (mod(x - 90, 180) === 0) throw new CalcError('tan: undefined', pos);
      }
      return snap(Math.tan(toRad(x)));
    }),
    asin: one((x, pos) => (x < -1 || x > 1 ? domain('asin', pos) : fromRad(Math.asin(x)))),
    acos: one((x, pos) => (x < -1 || x > 1 ? domain('acos', pos) : fromRad(Math.acos(x)))),
    atan: one((x) => fromRad(Math.atan(x))),
    atan2: two((y, x) => fromRad(Math.atan2(y, x))),
    sinh: one(Math.sinh),
    cosh: one(Math.cosh),
    tanh: one(Math.tanh),
    sqrt: one((x, pos) => (x < 0 ? domain('sqrt', pos) : Math.sqrt(x))),
    cbrt: one(Math.cbrt),
    abs: one(Math.abs),
    ln: one((x, pos) => (x <= 0 ? domain('ln', pos) : Math.log(x))),
    log: one((x, pos) => (x <= 0 ? domain('log', pos) : Math.log10(x))),
    log2: one((x, pos) => (x <= 0 ? domain('log2', pos) : Math.log2(x))),
    exp: one(Math.exp),
    floor: one(Math.floor),
    ceil: one(Math.ceil),
    round: one((x) => Math.sign(x) * Math.round(Math.abs(x))),
    sign: one(Math.sign),
    pow: two((x, y) => Math.pow(x, y)),
    nroot: two((x, n, pos) => nroot(x, n, pos)),
    logb: two((x, b, pos) => {
      if (x <= 0 || b <= 0 || b === 1) domain('logb', pos);
      return Math.log(x) / Math.log(b);
    }),
    min: vari((...a) => Math.min(...a.slice(0, -1))),
    max: vari((...a) => Math.max(...a.slice(0, -1))),
    sum: vari((...a) => a.slice(0, -1).reduce((s, v) => s + v, 0)),
    avg: vari((...a) => a.slice(0, -1).reduce((s, v) => s + v, 0) / (a.length - 1)),
    hypot: vari((...a) => Math.hypot(...a.slice(0, -1))),
  };
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 100;

// ---------------------------------------------------------------- calculator
export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') throw new CalcError('Invalid angle mode: ' + angleMode, 0);
  let mode = angleMode;
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  const calc = {};
  const builtins = makeBuiltins(calc);

  const check = (v, pos) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
    return v;
  };

  function lookup(name, pos, scope) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    if (name === 'ans') return ans;
    if (vars.has(name)) return vars.get(name);
    throw new CalcError('Undefined variable: ' + name, pos);
  }

  function ev(node, scope) {
    switch (node.k) {
      case 'num': return check(node.v, node.pos);
      case 'var': return lookup(node.name, node.pos, scope);
      case 'un': {
        const a = ev(node.a, scope);
        return node.op === '-' ? -a : a;
      }
      case 'fact': return factorial(ev(node.a, scope), node.pos);
      case 'bin': {
        const a = ev(node.a, scope);
        const b = ev(node.b, scope);
        switch (node.op) {
          case '+': return check(a + b, node.pos);
          case '-': return check(a - b, node.pos);
          case '*': return check(a * b, node.pos);
          case '/':
            if (b === 0) throw new CalcError('Division by zero', node.pos);
            return check(a / b, node.pos);
          case '%':
            if (b === 0) throw new CalcError('Division by zero', node.pos);
            return check(a % b, node.pos);
          case '^': return check(Math.pow(a, b), node.pos);
        }
        break;
      }
      case 'call': {
        const args = node.args.map((x) => ev(x, scope));
        const uf = funcs.get(node.name);
        if (uf) {
          if (args.length !== uf.params.length) {
            throw new CalcError(`${node.name} expects ${uf.params.length} argument(s), got ${args.length}`, node.pos);
          }
          if (depth >= MAX_DEPTH) throw new CalcError('Maximum call depth exceeded (recursion?)', node.pos);
          const local = Object.create(null);
          uf.params.forEach((p, i) => { local[p] = args[i]; });
          depth++;
          try {
            return check(ev(uf.body, local), node.pos);
          } finally {
            depth--;
          }
        }
        if (Object.prototype.hasOwnProperty.call(builtins, node.name)) {
          const b = builtins[node.name];
          if (args.length < b.min || args.length > b.max) {
            const exp = b.max === Infinity ? `at least ${b.min}` : String(b.min);
            throw new CalcError(`${node.name} expects ${exp} argument(s), got ${args.length}`, node.pos);
          }
          return check(b.f(...args, node.pos), node.pos);
        }
        throw new CalcError('Unknown function: ' + node.name, node.pos);
      }
    }
    throw new CalcError('Internal error', node.pos || 0);
  }

  // Detect "name(p1, p2, ...) =" ; returns index after '=' or -1
  function matchFuncDef(tokens) {
    if (tokens[0].type !== T_NAME || !(tokens[1].type === T_OP && tokens[1].value === '(')) return -1;
    let i = 2;
    const isOp = (t, v) => t.type === T_OP && t.value === v;
    if (isOp(tokens[i], ')')) return isOp(tokens[i + 1], '=') ? i + 2 : -1;
    for (;;) {
      if (tokens[i].type !== T_NAME) return -1;
      i++;
      if (isOp(tokens[i], ',')) { i++; continue; }
      if (isOp(tokens[i], ')')) { i++; break; }
      return -1;
    }
    return isOp(tokens[i], '=') ? i + 1 : -1;
  }

  function run(input) {
    if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
    const tokens = new TokenStream(input).all();
    if (tokens[0].type === T_EOF) throw new CalcError('Empty input', tokens[0].pos);

    // Function definition
    const fd = matchFuncDef(tokens);
    if (fd >= 0) {
      const nameTok = tokens[0];
      const name = nameTok.value;
      const params = [];
      for (let i = 2; i < fd - 2; i++) {
        const t = tokens[i];
        if (t.type === T_NAME) {
          if (params.includes(t.value)) throw new CalcError('Duplicate parameter: ' + t.value, t.pos);
          params.push(t.value);
        }
      }
      if (params.length === 0) throw new CalcError('Function definition requires at least one parameter', tokens[2].pos);
      if (Object.prototype.hasOwnProperty.call(builtins, name)) {
        throw new CalcError('Cannot redefine built-in function: ' + name, nameTok.pos);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
        throw new CalcError('Cannot define function named ' + name, nameTok.pos);
      }
      const body = new Parser(tokens, fd).parseAll();
      funcs.set(name, { params, body });
      return { kind: 'def', value: `${name}(${params.join(',')})` };
    }

    // Assignment
    if (tokens[0].type === T_NAME && tokens[1].type === T_OP && tokens[1].value === '=') {
      const name = tokens[0].value;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
        throw new CalcError('Cannot assign to ' + name, tokens[0].pos);
      }
      const ast = new Parser(tokens, 2).parseAll();
      depth = 0;
      const v = ev(ast, null);
      vars.set(name, v);
      ans = v;
      return { kind: 'num', value: v };
    }

    const ast = new Parser(tokens, 0).parseAll();
    depth = 0;
    const v = ev(ast, null);
    ans = v;
    return { kind: 'num', value: v };
  }

  Object.assign(calc, {
    evaluate(input) {
      const r = run(input);
      hist.push({ input: input.trim(), result: r.value });
      return r.value;
    },
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError('Invalid angle mode: ' + m, 0);
      mode = m;
    },
    getAngleMode() { return mode; },
    getVariable(name) {
      if (name === 'ans') return ans;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      return vars.has(name) ? vars.get(name) : undefined;
    },
    setVariable(name, value) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new CalcError('Invalid variable name: ' + name, 0);
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name) || name === 'ans') {
        throw new CalcError('Cannot assign to ' + name, 0);
      }
      const v = Number(value);
      if (!Number.isFinite(v)) throw new CalcError('Variable value must be a finite number', 0);
      vars.set(name, v);
    },
    variables() {
      return [...vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    },
    history() { return hist.map((h) => ({ ...h })); },
    clear() {
      vars = new Map();
      funcs = new Map();
      ans = 0;
      hist = [];
    },
    format(value) {
      if (typeof value !== 'number') return String(value);
      const n = Number(value.toPrecision(precision));
      if (Object.is(n, -0) || n === 0) return '0';
      return String(n);
    },
  });
  return calc;
}
