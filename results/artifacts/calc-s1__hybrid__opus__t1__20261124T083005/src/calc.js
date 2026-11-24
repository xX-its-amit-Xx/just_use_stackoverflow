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
        const expStart = j;
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        if (j === expStart) throw new CalcError(`Invalid exponent in number at position ${i}`, i);
        i = j;
      }
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

  function fail(t, what) {
    if (t.type === 'eof') throw new CalcError(`Unexpected end of input${what ? ', expected ' + what : ''}`, t.pos);
    const desc = t.type === 'num' ? 'number' : `'${t.type}'`;
    throw new CalcError(`Unexpected ${desc} at position ${t.pos}`, t.pos);
  }

  function parseAdd() {
    let left = parseMul();
    while (peek().type === '+' || peek().type === '-') {
      const op = toks[p++];
      const right = parseMul();
      left = check(op.type === '+' ? left + right : left - right, op.pos);
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while ('*/%'.includes(peek().type) && peek().type.length === 1) {
      const op = toks[p++];
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
    if (t.type === '+' || t.type === '-') {
      p++;
      const v = parseUnary();
      return t.type === '-' ? -v : v;
    }
    return parsePow();
  }
  function parsePow() {
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
      const v = parseAdd();
      if (peek().type !== ')') {
        if (peek().type === 'eof') throw new CalcError(`Unbalanced parenthesis: missing ')' for '(' at position ${t.pos}`, peek().pos);
        fail(peek(), "')'");
      }
      p++;
      return v;
    }
    fail(t, 'operand');
  }

  const result = parseAdd();
  const t = peek();
  if (t.type !== 'eof') {
    if (t.type === ')') throw new CalcError(`Unbalanced parenthesis: unexpected ')' at position ${t.pos}`, t.pos);
    fail(t);
  }
  return check(result, 0);
}
