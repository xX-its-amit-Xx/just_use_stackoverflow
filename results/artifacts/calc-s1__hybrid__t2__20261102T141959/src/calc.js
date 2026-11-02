export class CalcError extends Error {
  constructor(message, position = 0) { super(message); this.name = 'CalcError'; this.position = position; }
}
function tokenize(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { t.push({ type: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new CalcError(`Invalid number at ${i}`, i);
      t.push({ type: 'num', value: Number(m[0]), pos: i }); i += m[0].length; continue;
    }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
  }
  return t;
}
export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const t = tokenize(expr); let p = 0;
  const end = expr.length;
  const peek = () => t[p];
  const posOf = () => (t[p] ? t[p].pos : end);
  function additive() {
    let v = term();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = t[p++].type; const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() && '*/%'.includes(peek().type)) {
      const tk = t[p++]; const r = unary();
      if (tk.type === '*') v *= r;
      else {
        if (r === 0) throw new CalcError('Division by zero', tk.pos);
        v = tk.type === '/' ? v / r : v % r;
      }
    }
    return v;
  }
  function unary() {
    const k = peek();
    if (k && (k.type === '+' || k.type === '-')) { p++; const v = unary(); return k.type === '-' ? -v : v; }
    return power();
  }
  function power() {
    const b = primary();
    if (peek() && peek().type === '^') { p++; return b ** unary(); }
    return b;
  }
  function primary() {
    const k = peek();
    if (!k) throw new CalcError('Unexpected end of expression', end);
    if (k.type === 'num') { p++; return k.value; }
    if (k.type === '(') {
      p++; const v = additive();
      if (!peek() || peek().type !== ')') throw new CalcError('Unbalanced parentheses', posOf());
      p++; return v;
    }
    throw new CalcError(`Unexpected token '${k.type}' at ${k.pos}`, k.pos);
  }
  const v = additive();
  if (p < t.length) throw new CalcError(`Unexpected token at ${posOf()}`, posOf());
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', 0);
  return v;
}
