// Tokenizer/parser structure adapted from celaldrg/calculator (MIT), see THIRD_PARTY_NOTICES.md.
export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const NUMBER_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const WS_RE = /\s/;

function matchAt(re, input, i) {
  re.lastIndex = i;
  const m = re.exec(input);
  return m ? m[0] : null;
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (WS_RE.test(ch)) { i++; continue; }
    const num = matchAt(NUMBER_RE, input, i);
    if (num) {
      let value;
      if (/^0[bB]/.test(num)) value = parseInt(num.slice(2), 2);
      else value = Number(num);
      tokens.push({ type: 'num', value, pos: i });
      i += num.length;
      continue;
    }
    const name = matchAt(NAME_RE, input, i);
    if (name) { tokens.push({ type: 'name', name, pos: i }); i += name.length; continue; }
    if ('+-*/%^!(),='.includes(ch)) { tokens.push({ type: ch, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', pos: input.length });
  return tokens;
}

// Recursive-descent parser (grammar shape adapted from celaldrg/calculator).
//   expr    := term (('+'|'-') term)*
//   term    := implicit (('*'|'/'|'%') implicit)*
//   implicit:= unary (unary-starting-with-name-or-'(' when previous is number or ')')*
//   unary   := ('+'|'-') unary | power
//   power   := postfix ('^' unary)?
//   postfix := primary '!'*
class Parser {
  constructor(tokens, start = 0) { this.t = tokens; this.i = start; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  fail(tok = this.peek()) {
    throw new CalcError(tok.type === 'eof' ? 'Unexpected end of input' : `Unexpected token '${tok.type === 'num' ? tok.value : tok.name ?? tok.type}'`, tok.pos);
  }
  expect(type) { const t = this.peek(); if (t.type !== type) this.fail(t); return this.next(); }

  parseExpr() {
    let left = this.parseTerm();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const t = this.next();
      left = { k: 'bin', op: t.type, l: left, r: this.parseTerm(), pos: t.pos };
    }
    return left;
  }
  parseTerm() {
    let left = this.parseImplicit();
    while (['*', '/', '%'].includes(this.peek().type)) {
      const t = this.next();
      left = { k: 'bin', op: t.type, l: left, r: this.parseImplicit(), pos: t.pos };
    }
    return left;
  }
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const prev = this.t[this.i - 1];
      const cur = this.peek();
      if ((prev.type === 'num' || prev.type === ')') && (cur.type === 'name' || cur.type === '(')) {
        left = { k: 'bin', op: '*', l: left, r: this.parseUnary(), pos: cur.pos };
      } else return left;
    }
  }
  parseUnary() {
    const t = this.peek();
    if (t.type === '+' || t.type === '-') {
      this.next();
      const arg = this.parseUnary();
      return t.type === '-' ? { k: 'neg', arg } : arg;
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.peek().type !== '^') return base;
    const t = this.next();
    return { k: 'bin', op: '^', l: base, r: this.parseUnary(), pos: t.pos };
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.peek().type === '!') {
      const t = this.next();
      node = { k: 'fact', arg: node, pos: t.pos };
    }
    return node;
  }
  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { k: 'num', value: t.value }; }
    if (t.type === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (t.type === 'name') {
      this.next();
      if (this.peek().type === '(') {
        this.next();
        const args = [];
        if (this.peek().type !== ')') {
          args.push(this.parseExpr());
          while (this.peek().type === ',') { this.next(); args.push(this.parseExpr()); }
        }
        this.expect(')');
        return { k: 'call', name: t.name, args, pos: t.pos };
      }
      return { k: 'var', name: t.name, pos: t.pos };
    }
    return this.fail(t);
  }
}

