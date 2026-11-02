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
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new CalcError(`Invalid number at ${i}`, i);
      t.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^()'.includes(c)) { t.push({ type: c, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
  }
  return t;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const endPos = expr.length;
  const fin = (v, pos) => {
    if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
    return v;
  };

  function additive() {
    let l = term();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = toks[p++].type;
      const r = term();
      l = fin(op === '+' ? l + r : l - r, toks[p - 1]?.pos ?? 0);
    }
    return l;
  }
  function term() {
    let l = unary();
    while (peek() && '*/%'.includes(peek().type)) {
      const o = toks[p++];
      const r = unary();
      if (o.type !== '*' && r === 0) throw new CalcError('Division by zero', o.pos);
      l = fin(o.type === '*' ? l * r : o.type === '/' ? l / r : l % r, o.pos);
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t && (t.type === '-' || t.type === '+')) {
      p++;
      const v = unary();
      return t.type === '-' ? -v : v;
    }
    return power();
  }
  function power() {
    const base = primary();
    const t = peek();
    if (t && t.type === '^') {
      p++;
      const e = unary(); // right-assoc, allows 2^-1
      return fin(Math.pow(base, e), t.pos);
    }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new CalcError('Unexpected end of expression', endPos);
    if (t.type === 'num') { p++; return t.value; }
    if (t.type === '(') {
      p++;
      const v = additive();
      const c = peek();
      if (!c || c.type !== ')') throw new CalcError('Unbalanced parentheses', c ? c.pos : endPos);
      p++;
      return v;
    }
    throw new CalcError(`Unexpected token '${t.type}' at ${t.pos}`, t.pos);
  }

  const v = additive();
  if (p < toks.length) {
    const t = toks[p];
    throw new CalcError(t.type === ')' ? 'Unbalanced parentheses' : `Unexpected token at ${t.pos}`, t.pos);
  }
  return fin(v, 0);
}
