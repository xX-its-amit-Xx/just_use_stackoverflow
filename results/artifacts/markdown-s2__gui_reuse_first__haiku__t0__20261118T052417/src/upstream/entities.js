// Local replacement for the `entities` package's decodeHTMLStrict, using the
// vendored HTML5 entity table (maps/entities.json, from fb55/entities, BSD-2).
import entityMap from "./maps/entities.json" with { type: "json" };

var reEntity = /&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

function decodeCodePoint(code) {
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return "�";
    }
    return String.fromCodePoint(code);
}

export function decodeHTMLStrict(str) {
    return str.replace(reEntity, function(m) {
        var body = m.slice(1, -1);
        if (body.charAt(0) === "#") {
            var code =
                body.charAt(1) === "x" || body.charAt(1) === "X"
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
            return decodeCodePoint(code);
        }
        return Object.prototype.hasOwnProperty.call(entityMap, body)
            ? entityMap[body]
            : m;
    });
}
export default { decodeHTMLStrict };
