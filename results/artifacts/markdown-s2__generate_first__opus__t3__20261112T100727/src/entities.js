// Named HTML character references (a commonly used subset of the HTML5 list).
const ENT = Object.create(null);

const latin1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
latin1.forEach((n, i) => { ENT[n] = String.fromCodePoint(160 + i); });

const greekUpper = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');
greekUpper.forEach((n, i) => { if (n !== '_') ENT[n] = String.fromCodePoint(913 + i); });
const greekLower = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(' ');
greekLower.forEach((n, i) => { ENT[n] = String.fromCodePoint(945 + i); });

const misc = {
  amp: 38, AMP: 38, lt: 60, LT: 60, gt: 62, GT: 62, quot: 34, QUOT: 34, apos: 39,
  COPY: 169, REG: 174, NewLine: 10, Tab: 9, excl: 33, num: 35, dollar: 36, percnt: 37,
  lpar: 40, rpar: 41, ast: 42, plus: 43, comma: 44, period: 46, sol: 47, colon: 58, semi: 59,
  equals: 61, quest: 63, commat: 64, lsqb: 91, lbrack: 91, bsol: 92, rsqb: 93, rbrack: 93,
  Hat: 94, lowbar: 95, grave: 96, lcub: 123, lbrace: 123, verbar: 124, vert: 124, rcub: 125, rbrace: 125,
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  Dcaron: 270, dcaron: 271, Ccaron: 268, ccaron: 269, Ecaron: 282, ecaron: 283, Rcaron: 344, rcaron: 345,
  Zcaron: 381, zcaron: 382, Ncaron: 327, ncaron: 328, Tcaron: 356, tcaron: 357,
  thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472,
  real: 8476, trade: 8482, TRADE: 8482, alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595,
  harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715,
  prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736,
  and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773,
  asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836,
  sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968,
  rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 10216, rang: 10217, loz: 9674, spades: 9824,
  clubs: 9827, hearts: 9829, diams: 9830, HilbertSpace: 8459, DifferentialD: 8518,
  ClockwiseContourIntegral: 8754, check: 10003, cross: 10007, star: 9734, starf: 9733,
  half: 189, dash: 8208, hyphen: 8208, nbsp: 160, NonBreakingSpace: 160, ohm: 937, micro: 181,
  angst: 197, larrow: 8592, rarrow: 8594, Rarr: 8608, Larr: 8606, leftarrow: 8592, rightarrow: 8594,
  le: 8804, leq: 8804, geq: 8805, ge: 8805, pm: 177, times: 215, div: 247, deg: 176,
  laquo: 171, raquo: 187, sect: 167, para: 182, middot: 183, centerdot: 183,
};
for (const k of Object.keys(misc)) ENT[k] = String.fromCodePoint(misc[k]);
ENT.ngE = '≧̸';
ENT.nge = '≱';
ENT.nle = '≰';
ENT.nlE = '≦̸';

export function decodeEntity(name) {
  return Object.prototype.hasOwnProperty.call(ENT, name) ? ENT[name] : null;
}
