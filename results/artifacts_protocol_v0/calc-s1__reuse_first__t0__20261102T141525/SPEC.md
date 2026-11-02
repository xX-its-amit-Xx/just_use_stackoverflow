# calc-s1 — Arithmetic expression calculator (tier S1)

Build a safe arithmetic expression evaluator (no `eval`, no `Function`).

## Module: `src/calc.js` (ES module)
- `export class CalcError extends Error` — thrown for every invalid input. Has a numeric `position` property (0-based character index where the problem was detected; best effort).
- `export function evaluate(expr: string): number`

## Grammar / semantics
- Numbers: integers, decimals (`3.14`, `.5`, `5.`), scientific notation (`1e3`, `2.5E-2`).
- Binary operators: `+ - * / %` and `^` (power).
- Precedence (high → low): `^` (right-associative) > unary `+`/`-` > `* / %` (left-assoc) > `+ -` (left-assoc).
  Thus `-2^2 = -4`, `2^-1 = 0.5`, `2^3^2 = 512`, `-3*-2 = 6`.
- `%` is the remainder operator with JavaScript semantics (`-7 % 3 = -1`).
- Parentheses for grouping, arbitrarily nested.
- Whitespace (spaces, tabs) is ignored between tokens.
- Errors (throw `CalcError`): empty/whitespace-only input, unknown characters, unbalanced parentheses, missing operands (`1+`, `*2`), two numbers in a row (`1 2`), division or remainder by zero, a result that is not finite (`10^400`), and non-string input.

## CLI: `src/cli.js`
`node src/cli.js "<expr>"` prints the result to stdout followed by a newline and exits 0.
On error prints `Error: <message>` to stderr and exits 1. Results are printed with JavaScript's default `String(number)` formatting.

## package.json
Must have `"type": "module"` and a `test` script running `node --test tests/`.
