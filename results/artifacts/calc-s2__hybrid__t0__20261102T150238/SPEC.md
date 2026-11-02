# calc-s2 — Scientific calculator engine + REPL (tier S2)

A safe (no `eval` / `Function`) scientific calculator with variables, user functions, angle modes, history and precise error reporting.

## Module: `src/calc.js` (ES module)
- `export class CalcError extends Error` with numeric `position` (0-based index into the input where the error was detected).
- `export function createCalculator({ angleMode = 'rad', precision = 12 } = {})` returns a calculator `c`:
  - `c.evaluate(input: string): number | string` — evaluates one statement (see below). Returns the numeric result; for a function definition returns the string `"<name>(<params comma-separated>)"`, e.g. `"f(x,y)"`.
  - `c.setAngleMode('rad' | 'deg')`, `c.getAngleMode()`; invalid mode → `CalcError`.
  - `c.getVariable(name)` → number or `undefined`; `c.setVariable(name, value)`.
  - `c.history()` → array of `{ input, result }` for every successful statement, oldest first (failed statements are not recorded).
  - `c.clear()` — resets variables, user functions, `ans` and history (angle mode unchanged).
  - `c.format(value: number): string` — rounds to `precision` significant digits and strips trailing zeros, using `Number(value.toPrecision(precision))` then `String(...)`; `-0` formats as `"0"`.

## Statements
- Expression: `1 + 2`.
- Assignment: `name = expr` → stores and returns the value. Names: `[A-Za-z_][A-Za-z0-9_]*`. Assigning to a constant (`pi`, `e`, `tau`) or to `ans` → `CalcError`.
- Function definition: `name(p1, p2, ...) = expr` (≥1 param, unique params). Body may reference params, variables (resolved at call time), constants, built-ins and other user functions. Redefinition replaces. Defining a name that is a built-in function → `CalcError`. Direct or indirect recursion detected at call time (call depth > 100) → `CalcError`.
- After every successful expression or assignment, `ans` holds the result (initially `0`).

## Expressions
- Numbers: `12`, `3.5`, `.5`, `1e-3`, `2.5E+4`; also hexadecimal `0x1F` and binary `0b101`.
- Operators by precedence (high → low):
  1. postfix factorial `!` (non-negative integers only, ≤ 170; else `CalcError`)
  2. `^` power, right-associative (`2^3^2 = 512`); the exponent may carry a unary sign (`2^-1 = 0.5`)
  3. unary `+` / `-` (`-2^2 = -4`, `-3! = -6`)
  4. implicit multiplication (binds tighter than explicit `*` `/`): number or `)` immediately followed by a name, number-less `(`, e.g. `2pi`, `3x`, `2(3+1)`, `(1+1)(2+2)`, `2 sin(0)`; so `6/2(1+2) = 1` and `1/2x` with x=2 is `0.25`.
  5. `*`, `/`, `%` (remainder, JS semantics), left-associative
  6. `+`, `-`, left-associative
- Parentheses; function calls `name(arg, ...)`.
- Constants: `pi`, `e`, `tau` (=2π). Variable lookup of an undefined name → `CalcError`.
- Built-in functions (arity checked; wrong arity → `CalcError`):
  - 1-arg: `sin cos tan asin acos atan sinh cosh tanh sqrt cbrt abs ln log log2 exp floor ceil round sign`
    (`log` = base 10; `ln` = natural; `round` rounds half away from zero: `round(-2.5) = -3`)
  - 2-arg: `atan2(y, x)`, `pow(x, y)`, `nroot(x, n)` (n-th root; negative x with odd integer n allowed, e.g. `nroot(-8,3) = -2`), `logb(x, base)`
  - variadic (≥1): `min max sum avg`
  - `hypot(...)` variadic ≥1
- Angle mode: in `deg` mode, `sin cos tan` take degrees and `asin acos atan atan2` return degrees. In `deg` mode `sin(30)` must be exactly `0.5` after formatting and `cos(90)` and `sin(180)` must return results with absolute value < 1e-12 (snap |x|<1e-12 to 0 is acceptable).
- Domain errors → `CalcError`: `sqrt(-1)`, `ln(0)`, `ln(-1)`, `log(0)`, `asin(2)`, division/remainder by zero, any non-finite result (overflow), factorial of negative or non-integer.
- Syntax errors → `CalcError` with `position` pointing at the offending token's start index (e.g. `"2 + * 3"` → 4; `"(1+2"` → 4, i.e. end of input; `"1 + $"` → 4).

## REPL: `src/repl.js`
Reads statements line-by-line from stdin (one per line; blank lines ignored; print no prompt when stdin is not a TTY), keeps state across lines, and writes one line per statement to stdout:
the formatted result (`c.format`) for numbers, the signature string for function definitions, or `Error: <message>` for errors (and continues).
Special commands: `:deg`, `:rad` (print `mode: deg` / `mode: rad`), `:vars` (print `name = <formatted value>` lines sorted by name, user variables only, excluding `ans`), `:history` (print `<n>: <input> = <formatted result or signature>` lines, 1-based; function definitions are history entries whose result is the signature string).
Exit code 0 at EOF.
