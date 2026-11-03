export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const roundAway = (x) => Math.sign(x) * Math.round(Math.abs(x));
const F1 = {
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: 1, cbrt: Math.cbrt, abs: Math.abs, ln: 1, log: 1, log2: 1, exp: Math.exp,
  floor: Math.floor, ceil: Math.ceil, round: roundAway, sign: Math.sign,
};
const F2 = new Set(['atan2', 'pow', 'nroot', 'logb']);
const FV = new Set(['min', 'max', 'sum', 'avg', 'hypot']);
const isBuiltin = (n) => n in F1 || F2.has(n) || FV.has(n);

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = s.slice(i);
    let m;
    if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16), pos: i });
    else if ((m = /^0[bB][01]+/.exec(rest))) toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2), pos: i });
    else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) toks.push({ t: 'num', v: Number(m[0]), pos: i });
    else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) toks.push({ t: 'name', v: m[0], pos: i });
    else if ('+-*/%^!(),='.includes(ch)) { toks.push({ t: 'op', v: ch, pos: i }); m = [ch]; }
    else throw new CalcError(`Unexpected character '${ch}'`, i);
    i += m[0].length;
  }
  toks.push({ t: 'end', pos: s.length });
  return toks;
}

class Parser {
  constructor(toks, start = 0) { this.toks = toks; this.i = start; }
  get cur() { return this.toks[this.i]; }
  isOp(v) { return this.cur.t === 'op' && this.cur.v === v; }
  fail(tok = this.cur) {
    throw new CalcError(tok.t === 'end' ? 'Unexpected end of input' : `Unexpected token '${tok.v}'`, tok.pos);
  }
  expect(v) { if (!this.isOp(v)) this.fail(); return this.toks[this.i++]; }
  parseAll() {
    const n = this.parseAdd();
    if (this.cur.t !== 'end') this.fail();
    return n;
  }
  parseAdd() {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.toks[this.i++];
      l = { k: 'bin', op: op.v, l, r: this.parseMul(), pos: op.pos };
    }
    return l;
  }
  parseMul() {
    let l = this.parseImplicit();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.toks[this.i++];
      l = { k: 'bin', op: op.v, l, r: this.parseImplicit(), pos: op.pos };
    }
    return l;
  }
  parseImplicit() {
    let l = this.parseUnary();
    for (;;) {
      const prev = this.toks[this.i - 1];
      const prevOk = prev.t === 'num' || (prev.t === 'op' && prev.v === ')');
      if (prevOk && (this.cur.t === 'name' || this.isOp('('))) {
        const pos = this.cur.pos;
        l = { k: 'bin', op: '*', l, r: this.parsePower(), pos };
      } else return l;
    }
  }
  parseUnary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.toks[this.i++];
      const x = this.parseUnary();
      return op.v === '-' ? { k: 'neg', x } : x;
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      const op = this.toks[this.i++];
      return { k: 'bin', op: '^', l: base, r: this.parseUnary(), pos: op.pos };
    }
    return base;
  }
  parsePostfix() {
    let n = this.parsePrimary();
    while (this.isOp('!')) { n = { k: 'fact', x: n, pos: this.cur.pos }; this.i++; }
    return n;
  }
  parsePrimary() {
    const t = this.cur;
    if (t.t === 'num') { this.i++; return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.parseAdd());
          while (this.isOp(',')) { this.i++; args.push(this.parseAdd()); }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args, pos: t.pos };
      }
      return { k: 'var', name: t.v, pos: t.pos };
    }
    if (this.isOp('(')) {
      this.i++;
      const n = this.parseAdd();
      this.expect(')');
      return n;
    }
    this.fail();
  }
}

