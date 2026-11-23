// Minimal strict HTML entity decoder used by the vendored commonmark.js code.
// Replaces the `entities` npm package's decodeHTMLStrict (same contract:
// named refs must end in ';', unknown names are left untouched, invalid
// numeric references become U+FFFD). Name table: ./entities.json.
import entityMap from "./entities.json" with { type: "json" };

const REF = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([0-9a-zA-Z]+));/g;

export function decodeHTMLStrict(text) {
  return String(text).replace(REF, (match, hex, dec, name) => {
    if (name !== undefined) {
      return Object.prototype.hasOwnProperty.call(entityMap, name) ? entityMap[name] : match;
    }
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
    return String.fromCodePoint(cp);
  });
}
