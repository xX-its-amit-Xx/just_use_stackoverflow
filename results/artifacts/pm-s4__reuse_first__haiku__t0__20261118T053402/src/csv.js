// RFC 4180 CSV parse/format.
// Parser adapted from d3-dsv (ISC, Copyright 2013-2026 Mike Bostock): the quoted-token
// scan with "" unescaping and CR / LF / CRLF record terminators in dist/d3-dsv.mjs
// (parseRows / token). Rewritten as a single-pass character state machine.
const QUOTE = 34;
const LF = 10;
const CR = 13;

export function parseCSV(text, delimiter = ',') {
  const d = delimiter.charCodeAt(0);
  const rows = [];
  const n = text.length;
  let i = 0;
  let row = [];
  if (n === 0) return rows;
  while (i < n) {
    let value;
    if (text.charCodeAt(i) === QUOTE) {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        if (text.charCodeAt(j) === QUOTE) {
          if (text.charCodeAt(j + 1) === QUOTE) { out += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        out += text[j];
        j++;
      }
      if (!closed) throw new Error('unterminated quoted field');
      value = out;
      i = j;
      if (i < n) {
        const c = text.charCodeAt(i);
        if (c !== d && c !== LF && c !== CR) throw new Error('unexpected character after closing quote');
      }
    } else {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === d || c === LF || c === CR) break;
        j++;
      }
      value = text.slice(i, j);
      i = j;
    }
    row.push(value);
    if (i >= n) { rows.push(row); break; }
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i >= n) { row.push(''); rows.push(row); break; }
      continue;
    }
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    rows.push(row);
    row = [];
  }
  return rows;
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatCSV(rows) {
  return rows.map((r) => r.map(formatValue).join(',')).join('\r\n') + '\r\n';
}
