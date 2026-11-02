export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const toks = [];
  const re = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;
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
      i = re.lastIndex;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
  }
  toks.push({ t: 'end', pos: s.length });
  return toks;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];

  function additive() {
    let v = multiplicative();
    while (peek().t === '+' || peek().t === '-') {
      const op = toks[p++].t;
      const r = multiplicative();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function multiplicative() {
    let v = unary();
    while (['*', '/', '%'].includes(peek().t)) {
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
    if (tk.t === '+' || tk.t === '-') {
      p++;
      const v = unary();
      return tk.t === '-' ? -v : v;
    }
    return power();
  }
  function power() {
    const base = primary();
    if (peek().t === '^') {
      p++;
      return base ** unary();
    }
    return base;
  }
  function primary() {
    const tk = peek();
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      if (peek().t !== ')') throw new CalcError('Unbalanced parentheses', peek().pos);
      p++;
      return v;
    }
    throw new CalcError(tk.t === 'end' ? 'Unexpected end of input' : `Unexpected '${tk.t}' at ${tk.pos}`, tk.pos);
  }

  const result = additive();
  if (peek().t !== 'end') {
    throw new CalcError(peek().t === ')' ? 'Unbalanced parentheses' : `Unexpected token at ${peek().pos}`, peek().pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
