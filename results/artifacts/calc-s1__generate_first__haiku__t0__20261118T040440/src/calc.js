// Safe arithmetic expression evaluator: hand-written tokenizer and
// recursive-descent parser. No eval, no Function.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const isDigit = (c) => c >= '0' && c <= '9';

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    const start = i;
    if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(src[i + 1]))) {
      // Number: digits [. digits] | . digits, then optional exponent.
      while (i < n && isDigit(src[i])) i++;
      if (i < n && src[i] === '.') {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (i < n && (src[i] === 'e' || src[i] === 'E')) {
        let j = i + 1;
        if (j < n && (src[j] === '+' || src[j] === '-')) j++;
        if (!(j < n && isDigit(src[j]))) {
          throw new CalcError(`Invalid exponent in number`, i);
        }
        while (j < n && isDigit(src[j])) j++;
        i = j;
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalcError('Number out of range', start);
      }
      tokens.push({ type: 'num', value, pos: start });
      continue;
    }
    if ('+-*/%^'.includes(c)) {
      tokens.push({ type: 'op', value: c, pos: start });
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: c, pos: start });
      i++;
      continue;
    }
    throw new CalcError(`Unknown character '${c}'`, start);
  }
  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

function checkFinite(value, pos) {
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not finite', pos);
  }
  return value;
}

class Parser {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.k = 0;
  }

  peek() { return this.tokens[this.k]; }

  next() { return this.tokens[this.k++]; }

  isOp(tok, ops) { return tok.type === 'op' && ops.includes(tok.value); }

  // expr := term (('+' | '-') term)*
  parseExpr() {
    let left = this.parseTerm();
    while (this.isOp(this.peek(), ['+', '-'])) {
      const op = this.next();
      const right = this.parseTerm();
      left = checkFinite(op.value === '+' ? left + right : left - right, op.pos);
    }
    return left;
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    while (this.isOp(this.peek(), ['*', '/', '%'])) {
      const op = this.next();
      const right = this.parseUnary();
      if (op.value === '*') {
        left = checkFinite(left * right, op.pos);
      } else {
        if (right === 0) throw new CalcError('Division by zero', op.pos);
        left = checkFinite(op.value === '/' ? left / right : left % right, op.pos);
      }
    }
    return left;
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const tok = this.peek();
    if (this.isOp(tok, ['+', '-'])) {
      this.next();
      const v = this.parseUnary();
      return tok.value === '-' ? -v : v;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    if (this.isOp(this.peek(), ['^'])) {
      const op = this.next();
      const exp = this.parseUnary();
      return checkFinite(Math.pow(base, exp), op.pos);
    }
    return base;
  }

  parsePrimary() {
    const tok = this.next();
    if (tok.type === 'num') return tok.value;
    if (tok.type === '(') {
      if (this.peek().type === ')') {
        throw new CalcError('Empty parentheses', this.peek().pos);
      }
      const v = this.parseExpr();
      const close = this.peek();
      if (close.type !== ')') {
        throw new CalcError("Expected ')'", close.pos);
      }
      this.next();
      return v;
    }
    if (tok.type === 'eof') {
      throw new CalcError('Unexpected end of expression', tok.pos);
    }
    if (tok.type === 'op') {
      throw new CalcError(`Missing operand before '${tok.value}'`, tok.pos);
    }
    if (tok.type === ')') {
      throw new CalcError("Unexpected ')'", tok.pos);
    }
    throw new CalcError('Unexpected token', tok.pos);
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('Input must be a string', 0);
  }
  if (expr.trim() === '') {
    throw new CalcError('Empty expression', 0);
  }
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, expr);
  const value = parser.parseExpr();
  const rest = parser.peek();
  if (rest.type === ')') {
    throw new CalcError("Unbalanced parentheses: unexpected ')'", rest.pos);
  }
  if (rest.type !== 'eof') {
    if (rest.type === 'num') {
      throw new CalcError('Missing operator between numbers', rest.pos);
    }
    throw new CalcError('Unexpected token', rest.pos);
  }
  return checkFinite(value, 0);
}
