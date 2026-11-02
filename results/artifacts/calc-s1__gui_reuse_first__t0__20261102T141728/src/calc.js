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
    const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (m) { toks.push({ t: 'num', v: Number(m[0]), pos: i }); i += m[0].length; continue; }
    throw new CalcError(`Unexpected character '${c}'`, i);
  }
  return toks;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  const toks = tokenize(expr);
  if (!toks.length) throw new CalcError('Empty expression', 0);
  let p = 0;
  const endPos = expr.length;
  const peek = () => toks[p];
  const posOf = (t) => (t ? t.pos : endPos);

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
      return Math.pow(base, unary());
    }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new CalcError('Unexpected end of expression', endPos);
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === '(') {
      p++;
      const v = additive();
      if (!peek() || peek().t !== ')') throw new CalcError('Missing closing parenthesis', posOf(peek()));
      p++;
      return v;
    }
    throw new CalcError(`Unexpected token '${t.t}'`, t.pos);
  }

  const result = additive();
  if (p < toks.length) {
    const t = toks[p];
    throw new CalcError(t.t === ')' ? 'Unbalanced parenthesis' : 'Unexpected token', t.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