export function createCalculator({ angleMode = 'rad', precision = 12 } = {}) {
  let mode = angleMode;
  if (mode !== 'rad' && mode !== 'deg') throw new CalcError('Invalid angle mode', 0);
  let vars = new Map();
  let funcs = new Map();
  let ans = 0;
  let hist = [];
  let depth = 0;

  const chk = (v, pos) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
    return v;
  };
  const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  const toRad = (x) => (mode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (mode === 'deg' ? (x * 180) / Math.PI : x);

  function builtin(name, a, pos) {
    const arity = (n) => { if (a.length !== n) throw new CalcError(`${name} expects ${n} argument(s)`, pos); };
    const dom = (ok, msg = `Domain error in ${name}`) => { if (!ok) throw new CalcError(msg, pos); };
    if (name in F1) {
      arity(1);
      const x = a[0];
      switch (name) {
        case 'sin': return snap(Math.sin(toRad(x)));
        case 'cos': return snap(Math.cos(toRad(x)));
        case 'tan': return Math.tan(toRad(x));
        case 'asin': dom(x >= -1 && x <= 1); return fromRad(Math.asin(x));
        case 'acos': dom(x >= -1 && x <= 1); return fromRad(Math.acos(x));
        case 'atan': return fromRad(Math.atan(x));
        case 'sqrt': dom(x >= 0); return Math.sqrt(x);
        case 'ln': dom(x > 0); return Math.log(x);
        case 'log': dom(x > 0); return Math.log10(x);
        case 'log2': dom(x > 0); return Math.log2(x);
        default: return F1[name](x);
      }
    }
    if (F2.has(name)) {
      arity(2);
      const [x, y] = a;
      switch (name) {
        case 'atan2': return fromRad(Math.atan2(x, y));
        case 'pow': return Math.pow(x, y);
        case 'nroot': {
          dom(y !== 0);
          if (x < 0) {
            dom(Number.isInteger(y) && Math.abs(y % 2) === 1);
            return -Math.pow(-x, 1 / y);
          }
          return y === 3 ? Math.cbrt(x) : Math.pow(x, 1 / y);
        }
        case 'logb': dom(x > 0 && y > 0 && y !== 1); return Math.log(x) / Math.log(y);
      }
    }
    if (a.length < 1) throw new CalcError(`${name} expects at least 1 argument`, pos);
    switch (name) {
      case 'min': return Math.min(...a);
      case 'max': return Math.max(...a);
      case 'sum': return a.reduce((p, q) => p + q, 0);
      case 'avg': return a.reduce((p, q) => p + q, 0) / a.length;
      case 'hypot': return Math.hypot(...a);
    }
  }

  function ev(n, scope) {
    switch (n.k) {
      case 'num': return n.v;
      case 'neg': return -ev(n.x, scope);
      case 'var': {
        if (scope && scope.has(n.name)) return scope.get(n.name);
        if (n.name in CONSTS) return CONSTS[n.name];
        if (n.name === 'ans') return ans;
        if (vars.has(n.name)) return vars.get(n.name);
        throw new CalcError(`Undefined variable '${n.name}'`, n.pos);
      }
      case 'fact': {
        const x = ev(n.x, scope);
        if (!Number.isInteger(x) || x < 0 || x > 170) throw new CalcError('Invalid factorial argument', n.pos);
        let r = 1;
        for (let i = 2; i <= x; i++) r *= i;
        return r;
      }
      case 'bin': {
        const l = ev(n.l, scope), r = ev(n.r, scope);
        switch (n.op) {
          case '+': return chk(l + r, n.pos);
          case '-': return chk(l - r, n.pos);
          case '*': return chk(l * r, n.pos);
          case '/': if (r === 0) throw new CalcError('Division by zero', n.pos); return chk(l / r, n.pos);
          case '%': if (r === 0) throw new CalcError('Division by zero', n.pos); return chk(l % r, n.pos);
          case '^': return chk(Math.pow(l, r), n.pos);
        }
        break;
      }
      case 'call': {
        const uf = funcs.get(n.name);
        if (isBuiltin(n.name)) {
          return chk(builtin(n.name, n.args.map((x) => ev(x, scope)), n.pos), n.pos);
        }
        if (uf) {
          if (n.args.length !== uf.params.length) throw new CalcError(`${n.name} expects ${uf.params.length} argument(s)`, n.pos);
          const vals = n.args.map((x) => ev(x, scope));
          if (depth >= 100) throw new CalcError('Maximum call depth exceeded', n.pos);
          const sc = new Map(uf.params.map((p, i) => [p, vals[i]]));
          depth++;
          try { return chk(ev(uf.body, sc), n.pos); } finally { depth--; }
        }
        // variable followed by parenthesis: implicit multiplication
        if (n.args.length === 1 && ((scope && scope.has(n.name)) || vars.has(n.name) || n.name in CONSTS || n.name === 'ans')) {
          return chk(ev({ k: 'var', name: n.name, pos: n.pos }, scope) * ev(n.args[0], scope), n.pos);
        }
        throw new CalcError(`Unknown function '${n.name}'`, n.pos);
      }
    }
  }

  const c = {
    evaluate(input) {
      if (typeof input !== 'string') throw new CalcError('Input must be a string', 0);
      const toks = tokenize(input);
      depth = 0;
      const isName = (i) => toks[i].t === 'name';
      const isOp = (i, v) => toks[i].t === 'op' && toks[i].v === v;
      if (toks[0].t === 'end') throw new CalcError('Empty input', 0);
      // function definition?
      if (isName(0) && isOp(1, '(')) {
        let j = 2;
        const params = [];
        let ok = true;
        if (isName(j)) {
          params.push(toks[j++].v);
          while (isOp(j, ',') && isName(j + 1)) { params.push(toks[j + 1].v); j += 2; }
        } else ok = false;
        if (ok && isOp(j, ')') && isOp(j + 1, '=')) {
          const name = toks[0].v;
          if (isBuiltin(name)) throw new CalcError(`Cannot redefine built-in '${name}'`, 0);
          if (name in CONSTS || name === 'ans') throw new CalcError(`Cannot redefine '${name}'`, 0);
          const seen = new Set();
          for (let k = 2; k < j; k += 2) {
            if (seen.has(toks[k].v)) throw new CalcError(`Duplicate parameter '${toks[k].v}'`, toks[k].pos);
            seen.add(toks[k].v);
          }
          const body = new Parser(toks, j + 2).parseAll();
          funcs.set(name, { params, body });
          const sig = `${name}(${params.join(',')})`;
          hist.push({ input, result: sig });
          return sig;
        }
      }
      let result;
      if (isName(0) && isOp(1, '=')) {
        const name = toks[0].v;
        if (name in CONSTS || name === 'ans') throw new CalcError(`Cannot assign to '${name}'`, 0);
        const v = chk(ev(new Parser(toks, 2).parseAll(), null), 0);
        vars.set(name, v);
        result = v;
      } else {
        result = chk(ev(new Parser(toks, 0).parseAll(), null), 0);
      }
      ans = result;
      hist.push({ input, result });
      return result;
    },
    setAngleMode(m) {
      if (m !== 'rad' && m !== 'deg') throw new CalcError('Invalid angle mode', 0);
      mode = m;
    },
    getAngleMode: () => mode,
    getVariable: (name) => (name === 'ans' ? ans : vars.get(name)),
    setVariable(name, value) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name in CONSTS || name === 'ans') throw new CalcError(`Invalid variable name '${name}'`, 0);
      vars.set(name, value);
    },
    history: () => hist.map((h) => ({ ...h })),
    clear() { vars = new Map(); funcs = new Map(); ans = 0; hist = []; },
    format(value) {
      const r = Number(value.toPrecision(precision));
      return Object.is(r, -0) ? '0' : String(r);
    },
    _vars: () => vars,
  };
  return c;
}
