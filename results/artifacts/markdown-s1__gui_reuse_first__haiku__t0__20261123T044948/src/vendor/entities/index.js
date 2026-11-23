// Strict HTML5 entity decoder used by the vendored commonmark.js parser.
// Replaces the npm `entities` package (BSD-2-Clause) with a small adapter over
// the vendored ./entities.json name->characters map (from fb55/entities maps/).
import entityMap from "./entities.json" with { type: "json" };

const reEntity = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/g;

function fromCodePoint(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

export function decodeHTMLStrict(s) {
  return s.replace(reEntity, (match, dec, hex, name) => {
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10));
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
    const v = Object.prototype.hasOwnProperty.call(entityMap, name) ? entityMap[name] : undefined;
    return v === undefined ? match : v;
  });
}

export default { decodeHTMLStrict };
