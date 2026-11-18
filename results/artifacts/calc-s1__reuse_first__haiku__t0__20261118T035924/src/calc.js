// Safe arithmetic expression evaluator (no eval / Function).
//
// The precedence chain (parseAddSub -> parseTerm -> parseFactor -> parseExponential)
// is adapted from expr-eval's ParserState (MIT, Copyright (c) 2015 Matthew Crumley);
// see THIRD_PARTY_NOTICES.md and PROVENANCE.json. The tokenizer and the
// error/position handling are written for this specification.

export class CalcError extends Error {
  /**
   * @param {string} message
   * @param {number} [position] 0-based character index of the problem (best effort)
   */
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Split the input into tokens: {type, value, pos}. */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push({ type: 'op', value: c, pos: i });
      i++;
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(expr);
    if (m) {
      const value = Number(m[0]);
      if (!Number.isFinite(value)) {
        throw new CalcError(`number out of range: ${m[0]}`, i);
      }
      tokens.push({ type: 'num', value, pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`unexpected character '${c}'`, i);
  }
  return tokens;
}

class Parser {
  constructor(expr) {
    this.expr = expr;
    this.tokens = tokenize(expr);
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  /** Consume the next token if it is the operator `op`. */
  accept(op) {
    const t = this.peek();
    if (t && t.type === 'op' && t.value === op) {
      this.index++;
      return t;
    }
    return null;
  }

  endPos() {
    return this.expr.length;
  }

  parse() {
    if (this.tokens.length === 0) {
      throw new CalcError('empty expression', 0);
    }
    const value = this.parseAddSub();
    const t = this.peek();
    if (t) {
      if (t.type === 'op' && t.value === ')') {
        throw new CalcError('unbalanced parentheses: unexpected ")"', t.pos);
      }
      if (t.type === 'num') {
        throw new CalcError('missing operator between numbers', t.pos);
      }
      throw new CalcError(`unexpected '${t.value}'`, t.pos);
    }
    return value;
  }

  // expr := term (('+' | '-') term)*
  parseAddSub() {
    let left = this.parseTerm();
    for (;;) {
      const op = this.accept('+') || this.accept('-');
      if (!op) return left;
      const right = this.parseTerm();
      left = applyBinary(op.value, left, right, op.pos);
    }
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      const op = this.accept('*') || this.accept('/') || this.accept('%');
      if (!op) return left;
      const right = this.parseUnary();
      left = applyBinary(op.value, left, right, op.pos);
    }
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const op = this.accept('+') || this.accept('-');
    if (op) {
      const operand = this.parseUnary();
      return op.value === '-' ? -operand : operand;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    const op = this.accept('^');
    if (!op) return base;
    const exponent = this.parseUnary();
    return applyBinary('^', base, exponent, op.pos);
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const t = this.peek();
    if (!t) {
      throw new CalcError('unexpected end of expression: missing operand', this.endPos());
    }
    if (t.type === 'num') {
      this.index++;
      return t.value;
    }
    if (t.value === '(') {
      this.index++;
      const inner = this.parseAddSub();
      const close = this.peek();
      if (!close || close.type !== 'op' || close.value !== ')') {
        throw new CalcError('unbalanced parentheses: missing ")"', this.endPos());
      }
      this.index++;
      return inner;
    }
    if (t.value === ')') {
      throw new CalcError('missing operand before ")"', t.pos);
    }
    throw new CalcError(`missing operand before '${t.value}'`, t.pos);
  }
}

function applyBinary(op, a, b, pos) {
  let result;
  switch (op) {
    case '+':
      result = a + b;
      break;
    case '-':
      result = a - b;
      break;
    case '*':
      result = a * b;
      break;
    case '/':
      if (b === 0) throw new CalcError('division by zero', pos);
      result = a / b;
      break;
    case '%':
      if (b === 0) throw new CalcError('remainder by zero', pos);
      result = a % b;
      break;
    case '^':
      result = a ** b;
      break;
    default:
      throw new CalcError(`unknown operator '${op}'`, pos);
  }
  if (!Number.isFinite(result)) {
    throw new CalcError('result is not a finite number', pos);
  }
  return result;
}

/**
 * Evaluate an arithmetic expression.
 * @param {string} expr
 * @returns {number}
 * @throws {CalcError}
 */
export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('expression must be a string', 0);
  }
  if (expr.trim() === '') {
    throw new CalcError('empty expression', 0);
  }
  const result = new Parser(expr).parse();
  if (!Number.isFinite(result)) {
    throw new CalcError('result is not a finite number', 0);
  }
  return result;
}
