export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const toks = [];
  const re = /(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
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
    let l = term();
    while (peek().t === '+' || peek().t === '-') {
      const op = toks[p++].t;
      const r = term();
      l = op === '+' ? l + r : l - r;
    }
    return l;
  }
  function term() {
    let l = unary();
    while (['*', '/', '%'].includes(peek().t)) {
      const { t: op, pos } = toks[p++];
      const r = unary();
      if (op === '*') l *= r;
      else {
        if (r === 0) throw new CalcError(op === '/' ? 'Division by zero' : 'Remainder by zero', pos);
        l = op === '/' ? l / r : l % r;
      }
    }
    return l;
  }
  function unary() {
    if (peek().t === '-') { p++; return -unary(); }
    if (peek().t === '+') { p++; return unary(); }
    return power();
  }
  function power() {
    const b = primary();
    if (peek().t === '^') {
      p++;
      return b ** unary(); // right-assoc; exponent may carry unary sign
    }
    return b;
  }
  function primary() {
    const tk = toks[p];
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === '(') {
      p++;
      const v = additive();
      if (peek().t !== ')') throw new CalcError('Missing closing parenthesis', peek().pos);
      p++;
      return v;
    }
    if (tk.t === 'end') throw new CalcError('Unexpected end of expression', tk.pos);
    throw new CalcError(`Unexpected token '${tk.t === 'num' ? tk.v : tk.t}'`, tk.pos);
  }

  const result = additive();
  if (peek().t !== 'end') {
    const tk = peek();
    throw new CalcError(tk.t === ')' ? 'Unbalanced parenthesis' : 'Unexpected token', tk.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
