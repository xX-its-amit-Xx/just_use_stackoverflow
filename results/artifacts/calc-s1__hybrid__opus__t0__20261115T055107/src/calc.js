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
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      const start = i;
      let digits = 0;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
      if (s[i] === '.') {
        i++;
        while (i < s.length && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
      }
      if (digits === 0) throw new CalcError(`Invalid number at position ${start}`, start);
      if (s[i] === 'e' || s[i] === 'E') {
        let j = i + 1;
        if (s[j] === '+' || s[j] === '-') j++;
        let ed = 0;
        while (j < s.length && s[j] >= '0' && s[j] <= '9') { j++; ed++; }
        if (ed === 0) throw new CalcError(`Invalid exponent in number at position ${i}`, i);
        i = j;
      }
      if (i < s.length && s[i] === '.') throw new CalcError(`Invalid number at position ${i}`, i);
      toks.push({ type: 'num', value: Number(s.slice(start, i)), pos: start });
      continue;
    }
    if ('+-*/%^()'.includes(c)) { toks.push({ type: c, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${c}' at position ${i}`, i);
  }
  toks.push({ type: 'eof', pos: s.length });
  return toks;
}

function check(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
  return v;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseExpr() {
    let left = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      const op = next();
      const right = parseTerm();
      left = check(op.type === '+' ? left + right : left - right, op.pos);
    }
    return left;
  }
  function parseTerm() {
    let left = parseUnary();
    while (peek().type === '*' || peek().type === '/' || peek().type === '%') {
      const op = next();
      const right = parseUnary();
      if (op.type === '*') left = check(left * right, op.pos);
      else {
        if (right === 0) throw new CalcError(op.type === '/' ? 'Division by zero' : 'Remainder by zero', op.pos);
        left = check(op.type === '/' ? left / right : left % right, op.pos);
      }
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.type === '+' || t.type === '-') {
      next();
      const v = parseUnary();
      return t.type === '-' ? -v : v;
    }
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (peek().type === '^') {
      const op = next();
      const exp = parseUnary();
      return check(Math.pow(base, exp), op.pos);
    }
    return base;
  }
  function parsePrimary() {
    const t = next();
    if (t.type === 'num') return check(t.value, t.pos);
    if (t.type === '(') {
      const v = parseExpr();
      const c = next();
      if (c.type !== ')') {
        if (c.type === 'eof') throw new CalcError(`Unbalanced parenthesis: missing ')' for '(' at position ${t.pos}`, c.pos);
        throw new CalcError(`Expected ')' at position ${c.pos}`, c.pos);
      }
      return v;
    }
    if (t.type === 'eof') throw new CalcError(`Missing operand at end of input (position ${t.pos})`, t.pos);
    if (t.type === ')') throw new CalcError(`Unexpected ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Missing operand before '${t.type}' at position ${t.pos}`, t.pos);
  }

  const result = parseExpr();
  const t = peek();
  if (t.type !== 'eof') {
    if (t.type === ')') throw new CalcError(`Unbalanced parenthesis: unexpected ')' at position ${t.pos}`, t.pos);
    if (t.type === 'num') throw new CalcError(`Unexpected number at position ${t.pos}`, t.pos);
    throw new CalcError(`Unexpected token '${t.type}' at position ${t.pos}`, t.pos);
  }
  return check(result, 0);
}
