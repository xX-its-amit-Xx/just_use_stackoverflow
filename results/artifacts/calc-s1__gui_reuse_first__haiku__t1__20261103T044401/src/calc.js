// Safe arithmetic expression evaluator. No eval, no Function.
//
// Grammar (high -> low precedence):
//   primary := NUMBER | '(' expr ')'
//   power   := primary ( '^' unary )?          -- right-assoc via unary -> power
//   unary   := ('+' | '-') unary | power
//   term    := unary ( ('*' | '/' | '%') unary )*
//   expr    := term ( ('+' | '-') term )*

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
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (!m) {
        throw new CalcError(`Unexpected character '${ch}'`, i);
      }
      const value = Number(m[0]);
      tokens.push({ type: 'num', value, pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
    } else if (ch === '(') {
      tokens.push({ type: 'lparen', pos: i });
    } else if (ch === ')') {
      tokens.push({ type: 'rparen', pos: i });
    } else {
      throw new CalcError(`Unexpected character '${ch}'`, i);
    }
    i++;
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
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

  parseExpr() {
    let node = this.parseTerm();
    while (this.isOp(this.peek(), ['+', '-'])) {
      const op = this.next();
      const right = this.parseTerm();
      node = { kind: 'bin', op: op.value, pos: op.pos, left: node, right };
    }
    return node;
  }

  parseTerm() {
    let node = this.parseUnary();
    while (this.isOp(this.peek(), ['*', '/', '%'])) {
      const op = this.next();
      const right = this.parseUnary();
      node = { kind: 'bin', op: op.value, pos: op.pos, left: node, right };
    }
    return node;
  }

  parseUnary() {
    if (this.isOp(this.peek(), ['+', '-'])) {
      const op = this.next();
      const operand = this.parseUnary();
      return { kind: 'neg', op: op.value, pos: op.pos, operand };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    if (this.isOp(this.peek(), ['^'])) {
      const op = this.next();
      // Exponent is a unary expression, which itself reaches parsePower,
      // giving right associativity (2^3^2 = 2^(3^2)) and allowing 2^-1.
      const exponent = this.parseUnary();
      return { kind: 'bin', op: '^', pos: op.pos, left: base, right: exponent };
    }
    return base;
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.type === 'num') {
      this.next();
      return { kind: 'num', value: tok.value, pos: tok.pos };
    }
    if (tok.type === 'lparen') {
      this.next();
      if (this.peek().type === 'rparen') {
        throw new CalcError('Missing operand inside parentheses', this.peek().pos);
      }
      const inner = this.parseExpr();
      const close = this.peek();
      if (close.type !== 'rparen') {
        if (close.type === 'end') {
          throw new CalcError('Unbalanced parentheses: missing ")"', tok.pos);
        }
        throw new CalcError(`Unexpected ${describe(close)}`, close.pos);
      }
      this.next();
      return inner;
    }
    if (tok.type === 'end') {
      throw new CalcError('Missing operand', tok.pos);
    }
    if (tok.type === 'op') {
      throw new CalcError(`Missing operand before '${tok.value}'`, tok.pos);
    }
    if (tok.type === 'rparen') {
      throw new CalcError('Unbalanced parentheses: unexpected ")"', tok.pos);
    }
    throw new CalcError(`Unexpected ${describe(tok)}`, tok.pos);
  }
}

function describe(tok) {
  switch (tok.type) {
    case 'num':
      return 'number';
    case 'op':
      return `operator '${tok.value}'`;
    case 'lparen':
      return "'('";
    case 'rparen':
      return "')'";
    default:
      return 'end of input';
  }
}

function compute(node) {
  if (node.kind === 'num') return node.value;
  if (node.kind === 'neg') {
    const v = compute(node.operand);
    return node.op === '-' ? -v : v;
  }
  const a = compute(node.left);
  const b = compute(node.right);
  switch (node.op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new CalcError('Division by zero', node.pos);
      return a / b;
    case '%':
      if (b === 0) throw new CalcError('Remainder by zero', node.pos);
      return a % b;
    case '^':
      return Math.pow(a, b);
    default:
      throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
  }
}

export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('Input must be a string', 0);
  }
  if (expr.trim().length === 0) {
    throw new CalcError('Empty expression', 0);
  }
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const tree = parser.parseExpr();
  const trailing = parser.peek();
  if (trailing.type !== 'end') {
    if (trailing.type === 'num') {
      throw new CalcError('Unexpected number after complete expression (missing operator?)', trailing.pos);
    }
    if (trailing.type === 'rparen') {
      throw new CalcError('Unbalanced parentheses: unexpected ")"', trailing.pos);
    }
    throw new CalcError(`Unexpected ${describe(trailing)}`, trailing.pos);
  }
  const result = compute(tree);
  if (!Number.isFinite(result)) {
    throw new CalcError('Result is not a finite number', 0);
  }
  return result;
}
