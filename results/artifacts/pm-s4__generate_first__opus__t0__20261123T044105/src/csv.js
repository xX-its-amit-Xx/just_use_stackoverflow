// RFC 4180 CSV helpers (original implementation).

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCSV(rows) {
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Parses CSV text into [{ line, fields }] where line is the 1-based physical
// line on which the record starts. Throws Error on malformed input.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let fields = [];
  let field = '';
  let i = 0;
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let fieldStarted = false; // whether current record has any content
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
        const nx = text[i];
        if (i < n && nx !== ',' && nx !== '\r' && nx !== '\n') {
          throw new Error(`unexpected character after closing quote on line ${line}`);
        }
        continue;
      }
      if (c === '\n') line++;
      field += c; i++;
      continue;
    }
    if (c === '"') {
      if (field.length > 0) throw new Error(`unexpected quote on line ${line}`);
      inQuotes = true; fieldStarted = true; i++;
      continue;
    }
    if (c === ',') { fields.push(field); field = ''; fieldStarted = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      fields.push(field);
      if (!(fields.length === 1 && fields[0] === '' && !fieldStarted)) records.push({ line: recordLine, fields });
      fields = []; field = ''; fieldStarted = false;
      line++; recordLine = line;
      continue;
    }
    field += c; fieldStarted = true; i++;
  }
  if (inQuotes) throw new Error(`unterminated quoted field starting on line ${recordLine}`);
  if (field.length > 0 || fields.length > 0 || fieldStarted) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  return records;
}
