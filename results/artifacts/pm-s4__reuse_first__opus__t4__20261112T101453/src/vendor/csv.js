// Vendored and adapted from d3-dsv v3.0.2 (https://github.com/d3/d3-dsv)
// Copyright 2013-2026 Mike Bostock — ISC License (see src/THIRD_PARTY_NOTICES.md).
// Adapted: reduced to the CSV parseRows/formatValue/formatRow functions, ES module exports,
// rows joined with CRLF per RFC 4180, line-number tracking added for import error reporting.
const EOL = {}, EOF = {}, QUOTE = 34, NEWLINE = 10, RETURN = 13, DELIMITER = 44;
const reFormat = /[",\n\r]/;

// Returns array of { line, row } where line is the 1-based physical line the record starts on.
export function csvParseRows(text) {
  const rows = [];
  let N = text.length, I = 0, t, eof = N <= 0, eol = false;
  if (text.charCodeAt(0) === 0xfeff) I = 1;
  if (text.charCodeAt(N - 1) === NEWLINE) --N;
  if (text.charCodeAt(N - 1) === RETURN) --N;
  let lpos = 0, lline = 1;
  function lineAt(pos) { for (; lpos < pos && lpos < text.length; lpos++) if (text.charCodeAt(lpos) === NEWLINE) lline++; return lline; }
  function token() {
    if (eof) return EOF;
    if (eol) return eol = false, EOL;
    let i, j = I, c;
    if (text.charCodeAt(j) === QUOTE) {
      while (I++ < N && text.charCodeAt(I) !== QUOTE || text.charCodeAt(++I) === QUOTE);
      if ((i = I) >= N) eof = true;
      else if ((c = text.charCodeAt(I++)) === NEWLINE) eol = true;
      else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I; }
      return text.slice(j + 1, i - 1).replace(/""/g, '"');
    }
    while (I < N) {
      if ((c = text.charCodeAt(i = I++)) === NEWLINE) eol = true;
      else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I; }
      else if (c !== DELIMITER) continue;
      return text.slice(j, i);
    }
    return eof = true, text.slice(j, N);
  }
  for (;;) {
    const start = I;
    if ((t = token()) === EOF) break;
    const row = [];
    while (t !== EOL && t !== EOF) row.push(t), t = token();
    rows.push({ line: lineAt(start), row });
  }
  return rows;
}

export function csvFormatValue(value) {
  return value == null ? ''
    : reFormat.test(value += '') ? '"' + value.replace(/"/g, '""') + '"'
    : value;
}

export function csvFormatRow(row) { return row.map(csvFormatValue).join(','); }
export function csvFormatRows(rows) { return rows.map(csvFormatRow).join('\r\n') + '\r\n'; }
