// CSV parsing/formatting adapted from d3-dsv v3.0.2 (ISC License, Copyright 2013-2026 Mike Bostock)
// https://github.com/d3/d3-dsv  — see src/THIRD_PARTY_NOTICES.md
// Adaptations: reduced to comma delimiter, ES module exports, CRLF row separator (RFC 4180),
// BOM stripping, and reporting of unterminated quoted fields.
const EOL = {}, EOF = {}, QUOTE = 34, NEWLINE = 10, RETURN = 13, DELIMITER = 44;
const reFormat = /["\n\r,]/;

export function csvParseRows(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let N = text.length, I = 0, t, eof = N <= 0, eol = false;
  const unterminated = ((text.match(/"/g) || []).length % 2) === 1;
  if (text.charCodeAt(N - 1) === NEWLINE) --N;
  if (text.charCodeAt(N - 1) === RETURN) --N;
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
  while ((t = token()) !== EOF) {
    const row = [];
    while (t !== EOL && t !== EOF) row.push(t), t = token();
    rows.push(row);
  }
  rows.unterminated = unterminated;
  return rows;
}

export function csvFormatValue(value) {
  return value == null ? '' : reFormat.test(value += '') ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function csvFormatRows(rows) {
  return rows.map(r => r.map(csvFormatValue).join(',')).join('\r\n') + '\r\n';
}
