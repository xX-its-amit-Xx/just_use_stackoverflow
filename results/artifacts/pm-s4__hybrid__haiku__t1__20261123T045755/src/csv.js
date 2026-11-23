import { bad } from './errors.js';

// RFC 4180 field escaping.
export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Returns [{ line, fields }]; blank lines are skipped. `line` is the 1-based physical line of the row start.
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const pushRow = () => {
    fields.push(field);
    rows.push({ line: rowLine, fields });
    fields = [];
    field = '';
  };
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { fields.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      pushRow();
      line++;
      rowLine = line;
      i++;
      continue;
    }
    field += c; i++;
  }
  if (inQuotes) throw bad('Unterminated quoted field in CSV');
  if (field !== '' || fields.length > 0) pushRow();
  return rows.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}
