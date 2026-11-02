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
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new CalcError(`Invalid number at ${i}`, i);
      toks.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
  }
  return toks;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  const toks = tokenize(expr);
  if (toks.length === 0) throw new CalcError('Empty expression', 0);
  let p = 0;
  const peek = () => toks[p];
  const endPos = expr.length;

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
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
      const tk = toks[p++];
      const r = unary();
      if (tk.t === '*') v *= r;
      else {
        if (r === 0) throw new CalcError(tk.t === '/' ? 'Division by zero' : 'Remainder by zero', tk.pos);
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
    const base = atom();
    const tk = peek();
    if (tk && tk.t === '^') {
      p++;
      const e = unary();
      return Math.pow(base, e);
    }
    return base;
  }
  function atom() {
    const tk = toks[p];
    if (!tk) throw new CalcError('Unexpected end of expression', endPos);
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      const c = toks[p];
      if (!c || c.t !== ')') throw new CalcError('Unbalanced parentheses: missing )', c ? c.pos : endPos);
      p++;
      return v;
    }
    throw new CalcError(`Unexpected token '${tk.t}' at ${tk.pos}`, tk.pos);
  }

  const result = additive();
  if (p < toks.length) {
    const tk = toks[p];
    throw new CalcError(tk.t === ')' ? `Unbalanced parentheses at ${tk.pos}` : `Unexpected token at ${tk.pos}`, tk.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
