// Safe arithmetic expression evaluator (no eval / Function).
// Recursive-descent structure (peek/get, factor/term/expression) adapted from
// spyannis/jsExpeval (MIT License, Copyright (c) 2022 spyannis) — see THIRD_PARTY_NOTICES.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(c)) { tokens.push({ type: c, pos: i }); i++; continue; }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(expr);
    if (m) {
      tokens.push({ type: 'num', value: Number(m[0]), pos: i, text: m[0] });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${c}' at position ${i}`, i);
  }
  tokens.push({ type: 'eof', pos: expr.length });
  return tokens;
}

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Expression must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const get = () => tokens[pos++];

  function describe(t) {
    return t.type === 'eof' ? 'end of input' : t.type === 'num' ? `number '${t.text}'` : `'${t.type}'`;
  }

  // primary := number | '(' expression ')'
  function primary() {
    const t = get();
    if (t.type === 'num') return t.value;
    if (t.type === '(') {
      const result = expression();
      const close = get();
      if (close.type !== ')') {
        throw new CalcError(`Expected ')' but found ${describe(close)} at position ${close.pos}`, close.pos);
      }
      return result;
    }
    if (t.type === ')') throw new CalcError(`Unexpected ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Missing operand: unexpected ${describe(t)} at position ${t.pos}`, t.pos);
  }

  // power := primary ('^' unary)?   (right-assoc; exponent may carry unary sign)
  function power() {
    const base = primary();
    if (peek().type === '^') {
      get();
      return Math.pow(base, unary());
    }
    return base;
  }

  // unary := ('+' | '-') unary | power
  function unary() {
    const t = peek();
    if (t.type === '-') { get(); return -unary(); }
    if (t.type === '+') { get(); return +unary(); }
    return power();
  }

  // term := unary (('*' | '/' | '%') unary)*
  function term() {
    let result = unary();
    while (['*', '/', '%'].includes(peek().type)) {
      const op = get();
      const rhs = unary();
      if (op.type === '*') result *= rhs;
      else {
        if (rhs === 0) {
          throw new CalcError(`${op.type === '/' ? 'Division' : 'Remainder'} by zero at position ${op.pos}`, op.pos);
        }
        result = op.type === '/' ? result / rhs : result % rhs;
      }
    }
    return result;
  }

  // expression := term (('+' | '-') term)*
  function expression() {
    let result = term();
    while (peek().type === '+' || peek().type === '-') {
      if (get().type === '+') result += term();
      else result -= term();
    }
    return result;
  }

  const result = expression();
  const t = peek();
  if (t.type !== 'eof') {
    if (t.type === ')') throw new CalcError(`Unbalanced ')' at position ${t.pos}`, t.pos);
    throw new CalcError(`Unexpected ${describe(t)} at position ${t.pos}`, t.pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not a finite number', 0);
  return result;
}
