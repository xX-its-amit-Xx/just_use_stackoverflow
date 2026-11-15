// Minimal stand-in for the `entities` package's decodeHTMLStrict, written for
// this project (not vendored). Handles numeric references and a subset of
// common HTML5 named references; unknown names are returned unchanged.
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  middot: "·", bull: "•", deg: "°", plusmn: "±",
  times: "×", divide: "÷", frac12: "½", frac14: "¼",
  frac34: "¾", sect: "§", para: "¶", euro: "€",
  pound: "£", yen: "¥", cent: "¢", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  ne: "≠", le: "≤", ge: "≥", infin: "∞",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ",
  pi: "π", sigma: "σ", omega: "ω", Omega: "Ω",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä",
  Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é",
  egrave: "è", aacute: "á", agrave: "à", ccedil: "ç",
  ntilde: "ñ", iexcl: "¡", iquest: "¿", shy: "­",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌",
  zwj: "‍", dagger: "†", Dagger: "‡", permil: "‰",
  prime: "′", Prime: "″", check: "✓", hearts: "♥",
  ngE: "≧̸", DifferentialD: "ⅆ",
  ClockwiseContourIntegral: "∲", AElig: "Æ", Dcaron: "Ď",
  HilbertSpace: "ℋ", tab: "\t", Tab: "\t", NewLine: "\n", colon: ":",
  excl: "!", num: "#", dollar: "$", percnt: "%", lpar: "(", rpar: ")",
  ast: "*", plus: "+", comma: ",", period: ".", sol: "/", semi: ";",
  equals: "=", quest: "?", commat: "@", lsqb: "[", rsqb: "]", bsol: "\\",
  lowbar: "_", grave: "`", lcub: "{", rcub: "}", verbar: "|", vert: "|",
  Hat: "^", micro: "µ",
};

export function decodeHTMLStrict(s) {
  return s.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (m, body) => {
      if (body[0] === "#") {
        let cp =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          cp = 0xfffd;
        }
        return String.fromCodePoint(cp);
      }
      return Object.prototype.hasOwnProperty.call(NAMED, body)
        ? NAMED[body]
        : m;
    }
  );
}
