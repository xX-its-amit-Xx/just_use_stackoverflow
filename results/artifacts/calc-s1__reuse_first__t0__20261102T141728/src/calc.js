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
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
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
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const toks = tokenize(expr);
  let p = 0;
  const end = expr.length;
  const peek = () => toks[p];
  const posOf = (t) => (t ? t.pos : end);

  function additive() {
    let v = multiplicative();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const r = multiplicative();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function multiplicative() {
    let v = unary();
    while (peek() && '*/%'.includes(peek().t)) {
      const tk = toks[p++];
      const r = unary();
      if (tk.t === '*') v *= r;
      else {
        if (r === 0) throw new CalcError('Division by zero', tk.pos);
        v = tk.t === '/' ? v / r : v % r;
      }
    }
    return v;
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
      return base ** unary(); // right-assoc; exponent may have unary sign
    }
    return base;
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new CalcError('Unexpected end of input', end);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      if (!peek() || peek().t !== ')') throw new CalcError('Missing closing parenthesis', posOf(peek()));
      p++;
      return v;
    }
    throw new CalcError(`Unexpected token '${tk.t}'`, tk.pos);
  }

  const result = additive();
  if (p < toks.length) {
    const tk = toks[p];
    throw new CalcError(tk.t === ')' ? 'Unbalanced parenthesis' : 'Unexpected token', tk.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
