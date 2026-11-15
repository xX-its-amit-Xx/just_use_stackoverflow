// Safe arithmetic expression evaluator: tokenizer + recursive-descent parser.
// No eval / Function. Written from SPEC.md.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(input);
      if (!m) {
        throw new CalcError(`Unexpected character '${ch}'`, i);
      }
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ type: ch, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  return tokens;
}

function describe(tok) {
  return tok.type === 'num' ? 'number' : `'${tok.type}'`;
}

class Parser {
  constructor(tokens, input) {
    this.tokens = tokens;
    this.input = input;
    this.i = 0;
  }

  peek() {
    return this.tokens[this.i];
  }

  endPos() {
    return this.input.length;
  }

  next() {
    return this.tokens[this.i++];
  }

  // expr := term (('+' | '-') term)*
  parseExpr() {
    let left = this.parseTerm();
    for (;;) {
      const tok = this.peek();
      if (tok && (tok.type === '+' || tok.type === '-')) {
        this.next();
        const right = this.parseTerm();
        left = apply(tok, left, right);
      } else {
        return left;
      }
    }
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok && (tok.type === '*' || tok.type === '/' || tok.type === '%')) {
        this.next();
        const right = this.parseUnary();
        left = apply(tok, left, right);
      } else {
        return left;
      }
    }
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const tok = this.peek();
    if (tok && (tok.type === '+' || tok.type === '-')) {
      this.next();
      const operand = this.parseUnary();
      return tok.type === '-' ? -operand : operand;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-associative; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok && tok.type === '^') {
      this.next();
      const exponent = this.parseUnary();
      return apply(tok, base, exponent);
    }
    return base;
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const tok = this.peek();
    if (!tok) {
      throw new CalcError('Unexpected end of input (missing operand)', this.endPos());
    }
    if (tok.type === 'num') {
      this.next();
      return tok.value;
    }
    if (tok.type === '(') {
      this.next();
      const value = this.parseExpr();
      const close = this.peek();
      if (!close) {
        throw new CalcError("Unbalanced parentheses: missing ')'", this.endPos());
      }
      if (close.type !== ')') {
        throw new CalcError(`Expected ')' but found ${describe(close)}`, close.pos);
      }
      this.next();
      return value;
    }
    if (tok.type === ')') {
      throw new CalcError("Unbalanced parentheses: unexpected ')'", tok.pos);
    }
    throw new CalcError(`Missing operand before ${describe(tok)}`, tok.pos);
  }
}

function apply(opTok, a, b) {
  switch (opTok.type) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new CalcError('Division by zero', opTok.pos);
      return a / b;
    case '%':
      if (b === 0) throw new CalcError('Remainder by zero', opTok.pos);
      return a % b;
    case '^':
      return a ** b;
    default:
      throw new CalcError(`Unknown operator '${opTok.type}'`, opTok.pos);
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
  const parser = new Parser(tokens, expr);
  const value = parser.parseExpr();
  const rest = parser.peek();
  if (rest) {
    if (rest.type === ')') {
      throw new CalcError("Unbalanced parentheses: unexpected ')'", rest.pos);
    }
    throw new CalcError(`Unexpected ${describe(rest)} after expression`, rest.pos);
  }
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not a finite number', 0);
  }
  return value;
}
