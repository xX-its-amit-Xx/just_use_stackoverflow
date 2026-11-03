// Minimal replacement for `entities`' decodeHTMLStrict, as used by commonmark.js.
// Decodes a single entity reference like "&amp;", "&#123;", "&#x1F;".
import table from "./entities-data.js";
import fromCodePoint from "./from-code-point.js";

export function decodeHTMLStrict(s) {
    return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
        function (m, hex, dec, name) {
            if (name !== undefined) {
                return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : m;
            }
            var cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
            if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
            return fromCodePoint(cp);
        });
}
