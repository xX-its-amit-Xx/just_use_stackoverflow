export class CalcError extends Error {
  constructor(message, position = 0) { super(message); this.name = 'CalcError'; this.position = position; }
}
export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  const toks = [];
  const re = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;
  for (let i = 0; i < expr.length;) {
    const c = expr[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      re.lastIndex = i;
      const m = re.exec(expr);
      if (!m) throw new CalcError(`Invalid number at ${i}`, i);
      toks.push({ t: 'n', v: Number(m[0]), pos: i }); i += m[0].length; continue;
    }
    throw new CalcError(`Unexpected character '${c}' at ${i}`, i);
  }
  if (!toks.length) throw new CalcError('Empty expression', 0);
  let p = 0;
  const end = expr.length;
  const peek = () => toks[p];
  const fin = (v, pos) => { if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos); return v; };
  function additive() {
    let l = mult();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const o = toks[p++]; const r = mult();
      l = fin(o.t === '+' ? l + r : l - r, o.pos);
    }
    return l;
  }
  function mult() {
    let l = unary();
    while (peek() && '*/%'.includes(peek().t)) {
      const o = toks[p++]; const r = unary();
      if (o.t !== '*' && r === 0) throw new CalcError('Division by zero', o.pos);
      l = fin(o.t === '*' ? l * r : o.t === '/' ? l / r : l % r, o.pos);
    }
    return l;
  }
  function unary() {
    const k = peek();
    if (k && (k.t === '+' || k.t === '-')) { p++; const v = unary(); return k.t === '-' ? -v : v; }
    return power();
  }
  function power() {
    const b = primary();
    const k = peek();
    if (k && k.t === '^') { p++; const e = unary(); return fin(Math.pow(b, e), k.pos); }
    return b;
  }
  function primary() {
    const k = peek();
    if (!k) throw new CalcError('Unexpected end of expression', end);
    if (k.t === 'n') { p++; return k.v; }
    if (k.t === '(') {
      p++; const v = additive();
      if (!peek() || peek().t !== ')') throw new CalcError('Unbalanced parentheses', peek() ? peek().pos : end);
      p++; return v;
    }
    throw new CalcError(`Unexpected token '${k.t}'`, k.pos);
  }
  const v = additive();
  if (p < toks.length) throw new CalcError(toks[p].t === ')' ? 'Unbalanced parentheses' : 'Unexpected token', toks[p].pos);
  return fin(v, 0);
}
