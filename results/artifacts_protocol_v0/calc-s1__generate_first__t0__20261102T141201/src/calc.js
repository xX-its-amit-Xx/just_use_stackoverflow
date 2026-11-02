export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const toks = [];
  let i = 0;
  const re = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) throw new CalcError('Invalid number', i);
      toks.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}'`, i);
  }
  return toks;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  const toks = tokenize(expr);
  if (toks.length === 0) throw new CalcError('Empty expression', 0);
  let p = 0;
  const end = expr.length;
  const peek = () => toks[p];

  function additive() {
    let l = multiplicative();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const r = multiplicative();
      l = op === '+' ? l + r : l - r;
    }
    return l;
  }
  function multiplicative() {
    let l = unary();
    while (peek() && '*/%'.includes(peek().t)) {
      const tk = toks[p++];
      const r = unary();
      if (tk.t === '*') l *= r;
      else {
        if (r === 0) throw new CalcError(tk.t === '/' ? 'Division by zero' : 'Remainder by zero', tk.pos);
        l = tk.t === '/' ? l / r : l % r;
      }
    }
    return l;
  }
  function unary() {
    const tk = peek();
    if (tk && (tk.t === '+' || tk.t === '-')) {
      p++;
      const v = unary();
      return tk.t === '-' ? -v : v;
    }
    return power();
  }
  function power() {
    const base = primary();
    const tk = peek();
    if (tk && tk.t === '^') {
      p++;
      return base ** unary();
    }
    return base;
  }
  function primary() {
    const tk = toks[p];
    if (!tk) throw new CalcError('Unexpected end of expression', end);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      const c = toks[p];
      if (!c) throw new CalcError('Missing closing parenthesis', end);
      if (c.t !== ')') throw new CalcError('Expected closing parenthesis', c.pos);
      p++;
      return v;
    }
    if (tk.t === ')') throw new CalcError('Unbalanced parenthesis', tk.pos);
    throw new CalcError(`Unexpected operator '${tk.t}'`, tk.pos);
  }

  const v = additive();
  if (p < toks.length) {
    const tk = toks[p];
    throw new CalcError(tk.t === ')' ? 'Unbalanced parenthesis' : 'Unexpected token', tk.pos);
  }
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', 0);
  return v;
}
