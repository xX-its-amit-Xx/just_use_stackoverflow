// Safe arithmetic expression evaluator. No eval / Function.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' ||
        ch === '^' || ch === '(' || ch === ')') {
      tokens.push({ type: ch, value: ch, pos: i });
      i++;
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(src);
    if (m) {
      const value = Number(m[0]);
      if (!Number.isFinite(value)) {
        throw new CalcError('Number out of range', i);
      }
      tokens.push({ type: 'num', value, pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  return tokens;
}

function checkFinite(value, pos) {
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not a finite number', pos);
  }
  return value;
}

class Parser {
  constructor(src) {
    this.src = src;
    this.tokens = tokenize(src);
    this.idx = 0;
  }

  peek() {
    return this.tokens[this.idx];
  }

  endPos() {
    return this.src.length;
  }

  next() {
    return this.tokens[this.idx++];
  }

  // expr := term (('+' | '-') term)*
  parseExpr() {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (!t || (t.type !== '+' && t.type !== '-')) break;
      this.next();
      const right = this.parseTerm();
      left = checkFinite(t.type === '+' ? left + right : left - right, t.pos);
    }
    return left;
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || (t.type !== '*' && t.type !== '/' && t.type !== '%')) break;
      this.next();
      const right = this.parseUnary();
      if (t.type === '*') {
        left = checkFinite(left * right, t.pos);
      } else {
        if (right === 0) throw new CalcError('Division by zero', t.pos);
        left = checkFinite(t.type === '/' ? left / right : left % right, t.pos);
      }
    }
    return left;
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const t = this.peek();
    if (t && (t.type === '+' || t.type === '-')) {
      this.next();
      const v = this.parseUnary();
      return t.type === '-' ? -v : v;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative, exponent may be signed)
  parsePower() {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t && t.type === '^') {
      this.next();
      const exp = this.parseUnary();
      return checkFinite(Math.pow(base, exp), t.pos);
    }
    return base;
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const t = this.peek();
    if (!t) {
      throw new CalcError('Unexpected end of input, expected a number or "("', this.endPos());
    }
    if (t.type === 'num') {
      this.next();
      return t.value;
    }
    if (t.type === '(') {
      this.next();
      const v = this.parseExpr();
      const close = this.peek();
      if (!close || close.type !== ')') {
        throw new CalcError('Unbalanced parentheses: missing ")"', close ? close.pos : this.endPos());
      }
      this.next();
      return v;
    }
    if (t.type === ')') {
      throw new CalcError('Unbalanced parentheses: unexpected ")"', t.pos);
    }
    throw new CalcError(`Missing operand before '${t.value}'`, t.pos);
  }

  parseAll() {
    if (this.tokens.length === 0) {
      throw new CalcError('Empty expression', 0);
    }
    const value = this.parseExpr();
    const rest = this.peek();
    if (rest) {
      if (rest.type === 'num') {
        throw new CalcError('Unexpected number: missing operator', rest.pos);
      }
      if (rest.type === ')') {
        throw new CalcError('Unbalanced parentheses: unexpected ")"', rest.pos);
      }
      throw new CalcError(`Unexpected token '${rest.value}'`, rest.pos);
    }
    return checkFinite(value, this.endPos());
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('Input must be a string', 0);
  }
  if (expr.trim().length === 0) {
    throw new CalcError('Empty expression', 0);
  }
  return new Parser(expr).parseAll();
}
