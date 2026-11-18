// RFC 4180 CSV parsing/serialisation (written for this project).

// Returns [{ line, fields }] where line is the 1-based physical line the record starts on.
// Blank records are skipped.
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recLine = 1;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    records.push({ line: recLine, fields: row });
    row = [];
    field = '';
  };
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
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      pushRow();
      line++;
      recLine = line;
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) pushRow();
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}

function escapeField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  const lines = [header, ...rows].map((r) => r.map(escapeField).join(','));
  return lines.join('\r\n') + '\r\n';
}
