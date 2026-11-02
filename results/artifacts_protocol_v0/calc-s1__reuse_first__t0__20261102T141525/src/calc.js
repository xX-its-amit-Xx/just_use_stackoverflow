export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const toks = [];
  const re = /(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) throw new CalcError(`Invalid number at ${i}`, i);
      toks.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
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
    while (peek() && '*/%'.includes(peek().t) ) {
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
    const t = peek();
    if (t && (t.t === '+' || t.t === '-')) {
      p++;
      const v = unary();
      return t.t === '-' ? -v : v;
    }
    return power();
  }
  function power() {
    const base = primary();
    const t = peek();
    if (t && t.t === '^') {
      p++;
      const e = unary(); // right-assoc, allows unary in exponent
      return base ** e;
    }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new CalcError('Unexpected end of expression', end);
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === '(') {
      p++;
      const v = additive();
      const c = peek();
      if (!c || c.t !== ')') throw new CalcError('Unbalanced parentheses', posOf(c));
      p++;
      return v;
    }
    if (t.t === ')') throw new CalcError('Unbalanced parentheses', t.pos);
    throw new CalcError(`Missing operand before '${t.t}'`, t.pos);
  }

  const result = additive();
  if (p < toks.length) {
    const t = toks[p];
    if (t.t === ')') throw new CalcError('Unbalanced parentheses', t.pos);
    throw new CalcError('Unexpected token', t.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
