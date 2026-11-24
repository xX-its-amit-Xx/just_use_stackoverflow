// GFM strikethrough for markdown-it: `~text~` and `~~text~~` -> <del>.
// Adapted from markdown-it 15.0.3 src/rules_inline/strikethrough.ts (MIT,
// Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin). Changes: single-tilde
// runs are accepted, runs longer than 2 are literal text, an opener only
// matches a closer of the same run length (as in GFM), tag is <del>.
const TILDE = 0x7e;
const SINGLE = -0x7e; // distinct marker so `~` never pairs with `~~`

function tokenize(state, silent) {
  const start = state.pos;
  if (silent) return false;
  if (state.src.charCodeAt(start) !== TILDE) return false;
  const scanned = state.scanDelims(state.pos, true);
  const len = scanned.length;
  const run = '~'.repeat(len);
  const token = state.push('text', '', 0);
  token.content = run;
  if (len <= 2) {
    state.delimiters.push({
      marker: len === 1 ? SINGLE : TILDE,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += len;
  return true;
}

function process(state, delimiters) {
  for (let i = 0; i < delimiters.length; i++) {
    const startDelim = delimiters[i];
    if (startDelim.marker !== TILDE && startDelim.marker !== SINGLE) continue;
    if (startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];
    const markup = startDelim.marker === TILDE ? '~~' : '~';
    let token = state.tokens[startDelim.token];
    token.type = 's_open'; token.tag = 'del'; token.nesting = 1; token.markup = markup; token.content = '';
    token = state.tokens[endDelim.token];
    token.type = 's_close'; token.tag = 'del'; token.nesting = -1; token.markup = markup; token.content = '';
  }
}

function postProcess(state) {
  process(state, state.delimiters);
  for (const meta of state.tokens_meta) {
    if (meta && meta.delimiters) process(state, meta.delimiters);
  }
}

export default function gfmStrikethrough(md) {
  md.inline.ruler.at('strikethrough', tokenize);
  md.inline.ruler2.at('strikethrough', postProcess);
}
