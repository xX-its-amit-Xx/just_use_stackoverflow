export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const toks = [];
  const numRe = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      numRe.lastIndex = i;
      const m = numRe.exec(s);
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

  function expr_() {
    let l = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const r = term();
      l = op === '+' ? l + r : l - r;
    }
    return l;
  }
  function term() {
    let l = unary();
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
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
    const b = primary();
    const tk = peek();
    if (tk && tk.t === '^') {
      p++;
      return Math.pow(b, unary());
    }
    return b;
  }
  function primary() {
    const tk = toks[p];
    if (!tk) throw new CalcError('Unexpected end of expression', end);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = expr_();
      const c = toks[p];
      if (!c || c.t !== ')') throw new CalcError('Unbalanced parentheses', c ? c.pos : end);
      p++;
      return v;
    }
    if (tk.t === ')') throw new CalcError('Unbalanced parentheses', tk.pos);
    throw new CalcError(`Unexpected token '${tk.t}'`, tk.pos);
  }

  const v = expr_();
  if (p < toks.length) {
    const tk = toks[p];
    throw new CalcError(tk.t === ')' ? 'Unbalanced parentheses' : `Unexpected token at ${tk.pos}`, tk.pos);
  }
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', 0);
  return v;
}
