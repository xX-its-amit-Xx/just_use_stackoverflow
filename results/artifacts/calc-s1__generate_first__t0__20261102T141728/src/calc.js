export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const t = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { t.push({ type: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new CalcError('Invalid number', i);
      t.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}'`, i);
  }
  return t;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  const toks = tokenize(expr);
  if (!toks.length) throw new CalcError('Empty expression', 0);
  let p = 0;
  const end = expr.length;
  const peek = () => toks[p];
  const posOf = (t) => (t ? t.pos : end);

  function additive() {
    let v = term();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = toks[p++].type;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() && '*/%'.includes(peek().type)) {
      const t = toks[p++];
      const r = unary();
      if (t.type === '*') v *= r;
      else {
        if (r === 0) throw new CalcError('Division by zero', t.pos);
        v = t.type === '/' ? v / r : v % r;
      }
    }
    return v;
  }
  function unary() {
    const t = peek();
    if (t && (t.type === '+' || t.type === '-')) {
      p++;
      const v = unary();
      return t.type === '-' ? -v : v;
    }
    return power();
  }
  function power() {
    const b = primary();
    const t = peek();
    if (t && t.type === '^') {
      p++;
      const e = unary(); // right-assoc, allows unary in exponent
      return Math.pow(b, e);
    }
    return b;
  }
  function primary() {
    const t = peek();
    if (!t) throw new CalcError('Unexpected end of expression', end);
    if (t.type === 'num') { p++; return t.value; }
    if (t.type === '(') {
      p++;
      const v = additive();
      if (!peek() || peek().type !== ')') throw new CalcError('Unbalanced parentheses', posOf(peek()));
      p++;
      return v;
    }
    if (t.type === ')') throw new CalcError('Unbalanced parentheses', t.pos);
    throw new CalcError(`Unexpected token '${t.type}'`, t.pos);
  }

  const v = additive();
  if (p < toks.length) {
    const t = toks[p];
    throw new CalcError(t.type === ')' ? 'Unbalanced parentheses' : 'Unexpected token', t.pos);
  }
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', 0);
  return v;
}
