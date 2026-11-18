// Strict HTML entity decoding (replacement for the `entities` npm package's
// decodeHTMLStrict, which commonmark.js uses). Named entities must end in ";".
// Named map: src/vendor/entities-data.js (from `entities`, BSD-2-Clause).
import NAMED from "./entities-data.js";

const hasOwn = Object.prototype.hasOwnProperty;

export function decodeHTMLStrict(s) {
    if (s.charAt(1) === "#") {
        const hex = s.charAt(2) === "x" || s.charAt(2) === "X";
        const body = s.slice(hex ? 3 : 2, -1);
        let code = parseInt(body, hex ? 16 : 10);
        if (!(code > 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            code = 0xfffd;
        }
        return String.fromCodePoint(code);
    }
    const name = s.slice(1, -1);
    return hasOwn.call(NAMED, name) ? NAMED[name] : s;
}
