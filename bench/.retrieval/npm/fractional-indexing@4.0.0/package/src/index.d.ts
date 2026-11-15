/**
 * Generates an order key that sorts between `a` and `b`.
 *
 * `a` is the lower bound: an order key, or null for the start.
 * `b` is the upper bound: an order key, or null for the end.
 * When both are non-null, they may be passed in either order.
 *
 * `digits` is the alphabet, e.g. '0123456789' for base 10. Its characters
 * must be single-byte (char code 0-255) and in ascending character code order;
 * both are validated. It may otherwise be any alphabet (it does not need to
 * contain 0-9, A-Z or a-z). Because `intDigits` defaults to `digits`, an
 * odd-length `digits` must be paired with an explicit even-length `intDigits`.
 *
 * Note that `digits` only defines the *digit values* of a key. The integer
 * part of every key also begins with a length/magnitude marker (a "head") drawn
 * from the `intDigits` alphabet. The head only ever occupies the first position
 * and is only compared against other heads, which is why `digits` and
 * `intDigits` may overlap (or be identical) and keys still sort correctly.
 *
 * `intDigits` is the head alphabet: a single alphabet in ascending
 * (lexicographical) character order, with even length. Its first half are the
 * negative-length heads and its second half the positive-length heads. The
 * outermost characters mark the longest integer parts and the two characters
 * straddling the midpoint mark the shortest (length 2). The integer part may
 * grow until it reaches the outermost heads, so a shorter alphabet limits how
 * large/small a key's integer part can become.
 *
 * `intDigits` defaults to `digits`, so a base-10 alphabet produces self-headed
 * keys like "50", "600" or "49". When `digits` is also omitted it falls back to
 * BASE_52_DIGITS (A-Z/a-z), giving the classic "a0", "b00", "Z9" form. Note that
 * passing `digits` explicitly (even BASE_62_DIGITS) makes the keys self-headed;
 * only omitting `digits` entirely yields the A-Z/a-z heads.
 *
 * @example
 * // base 10: heads come from `digits` itself. The first half (0-4) are negative
 * // heads, the second half (5-9) positive heads, and 4/5 mark the shortest
 * // (length-2) integer parts.
 * generateKeyBetween(null, null, "0123456789"); // => "50"
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @param {string=} digits
 * @param {string=} intDigits
 * @return {string}
 */
export function generateKeyBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  digits?: string | undefined,
  intDigits?: string | undefined
): string;
/**
 * same preconditions as generateKeysBetween.
 * n >= 0.
 * Returns an array of n distinct keys in sorted order.
 * If a and b are both null, returns [a0, a1, ...]
 * If one or the other is null, returns consecutive "integer"
 * keys.  Otherwise, returns relatively short keys between
 * a and b.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @param {number} n
 * @param {string=} digits
 * @param {string=} intDigits
 * @return {string[]}
 */
export function generateNKeysBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
  digits?: string | undefined,
  intDigits?: string | undefined
): string[];
export const BASE_62_DIGITS: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const BASE_52_DIGITS: string;
