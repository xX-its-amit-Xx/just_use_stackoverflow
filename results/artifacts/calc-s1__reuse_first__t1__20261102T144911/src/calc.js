// Structure (peek/get, expression/term/factor recursive descent) adapted from
// spyannis/jsExpeval (MIT) — see THIRD_PARTY_NOTICES.md. Extended heavily.
export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  let pos = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const skip = () => { while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) pos++; };
  const peek = () => { skip(); return pos < expr.length ? expr[pos] : undefined; };

  function number() {
    const start = pos;
    while (isDigit(expr[pos])) pos++;
    if (expr[pos] === '.') { pos++; while (isDigit(expr[pos])) pos++; }
    if (expr[pos] === 'e' || expr[pos] === 'E') {
      let p = pos + 1;
      if (expr[p] === '+' || expr[p] === '-') p++;
      if (!isDigit(expr[p])) throw new CalcError('Malformed exponent', pos);
      while (isDigit(expr[p])) p++;
      pos = p;
    }
    return Number(expr.slice(start, pos));
  }

  function primary() {
    const c = peek();
    if (c === undefined) throw new CalcError('Unexpected end of input', expr.length);
    if (isDigit(c) || c === '.') {
      if (c === '.' && !isDigit(expr[pos + 1])) {
        // allow nothing like "." alone
        throw new CalcError('Invalid number', pos);
      }
      return number();
    }
    if (c === '(') {
      const open = pos++;
      const v = expression();
      if (peek() !== ')') throw new CalcError('Unbalanced parentheses', peek() === undefined ? open : pos);
      pos++;
      return v;
    }
    throw new CalcError(`Unexpected character '${c}'`, pos);
  }

  function power() {
    const base = primary();
    if (peek() === '^') {
      pos++;
      const exp = unary(); // right-assoc, allows 2^-1
      return check(Math.pow(base, exp));
    }
    return base;
  }

  function unary() {
    const c = peek();
    if (c === '-') { pos++; return -unary(); }
    if (c === '+') { pos++; return unary(); }
    return power();
  }

  function check(v, at = pos) {
    if (!Number.isFinite(v)) throw new CalcError('Result is not finite', at);
    return v;
  }

  function term() {
    let r = unary();
    for (let c = peek(); c === '*' || c === '/' || c === '%'; c = peek()) {
      const at = pos++;
      const b = unary();
      if (c === '*') r = check(r * b, at);
      else {
        if (b === 0) throw new CalcError('Division by zero', at);
        r = check(c === '/' ? r / b : r % b, at);
      }
    }
    return r;
  }

  function expression() {
    let r = term();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      const at = pos++;
      const b = term();
      r = check(c === '+' ? r + b : r - b, at);
    }
    return r;
  }

  if (peek() === undefined) throw new CalcError('Empty expression', 0);
  const result = expression();
  const c = peek();
  if (c !== undefined) {
    if (c === ')') throw new CalcError('Unbalanced parentheses', pos);
    throw new CalcError(isDigit(c) || c === '.' ? 'Unexpected number' : `Unexpected character '${c}'`, pos);
  }
  return check(result, 0);
}
