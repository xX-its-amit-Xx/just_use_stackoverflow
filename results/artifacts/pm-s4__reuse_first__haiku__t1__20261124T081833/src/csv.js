// RFC 4180 CSV reader/writer (own implementation; no suitable permissive small source was vendored).
import { bad } from './util.js';

// Returns [{ line, fields }] where line is the 1-based physical line the record starts on.
// Blank lines are skipped.
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recLine = 1;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === '\n') line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      fields.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ line: recLine, fields });
      fields = [];
      field = '';
      i++;
      line++;
      recLine = line;
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw bad('unterminated quoted field in CSV');
  if (field !== '' || fields.length) {
    fields.push(field);
    records.push({ line: recLine, fields });
  }
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}

const escapeField = (v) => {
  const str = v == null ? '' : String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(escapeField).join(',')).join('\r\n') + '\r\n';
}
