// Arithmetic expression evaluator.
// Adapted from spyannis/jsExpeval (ExpEval.js, MIT License, Copyright (c) 2022 spyannis)
// https://github.com/spyannis/jsExpeval — recursive-descent structure (peek/get/
// factor/term/expression) retained; extended with errors, ^, %, scientific notation.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function evaluate(expr) {
  if (typeof expr !== 'string') throw new CalcError('Input must be a string', 0);
  if (expr.trim() === '') throw new CalcError('Empty expression', 0);

  let pos = 0;

  function skip() {
    while (pos < expr.length && isSpace(expr[pos])) pos++;
  }
  function peek() {
    skip();
    return expr[pos];
  }
  function get() {
    skip();
    return expr[pos++];
  }
  function describe(c) {
    return c === undefined ? 'end of input' : `'${c}'`;
  }

  function getNumber() {
    skip();
    const start = pos;
    while (isDigit(expr[pos])) pos++;
    let digits = pos - start;
    if (expr[pos] === '.') {
      pos++;
      while (isDigit(expr[pos])) { pos++; digits++; }
    }
    if (digits === 0) throw new CalcError(`Invalid number at position ${start}`, start);
    if (expr[pos] === 'e' || expr[pos] === 'E') {
      const ePos = pos;
      pos++;
      if (expr[pos] === '+' || expr[pos] === '-') pos++;
      if (!isDigit(expr[pos])) throw new CalcError(`Invalid exponent at position ${ePos}`, ePos);
      while (isDigit(expr[pos])) pos++;
    }
    return Number(expr.slice(start, pos));
  }

  // primary := number | '(' expression ')'
  function factor() {
    const c = peek();
    if (isDigit(c) || c === '.') return getNumber();
    if (c === '(') {
      const open = pos;
      get();
      const result = expression();
      const close = peek();
      if (close !== ')') {
        if (close === undefined) throw new CalcError(`Unbalanced parenthesis opened at position ${open}`, open);
        throw new CalcError(`Expected ')' but found ${describe(close)} at position ${pos}`, pos);
      }
      get();
      return result;
    }
    if (c === undefined) throw new CalcError('Missing operand at end of input', pos);
    if (c === ')') throw new CalcError(`Unexpected ')' at position ${pos}`, pos);
    if ('+-*/%^'.includes(c)) throw new CalcError(`Missing operand before ${describe(c)} at position ${pos}`, pos);
    throw new CalcError(`Unknown character ${describe(c)} at position ${pos}`, pos);
  }

  // power := primary ('^' unary)?   (right-associative, exponent may be signed)
  function power() {
    const base = factor();
    if (peek() === '^') {
      get();
      return Math.pow(base, unary());
    }
    return base;
  }

  // unary := ('+'|'-') unary | power
  function unary() {
    const c = peek();
    if (c === '-') { get(); return -unary(); }
    if (c === '+') { get(); return +unary(); }
    return power();
  }

  function term() {
    let result = unary();
    for (;;) {
      const c = peek();
      if (c !== '*' && c !== '/' && c !== '%') break;
      const opPos = pos;
      get();
      const rhs = unary();
      if (c === '*') result *= rhs;
      else {
        if (rhs === 0) throw new CalcError(c === '/' ? 'Division by zero' : 'Remainder by zero', opPos);
        result = c === '/' ? result / rhs : result % rhs;
      }
    }
    return result;
  }

  function expression() {
    let result = term();
    for (;;) {
      const c = peek();
      if (c !== '+' && c !== '-') break;
      get();
      const rhs = term();
      result = c === '+' ? result + rhs : result - rhs;
    }
    return result;
  }

  const result = expression();
  const rest = peek();
  if (rest !== undefined) {
    if (rest === ')') throw new CalcError(`Unbalanced ')' at position ${pos}`, pos);
    if (isDigit(rest) || rest === '.') throw new CalcError(`Unexpected number at position ${pos}`, pos);
    if (rest === '(') throw new CalcError(`Unexpected '(' at position ${pos}`, pos);
    throw new CalcError(`Unknown character ${describe(rest)} at position ${pos}`, pos);
  }
  if (!Number.isFinite(result)) throw new CalcError('Result is not finite', 0);
  return result;
}
