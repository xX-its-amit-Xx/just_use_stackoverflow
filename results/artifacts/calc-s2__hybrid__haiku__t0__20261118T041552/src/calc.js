// Safe scientific calculator engine (no eval / Function).
// Statements: expression, assignment, function definition.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: 2 * Math.PI });
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const HEX_RE = /0[xX][0-9a-fA-F]+/y;
const BIN_RE = /0[bB][01]+/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_FULL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPS = '+-*/%^!(),=';

function matchAt(re, s, i) {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
}

// ---------- Lexer (lazy, one token at a time) ----------
class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }

  next() {
    const s = this.src;
    let i = this.pos;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) {
      this.pos = i;
      return { type: 'eof', value: '', pos: i };
    }
    const ch = s[i];
    let text;
    if ((text = matchAt(HEX_RE, s, i))) {
      this.pos = i + text.length;
      return { type: 'num', value: parseInt(text.slice(2), 16), pos: i, text };
    }
    if ((text = matchAt(BIN_RE, s, i))) {
      this.pos = i + text.length;
      return { type: 'num', value: parseInt(text.slice(2), 2), pos: i, text };
    }
    if ((text = matchAt(NUM_RE, s, i))) {
      this.pos = i + text.length;
      return { type: 'num', value: Number(text), pos: i, text };
    }
    if ((text = matchAt(NAME_RE, s, i))) {
      this.pos = i + text.length;
      return { type: 'name', value: text, pos: i };
    }
    if (OPS.includes(ch)) {
      this.pos = i + 1;
      return { type: 'op', value: ch, pos: i };
    }
    throw new CalcError(`unexpected character '${ch}'`, i);
  }
}

// ---------- Parser (recursive descent, produces AST) ----------
function syntaxErr(t) {
  if (t.type === 'eof') return new CalcError('unexpected end of input', t.pos);
  if (t.type === 'num') return new CalcError('unexpected number', t.pos);
  if (t.type === 'name') return new CalcError(`unexpected name '${t.value}'`, t.pos);
  return new CalcError(`unexpected '${t.value}'`, t.pos);
}

const isOp = (t, v) => t.type === 'op' && t.value === v;

class Parser {
  constructor(src) {
    this.lex = new Lexer(src);
    this.tok = null; // lookahead cache
    this.last = null; // last consumed token
  }

  peek() {
    if (!this.tok) this.tok = this.lex.next();
    return this.tok;
  }

  next() {
    const t = this.peek();
    this.tok = null;
    this.last = t;
    return t;
  }

  save() {
    return { pos: this.lex.pos, tok: this.tok, last: this.last };
  }

  restore(s) {
    this.lex.pos = s.pos;
    this.tok = s.tok;
    this.last = s.last;
  }

  expectOp(v) {
    const t = this.peek();
    if (!isOp(t, v)) throw syntaxErr(t);
    return this.next();
  }

  expectEnd() {
    const t = this.peek();
    if (t.type !== 'eof') throw syntaxErr(t);
  }

  // Statement: assignment | function definition | expression
  parseStatement() {
    const start = this.save();
    const t = this.peek();
    if (t.type === 'name') {
      const nameTok = this.next();
      const t2 = this.peek();
      if (isOp(t2, '=')) {
        this.next();
        const expr = this.parseExpression();
        this.expectEnd();
        return { kind: 'assign', name: nameTok.value, pos: nameTok.pos, expr };
      }
      if (isOp(t2, '(')) {
        const params = this.tryParams();
        if (params) {
          const body = this.parseExpression();
          this.expectEnd();
          return { kind: 'def', name: nameTok.value, pos: nameTok.pos, params, body };
        }
      }
    }
    this.restore(start);
    const expr = this.parseExpression();
    this.expectEnd();
    return { kind: 'expr', expr };
  }

  // At '(' after a name: try to read `(p1, p2, ...) =`. Returns params or null (state restored).
  tryParams() {
    const s = this.save();
    const fail = () => {
      this.restore(s);
      return null;
    };
    try {
      this.next(); // '('
      const params = [];
      if (isOp(this.peek(), ')')) return fail();
      for (;;) {
        const t = this.next();
        if (t.type !== 'name') return fail();
        params.push({ name: t.value, pos: t.pos });
        const sep = this.next();
        if (isOp(sep, ')')) break;
        if (!isOp(sep, ',')) return fail();
      }
      if (!isOp(this.peek(), '=')) return fail();
      this.next();
      return params;
    } catch (e) {
      if (e instanceof CalcError) return fail();
      throw e;
    }
  }

