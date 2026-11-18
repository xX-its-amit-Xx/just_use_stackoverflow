// RFC 4180 CSV helpers.

// Returns [{ line, fields }] where line is the 1-based physical line a record starts on.
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recStart = 1;
  let fieldQuoted = false;

  const endRecord = () => {
    row.push(field);
    const isBlank = row.length === 1 && row[0] === '' && !fieldQuoted;
    if (!isBlank) records.push({ line: recStart, fields: row });
    row = [];
    field = '';
    fieldQuoted = false;
  };

  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; fieldQuoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; fieldQuoted = false; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      endRecord(); line++; recStart = line; i++; continue;
    }
    field += c; i++;
  }
  if (inQuotes) throw new Error('unterminated quoted field in CSV');
  if (field !== '' || row.length > 0 || fieldQuoted) endRecord();
  return records;
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(fields) {
  return fields.map(csvEscape).join(',') + '\r\n';
}
