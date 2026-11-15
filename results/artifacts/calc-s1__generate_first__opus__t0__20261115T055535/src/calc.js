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
  const n = s.length;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) {
      const start = i;
      while (i < n && isDigit(s[i])) i++;
      if (s[i] === '.') { i++; while (i < n && isDigit(s[i])) i++; }
      if (s[i] === 'e' || s[i] === 'E') {
        let j = i + 1;
        if (s[j] === '+' || s[j] === '-') j++;
        if (isDigit(s[j] ?? '')) {
          while (j < n && isDigit(s[j])) j++;
          i = j;
        } else {
          throw new CalcError(`Malformed exponent in number at position ${i}`, i);
        }
      }
      toks.push({ type: 'num', value: Number(s.slice(start, i)), pos: start });
      continue;
    }
    if ('+-*/%^()'.includes(c)) { toks.push({ type: c, pos: i }); i++; continue; }
    throw new CalcError(`Unexpected character '${c}' at position ${i}`, i);
  }
  toks.push({ type: 'eof', pos: n });
  return toks;
}

function check(v, pos) {
  if (!Number.isFinite(v)) throw new CalcError(`Result is not finite at position ${pos}`, pos);
  return v;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const describe = (t) => (t.type === 'eof' ? 'end of input' : t.type === 'num' ? 'number' : `'${t.type}'`);

  function parseExpr() {
    let left = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      const op = toks[p++];
      const right = parseTerm();
      left = check(op.type === '+' ? left + right : left - right, op.pos);
    }
    return left;
  }
  function parseTerm() {
    let left = parseUnary();
    while (['*', '/', '%'].includes(peek().type)) {
      const op = toks[p++];
      const right = parseUnary();
      if (op.type === '*') left = left * right;
      else {
        if (right === 0) throw new CalcError(op.type === '/' ? `Division by zero at position ${op.pos}` : `Remainder by zero at position ${op.pos}`, op.pos);
        left = op.type === '/' ? left / right : left % right;
      }
      left = check(left, op.pos);
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.type === '+' || t.type === '-') {
      p++;
      const v = parseUnary();
      return t.type === '-' ? -v : v;
    }
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (peek().type === '^') {
      const op = toks[p++];
      const exp = parseUnary();
      return check(Math.pow(base, exp), op.pos);
    }
    return base;
  }
  function parsePrimary() {
    const t = peek();
    if (t.type === 'num') { p++; return check(t.value, t.pos); }
    if (t.type === '(') {
      p++;
      const v = parseExpr();
      if (peek().type !== ')') {
        const u = peek();
        throw new CalcError(u.type === 'eof' ? `Unbalanced parentheses: missing ')' for '(' at position ${t.pos}` : `Expected ')' but found ${describe(u)} at position ${u.pos}`, u.pos);
      }
      p++;
      return v;
    }
    if (t.type === 'eof') throw new CalcError(`Missing operand at end of input (position ${t.pos})`, t.pos);
    if (t.type === ')') throw new CalcError(`Unexpected ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Missing operand before ${describe(t)} at position ${t.pos}`, t.pos);
  }

  const result = parseExpr();
  const t = peek();
  if (t.type !== 'eof') {
    if (t.type === ')') throw new CalcError(`Unbalanced parentheses: unexpected ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Unexpected ${describe(t)} at position ${t.pos}`, t.pos);
  }
  return check(result, 0);
}
