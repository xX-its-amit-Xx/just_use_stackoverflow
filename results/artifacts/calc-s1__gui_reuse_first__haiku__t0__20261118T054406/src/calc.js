// Safe arithmetic expression evaluator. No eval / Function.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SPACE_RE = /[ \t]+/y;
const OPERATORS = new Set(['+', '-', '*', '/', '%', '^']);

function tokenize(expr) {
  const tokens = [];
  let pos = 0;
  while (pos < expr.length) {
    SPACE_RE.lastIndex = pos;
    if (SPACE_RE.test(expr)) {
      pos = SPACE_RE.lastIndex;
      continue;
    }
    const ch = expr[pos];
    if (ch === '(' || ch === ')' || OPERATORS.has(ch)) {
      tokens.push({ type: ch, pos });
      pos += 1;
      continue;
    }
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(expr);
    if (m) {
      tokens.push({ type: 'num', value: Number(m[0]), pos });
      pos += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, pos);
  }
  return tokens;
}

class Parser {
  constructor(tokens, length) {
    this.tokens = tokens;
    this.i = 0;
    this.length = length;
  }

  peek() {
    return this.tokens[this.i];
  }

  // Position used for "missing operand"/"end of input" style errors.
  here() {
    const t = this.peek();
    return t ? t.pos : this.length;
  }

  // expr := term (('+' | '-') term)*
  parseExpr() {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && (t.type === '+' || t.type === '-')) {
        this.i++;
        const right = this.parseTerm();
        left = t.type === '+' ? left + right : left - right;
      } else {
        return left;
      }
    }
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && (t.type === '*' || t.type === '/' || t.type === '%')) {
        this.i++;
        const opPos = t.pos;
        const right = this.parseUnary();
        if (t.type === '*') {
          left = left * right;
        } else {
          if (right === 0) throw new CalcError('Division by zero', opPos);
          left = t.type === '/' ? left / right : left % right;
        }
      } else {
        return left;
      }
    }
  }

  // unary := ('+' | '-') unary | power
  // Unary minus binds looser than '^': -2^2 = -4.
  parseUnary() {
    const t = this.peek();
    if (t && (t.type === '+' || t.type === '-')) {
      this.i++;
      const v = this.parseUnary();
      return t.type === '-' ? -v : v;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t && t.type === '^') {
      this.i++;
      const exponent = this.parseUnary();
      return base ** exponent;
    }
    return base;
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const t = this.peek();
    if (!t) {
      throw new CalcError('Missing operand at end of expression', this.length);
    }
    if (t.type === 'num') {
      this.i++;
      return t.value;
    }
    if (t.type === '(') {
      this.i++;
      const v = this.parseExpr();
      const close = this.peek();
      if (!close || close.type !== ')') {
        throw new CalcError("Expected ')'", this.here());
      }
      this.i++;
      return v;
    }
    if (t.type === ')') {
      throw new CalcError("Unexpected ')'", t.pos);
    }
    throw new CalcError(`Missing operand before '${t.type}'`, t.pos);
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('Expression must be a string', 0);
  }
  if (expr.trim() === '') {
    throw new CalcError('Empty expression', 0);
  }
  const tokens = tokenize(expr);
  const parser = new Parser(tokens, expr.length);
  const value = parser.parseExpr();
  const rest = parser.peek();
  if (rest) {
    if (rest.type === ')') throw new CalcError("Unbalanced parentheses: unexpected ')'", rest.pos);
    if (rest.type === 'num') throw new CalcError('Missing operator between numbers', rest.pos);
    throw new CalcError(`Unexpected token '${rest.type}'`, rest.pos);
  }
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not a finite number', 0);
  }
  return value;
}
