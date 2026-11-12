// Safe arithmetic expression evaluator (no eval, no Function).
// Grammar (lowest to highest precedence):
//   expr    := term   (('+' | '-') term)*
//   term    := unary  (('*' | '/' | '%') unary)*
//   unary   := ('+' | '-') unary | power
//   power   := primary ('^' unary)?          // right-associative, exponent may be signed
//   primary := NUMBER | '(' expr ')'

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

function isDigit(c) {
  return c !== undefined && c >= '0' && c <= '9';
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j])) {
          while (j < n && isDigit(src[j])) j++;
          i = j;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalcError(`number '${text}' is out of range`, start);
      }
      tokens.push({ type: 'num', value, text, pos: start });
      continue;
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push({ type: 'op', val: c, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`unexpected character '${c}'`, i);
  }
  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

function isOp(tok, ...vals) {
  return tok.type === 'op' && vals.includes(tok.val);
}

function apply(tok, a, b) {
  let r;
  switch (tok.val) {
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '/':
      if (b === 0) throw new CalcError('division by zero', tok.pos);
      r = a / b;
      break;
    case '%':
      if (b === 0) throw new CalcError('remainder by zero', tok.pos);
      r = a % b;
      break;
    case '^': r = a ** b; break;
    default: throw new CalcError(`unknown operator '${tok.val}'`, tok.pos);
  }
  if (!Number.isFinite(r)) {
    throw new CalcError('result is not finite', tok.pos);
  }
  return r;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  peek() {
    return this.tokens[this.i];
  }

  advance() {
    const t = this.tokens[this.i];
    if (t.type !== 'eof') this.i++;
    return t;
  }

  parse() {
    const value = this.expr();
    const t = this.peek();
    if (t.type === 'eof') return value;
    if (t.type === 'num') {
      throw new CalcError(`unexpected number '${t.text}' (missing operator?)`, t.pos);
    }
    if (isOp(t, ')')) {
      throw new CalcError("unbalanced parentheses: unexpected ')'", t.pos);
    }
    throw new CalcError(`unexpected operator '${t.val}'`, t.pos);
  }

  expr() {
    let left = this.term();
    while (isOp(this.peek(), '+', '-')) {
      const op = this.advance();
      const right = this.term();
      left = apply(op, left, right);
    }
    return left;
  }

  term() {
    let left = this.unary();
    while (isOp(this.peek(), '*', '/', '%')) {
      const op = this.advance();
      const right = this.unary();
      left = apply(op, left, right);
    }
    return left;
  }

  unary() {
    if (isOp(this.peek(), '+', '-')) {
      const op = this.advance();
      const v = this.unary();
      return op.val === '-' ? -v : v;
    }
    return this.power();
  }

  power() {
    const base = this.primary();
    if (isOp(this.peek(), '^')) {
      const op = this.advance();
      const exp = this.unary();
      return apply(op, base, exp);
    }
    return base;
  }

  primary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.advance();
      return t.value;
    }
    if (isOp(t, '(')) {
      this.advance();
      const v = this.expr();
      const close = this.peek();
      if (isOp(close, ')')) {
        this.advance();
        return v;
      }
      if (close.type === 'eof') {
        throw new CalcError("unbalanced parentheses: missing ')'", close.pos);
      }
      throw new CalcError(`expected ')' but found '${close.type === 'num' ? close.text : close.val}'`, close.pos);
    }
    if (t.type === 'eof') {
      throw new CalcError('missing operand: unexpected end of expression', t.pos);
    }
    if (isOp(t, ')')) {
      throw new CalcError("missing operand: unexpected ')'", t.pos);
    }
    throw new CalcError(`missing operand: unexpected operator '${t.val}'`, t.pos);
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('input must be a string', 0);
  }
  const tokens = tokenize(expr);
  if (tokens.length === 1) {
    throw new CalcError('empty expression', 0);
  }
  try {
    return new Parser(tokens).parse();
  } catch (err) {
    if (err instanceof RangeError) {
      throw new CalcError('expression is nested too deeply', 0);
    }
    throw err;
  }
}