const D2R = Math.PI / 180;
const snap = (x) => (Math.abs(x) < 1e-12 ? 0 : x);

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = 'rad';
  const vars = new Map();
  const funcs = new Map();
  let hist = [];
  let ans = 0;
  const setMode = (m) => {
    if (m !== 'rad' && m !== 'deg') throw new CalcError(`Invalid angle mode: ${m}`, 0);
    mode = m;
  };
  setMode(angleMode);

  const err = (msg, pos) => new CalcError(msg, pos);
  const fin = (x, pos) => { if (!Number.isFinite(x)) throw err('Result is not finite', pos); return x; };
  const toRad = (x) => (mode === 'deg' ? x * D2R : x);
  const fromRad = (x) => (mode === 'deg' ? x / D2R : x);
  const need = (cond, msg, pos) => { if (!cond) throw err(msg, pos); };

  const B1 = {
    sin: (x) => snap(Math.sin(toRad(x))),
    cos: (x) => snap(Math.cos(toRad(x))),
    tan: (x) => snap(Math.tan(toRad(x))),
    asin: (x, p) => { need(x >= -1 && x <= 1, 'asin domain error', p); return fromRad(Math.asin(x)); },
    acos: (x, p) => { need(x >= -1 && x <= 1, 'acos domain error', p); return fromRad(Math.acos(x)); },
    atan: (x) => fromRad(Math.atan(x)),
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sqrt: (x, p) => { need(x >= 0, 'sqrt of negative number', p); return Math.sqrt(x); },
    cbrt: Math.cbrt, abs: Math.abs,
    ln: (x, p) => { need(x > 0, 'ln domain error', p); return Math.log(x); },
    log: (x, p) => { need(x > 0, 'log domain error', p); return Math.log10(x); },
    log2: (x, p) => { need(x > 0, 'log2 domain error', p); return Math.log2(x); },
    exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
    round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
    sign: Math.sign,
  };
  const B2 = {
    atan2: (y, x) => fromRad(Math.atan2(y, x)),
    pow: (x, y) => Math.pow(x, y),
    nroot: (x, n, p) => {
      need(n !== 0, 'nroot: zero degree', p);
      if (x < 0) {
        need(Number.isInteger(n) && Math.abs(n % 2) === 1, 'nroot of negative number', p);
        return -Math.pow(-x, 1 / n);
      }
      const r = Math.pow(x, 1 / n);
      // clean up e.g. nroot(27,3)
      const rr = Math.round(r);
      return Number.isInteger(n) && Math.pow(rr, n) === x ? rr : r;
    },
    logb: (x, b, p) => {
      need(x > 0 && b > 0 && b !== 1, 'logb domain error', p);
      return Math.log(x) / Math.log(b);
    },
  };
  const BV = {
    min: (a) => Math.min(...a), max: (a) => Math.max(...a),
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
    hypot: (a) => Math.hypot(...a),
  };
  const isBuiltin = (n) => n in B1 || n in B2 || n in BV;
  const own = (o, n) => Object.prototype.hasOwnProperty.call(o, n);

  function evalNode(n, scope, depth) {
    switch (n.k) {
      case 'num': return fin(n.value, 0);
      case 'neg': return -evalNode(n.arg, scope, depth);
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (own(CONSTANTS, n.name)) return CONSTANTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw err(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'fact': {
        const v = evalNode(n.arg, scope, depth);
        need(Number.isInteger(v) && v >= 0 && v <= 170, 'Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= v; i++) r *= i;
        return r;
      }
      case 'bin': {
        const a = evalNode(n.l, scope, depth);
        const b = evalNode(n.r, scope, depth);
        switch (n.op) {
          case '+': return fin(a + b, n.pos);
          case '-': return fin(a - b, n.pos);
          case '*': return fin(a * b, n.pos);
          case '/': need(b !== 0, 'Division by zero', n.pos); return fin(a / b, n.pos);
          case '%': need(b !== 0, 'Remainder by zero', n.pos); return fin(a % b, n.pos);
          case '^': need(!Number.isNaN(Math.pow(a, b)), 'Invalid power', n.pos); return fin(Math.pow(a, b), n.pos);
        }
        break;
      }
      case 'call': return evalCall(n, scope, depth);
    }
    throw err('Internal error', 0);
  }

  function evalCall(n, scope, depth) {
    const { name, pos } = n;
    const f = funcs.get(name);
    if (!f && !isBuiltin(name)) {
      // implicit multiplication of a variable with a parenthesised group: x(3)
      if ((scope && scope.has(name)) || vars.has(name) || own(CONSTANTS, name) || name === 'ans') {
        if (n.args.length !== 1) throw err(`Unknown function '${name}'`, pos);
        const v = evalNode({ k: 'var', name, pos }, scope, depth);
        return fin(v * evalNode(n.args[0], scope, depth), pos);
      }
      throw err(`Unknown function '${name}'`, pos);
    }
    const args = n.args.map((a) => evalNode(a, scope, depth));
    if (f) {
      need(args.length === f.params.length, `Function '${name}' expects ${f.params.length} argument(s)`, pos);
      need(depth + 1 <= 100, 'Maximum call depth exceeded', pos);
      const s = new Map(f.params.map((p, i) => [p, args[i]]));
      return evalNode(f.body, s, depth + 1);
    }
    let r;
    if (own(B1, name) && B1[name]) {
      need(args.length === 1, `'${name}' expects 1 argument`, pos);
      r = B1[name](args[0], pos);
    } else if (own(B2, name)) {
      need(args.length === 2, `'${name}' expects 2 arguments`, pos);
      r = B2[name](args[0], args[1], pos);
    } else {
      need(args.length >= 1, `'${name}' expects at least 1 argument`, pos);
      r = BV[name](args);
    }
    return fin(r, pos);
  }

  function run(input) {
    if (typeof input !== 'string') throw err('Input must be a string', 0);
    const tokens = tokenize(input);
    const t0 = tokens[0];
    // function definition
    if (t0.type === 'name' && tokens[1].type === '(') {
      let j = 2;
      const params = [];
      let isDef = false;
      if (tokens[j].type === 'name') {
        let k = j;
        const ps = [tokens[k++]];
        while (tokens[k].type === ',' && tokens[k + 1].type === 'name') { ps.push(tokens[k + 1]); k += 2; }
        if (tokens[k].type === ')' && tokens[k + 1].type === '=') { isDef = true; params.push(...ps); j = k + 2; }
      }
      if (isDef) {
        if (isBuiltin(t0.name)) throw err(`Cannot redefine built-in function '${t0.name}'`, t0.pos);
        if (own(CONSTANTS, t0.name) || t0.name === 'ans') throw err(`Cannot define '${t0.name}'`, t0.pos);
        const seen = new Set();
        for (const p of params) {
          if (seen.has(p.name)) throw err(`Duplicate parameter '${p.name}'`, p.pos);
          seen.add(p.name);
        }
        const parser = new Parser(tokens, j);
        const body = parser.parseExpr();
        if (parser.peek().type !== 'eof') parser.fail();
        funcs.set(t0.name, { params: params.map((p) => p.name), body });
        const sig = `${t0.name}(${params.map((p) => p.name).join(',')})`;
        hist.push({ input, result: sig });
        return sig;
      }
    }
    let target = null;
    let start = 0;
    if (t0.type === 'name' && tokens[1].type === '=') {
      if (own(CONSTANTS, t0.name) || t0.name === 'ans') throw err(`Cannot assign to '${t0.name}'`, t0.pos);
      target = t0.name;
      start = 2;
    }
    const parser = new Parser(tokens, start);
    const ast = parser.parseExpr();
    if (parser.peek().type !== 'eof') parser.fail();
    const value = fin(evalNode(ast, null, 0), 0);
    if (target) vars.set(target, value);
    ans = value;
    hist.push({ input, result: value });
    return value;
  }

  const format = (v) => {
    const r = Number(v.toPrecision(precision));
    return Object.is(r, -0) ? '0' : String(r);
  };

  return {
    evaluate: run,
    setAngleMode: setMode,
    getAngleMode: () => mode,
    getVariable(name) {
      if (name === 'ans') return ans;
      if (own(CONSTANTS, name)) return CONSTANTS[name];
      return vars.get(name);
    },
    setVariable(name, value) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw err(`Invalid name '${name}'`, 0);
      if (own(CONSTANTS, name)) throw err(`Cannot assign to '${name}'`, 0);
      if (typeof value !== 'number') throw err('Value must be a number', 0);
      if (name === 'ans') ans = value; else vars.set(name, value);
    },
    variables: () => [...vars.entries()],
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars.clear(); funcs.clear(); hist = []; ans = 0; },
    format,
  };
}
