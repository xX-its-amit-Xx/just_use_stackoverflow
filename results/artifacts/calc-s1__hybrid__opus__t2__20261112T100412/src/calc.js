export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function tokenize(s) {
  const tokens = [];
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
        const ds = j;
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        if (j === ds) throw new CalcError(`Invalid exponent in number at position ${i}`, i);
        i = j;
      }
      tokens.push({ type: 'num', value: Number(s.slice(start, i)), pos: start });
      continue;
    }
    if ('+-*/%^()'.includes(c)) { tokens.push({ type: c, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${c}' at position ${i}`, i);
  }
  tokens.push({ type: 'eof', pos: s.length });
  return tokens;
}

function check(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError('Result is not finite', pos);
  return v;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const tokens = tokenize(expr);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];

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
      if (op.type === '*') left = left * right;
      else {
        if (right === 0) throw new CalcError(op.type === '/' ? 'Division by zero' : 'Remainder by zero', op.pos);
        left = op.type === '/' ? left / right : left % right;
      }
      left = check(left, op.pos);
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.type === '-') { next(); return -parseUnary(); }
    if (t.type === '+') { next(); return parseUnary(); }
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
      const c = peek();
      if (c.type !== ')') throw new CalcError(`Expected ')' at position ${c.pos}`, c.pos);
      next();
      return v;
    }
    if (t.type === 'eof') throw new CalcError('Unexpected end of expression (missing operand)', t.pos);
    if (t.type === ')') throw new CalcError(`Unexpected ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Missing operand before '${t.type}' at position ${t.pos}`, t.pos);
  }

  const result = parseExpr();
  const t = peek();
  if (t.type !== 'eof') {
    if (t.type === ')') throw new CalcError(`Unbalanced ')' at position ${t.pos}`, t.pos);
    if (t.type === 'num' || t.type === '(') throw new CalcError(`Unexpected token at position ${t.pos}`, t.pos);
    throw new CalcError(`Unexpected token '${t.type}' at position ${t.pos}`, t.pos);
  }
  return check(result, expr.length);
}