  // additive: term (('+'|'-') term)*
  parseExpression() {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (isOp(t, '+') || isOp(t, '-')) {
        this.next();
        const right = this.parseTerm();
        left = { t: 'bin', op: t.value, l: left, r: right, pos: t.pos };
      } else break;
    }
    return left;
  }

  // multiplicative: implicit (('*'|'/'|'%') implicit)*
  parseTerm() {
    let left = this.parseImplicit();
    for (;;) {
      const t = this.peek();
      if (isOp(t, '*') || isOp(t, '/') || isOp(t, '%')) {
        this.next();
        const right = this.parseImplicit();
        left = { t: 'bin', op: t.value, l: left, r: right, pos: t.pos };
      } else break;
    }
    return left;
  }

  // implicit multiplication: after a number or ')', a name or '(' multiplies.
  parseImplicit() {
    let left = this.parseUnary();
    for (;;) {
      const last = this.last;
      const t = this.peek();
      const lastOk = last && (last.type === 'num' || isOp(last, ')'));
      const nextOk = t.type === 'name' || isOp(t, '(');
      if (lastOk && nextOk) {
        const right = this.parsePower();
        left = { t: 'bin', op: '*', l: left, r: right, pos: t.pos };
      } else break;
    }
    return left;
  }

  // unary + / -
  parseUnary() {
    const t = this.peek();
    if (isOp(t, '+') || isOp(t, '-')) {
      this.next();
      const operand = this.parseUnary();
      return t.value === '-' ? { t: 'neg', e: operand, pos: t.pos } : operand;
    }
    return this.parsePower();
  }

  // power: postfix ('^' exponent)?  (right-assoc)
  parsePower() {
    const base = this.parsePostfix();
    const t = this.peek();
    if (isOp(t, '^')) {
      this.next();
      const exp = this.parseExponent();
      return { t: 'bin', op: '^', l: base, r: exp, pos: t.pos };
    }
    return base;
  }

  parseExponent() {
    const t = this.peek();
    if (isOp(t, '+') || isOp(t, '-')) {
      this.next();
      const operand = this.parseExponent();
      return t.value === '-' ? { t: 'neg', e: operand, pos: t.pos } : operand;
    }
    return this.parsePower();
  }

  // postfix factorial
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (isOp(t, '!')) {
        this.next();
        e = { t: 'fact', e, pos: t.pos };
      } else break;
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      if (!Number.isFinite(t.value)) throw new CalcError('number out of range', t.pos);
      return { t: 'num', v: t.value, pos: t.pos };
    }
    if (t.type === 'name') {
      this.next();
      if (isOp(this.peek(), '(')) {
        this.next();
        const args = [];
        if (!isOp(this.peek(), ')')) {
          args.push(this.parseExpression());
          while (isOp(this.peek(), ',')) {
            this.next();
            args.push(this.parseExpression());
          }
        }
        this.expectOp(')');
        return { t: 'call', name: t.value, args, pos: t.pos };
      }
      return { t: 'var', name: t.value, pos: t.pos };
    }
    if (isOp(t, '(')) {
      this.next();
      const e = this.parseExpression();
      this.expectOp(')');
      return e;
    }
    throw syntaxErr(t);
  }
}

