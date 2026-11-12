// Safe arithmetic expression evaluator (recursive descent). No eval / Function.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(ch) || (ch === '.' && i + 1 < n && isDigit(input[i + 1]))) {
      // mantissa: digits [. digits] | . digits
      while (i < n && isDigit(input[i])) i++;
      if (i < n && input[i] === '.') {
        i++;
        while (i < n && isDigit(input[i])) i++;
      }
      // optional exponent, only if followed by optional sign and at least one digit
      if (i < n && (input[i] === 'e' || input[i] === 'E')) {
        let j = i + 1;
        if (j < n && (input[j] === '+' || input[j] === '-')) j++;
        if (j < n && isDigit(input[j])) {
          while (j < n && isDigit(input[j])) j++;
          i = j;
        }
      }
      const text = input.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalcError(`Number is not finite: ${text}`, start);
      }
      tokens.push({ type: 'num', value, pos: start });
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: start });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', pos: start });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', pos: start });
      i++;
      continue;
    }
    throw new CalcError(`Unknown character '${ch}'`, start);
  }
  tokens.push({ type: 'end', pos: n });
  return tokens;
}

function checkFinite(value, pos) {
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not finite', pos);
  }
  return value;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  peek() {
    return this.tokens[this.i];
  }

  next() {
    return this.tokens[this.i++];
  }

  isOp(tok, ops) {
    return tok.type === 'op' && ops.includes(tok.value);
  }

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
      if ((op.value === '/' || op.value === '%') && right === 0) {
        throw new CalcError(
          op.value === '/' ? 'Division by zero' : 'Remainder by zero',
          op.pos,
        );
      }
      let result;
      if (op.value === '*') result = left * right;
      else if (op.value === '/') result = left / right;
      else result = left % right;
      left = checkFinite(result, op.pos);
    }
    return left;
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const tok = this.peek();
    if (this.isOp(tok, ['+', '-'])) {
      this.next();
      const operand = this.parseUnary();
      return tok.value === '-' ? -operand : operand;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    if (this.isOp(this.peek(), ['^'])) {
      const op = this.next();
      const exponent = this.parseUnary();
      return checkFinite(Math.pow(base, exponent), op.pos);
    }
    return base;
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const tok = this.next();
    if (tok.type === 'num') return tok.value;
    if (tok.type === 'lparen') {
      const value = this.parseExpr();
      const close = this.peek();
      if (close.type !== 'rparen') {
        throw new CalcError("Expected ')'", close.pos);
      }
      this.next();
      return value;
    }
    if (tok.type === 'end') {
      throw new CalcError('Unexpected end of expression', tok.pos);
    }
    if (tok.type === 'rparen') {
      throw new CalcError("Unbalanced ')'", tok.pos);
    }
    if (tok.type === 'op') {
      throw new CalcError(`Missing operand before '${tok.value}'`, tok.pos);
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
  const parser = new Parser(tokens);
  const value = parser.parseExpr();
  const rest = parser.peek();
  if (rest.type !== 'end') {
    if (rest.type === 'rparen') {
      throw new CalcError("Unbalanced ')'", rest.pos);
    }
    if (rest.type === 'num' || rest.type === 'lparen') {
      throw new CalcError('Missing operator between operands', rest.pos);
    }
    throw new CalcError('Unexpected token', rest.pos);
  }
  return checkFinite(value, expr.length);
}
