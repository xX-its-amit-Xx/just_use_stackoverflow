// Safe arithmetic expression evaluator: tokenizer + recursive-descent parser.
// No eval / Function. Grammar (high -> low precedence):
//   ^ (right-assoc)  >  unary +/-  >  * / %  >  + -

export class CalcError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

const MAX_DEPTH = 1000;
const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ type: ch, value: ch, pos: i });
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (!m) throw new CalcError(`Invalid number at position ${i}`, i);
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}' at position ${i}`, i);
  }
  return tokens;
}

function checkFinite(value, pos) {
  if (!Number.isFinite(value)) {
    throw new CalcError(`Result is not finite at position ${pos}`, pos);
  }
  return value;
}

class Parser {
  constructor(tokens, length) {
    this.tokens = tokens;
    this.index = 0;
    this.length = length;
    this.depth = 0;
  }

  peek() { return this.tokens[this.index]; }

  next() { return this.tokens[this.index++]; }

  endPos() { return this.length; }

  parse() {
    if (this.tokens.length === 0) {
      throw new CalcError('Empty expression', 0);
    }
    const value = this.parseExpr();
    const tok = this.peek();
    if (tok) {
      const what = tok.type === 'num' ? 'number' : `'${tok.value}'`;
      throw new CalcError(`Unexpected ${what} at position ${tok.pos}`, tok.pos);
    }
    return value;
  }

  // expr := term (('+' | '-') term)*
  parseExpr() {
    let left = this.parseTerm();
    for (let tok = this.peek(); tok && (tok.type === '+' || tok.type === '-'); tok = this.peek()) {
      this.next();
      const right = this.parseTerm();
      left = checkFinite(tok.type === '+' ? left + right : left - right, tok.pos);
    }
    return left;
  }

  // term := unary (('*' | '/' | '%') unary)*
  parseTerm() {
    let left = this.parseUnary();
    for (let tok = this.peek(); tok && (tok.type === '*' || tok.type === '/' || tok.type === '%'); tok = this.peek()) {
      this.next();
      const right = this.parseUnary();
      if (tok.type !== '*' && right === 0) {
        throw new CalcError(`Division by zero at position ${tok.pos}`, tok.pos);
      }
      let v;
      if (tok.type === '*') v = left * right;
      else if (tok.type === '/') v = left / right;
      else v = left % right;
      left = checkFinite(v, tok.pos);
    }
    return left;
  }

  // unary := ('+' | '-') unary | power
  parseUnary() {
    const tok = this.peek();
    if (tok && (tok.type === '+' || tok.type === '-')) {
      this.next();
      this.enter(tok.pos);
      const v = this.parseUnary();
      this.depth--;
      return tok.type === '-' ? -v : v;
    }
    return this.parsePower();
  }

  // power := primary ('^' unary)?   (right-assoc; exponent may carry a sign)
  parsePower() {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok && tok.type === '^') {
      this.next();
      this.enter(tok.pos);
      const exp = this.parseUnary();
      this.depth--;
      return checkFinite(Math.pow(base, exp), tok.pos);
    }
    return base;
  }

  // primary := number | '(' expr ')'
  parsePrimary() {
    const tok = this.peek();
    if (!tok) throw new CalcError('Unexpected end of expression', this.endPos());
    if (tok.type === 'num') {
      this.next();
      return tok.value;
    }
    if (tok.type === '(') {
      this.next();
      this.enter(tok.pos);
      const value = this.parseExpr();
      this.depth--;
      const close = this.peek();
      if (!close || close.type !== ')') {
        throw new CalcError(`Unbalanced parentheses: missing ')' for '(' at position ${tok.pos}`, close ? close.pos : this.endPos());
      }
      this.next();
      return value;
    }
    if (tok.type === ')') {
      throw new CalcError(`Unbalanced parentheses: unexpected ')' at position ${tok.pos}`, tok.pos);
    }
    throw new CalcError(`Missing operand before '${tok.value}' at position ${tok.pos}`, tok.pos);
  }

  enter(pos) {
    if (++this.depth > MAX_DEPTH) {
      throw new CalcError(`Expression nested too deeply at position ${pos}`, pos);
    }
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
  return new Parser(tokens, expr.length).parse();
}