// ---------- Calculator ----------
function snap(v) {
  return Math.abs(v) < 1e-12 ? 0 : v;
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  if (angleMode !== 'rad' && angleMode !== 'deg') {
    throw new CalcError(`invalid angle mode: ${angleMode}`);
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 100) {
    throw new CalcError(`invalid precision: ${precision}`);
  }

  let mode = angleMode;
  let vars = new Map([['ans', 0]]);
  let funcs = new Map();
  let hist = [];
  let depth = 0;
  const MAX_DEPTH = 100;

  const checkFinite = (v, pos) => {
    if (Number.isNaN(v)) throw new CalcError('domain error (result is undefined)', pos);
    if (!Number.isFinite(v)) throw new CalcError('result is not finite (overflow)', pos);
    return v;
  };

  const factorial = (n, pos) => {
    if (!Number.isInteger(n) || n < 0) {
      throw new CalcError('factorial requires a non-negative integer', pos);
    }
    if (n > 170) throw new CalcError('factorial argument too large (max 170)', pos);
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  };

  const trig = (kind, x, pos) => {
    if (mode === 'rad') {
      return kind === 'sin' ? Math.sin(x) : kind === 'cos' ? Math.cos(x) : Math.tan(x);
    }
    const r = ((x % 360) + 360) % 360;
    if (r % 90 === 0) {
      const k = r / 90;
      if (kind === 'sin') return [0, 1, 0, -1][k];
      if (kind === 'cos') return [1, 0, -1, 0][k];
      if (k === 1 || k === 3) throw new CalcError('tan is undefined at this angle', pos);
      return 0;
    }
    const rad = (r * Math.PI) / 180;
    const v = kind === 'sin' ? Math.sin(rad) : kind === 'cos' ? Math.cos(rad) : Math.tan(rad);
    return snap(v);
  };

  const invTrig = (v) => (mode === 'deg' ? (v * 180) / Math.PI : v);

  const roundHalfAway = (x) => {
    const a = Math.abs(x);
    let r = Math.floor(a);
    if (a - r >= 0.5) r += 1;
    return Math.sign(x) * r;
  };

  // name -> { min, max (Infinity for variadic), fn(args, pos) }
  const B = new Map();
  const f1 = (name, fn) => B.set(name, { min: 1, max: 1, fn: (a) => fn(a[0], a) });
  const f2 = (name, fn) => B.set(name, { min: 2, max: 2, fn: (a) => fn(a[0], a[1], a) });
  const fv = (name, fn) => B.set(name, { min: 1, max: Infinity, fn: (a) => fn(a) });

  B.set('sin', { min: 1, max: 1, fn: (a, pos) => trig('sin', a[0], pos) });
  B.set('cos', { min: 1, max: 1, fn: (a, pos) => trig('cos', a[0], pos) });
  B.set('tan', { min: 1, max: 1, fn: (a, pos) => trig('tan', a[0], pos) });
  f1('asin', (x) => invTrig(Math.asin(x)));
  f1('acos', (x) => invTrig(Math.acos(x)));
  f1('atan', (x) => invTrig(Math.atan(x)));
  f1('sinh', (x) => Math.sinh(x));
  f1('cosh', (x) => Math.cosh(x));
  f1('tanh', (x) => Math.tanh(x));
  f1('sqrt', (x) => Math.sqrt(x));
  f1('cbrt', (x) => Math.cbrt(x));
  f1('abs', (x) => Math.abs(x));
  f1('ln', (x) => Math.log(x));
  f1('log', (x) => Math.log10(x));
  f1('log2', (x) => Math.log2(x));
  f1('exp', (x) => Math.exp(x));
  f1('floor', (x) => Math.floor(x));
  f1('ceil', (x) => Math.ceil(x));
  f1('round', (x) => roundHalfAway(x));
  f1('sign', (x) => Math.sign(x));
  f2('atan2', (y, x) => invTrig(Math.atan2(y, x)));
  f2('pow', (x, y) => Math.pow(x, y));
  f2('nroot', (x, n) => {
    if (n === 0) throw new CalcError('nroot degree must be nonzero');
    if (x >= 0) return Math.pow(x, 1 / n);
    if (Number.isInteger(n) && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);
    return NaN;
  });
  f2('logb', (x, base) => Math.log(x) / Math.log(base));
  fv('min', (a) => Math.min(...a));
  fv('max', (a) => Math.max(...a));
  fv('sum', (a) => a.reduce((s, v) => s + v, 0));
  fv('avg', (a) => a.reduce((s, v) => s + v, 0) / a.length);
  fv('hypot', (a) => Math.hypot(...a));

  const lookupVar = (node, frame) => {
    if (frame && frame.params.has(node.name)) return frame.params.get(node.name);
    if (vars.has(node.name)) return vars.get(node.name);
    if (Object.prototype.hasOwnProperty.call(CONSTS, node.name)) return CONSTS[node.name];
    throw new CalcError(`undefined variable: ${node.name}`, node.pos);
  };

  const callNode = (node, frame) => {
    const args = node.args.map((a) => evalNode(a, frame));
    const bi = B.get(node.name);
    if (bi) {
      if (args.length < bi.min || args.length > bi.max) {
        throw new CalcError(`${node.name}: wrong number of arguments (${args.length})`, node.pos);
      }
      return checkFinite(bi.fn(args, node.pos), node.pos);
    }
    const uf = funcs.get(node.name);
    if (!uf) throw new CalcError(`unknown function: ${node.name}`, node.pos);
    if (args.length !== uf.params.length) {
      throw new CalcError(
        `${node.name} expects ${uf.params.length} argument(s), got ${args.length}`,
        node.pos,
      );
    }
    if (depth + 1 > MAX_DEPTH) {
      throw new CalcError('maximum recursion depth exceeded', node.pos);
    }
    const params = new Map();
    uf.params.forEach((p, i) => params.set(p, args[i]));
    depth++;
    try {
      return checkFinite(evalNode(uf.body, { params }), node.pos);
    } finally {
      depth--;
    }
  };

  const evalNode = (node, frame) => {
    switch (node.t) {
      case 'num':
        return node.v;
      case 'var':
        return lookupVar(node, frame);
      case 'neg':
        return -evalNode(node.e, frame);
      case 'fact':
        return factorial(evalNode(node.e, frame), node.pos);
      case 'call':
        return callNode(node, frame);
      case 'bin': {
        const l = evalNode(node.l, frame);
        const r = evalNode(node.r, frame);
        switch (node.op) {
          case '+':
            return checkFinite(l + r, node.pos);
          case '-':
            return checkFinite(l - r, node.pos);
          case '*':
            return checkFinite(l * r, node.pos);
          case '/':
            if (r === 0) throw new CalcError('division by zero', node.pos);
            return checkFinite(l / r, node.pos);
          case '%':
            if (r === 0) throw new CalcError('remainder by zero', node.pos);
            return checkFinite(l % r, node.pos);
          case '^':
            return checkFinite(Math.pow(l, r), node.pos);
        }
        throw new CalcError(`unknown operator ${node.op}`, node.pos);
      }
    }
    throw new CalcError('internal error: bad node', node.pos);
  };

  const checkAssignable = (name, pos) => {
    if (name === 'ans' || Object.prototype.hasOwnProperty.call(CONSTS, name)) {
      throw new CalcError(`cannot assign to ${name}`, pos);
    }
  };

  const calc = {
    evaluate(input) {
      const src = String(input);
      const stmt = new Parser(src).parseStatement();
      const inputText = src.trim();

      if (stmt.kind === 'expr') {
        const v = evalNode(stmt.expr, null);
        vars.set('ans', v);
        hist.push({ input: inputText, result: v });
        return v;
      }
      if (stmt.kind === 'assign') {
        checkAssignable(stmt.name, stmt.pos);
        const v = evalNode(stmt.expr, null);
        vars.set(stmt.name, v);
        vars.set('ans', v);
        hist.push({ input: inputText, result: v });
        return v;
      }
      // function definition
      if (B.has(stmt.name)) {
        throw new CalcError(`cannot redefine built-in function ${stmt.name}`, stmt.pos);
      }
      const seen = new Set();
      for (const p of stmt.params) {
        if (seen.has(p.name)) throw new CalcError(`duplicate parameter: ${p.name}`, p.pos);
        seen.add(p.name);
      }
      const sig = `${stmt.name}(${stmt.params.map((p) => p.name).join(',')})`;
      funcs.set(stmt.name, { params: stmt.params.map((p) => p.name), body: stmt.body });
      hist.push({ input: inputText, result: sig });
      return sig;
    },

    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError(`invalid angle mode: ${m}`);
      mode = m;
    },

    getAngleMode() {
      return mode;
    },

    getVariable(name) {
      return vars.has(name) ? vars.get(name) : undefined;
    },

    setVariable(name, value) {
      if (!IDENT_FULL.test(name)) throw new CalcError(`invalid variable name: ${name}`);
      checkAssignable(name, 0);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CalcError('variable value must be a finite number');
      }
      vars.set(name, value);
    },

    // Extra helper for the REPL: user variables (excluding ans), sorted by name.
    variables() {
      return [...vars.entries()]
        .filter(([k]) => k !== 'ans')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },

    history() {
      return hist.map((h) => ({ input: h.input, result: h.result }));
    },

    clear() {
      vars = new Map([['ans', 0]]);
      funcs = new Map();
      hist = [];
    },

    format(value) {
      const n = Number(Number(value).toPrecision(precision));
      return n === 0 ? '0' : String(n);
    },
  };

  return calc;
}
