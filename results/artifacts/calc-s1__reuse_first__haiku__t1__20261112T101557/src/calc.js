// Safe arithmetic expression evaluator (no eval / Function).
//
// Lexer and Pratt (precedence-climbing) parser adapted from the MIT-licensed
// `formulakit` package (Copyright (c) 2026 trananhtung), see
// THIRD_PARTY_NOTICES.md. Reduced to the arithmetic subset in SPEC.md and
// extended with the spec's number syntax, error positions and finiteness checks.

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

// Number literal: integer, decimal (3.14, .5, 5.) with optional exponent.
const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

const SINGLE_OPS = {
  '+': 'plus',
  '-': 'minus',
  '*': 'star',
  '/': 'slash',
  '%': 'percent',
  '^': 'caret',
  '(': 'lparen',
  ')': 'rparen',
};

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (m) {
        tokens.push({ type: 'number', raw: m[0], value: Number(m[0]), pos: i });
        i += m[0].length;
        continue;
      }
      // A lone '.' that is not followed by digits.
      throw new CalcError(`Unexpected character '${ch}'`, i);
    }
    if (Object.prototype.hasOwnProperty.call(SINGLE_OPS, ch)) {
      tokens.push({ type: SINGLE_OPS[ch], raw: ch, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', raw: '', pos: src.length });
  return tokens;
}

// Binding powers. '^' is right-associative: its right operand is parsed with
// a slightly lower threshold so another '^' binds inside it. Unary +/- parses
// its operand above '*' but below '^', so -2^2 == -(2^2).
const BP = {
  plus: 50,
  minus: 50,
  star: 60,
  slash: 60,
  percent: 60,
  caret: 70,
};
const UNARY_BP = 65;

const BINARY_OP_NAME = {
  plus: '+',
  minus: '-',
  star: '*',
  slash: '/',
  percent: '%',
  caret: '^',
};

class Parser {
  constructor(src) {
    this.tokens = tokenize(src);
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  consume() {
    return this.tokens[this.pos++];
  }

  parse() {
    const node = this.expr(0);
    const t = this.peek();
    if (t.type !== 'eof') {
      if (t.type === 'rparen') {
        throw new CalcError("Unbalanced parentheses: unexpected ')'", t.pos);
      }
      throw new CalcError(`Unexpected token '${t.raw}'`, t.pos);
    }
    return node;
  }

  expr(minBP) {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const bp = BP[t.type];
      if (bp === undefined || bp <= minBP) break;
      this.consume();
      const rightBP = t.type === 'caret' ? bp - 1 : bp;
      const right = this.expr(rightBP);
      left = { kind: 'binary', op: t.type, left, right, pos: t.pos };
    }
    return left;
  }

  prefix() {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.consume();
        return { kind: 'number', value: t.value, pos: t.pos };
      case 'minus':
      case 'plus': {
        this.consume();
        const operand = this.expr(UNARY_BP);
        return t.type === 'minus'
          ? { kind: 'neg', operand, pos: t.pos }
          : operand;
      }
      case 'lparen': {
        this.consume();
        if (this.peek().type === 'rparen') {
          throw new CalcError('Missing operand inside parentheses', this.peek().pos);
        }
        const inner = this.expr(0);
        const close = this.peek();
        if (close.type !== 'rparen') {
          throw new CalcError("Unbalanced parentheses: missing ')'", t.pos);
        }
        this.consume();
        return inner;
      }
      case 'eof':
        throw new CalcError('Unexpected end of expression: missing operand', t.pos);
      case 'rparen':
        throw new CalcError("Unbalanced parentheses: unexpected ')'", t.pos);
      default:
        if (BINARY_OP_NAME[t.type] !== undefined) {
          throw new CalcError(
            `Missing operand before '${t.raw}'`,
            t.pos,
          );
        }
        throw new CalcError(`Unexpected token '${t.raw}'`, t.pos);
    }
  }
}

function checkFinite(value, pos) {
  if (!Number.isFinite(value)) {
    throw new CalcError('Result is not a finite number', pos);
  }
  return value;
}

function evalNode(node) {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'neg':
      return -evalNode(node.operand);
    case 'binary': {
      const l = evalNode(node.left);
      const r = evalNode(node.right);
      switch (node.op) {
        case 'plus':
          return checkFinite(l + r, node.pos);
        case 'minus':
          return checkFinite(l - r, node.pos);
        case 'star':
          return checkFinite(l * r, node.pos);
        case 'slash':
          if (r === 0) throw new CalcError('Division by zero', node.pos);
          return checkFinite(l / r, node.pos);
        case 'percent':
          if (r === 0) throw new CalcError('Remainder by zero', node.pos);
          return checkFinite(l % r, node.pos);
        case 'caret':
          return checkFinite(Math.pow(l, r), node.pos);
        default:
          throw new CalcError(`Unknown operator '${node.op}'`, node.pos);
      }
    }
    default:
      throw new CalcError(`Unknown node '${node.kind}'`, node.pos ?? 0);
  }
}

/**
 * Evaluate an arithmetic expression.
 * @param {string} expr
 * @returns {number}
 * @throws {CalcError}
 */
export function evaluate(expr) {
  if (typeof expr !== 'string') {
    throw new CalcError('Expression must be a string', 0);
  }
  if (expr.trim() === '') {
    throw new CalcError('Empty expression', 0);
  }
  const ast = new Parser(expr).parse();
  return checkFinite(evalNode(ast), 0);
}
