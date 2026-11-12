// Minimal ESM replacement for `decodeHTMLStrict` from the `entities` package (v3.0.1, BSD-2-Clause).
// decodeCodePoint/decodeMap copied from entities lib/decode_codepoint.js (itself adapted from `he`).
// The named-entity lookup uses entities' maps/entities.json instead of the generated binary trie.
import entityMap from "./entities-map.js";

const decodeMap = new Map([
    [0, 65533], [128, 8364], [130, 8218], [131, 402], [132, 8222], [133, 8230],
    [134, 8224], [135, 8225], [136, 710], [137, 8240], [138, 352], [139, 8249],
    [140, 338], [142, 381], [145, 8216], [146, 8217], [147, 8220], [148, 8221],
    [149, 8226], [150, 8211], [151, 8212], [152, 732], [153, 8482], [154, 353],
    [155, 8250], [156, 339], [158, 382], [159, 376],
]);

function decodeCodePoint(codePoint) {
    if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
        return "�";
    }
    return String.fromCodePoint(decodeMap.get(codePoint) ?? codePoint);
}

const reEntity = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));/g;

export function decodeHTMLStrict(str) {
    return str.replace(reEntity, (m, hex, dec, name) => {
        if (hex !== undefined) return decodeCodePoint(parseInt(hex, 16));
        if (dec !== undefined) return decodeCodePoint(parseInt(dec, 10));
        return Object.prototype.hasOwnProperty.call(entityMap, name) ? entityMap[name] : m;
    });
}
