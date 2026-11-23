import { bad } from './util.js';

/**
 * RFC 4180 parser. Returns [{ line, fields }] where `line` is the 1-based
 * physical line on which the record starts. Blank lines are skipped.
 */
export function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recLine = 1;
  let started = false;
  let i = 0;

  const endRecord = () => {
    row.push(field);
    records.push({ line: recLine, fields: row });
    row = [];
    field = '';
    started = false;
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
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
    if (c === '"') {
      inQuotes = true;
      started = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
      i++;
    } else if (c === '\r') {
      i++;
    } else if (c === '\n') {
      if (started || field !== '' || row.length) endRecord();
      line++;
      recLine = line;
      i++;
    } else {
      field += c;
      started = true;
      i++;
    }
  }
  if (inQuotes) throw bad('Unterminated quoted field', 'invalid_csv');
  if (started || field !== '' || row.length) endRecord();
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0] === ''));
}

const escapeCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 serializer with CRLF line endings. */
export function toCsv(rows) {
  return rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}
