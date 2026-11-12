// RFC 4180 CSV encoding and parsing (CRLF line endings on output).

export function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, header) {
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Returns [{ line, fields }] where `line` is the 1-based physical line the record starts on.
// Blank records are skipped. Throws on an unterminated quoted field.
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let i = 0;
  let line = 1;
  let recStart = 1;
  let field = '';
  let row = [];
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (!(row.length === 1 && row[0] === '')) records.push({ line: recStart, fields: row });
      row = [];
      field = '';
      line++;
      recStart = line;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push({ line: recStart, fields: row });
  }
  return records;
}
