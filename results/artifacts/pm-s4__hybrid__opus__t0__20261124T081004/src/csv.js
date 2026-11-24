// Minimal RFC 4180 CSV utilities (written from scratch).
export function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) {
  return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}
// Returns array of records; each record is array of fields. Throws on unterminated quote.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false; let any = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; any = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; any = false;
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    field += c; any = true; i++;
  }
  if (inQ) throw new Error('unterminated quoted field');
  if (any || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
