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
  const peek = () => toks[p];
  const endPos = expr.length;

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
      return Math.pow(base, unary()); // right-assoc; exponent may be signed
    }
    return base;
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new CalcError('Unexpected end of expression', endPos);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      const c = peek();
      if (!c || c.t !== ')') throw new CalcError('Unbalanced parentheses', c ? c.pos : endPos);
      p++;
      return v;
    }
    if (tk.t === ')') throw new CalcError('Unbalanced parentheses', tk.pos);
    throw new CalcError(`Unexpected operator '${tk.t}'`, tk.pos);
  }

  const result = additive();
  if (p < toks.length) {
    const tk = toks[p];
    throw new CalcError(tk.t === ')' ? 'Unbalanced parentheses' : 'Unexpected token', tk.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
